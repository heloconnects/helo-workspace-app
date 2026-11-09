// Round 3 fixes (docs/Build-Brief-Persistence-v1-Round3-Fixes.md), on real disk.
//
// Fix 1: plan revision 9, "block and warn". A swap at the source name during a move is detected,
// not prevented. The race is staged through the native helper's test hook: a callback, run inside
// the native move, that does the swap with ordinary file operations from this test file.
// Fix 2: one unreadable attempt never breaks the task view or task list.
// Fix 3: outside-review recovery is isolated per save and per outside/ folder.

import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { attemptDir } from '../../src/core/records.js';
import { Service } from '../../src/core/service.js';
import { CrashHooks, SimulatedCrash } from '../../src/core/sim-store.js';
import { loadSafePublish } from '../../src/persist/native.js';
import type { RealCloneFs, SwapHook } from '../../src/persist/real-fs.js';
import type { Scenario } from '../../src/shared/types.js';
import { cleanupTemp, makeTestFolder, openWs, tempDir } from './helpers.js';

afterEach(cleanupTemp);

const OK: Scenario = { draft: 'ok', review: 'ok', synthesis: 'ok' };
const n = loadSafePublish();
let keyN = 0;

function code(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    return (e as { code: string }).code;
  }
  return 'no error';
}

function setup(hooks = new CrashHooks()) {
  const folder = makeTestFolder();
  const data = tempDir('data');
  const o = openWs(data, folder, hooks);
  const task = newTask(o.ws, o.project.id, 'Made-up task on disk');
  return { ...o, folder, data, task };
}

function newTask(ws: ReturnType<typeof openWs>['ws'], projectId: string, title: string) {
  return ws.createTask({ projectId, title, brief: 'Example brief.', acceptanceCriteria: ['Example criterion'], sourceIds: [], drafter: 'claude', scenarioId: 'success-issues', scenario: OK });
}

function start(ws: ReturnType<typeof openWs>['ws'], taskId: string) {
  const t = ws.task(taskId);
  return ws.startAttempt({ taskId, approvedPacketHash: t.packetHash, idempotencyKey: `r3-${++keyN}`, acknowledgePriorStopped: false });
}

function relaunch(data: string, folder: string) {
  const o = openWs(data, folder);
  o.ws.recover();
  return o;
}

async function waitFor(cond: () => boolean, ms = 5000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 1));
  }
}

/** A test-only swap: at the instant of the move of `target`, the app's file is moved aside and `swapIn` is put at its name. */
function swapAt(target: string, swapIn: 'folder' | 'file' | 'same-bytes', blockMoveBack: boolean): SwapHook {
  return (stage, m) => {
    if (m.to !== target) return;
    const src = path.join(m.folder, m.from);
    if (stage === 'before-move') {
      const original = readFileSync(src);
      renameSync(src, `${src}-moved-aside-by-test`);
      if (swapIn === 'folder') mkdirSync(src);
      else if (swapIn === 'same-bytes') writeFileSync(src, original); // another file, with exactly the app's bytes
      else writeFileSync(src, 'swapped in by the test\n');
    } else if (blockMoveBack) {
      writeFileSync(src, 'occupies the original name so the move back fails\n');
    }
  };
}

describe('Fix 1, native: a swap at the source name is detected and reported in two distinct ways', () => {
  function prepared() {
    const root = tempDir('n3');
    const r = n.openRoot(root);
    const fd = n.openSub(r, ['app-records', 't1', 'a1'], true);
    n.closeDir(r);
    n.createExclusive(fd, '.tmp-w1', Buffer.from('the app record'), false);
    return { dir: path.join(root, 'app-records', 't1', 'a1'), fd };
  }

  it('"swapped, moved back": a folder swapped in is moved back to its original name; nothing is at the record name', () => {
    const { dir, fd } = prepared();
    const c = code(() =>
      n.moveNoReplace(fd, '.tmp-w1', fd, 'final.md', (stage) => {
        if (stage === 'before-move') {
          renameSync(path.join(dir, '.tmp-w1'), path.join(dir, 'aside'));
          mkdirSync(path.join(dir, '.tmp-w1'));
        }
      }),
    );
    expect(c).toBe('ESWAPPED_MOVED_BACK');
    expect(existsSync(path.join(dir, 'final.md'))).toBe(false);
    expect(lstatSync(path.join(dir, '.tmp-w1')).isDirectory()).toBe(true); // moved back
    expect(readFileSync(path.join(dir, 'aside'), 'utf8')).toBe('the app record'); // nothing deleted
    n.closeDir(fd);
  });

  it('"swapped, NOT moved back": when the original name is taken again, the swapped-in folder stays at the record name', () => {
    const { dir, fd } = prepared();
    const c = code(() =>
      n.moveNoReplace(fd, '.tmp-w1', fd, 'final.md', (stage) => {
        if (stage === 'before-move') {
          renameSync(path.join(dir, '.tmp-w1'), path.join(dir, 'aside'));
          mkdirSync(path.join(dir, '.tmp-w1'));
        } else writeFileSync(path.join(dir, '.tmp-w1'), 'taken');
      }),
    );
    expect(c).toBe('ESWAPPED_NOT_MOVED_BACK');
    expect(lstatSync(path.join(dir, 'final.md')).isDirectory()).toBe(true); // left at the destination; never claimed as published
    expect(readFileSync(path.join(dir, '.tmp-w1'), 'utf8')).toBe('taken');
    expect(readFileSync(path.join(dir, 'aside'), 'utf8')).toBe('the app record');
    n.closeDir(fd);
  });

  it('without a swap the hook changes nothing: the checked file is published', () => {
    const { dir, fd } = prepared();
    const stages: string[] = [];
    n.moveNoReplace(fd, '.tmp-w1', fd, 'final.md', (s) => void stages.push(s));
    expect(stages).toEqual(['before-move']);
    expect(readFileSync(path.join(dir, 'final.md'), 'utf8')).toBe('the app record');
    n.closeDir(fd);
  });
});

describe('Fix 1, engine: block and warn on a detected swap', () => {
  it('"moved back": nothing is published, the attempt fails by the F3 rules, and the project is blocked with the folder and names', async () => {
    const s = setup();
    const fs = s.ws.cloneOf(s.project.id) as RealCloneFs;
    fs.swapHook = swapAt('1-draft.md', 'folder', false);
    const at = start(s.ws, s.task.id);
    await waitFor(() => s.ws.attempt(at.id).finalizing !== null);
    await s.ws.settled(at.id);
    fs.swapHook = null;
    const a = s.ws.attempt(at.id);
    expect(a.state).toBe('failed');
    expect(a.finalizing!.reason).toMatch(/1-draft\.md could not be published: swapped/);
    expect(a.finalizing!.files.map((f) => f.name)).not.toContain('1-draft.md');
    const row = s.ws.t.recordFiles.find((r) => r.attemptId === at.id && r.name === '1-draft.md')!;
    expect(row.state).toBe('not_published');
    expect(row.swap).toBe('moved-back');
    const dir = path.join(s.folder, attemptDir(s.task.id, at.id));
    expect(existsSync(path.join(dir, '1-draft.md'))).toBe(false);
    // The block: recorded with the exact folder and names, and whether the entry was moved back.
    const b = s.ws.project(s.project.id).swapBlock!;
    expect(b.folder).toBe(dir);
    expect(b.destinationName).toBe('1-draft.md');
    expect(b.sourceName).toMatch(/^\.tmp-w/);
    expect(b.movedBack).toBe(true);
    expect(lstatSync(path.join(dir, b.sourceName)).isDirectory()).toBe(true); // the swapped-in folder, back at its name
    // final-status.json is a write too: refused while blocked. The outcome stays as decided.
    expect(a.final).toBe(false);
    expect(existsSync(path.join(dir, 'final-status.json'))).toBe(false);
    const view = new Service(s.ws).projectView(s.project.id);
    expect(view.swapBlock).toMatchObject({ folder: dir, destinationName: '1-draft.md', movedBack: true, advice: 'Check this folder. Something replaced a file while the app was saving it.' });
    expect(view.blocked).toMatch(/^Check this folder\. Something replaced a file while the app was saving it/);
    s.db.close();
  });

  it('the block survives a relaunch, refuses every task and write while it lasts, and only "I have checked this folder" lifts it, which is recorded', async () => {
    const s = setup();
    const fs = s.ws.cloneOf(s.project.id) as RealCloneFs;
    fs.swapHook = swapAt('packet.md', 'folder', false);
    const at = start(s.ws, s.task.id);
    await waitFor(() => s.ws.attempt(at.id).finalizing !== null);
    await s.ws.settled(at.id);
    s.db.close();

    const r = relaunch(s.data, s.folder);
    expect(r.ws.project(s.project.id).swapBlock?.destinationName).toBe('packet.md');
    const before = readdirSync(path.join(s.folder, attemptDir(s.task.id, at.id))).sort();
    // Every task and write is refused.
    expect(() => start(r.ws, s.task.id)).toThrow(/Check this folder/);
    expect(() => newTask(r.ws, s.project.id, 'Another')).toThrow(/Check this folder/);
    expect(() => r.ws.saveOutsideReview({ taskId: s.task.id, source: 'chatgpt', text: 'Made-up review.' })).toThrow(/Not saved: Check this folder/);
    expect((await new Service(r.ws).startAttempt({ taskId: s.task.id, approvedPacketHash: s.task.packetHash, idempotencyKey: 'x', acknowledgePriorStopped: false })).ok).toBe(false);
    r.ws.recover(); // recovery writes nothing while blocked
    expect(readdirSync(path.join(s.folder, attemptDir(s.task.id, at.id))).sort()).toEqual(before);
    expect(r.ws.attempt(at.id).final).toBe(false);

    const lifted = await new Service(r.ws).confirmFolderChecked({ projectId: s.project.id });
    expect(lifted.ok).toBe(true);
    expect(r.ws.project(s.project.id).swapBlock).toBeNull();
    expect(r.ws.project(s.project.id).swapBlockHistory).toHaveLength(1);
    expect(r.ws.project(s.project.id).swapBlockHistory![0]).toMatchObject({ action: 'I have checked this folder', block: { destinationName: 'packet.md' } });
    expect(r.ws.events[0]!.text).toMatch(/I have checked this folder/);
    expect((await new Service(r.ws).confirmFolderChecked({ projectId: s.project.id })).ok).toBe(false); // nothing left to lift
    r.db.close();

    // The lift is in the store too; the next start finishes the record with the outcome unchanged.
    const r2 = relaunch(s.data, s.folder);
    expect(r2.ws.project(s.project.id).swapBlockHistory).toHaveLength(1);
    expect(r2.ws.projectBlock(s.project.id)).toBeNull();
    const a = r2.ws.attempt(at.id);
    expect(a.state).toBe('failed');
    expect(a.final).toBe(true);
    expect(r2.ws.recordState(at.id)).toEqual({ kind: 'intact' });
    r2.db.close();
  });

  it('"NOT moved back", a folder: it is never counted as published, stays in place after the unblock and is listed in the inventory', async () => {
    const s = setup();
    const fs = s.ws.cloneOf(s.project.id) as RealCloneFs;
    fs.swapHook = swapAt('1-draft.md', 'folder', true);
    const at = start(s.ws, s.task.id);
    await waitFor(() => s.ws.attempt(at.id).finalizing !== null);
    await s.ws.settled(at.id);
    fs.swapHook = null;
    const dir = path.join(s.folder, attemptDir(s.task.id, at.id));
    expect(lstatSync(path.join(dir, '1-draft.md')).isDirectory()).toBe(true);
    const b = s.ws.project(s.project.id).swapBlock!;
    expect(b.movedBack).toBe(false);
    expect(new Service(s.ws).projectView(s.project.id).blocked).toMatch(/could NOT be moved back; it may still be at 1-draft\.md/);
    expect(s.ws.t.recordFiles.find((r) => r.attemptId === at.id && r.name === '1-draft.md')).toMatchObject({ state: 'not_published', swap: 'not-moved-back' });
    s.ws.liftSwapBlock(s.project.id);
    s.db.close();

    const r = relaunch(s.data, s.folder);
    expect(r.ws.attempt(at.id).finalizing!.files.map((f) => f.name)).not.toContain('1-draft.md');
    expect(lstatSync(path.join(dir, '1-draft.md')).isDirectory()).toBe(true); // left where it is
    expect(r.ws.recordState(at.id)).toEqual({ kind: 'intact' }); // a failed outcome never requires it
    const inv = await new Service(r.ws).getInventory({ taskId: s.task.id });
    const entry = inv.ok ? inv.value.entries.find((e) => e.path.endsWith('/1-draft.md')) : undefined;
    expect(entry).toMatchObject({ kind: 'not-a-file', flag: expect.stringMatching(/Not a regular file: not a valid record/) });
    r.db.close();
  });

  it('"NOT moved back", a regular file: recovery moves it to quarantine after the unblock, never counting it as published', async () => {
    const s = setup();
    const fs = s.ws.cloneOf(s.project.id) as RealCloneFs;
    fs.swapHook = swapAt('1-draft.md', 'file', true);
    const at = start(s.ws, s.task.id);
    await waitFor(() => s.ws.attempt(at.id).finalizing !== null);
    await s.ws.settled(at.id);
    fs.swapHook = null;
    const dir = path.join(s.folder, attemptDir(s.task.id, at.id));
    expect(readFileSync(path.join(dir, '1-draft.md'), 'utf8')).toBe('swapped in by the test\n');
    s.db.close();
    // Still blocked: recovery reads but moves nothing.
    const r = relaunch(s.data, s.folder);
    expect(readFileSync(path.join(dir, '1-draft.md'), 'utf8')).toBe('swapped in by the test\n');
    r.ws.liftSwapBlock(s.project.id);
    r.db.close();
    const r2 = relaunch(s.data, s.folder);
    expect(existsSync(path.join(dir, '1-draft.md'))).toBe(false);
    const q = readdirSync(path.join(dir, 'quarantine'));
    expect(q.some((x) => x.startsWith('1-draft.md-') && readFileSync(path.join(dir, 'quarantine', x), 'utf8') === 'swapped in by the test\n')).toBe(true);
    expect(r2.ws.attempt(at.id).finalizing!.files.map((f) => f.name)).not.toContain('1-draft.md');
    r2.db.close();
  });

  it('a swap during an outside-review save: nothing is saved and the project is blocked', () => {
    const s = setup();
    const fs = s.ws.cloneOf(s.project.id) as RealCloneFs;
    const date = s.ws.now().slice(0, 10);
    fs.swapHook = swapAt(`1-chatgpt-${date}.md`, 'folder', false);
    expect(() => s.ws.saveOutsideReview({ taskId: s.task.id, source: 'chatgpt', text: 'Made-up review.' })).toThrow(/Not saved\. Check this folder/);
    expect(s.ws.t.outsideSaves[0]!.state).toBe('not_saved');
    expect(s.ws.project(s.project.id).swapBlock).toMatchObject({ during: 'outside-review', movedBack: true });
    s.db.close();
  });

  it('recovery treats a folder found at a record name (the app killed between the two moves) as not published, and lists it', async () => {
    const hooks = new CrashHooks();
    const s = setup(hooks);
    hooks.arm('publish:1-draft.md:tmp-written');
    const at = start(s.ws, s.task.id);
    await waitFor(() => s.ws.crashedAt !== null);
    s.db.close();
    const dir = path.join(s.folder, attemptDir(s.task.id, at.id));
    mkdirSync(path.join(dir, '1-draft.md')); // what a swap left at the record name
    const r = relaunch(s.data, s.folder);
    const row = r.ws.t.recordFiles.find((x) => x.attemptId === at.id && x.name === '1-draft.md')!;
    expect(row.state).toBe('not_published');
    expect(row.error).toMatch(/not a regular file \(a folder\).*left in place/);
    const a = r.ws.attempt(at.id);
    expect(a.state).toBe('interrupted');
    expect(a.finalizing!.files.map((f) => f.name)).not.toContain('1-draft.md');
    expect(lstatSync(path.join(dir, '1-draft.md')).isDirectory()).toBe(true);
    const inv = await new Service(r.ws).getInventory({ taskId: s.task.id });
    expect(inv.ok && inv.value.entries.find((e) => e.path.endsWith('/1-draft.md'))?.kind).toBe('not-a-file');
    r.db.close();
  });
});

describe('Fix 2: one unreadable attempt never breaks the task view or the task list', () => {
  it('a final attempt whose folder is unreadable shows its outcome with "cannot be checked right now"; everything else loads', async () => {
    const s = setup();
    const t2 = newTask(s.ws, s.project.id, 'Second task');
    const a1 = start(s.ws, s.task.id);
    await s.ws.settled(a1.id);
    const a2 = start(s.ws, s.task.id); // a second attempt of the same task, readable
    await s.ws.settled(a2.id);
    const b1 = start(s.ws, t2.id);
    await s.ws.settled(b1.id);
    expect(s.ws.attempt(a1.id).final).toBe(true);
    const dir = path.join(s.folder, attemptDir(s.task.id, a1.id));
    chmodSync(dir, 0o000);
    try {
      const svc = new Service(s.ws);
      const view = svc.taskView(s.task.id);
      const v1 = view.attempts.find((x) => x.id === a1.id)!;
      expect(v1.outcome).toBe('complete'); // from the store
      expect(v1.recordState).toMatchObject({ kind: 'unchecked', path: dir, error: expect.stringMatching(/EACCES/) });
      expect(v1.display).toBe('Complete — record cannot be checked right now');
      expect(view.attempts.find((x) => x.id === a2.id)!.recordState).toEqual({ kind: 'intact' });
      const list = await svc.listTasks({ projectId: s.project.id });
      expect(list.ok).toBe(true);
      expect(list.ok && list.value.map((t) => t.latest?.recordState.kind).sort()).toEqual(['intact', 'intact']);
      expect((await svc.getTask({ taskId: s.task.id })).ok).toBe(true);
      expect(svc.taskView(t2.id).attempts[0]!.recordState).toEqual({ kind: 'intact' });
    } finally {
      chmodSync(dir, 0o755);
    }
    s.db.close();
  });

  it('a finalizing attempt (final-status.json not yet written) whose folder is unreadable: the task view and list still load', async () => {
    const s = setup();
    const fs = s.ws.cloneOf(s.project.id) as RealCloneFs;
    fs.injectFault('final-status.json', 'EIO', 1); // the outcome is decided, final-status.json is not written
    const a1 = start(s.ws, s.task.id);
    await s.ws.settled(a1.id);
    const a = s.ws.attempt(a1.id);
    expect(a.finalizing).not.toBeNull();
    expect(a.final).toBe(false);
    const dir = path.join(s.folder, attemptDir(s.task.id, a1.id));
    chmodSync(dir, 0o000);
    try {
      const svc = new Service(s.ws);
      const v = svc.taskView(s.task.id).attempts[0]!;
      expect(v.outcome).toBe('complete');
      expect(v.recordState.kind).toBe('unchecked');
      expect(v.display).toBe('Complete — record cannot be checked right now');
      expect(svc.taskSummary(s.task.id).latest?.recordState.kind).toBe('unchecked');
      const inv = await svc.getInventory({ taskId: s.task.id });
      expect(inv.ok).toBe(true); // the inventory loads too, and says plainly which folder it could not read
      expect(inv.ok && inv.value.entries.find((e) => e.kind === 'unreadable')).toMatchObject({ path: attemptDir(s.task.id, a1.id), flag: expect.stringMatching(/Cannot be read right now/) });
    } finally {
      chmodSync(dir, 0o755);
    }
    s.db.close();
  });
});

describe('Fix 3: outside-review recovery is isolated per save and per folder', () => {
  it('an unreadable earlier save does not stop a healthy later one from being reconciled and its temporary file cleaned', () => {
    const hooks = new CrashHooks();
    const s = setup(hooks);
    const t2 = newTask(s.ws, s.project.id, 'Second task');
    hooks.arm('outside:tmp-written');
    expect(() => s.ws.saveOutsideReview({ taskId: s.task.id, source: 'chatgpt', text: 'Made-up review one.' })).toThrow(SimulatedCrash);
    hooks.arm('outside:tmp-written');
    expect(() => s.ws.saveOutsideReview({ taskId: t2.id, source: 'claude-app', text: 'Made-up review two.' })).toThrow(SimulatedCrash);
    s.db.close();
    const out1 = path.join(s.folder, 'app-records', s.task.id, 'outside');
    const out2 = path.join(s.folder, 'app-records', t2.id, 'outside');
    expect(readdirSync(out2).filter((x) => x.startsWith('.tmp-'))).toHaveLength(1);
    chmodSync(out1, 0o000);
    try {
      const r = relaunch(s.data, s.folder);
      const [first, second] = r.ws.t.outsideSaves;
      expect(first!.taskId).toBe(s.task.id);
      expect(first!.state).toBe('intended'); // not reconciled on a partial picture; tried again next start
      expect(second!.state).toBe('not_saved'); // reconciled
      expect(readdirSync(out2).filter((x) => x.startsWith('.tmp-'))).toEqual([]); // cleaned
      expect(readdirSync(path.join(out2, 'quarantine'))).toHaveLength(1); // moved, never deleted
      expect(r.ws.events.some((e) => /outside review .* tried again on the next start/.test(e.text))).toBe(true);
      r.db.close();
    } finally {
      chmodSync(out1, 0o755);
    }
    const r2 = relaunch(s.data, s.folder);
    expect(r2.ws.t.outsideSaves[0]!.state).toBe('not_saved');
    expect(readdirSync(out1).filter((x) => x.startsWith('.tmp-'))).toEqual([]);
    r2.db.close();
  });
});

describe('Round 4: a detected swap is never counted as published, whatever its content', () => {
  it('a record swapped for a file with identical bytes: never adopted, even when recovery runs before an outcome is decided; quarantined after the unblock', async () => {
    const hooks = new CrashHooks();
    const s = setup(hooks);
    const fs = s.ws.cloneOf(s.project.id) as RealCloneFs;
    fs.swapHook = swapAt('1-draft.md', 'same-bytes', true);
    hooks.arm('txn:finalizing:before'); // the app stops after the swap is recorded, before any outcome
    const at = start(s.ws, s.task.id);
    await waitFor(() => s.ws.crashedAt !== null);
    s.db.close();
    const dir = path.join(s.folder, attemptDir(s.task.id, at.id));
    const r = relaunch(s.data, s.folder); // blocked: recovery reads, writes nothing
    const row = r.ws.t.recordFiles.find((x) => x.attemptId === at.id && x.name === '1-draft.md')!;
    expect(row).toMatchObject({ state: 'not_published', swap: 'not-moved-back' });
    expect(r.ws.attempt(at.id).finalizing!.files.map((f) => f.name)).not.toContain('1-draft.md');
    expect(existsSync(path.join(dir, '1-draft.md'))).toBe(true); // nothing moved while blocked
    r.ws.liftSwapBlock(s.project.id);
    r.db.close();
    const r2 = relaunch(s.data, s.folder);
    expect(existsSync(path.join(dir, '1-draft.md'))).toBe(false);
    expect(readdirSync(path.join(dir, 'quarantine')).some((x) => x.startsWith('1-draft.md-'))).toBe(true);
    expect(r2.ws.t.recordFiles.find((x) => x.attemptId === at.id && x.name === '1-draft.md')!.state).toBe('not_published');
    expect(r2.ws.recordState(at.id)).toEqual({ kind: 'intact' });
    r2.db.close();
  });

  it('final-status.json swapped for a file with identical bytes: not accepted while blocked; after the unblock it is quarantined and the stored bytes published', async () => {
    const s = setup();
    const fs = s.ws.cloneOf(s.project.id) as RealCloneFs;
    fs.swapHook = swapAt('final-status.json', 'same-bytes', true);
    const at = start(s.ws, s.task.id);
    await s.ws.settled(at.id);
    fs.swapHook = null;
    const dir = path.join(s.folder, attemptDir(s.task.id, at.id));
    expect(s.ws.attempt(at.id).state).toBe('complete'); // the outcome was decided before; it never changes
    expect(s.ws.attempt(at.id).final).toBe(false);
    expect(s.ws.project(s.project.id).swapBlock?.destinationName).toBe('final-status.json');
    s.db.close();
    const r = relaunch(s.data, s.folder);
    expect(r.ws.attempt(at.id).final).toBe(false); // identical bytes at the name are not accepted
    expect(r.ws.t.recordFiles.find((x) => x.attemptId === at.id && x.name === 'final-status.json')!.state).toBe('not_published');
    r.ws.liftSwapBlock(s.project.id);
    r.db.close();
    const r2 = relaunch(s.data, s.folder);
    const a = r2.ws.attempt(at.id);
    expect(a.final).toBe(true);
    expect(readFileSync(path.join(dir, 'final-status.json'), 'utf8')).toBe(a.finalizing!.finalStatusBytes);
    expect(readdirSync(path.join(dir, 'quarantine')).some((x) => x.startsWith('final-status.json-'))).toBe(true);
    expect(r2.ws.recordState(at.id)).toEqual({ kind: 'intact' });
    r2.db.close();
  });

  it('an outside-review swap not moved back: the save stays not saved, and after the unblock the file at its name goes to quarantine', async () => {
    for (const swapIn of ['file', 'same-bytes'] as const) {
      const s = setup();
      const fs = s.ws.cloneOf(s.project.id) as RealCloneFs;
      const date = s.ws.now().slice(0, 10);
      const name = `1-chatgpt-${date}.md`;
      fs.swapHook = swapAt(name, swapIn, true);
      expect(() => s.ws.saveOutsideReview({ taskId: s.task.id, source: 'chatgpt', text: 'Made-up review.' })).toThrow(/Not saved\. Check this folder/);
      fs.swapHook = null;
      const out = path.join(s.folder, 'app-records', s.task.id, 'outside');
      expect(existsSync(path.join(out, name)), swapIn).toBe(true);
      expect(s.ws.t.outsideSaves[0]).toMatchObject({ state: 'not_saved', swap: 'not-moved-back', swapTarget: name });
      expect(new Service(s.ws).taskView(s.task.id).outsideReviews[0]!.note).toMatch(/could not be moved back/);
      s.db.close();
      const r = relaunch(s.data, s.folder);
      expect(existsSync(path.join(out, name)), swapIn).toBe(true); // blocked: nothing moved
      r.ws.liftSwapBlock(s.project.id);
      r.db.close();
      const r2 = relaunch(s.data, s.folder);
      expect(existsSync(path.join(out, name)), swapIn).toBe(false);
      expect(readdirSync(path.join(out, 'quarantine')).some((x) => x.startsWith(`${name}-`)), swapIn).toBe(true);
      expect(r2.ws.t.outsideSaves[0]!.state).toBe('not_saved');
      r2.ws.recover(); // repeatable: nothing left to move
      r2.db.close();
    }
  });
});
