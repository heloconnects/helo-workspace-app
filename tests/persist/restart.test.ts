// The engine on real disk: records written through the native helper into a
// real temporary test folder, run state in a real SQLite file. A "restart"
// throws away the whole workspace and opens a new one from the same SQLite
// file and folder, as relaunching the app does.

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { attemptDir } from '../../src/core/records.js';
import { Service } from '../../src/core/service.js';
import { CrashHooks, SimulatedCrash } from '../../src/core/sim-store.js';
import type { Provider, Scenario } from '../../src/shared/types.js';
import { cleanupTemp, makeTestFolder, openWs, tempDir } from './helpers.js';

afterEach(cleanupTemp);

const OK: Scenario = { draft: 'ok', review: 'ok', synthesis: 'ok' };
const BOTH: Provider[] = ['claude', 'codex'];
let keyN = 0;

/** Every file and folder under a real folder, with contents, never following symlinks. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const name of readdirSync(path.join(root, rel))) {
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(path.join(root, r));
      if (st.isDirectory()) {
        out[`${r}/`] = 'dir';
        walk(r);
      } else out[r] = st.isSymbolicLink() ? 'symlink' : readFileSync(path.join(root, r), 'utf8');
    }
  };
  walk('');
  return out;
}

function without(snap: Record<string, string>, prefix: string) {
  return Object.fromEntries(Object.entries(snap).filter(([k]) => !k.startsWith(prefix)));
}

function setup(scenario: Scenario = OK, drafter: Provider = 'claude', hooks = new CrashHooks()) {
  const folder = makeTestFolder();
  mkdirSync(path.join(folder, '.git'));
  writeFileSync(path.join(folder, '.git', 'HEAD'), 'ref: refs/heads/main\n'); // a clone's git folder, never touched
  const data = tempDir('data');
  const o = openWs(data, folder, hooks);
  const task = o.ws.createTask({
    projectId: o.project.id,
    title: 'Made-up task on disk',
    brief: 'Example brief for a made-up task.',
    acceptanceCriteria: ['Example criterion one', 'Example criterion two'],
    sourceIds: [],
    drafter,
    scenarioId: 'success-issues',
    scenario,
  });
  return { ...o, folder, data, task };
}

function start(ws: ReturnType<typeof openWs>['ws'], taskId: string, ack = false) {
  const t = ws.task(taskId);
  return ws.startAttempt({ taskId, approvedPacketHash: t.packetHash, idempotencyKey: `k${++keyN}`, acknowledgePriorStopped: ack });
}

/** Relaunch: a brand-new workspace from the same SQLite file and folder, then start-up recovery. */
function relaunch(data: string, folder: string) {
  const o = openWs(data, folder);
  o.ws.recover();
  return o;
}

async function waitFor(cond: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 1));
  }
}

describe.each(BOTH)('on real disk (%s drafting)', (drafter) => {
  it('completes, writes all nine records, touches nothing outside app-records/, and survives a relaunch', async () => {
    const s = setup(OK, drafter);
    const before = snapshot(s.folder);
    const at = start(s.ws, s.task.id);
    await s.ws.settled(at.id);
    expect(s.ws.attempt(at.id).state).toBe('complete');
    const dir = path.join(s.folder, attemptDir(s.task.id, at.id));
    expect(readdirSync(dir).sort()).toEqual(
      ['1-draft-sent.json', '1-draft.md', '2-review-sent.json', '2-review.md', '3-synthesis-sent.json', '3-synthesis.md', 'final-status.json', 'packet.md', 'sharing-plan.json'],
    );
    const after = snapshot(s.folder);
    expect(without(after, 'app-records/')).toEqual(before); // RULES.md, notes/ and .git/ byte for byte
    const sent = JSON.parse(readFileSync(path.join(dir, '2-review-sent.json'), 'utf8'));
    expect(sent.meaning).toBe('Prepared payload and dispatch intent');
    expect(sent.provider).toBe(drafter === 'claude' ? 'codex' : 'claude');
    s.db.close();
    const r = relaunch(s.data, s.folder);
    expect(r.ws.attempt(at.id).state).toBe('complete');
    expect(r.ws.recordState(at.id)).toEqual({ kind: 'intact' });
    expect(snapshot(s.folder)).toEqual(after); // recovery changed nothing
    r.db.close();
  });

  it('quitting while a stage runs: after the relaunch the attempt is interrupted, and a retry needs acknowledgement', async () => {
    const s = setup({ ...OK, review: 'timeout' }, drafter, new CrashHooks());
    s.ws.setTiming({ responseMs: 1, lateResultMs: 25, stageTimeoutMs: 60_000, attemptLimitMs: 60_000, cancelGraceMs: 15 });
    const at = start(s.ws, s.task.id);
    await waitFor(() => s.ws.attempt(at.id).state === 'reviewing' && s.ws.dispatchStatus(at.id, 'review') === 'confirmed');
    s.ws.crash('quit'); // the process goes away: nothing more from this workspace
    s.db.close();
    const r = relaunch(s.data, s.folder);
    expect(r.ws.attempt(at.id).state).toBe('interrupted');
    expect(r.ws.attempt(at.id).final).toBe(true);
    expect(r.ws.unresolvedStages(at.id)).toEqual(['review']);
    expect(() => start(r.ws, s.task.id)).toThrow(/may still have a provider stage running/);
    expect(r.ws.recordState(at.id)).toEqual({ kind: 'intact' });
    r.db.close();
  });
});

describe.each(BOTH)('crash at every boundary, then a real relaunch (%s drafting)', (drafter) => {
  it('gives exactly one outcome, never changes a decided outcome, never re-runs a stage, and leaves no temporary file', async () => {
    // Dry run to list the boundaries a run passes on real disk.
    const probe = setup(OK, drafter);
    const mark = probe.hooks.seen.length;
    await probe.ws.settled(start(probe.ws, probe.task.id).id);
    const points = [...new Set(probe.hooks.seen.slice(mark))];
    probe.db.close();
    expect(points.length).toBeGreaterThan(90);
    for (const point of points) {
      const hooks = new CrashHooks();
      const s = setup(OK, drafter, hooks);
      const before = without(snapshot(s.folder), 'app-records/');
      hooks.arm(point);
      let attemptId: string | null = null;
      try {
        const at = start(s.ws, s.task.id);
        attemptId = at.id;
        await s.ws.settled(at.id);
      } catch (e) {
        if (!(e instanceof SimulatedCrash)) throw e;
        s.ws.crash(e.point);
      }
      await new Promise((r) => setTimeout(r, 5));
      expect(s.ws.crashedAt, point).not.toBeNull();
      attemptId ??= s.ws.t.attempts[0]?.id ?? null;
      const decided = attemptId ? (s.ws.t.attempts.find((x) => x.id === attemptId)?.finalizing?.outcome ?? null) : null;
      const received = s.ws.adapters.claude.received.length + s.ws.adapters.codex.received.length;
      s.db.close();
      const r = relaunch(s.data, s.folder);
      if (!attemptId || !r.ws.t.attempts.some((x) => x.id === attemptId)) {
        expect(point, 'only a crash before the attempt was committed may leave no attempt').toMatch(/^txn:attempt-create:(before|mid)$/);
        r.db.close();
        continue;
      }
      const a = r.ws.attempt(attemptId);
      expect(a.final, point).toBe(true);
      expect(a.state, point).toBe(a.finalizing!.outcome);
      if (decided) expect(a.finalizing!.outcome, point).toBe(decided);
      else expect(a.finalizing!.outcome, point).toBe('interrupted');
      expect(['complete', 'interrupted'], point).toContain(a.finalizing!.outcome);
      expect(r.ws.recordState(attemptId), point).toEqual({ kind: 'intact' });
      const dir = path.join(s.folder, attemptDir(s.task.id, attemptId));
      expect(readdirSync(dir).filter((n) => n.startsWith('.tmp-')), point).toEqual([]);
      expect(readFileSync(path.join(dir, 'final-status.json'), 'utf8'), point).toBe(a.finalizing!.finalStatusBytes);
      expect(r.ws.adapters.claude.received.length + r.ws.adapters.codex.received.length, point).toBe(0); // nothing dispatched by recovery
      expect(received, point).toBeLessThanOrEqual(3);
      expect(without(snapshot(s.folder), 'app-records/'), point).toEqual(before);
      // A second relaunch changes nothing.
      const snap = snapshot(s.folder);
      r.db.close();
      const r2 = relaunch(s.data, s.folder);
      expect(JSON.stringify(r2.ws.attempt(attemptId)), point).toBe(JSON.stringify(a));
      expect(snapshot(s.folder), point).toEqual(snap);
      r2.db.close();
    }
  }, 300_000);
});

describe('C1 on real disk', () => {
  it('republishes the exact final-status.json bytes kept with the outcome, never rebuilding the file list from disk', async () => {
    const s = setup();
    const at = start(s.ws, s.task.id);
    await s.ws.settled(at.id);
    const bytes = s.ws.attempt(at.id).finalizing!.finalStatusBytes;
    const dir = path.join(s.folder, attemptDir(s.task.id, at.id));
    s.db.close();
    // Outside the app: final-status.json deleted, and an extra file appears in the attempt folder.
    unlinkSync(path.join(dir, 'final-status.json'));
    writeFileSync(path.join(dir, 'extra.md'), 'someone added this');
    const r = relaunch(s.data, s.folder);
    expect(readFileSync(path.join(dir, 'final-status.json'), 'utf8')).toBe(bytes);
    expect(JSON.parse(bytes).files.map((f: { name: string }) => f.name)).not.toContain('extra.md');
    expect(r.ws.attempt(at.id).state).toBe('complete');
    expect(r.ws.recordState(at.id)).toEqual({ kind: 'intact' });
    r.db.close();
  });
});

describe('outside changes to a real folder', () => {
  it('a record changed outside the app shows "Complete — record damaged", and the next start quarantines it without changing the outcome', async () => {
    const s = setup();
    const at = start(s.ws, s.task.id);
    await s.ws.settled(at.id);
    const dir = path.join(s.folder, attemptDir(s.task.id, at.id));
    writeFileSync(path.join(dir, '1-draft.md'), 'edited by hand');
    expect(new Service(s.ws).attemptView(at.id).display).toBe('Complete — record damaged');
    s.db.close();
    const r = relaunch(s.data, s.folder);
    expect(existsSync(path.join(dir, '1-draft.md'))).toBe(false);
    expect(readdirSync(path.join(dir, 'quarantine')).some((n) => n.startsWith('1-draft.md-'))).toBe(true);
    const rs = r.ws.recordState(at.id);
    expect(rs.kind === 'damaged' && rs.problems.map((p) => [p.file, p.kind])).toEqual([['1-draft.md', 'quarantined']]);
    expect(r.ws.attempt(at.id).state).toBe('complete');
    expect(() => r.ws.damageRecord(at.id, 'packet.md', 'delete')).toThrow(/never changes its own records/);
    r.db.close();
  });

  it('a RULES.md change during a run blocks every later write into the real folder; after restoring it, the next start finishes the record', async () => {
    const s = setup({ ...OK, review: 'late-result-after-cancel' });
    const at = start(s.ws, s.task.id);
    await waitFor(() => s.ws.attempt(at.id).state === 'reviewing' && s.ws.dispatchStatus(at.id, 'review') === 'confirmed');
    const rules = readFileSync(path.join(s.folder, 'RULES.md'), 'utf8');
    writeFileSync(path.join(s.folder, 'RULES.md'), 'Business in this repository: Example Business B (fictional)\n');
    const frozen = snapshot(s.folder);
    await s.ws.settled(at.id);
    expect(snapshot(s.folder)).toEqual(frozen);
    expect(s.ws.attempt(at.id).finalizing?.reason).toMatch(/project blocked, nothing written/);
    expect(() => s.ws.saveOutsideReview({ taskId: s.task.id, source: 'chatgpt', text: 'Made-up.' })).toThrow(/Not saved/);
    s.db.close();
    let r = relaunch(s.data, s.folder);
    expect(snapshot(s.folder)).toEqual(frozen);
    expect(r.ws.attempt(at.id).final).toBe(false);
    r.db.close();
    writeFileSync(path.join(s.folder, 'RULES.md'), rules);
    r = relaunch(s.data, s.folder);
    expect(r.ws.attempt(at.id).state).toBe('failed');
    expect(r.ws.attempt(at.id).final).toBe(true);
    expect(r.ws.recordState(at.id)).toEqual({ kind: 'intact' });
    r.db.close();
  });

  it('a symlink planted where the task folder goes: the write is refused with the path, and nothing is written elsewhere', async () => {
    const s = setup();
    const elsewhere = tempDir('elsewhere');
    mkdirSync(path.join(s.folder, 'app-records'));
    symlinkSync(elsewhere, path.join(s.folder, 'app-records', s.task.id));
    const at = start(s.ws, s.task.id);
    await s.ws.settled(at.id);
    const row = s.ws.attempt(at.id);
    expect(row.state).toBe('failed');
    expect(row.finalizing?.reason).toMatch(/packet\.md could not be published: (ELOOP|ENOTDIR)/);
    expect(row.finalizing?.reason).toContain(s.folder);
    expect(readdirSync(elsewhere)).toEqual([]);
    s.db.close();
  });

  it('outside reviews are saved as real files, survive a relaunch, and removing the task leaves the folder byte for byte unchanged', async () => {
    const s = setup();
    await s.ws.settled(start(s.ws, s.task.id).id);
    s.ws.saveOutsideReview({ taskId: s.task.id, source: 'claude-app', text: 'Example outside review, made up.' });
    const outside = path.join(s.folder, 'app-records', s.task.id, 'outside');
    const files = readdirSync(outside);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^1-claude-app-\d{4}-\d{2}-\d{2}\.md$/);
    expect(readFileSync(path.join(outside, files[0]!), 'utf8').split('\n')[0]).toBe('Pasted by Ahmed; source not verified by the app');
    s.db.close();
    const r = relaunch(s.data, s.folder);
    expect(r.ws.t.outsideSaves.map((x) => x.state)).toEqual(['published']);
    const before = snapshot(s.folder);
    r.ws.deleteTask(s.task.id);
    r.ws.deleteProject(r.project.id);
    expect(snapshot(s.folder)).toEqual(before);
    r.db.close();
    expect(relaunch(s.data, s.folder).ws.t.tasks).toEqual([]);
  });
});

describe('Codex review of persistence v1: regression tests', () => {
  it('finding 2: the root folder swapped for an impostor with a matching RULES.md mid-run gets nothing written to it', async () => {
    const s = setup({ ...OK, review: 'late-result-after-cancel' });
    const at = start(s.ws, s.task.id);
    await waitFor(() => s.ws.attempt(at.id).state === 'reviewing' && s.ws.dispatchStatus(at.id, 'review') === 'confirmed');
    renameSync(s.folder, `${s.folder}-original`);
    mkdirSync(s.folder);
    writeFileSync(path.join(s.folder, 'RULES.md'), readFileSync(path.join(`${s.folder}-original`, 'RULES.md'), 'utf8')); // same business line
    await s.ws.settled(at.id);
    expect(readdirSync(s.folder)).toEqual(['RULES.md']); // nothing written into the impostor
    expect(s.ws.attempt(at.id).finalizing?.reason).toMatch(/project blocked, nothing written: (the folder was replaced|The folder was replaced)/);
    expect(s.ws.projectBlock(s.project.id)).toMatch(/replaced by a different folder/);
    s.db.close();
    // Put the original back: the next start finishes the record in the right folder.
    renameSync(s.folder, `${s.folder}-impostor`);
    renameSync(`${s.folder}-original`, s.folder);
    const r = relaunch(s.data, s.folder);
    expect(r.ws.attempt(at.id).final).toBe(true);
    expect(r.ws.recordState(at.id)).toEqual({ kind: 'intact' });
    expect(readdirSync(`${s.folder}-impostor`)).toEqual(['RULES.md']);
    r.db.close();
    cleanupExtra(`${s.folder}-impostor`);
  });

  it('finding 3: a FIFO and an oversized file in place of records do not hang or stop start-up recovery for other attempts', async () => {
    const s = setup();
    const done = start(s.ws, s.task.id);
    await s.ws.settled(done.id);
    const t2 = s.ws.createTask({ projectId: s.project.id, title: 'Second', brief: 'Example.', acceptanceCriteria: ['Example'], sourceIds: [], drafter: 'codex', scenarioId: 'success-issues', scenario: { ...OK, review: 'timeout' } });
    s.ws.setTiming({ responseMs: 1, lateResultMs: 25, stageTimeoutMs: 60_000, attemptLimitMs: 60_000, cancelGraceMs: 15 });
    const running = start(s.ws, t2.id);
    await waitFor(() => s.ws.dispatchStatus(running.id, 'review') === 'confirmed');
    s.ws.crash('quit');
    s.db.close();
    const dir = path.join(s.folder, attemptDir(s.task.id, done.id));
    unlinkSync(path.join(dir, '1-draft.md'));
    execFileSync('mkfifo', [path.join(dir, '1-draft.md')]); // test setup only
    writeFileSync(path.join(dir, '2-review.md'), 'x'.repeat(17 * 1024 * 1024));
    const t0 = Date.now();
    const r = relaunch(s.data, s.folder);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(r.ws.attempt(running.id).state).toBe('interrupted'); // the other attempt was still recovered
    expect(r.ws.attempt(done.id).state).toBe('complete');
    const rs = r.ws.recordState(done.id);
    expect(rs.kind).toBe('damaged');
    expect(rs.kind === 'damaged' && rs.problems.map((p) => p.file).sort()).toEqual(['1-draft.md', '2-review.md']);
    expect(new Service(r.ws).attemptView(done.id).display).toBe('Complete — record damaged');
    r.db.close();
  });

  it('finding 1: a failed move never deletes anything: the app\'s own temporary file is moved to quarantine', async () => {
    const s = setup();
    const fs = s.ws.cloneOf(s.project.id);
    fs.injectFault('move:1-draft.md', 'EACCES', 1); // the temporary file exists; the move then fails
    const at = start(s.ws, s.task.id);
    await s.ws.settled(at.id);
    expect(s.ws.attempt(at.id).state).toBe('failed');
    const dir = path.join(s.folder, attemptDir(s.task.id, at.id));
    expect(readdirSync(dir).filter((n) => n.startsWith('.tmp-'))).toEqual([]);
    const q = readdirSync(path.join(dir, 'quarantine'));
    expect(q).toHaveLength(1);
    expect(q[0]).toMatch(/^\.tmp-w-/);
    expect(readFileSync(path.join(dir, 'quarantine', q[0]!), 'utf8')).toContain('1. Draft'); // the content, kept
    s.db.close();
  });

  it('finding 1: a pre-existing .tmp- name the app did not create is never touched', async () => {
    const s = setup();
    const fs = s.ws.cloneOf(s.project.id);
    let planted = '';
    const openDir = fs.openDir.bind(fs);
    fs.openDir = (dir: string) => {
      const h = openDir(dir);
      const create = h.createExclusive.bind(h);
      h.createExclusive = (name: string, content: string, key?: string) => {
        if (key === 'packet.md') {
          // Another program created this exact temporary name first.
          planted = path.join(s.folder, dir, name);
          writeFileSync(planted, 'not the app\'s file');
        }
        create(name, content, key);
      };
      return h;
    };
    const at = start(s.ws, s.task.id);
    await s.ws.settled(at.id);
    expect(s.ws.attempt(at.id).state).toBe('failed');
    expect(s.ws.attempt(at.id).finalizing?.reason).toMatch(/packet\.md could not be published: collision: .* already exists; nothing was replaced/);
    expect(readFileSync(planted, 'utf8')).toBe('not the app\'s file');
    expect(existsSync(path.join(path.dirname(planted), 'quarantine'))).toBe(false);
    s.db.close();
  });

  it('new finding 2: a move that succeeds but whose flush fails is still counted as published', async () => {
    const s = setup();
    s.ws.cloneOf(s.project.id).injectFault('sync:2-review.md', 'EIO', 1);
    const at = start(s.ws, s.task.id);
    await s.ws.settled(at.id);
    expect(s.ws.attempt(at.id).state).toBe('complete');
    expect(s.ws.t.recordFiles.find((r) => r.attemptId === at.id && r.name === '2-review.md')!.state).toBe('published');
    expect(s.ws.recordState(at.id)).toEqual({ kind: 'intact' });
    expect(s.ws.events.some((e) => /2-review\.md was published, but flushing its folder failed/.test(e.text))).toBe(true);
    s.db.close();
  });

  it('new finding 2: recovery adopts a record recorded "not published" whose file is in place with the planned content', async () => {
    const hooks = new CrashHooks();
    const s = setup(OK, 'claude', hooks);
    hooks.arm('publish:1-draft.md:moved');
    const at = start(s.ws, s.task.id);
    await s.ws.settled(at.id);
    // The move happened; the database says "not published" (an acknowledgement that was lost).
    s.ws.db.transact('test:lost-ack', (d) => {
      const r = d.recordFiles.find((x) => x.attemptId === at.id && x.name === '1-draft.md')!;
      r.state = 'not_published';
      r.error = 'simulated lost acknowledgement';
    });
    s.db.close();
    const r = relaunch(s.data, s.folder);
    const fin = r.ws.attempt(at.id).finalizing!;
    expect(fin.outcome).toBe('interrupted');
    expect(fin.files.map((f) => f.name)).toContain('1-draft.md');
    unlinkSync(path.join(s.folder, attemptDir(s.task.id, at.id), '1-draft.md'));
    expect(r.ws.recordState(at.id).kind).toBe('damaged'); // it is required now
    r.db.close();
  });

  it('new finding 3: an attempt whose folder cannot be read is not settled on a partial picture; it waits, blocks retry, and settles once readable', async () => {
    const s = setup({ ...OK, review: 'timeout' });
    s.ws.setTiming({ responseMs: 1, lateResultMs: 25, stageTimeoutMs: 60_000, attemptLimitMs: 60_000, cancelGraceMs: 15 });
    const t2 = s.ws.createTask({ projectId: s.project.id, title: 'Other', brief: 'Example.', acceptanceCriteria: ['Example'], sourceIds: [], drafter: 'codex', scenarioId: 'success-issues', scenario: { ...OK, draft: 'timeout' } });
    const stuck = start(s.ws, s.task.id);
    const other = start(s.ws, t2.id);
    await waitFor(() => s.ws.dispatchStatus(stuck.id, 'review') === 'confirmed' && s.ws.dispatchStatus(other.id, 'draft') === 'confirmed');
    s.ws.crash('quit');
    s.db.close();
    const dir = path.join(s.folder, attemptDir(s.task.id, stuck.id));
    chmodSync(dir, 0o000);
    try {
      const r = relaunch(s.data, s.folder);
      expect(r.ws.attempt(other.id).state).toBe('interrupted'); // the other attempt was recovered
      const a = r.ws.attempt(stuck.id);
      expect(a.final).toBe(false);
      expect(a.finalizing).toBeNull(); // no outcome frozen on a partial picture
      expect(a.recoveryPending).toMatch(/could not be fully checked/);
      expect(r.ws.startBlock(s.task.id)).toMatch(/Recovery of attempt 1 is waiting/);
      expect(new Service(r.ws).attemptView(stuck.id).recoveryPending).toMatch(/could not be fully checked/);
      r.db.close();
    } finally {
      chmodSync(dir, 0o755);
    }
    const r2 = relaunch(s.data, s.folder);
    const a2 = r2.ws.attempt(stuck.id);
    expect(a2.state).toBe('interrupted');
    expect(a2.final).toBe(true);
    expect(a2.recoveryPending ?? null).toBeNull();
    expect(a2.finalizing!.files.map((f) => f.name)).toEqual(['packet.md', 'sharing-plan.json', '1-draft-sent.json', '1-draft.md', '2-review-sent.json']);
    expect(r2.ws.recordState(stuck.id)).toEqual({ kind: 'intact' });
    r2.db.close();
  });

  it('new finding 4: a store from the first persistence v1 build migrates without losing history, and the folder is confirmed once', async () => {
    const s = setup();
    const at = start(s.ws, s.task.id);
    await s.ws.settled(at.id);
    s.db.close();
    // Turn the store back into a schema-1 store: no folderIdentity, version 1 only.
    const file = path.join(s.data, 'helo-run-state.sqlite');
    const raw = new DatabaseSync(file);
    const row = raw.prepare('SELECT key, data FROM projects').get() as { key: string; data: string };
    const p = JSON.parse(row.data);
    delete p.folderIdentity;
    raw.prepare('UPDATE projects SET data = ? WHERE key = ?').run(JSON.stringify(p), row.key);
    raw.prepare('DELETE FROM schema_migrations WHERE version > 1').run();
    raw.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, 'then')").run();
    raw.close();
    const r = relaunch(s.data, s.folder);
    expect(r.db.schemaVersion()).toBe(2);
    expect(r.ws.attempt(at.id).state).toBe('complete'); // history kept
    expect(r.ws.projectBlock(r.project.id)).toMatch(/older version of the app/);
    expect(new Service(r.ws).projectView(r.project.id).identityUnconfirmed).toBe(true);
    expect(() => r.ws.saveOutsideReview({ taskId: s.task.id, source: 'chatgpt', text: 'Made-up.' })).toThrow(/older version/);
    r.ws.confirmFolderIdentity(r.project.id);
    expect(r.ws.projectBlock(r.project.id)).toBeNull();
    r.ws.saveOutsideReview({ taskId: s.task.id, source: 'chatgpt', text: 'Made-up.' });
    expect(() => r.ws.confirmFolderIdentity(r.project.id)).toThrow(/already confirmed/);
    r.db.close();
    const r2 = relaunch(s.data, s.folder);
    expect(r2.ws.projectBlock(r2.project.id)).toBeNull();
    r2.db.close();
  });

  it('F4 on real disk: a crash at each outside-review boundary, then a relaunch, leaves a consistent save and no temporary file', async () => {
    for (const point of ['outside:tmp-written', 'outside:moved', 'txn:outside:intended:after', 'txn:outside:published:before', 'txn:outside:published:after']) {
      const hooks = new CrashHooks();
      const s = setup(OK, 'claude', hooks);
      hooks.arm(point);
      expect(() => s.ws.saveOutsideReview({ taskId: s.task.id, source: 'chatgpt', text: 'Made-up outside review.' }), point).toThrow(SimulatedCrash);
      s.db.close();
      const r = relaunch(s.data, s.folder);
      const save = r.ws.t.outsideSaves[0]!;
      const outside = path.join(s.folder, 'app-records', s.task.id, 'outside');
      const files = existsSync(outside) ? readdirSync(outside) : [];
      expect(files.filter((n) => n.startsWith('.tmp-')), point).toEqual([]);
      if (save.state === 'published') expect(files.filter((n) => n.endsWith('.md')), point).toHaveLength(1);
      else expect(save.state, point).toBe('not_saved');
      r.db.close();
    }
  });

  it('repeated crashes during start-up recovery itself, on real disk', async () => {
    const probe = setup(OK, 'claude', new CrashHooks());
    probe.hooks.arm('publish:2-review.md:tmp-written');
    const at = start(probe.ws, probe.task.id);
    await probe.ws.settled(at.id);
    probe.db.close();
    // List the boundaries recovery passes for this state.
    const lister = openWs(probe.data, probe.folder);
    const mark = lister.hooks.seen.length;
    lister.ws.recover();
    const points = [...new Set(lister.hooks.seen.slice(mark))];
    lister.db.close();
    expect(points.some((p) => p.startsWith('quarantine:'))).toBe(true);
    for (const q of points) {
      const s = setup(OK, 'claude', new CrashHooks());
      s.hooks.arm('publish:2-review.md:tmp-written');
      const a = start(s.ws, s.task.id);
      await s.ws.settled(a.id);
      s.db.close();
      const h = new CrashHooks();
      h.arm(q);
      const crashing = openWs(s.data, s.folder, h);
      expect(() => crashing.ws.recover(), q).toThrow(SimulatedCrash);
      crashing.db.close();
      const r = relaunch(s.data, s.folder);
      expect(r.ws.attempt(a.id).state, q).toBe('interrupted');
      expect(r.ws.attempt(a.id).final, q).toBe(true);
      expect(r.ws.recordState(a.id), q).toEqual({ kind: 'intact' });
      expect(readdirSync(path.join(s.folder, attemptDir(s.task.id, a.id))).filter((n) => n.startsWith('.tmp-')), q).toEqual([]);
      r.db.close();
    }
  }, 120_000);
});

function cleanupExtra(p: string) {
  try {
    execFileSync('rm', ['-rf', p]);
  } catch {
    /* best effort; it is inside the system temporary folder */
  }
}
