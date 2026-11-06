// The engine on real disk: records written through the native helper into a
// real temporary test folder, run state in a real SQLite file. A "restart"
// throws away the whole workspace and opens a new one from the same SQLite
// file and folder, as relaunching the app does.

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
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
        expect(point, 'only a crash before the attempt was recorded may leave no attempt').toBe('txn:attempt-create:before');
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
