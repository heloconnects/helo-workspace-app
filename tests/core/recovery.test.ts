// F3 recovery with simulated crashes at every durable boundary, in both role
// orders, plus repeated crashes during recovery itself.

import { describe, expect, it } from 'vitest';
import { attemptDir } from '../../src/core/records.js';
import { CrashHooks, SimulatedCrash } from '../../src/core/sim-store.js';
import { STAGES, type Provider, type Scenario } from '../../src/shared/types.js';
import { BOTH, makeTask, makeWorkspace, OK, runToEnd, start } from './helpers.js';

const SCENARIOS: [string, Scenario][] = [
  ['success', OK],
  ['review fails', { ...OK, review: 'fail' }],
];

/** Run once without crashing and list every boundary reached by the run. */
async function boundaries(drafter: Provider, scenario: Scenario): Promise<string[]> {
  const { ws, a, hooks } = makeWorkspace();
  const before = hooks.seen.length;
  await runToEnd(ws, makeTask(ws, a.id, drafter, scenario).id);
  return [...new Set(hooks.seen.slice(before))].filter((p) => !p.startsWith('txn:task-create'));
}

async function crashRun(drafter: Provider, scenario: Scenario, point: string) {
  const hooks = new CrashHooks();
  const { ws, a } = makeWorkspace(undefined, hooks);
  const t = makeTask(ws, a.id, drafter, scenario);
  hooks.arm(point);
  try {
    const at = start(ws, t.id);
    await ws.settled(at.id);
  } catch (e) {
    // A crash inside the start call itself (the service layer does the same).
    if (!(e instanceof SimulatedCrash)) throw e;
    ws.crash(e.point);
  }
  // Let any pending acknowledgement handlers run (they may hold the armed point).
  await new Promise((r) => setTimeout(r, 10));
  const row = ws.t.attempts.find((x) => x.taskId === t.id) ?? null;
  return { ws, a, t, at: row, hooks };
}

function receivedCount(ws: ReturnType<typeof makeWorkspace>['ws']) {
  return ws.adapters.claude.received.length + ws.adapters.codex.received.length;
}

describe.each(BOTH)('crash at every boundary (%s drafting)', (drafter) => {
  describe.each(SCENARIOS)('%s', (_name, scenario) => {
    it('gives exactly one outcome at every crash point, never changes a decided outcome, and never re-runs a stage', async () => {
      const points = await boundaries(drafter, scenario);
      expect(points.length).toBeGreaterThan(40);
      const expectedEnd = scenario.review === 'fail' ? 'failed' : 'complete';
      for (const point of points) {
        const { ws, at: maybe, t } = await crashRun(drafter, scenario, point);
        const crashed = ws.crashedAt !== null;
        expect(crashed, point).toBe(true);
        if (!maybe) {
          // Crashed before the attempt was recorded: recovery has nothing to settle and nothing was sent.
          expect(point).toBe('txn:attempt-create:before');
          ws.recover();
          expect(ws.attemptsOf(t.id)).toEqual([]);
          expect(receivedCount(ws)).toBe(0);
          continue;
        }
        const at = maybe;
        const decidedBefore = at.finalizing?.outcome ?? null;
        const sent = receivedCount(ws);
        ws.recover();
        const after = ws.attempt(at.id);
        // Exactly one outcome, final, and the record is intact.
        expect(after.finalizing, point).not.toBeNull();
        expect(after.final, point).toBe(true);
        expect(after.state, point).toBe(after.finalizing!.outcome);
        if (decidedBefore) expect(after.finalizing!.outcome, point).toBe(decidedBefore);
        else expect(after.finalizing!.outcome, point).toBe('interrupted');
        expect(['interrupted', expectedEnd]).toContain(after.finalizing!.outcome);
        expect(ws.recordState(at.id), point).toEqual({ kind: 'intact' });
        // No stage dispatched by recovery.
        expect(receivedCount(ws), point).toBe(sent);
        // No temporary file left outside quarantine.
        const dir = attemptDir(at.taskId, at.id);
        expect(ws.cloneOf(at.projectId).list(`${dir}/.tmp-`), point).toEqual([]);
        // Recovery is repeatable: a second restart changes nothing.
        const snapshot = JSON.stringify(ws.attempt(at.id));
        ws.recover();
        expect(JSON.stringify(ws.attempt(at.id)), point).toBe(snapshot);
      }
    });
  });

  it('a crash after final-status.json says complete but before the database records it keeps "complete"', async () => {
    for (const point of ['publish:final-status.json:linked', 'publish:final-status.json:tmp-removed', 'txn:published:final-status.json:before', 'txn:final:before']) {
      const { ws, at: at0 } = await crashRun(drafter, OK, point);
      const at = at0!;
      expect(at.finalizing?.outcome, point).toBe('complete');
      expect(at.final, point).toBe(false);
      ws.recover();
      expect(ws.attempt(at.id).state, point).toBe('complete');
      expect(ws.attempt(at.id).final, point).toBe(true);
      expect(ws.recordState(at.id), point).toEqual({ kind: 'intact' });
    }
  });

  it('shows dispatch as uncertain when the app stopped after dispatch started but before it was confirmed (C3)', async () => {
    const { ws, at: at0 } = await crashRun(drafter, OK, 'adapter:review:dispatched');
    const at = at0!;
    ws.recover();
    expect(ws.dispatchStatus(at.id, 'draft')).toBe('confirmed');
    expect(ws.dispatchStatus(at.id, 'review')).toBe('uncertain');
    expect(ws.dispatchStatus(at.id, 'synthesis')).toBe('not_prepared');
    expect(ws.attempt(at.id).state).toBe('interrupted');
    // A new attempt needs an explicit acknowledgement that the old activity stopped.
    expect(ws.needsStopAcknowledgement(at.taskId)).toBe(true);
    expect(() => start(ws, at.taskId, false)).toThrow(/uncertain/);
    const second = start(ws, at.taskId, true);
    await ws.settled(second.id);
    expect(ws.attempt(second.id).state).toBe('complete');
  });

  it('shows "prepared; not dispatched" when the app stopped after -sent.json but before dispatch started (C3)', async () => {
    const { ws, at: at0 } = await crashRun(drafter, OK, 'txn:published:2-review-sent.json:after');
    const at = at0!;
    ws.recover();
    expect(ws.dispatchStatus(at.id, 'review')).toBe('prepared_not_dispatched');
    expect(ws.needsStopAcknowledgement(at.taskId)).toBe(false);
  });

  it('survives repeated crashes during recovery itself', async () => {
    // Collect the boundaries recovery passes through after a mid-run crash.
    const probe = await crashRun(drafter, OK, 'publish:2-review.md:tmp-written');
    const mark = probe.hooks.seen.length;
    probe.ws.recover();
    const recoveryPoints = [...new Set(probe.hooks.seen.slice(mark))];
    expect(recoveryPoints.some((p) => p.startsWith('quarantine:'))).toBe(true);
    expect(recoveryPoints.some((p) => p.includes('final-status.json'))).toBe(true);
    for (const q of recoveryPoints) {
      const { ws, at, hooks } = await crashRun(drafter, OK, 'publish:2-review.md:tmp-written');
      expect(at).not.toBeNull();
      hooks.arm(q);
      expect(() => ws.recover(), q).toThrow(SimulatedCrash);
      // Arm the same point for the next restart too (it may no longer be reached), then recover cleanly.
      hooks.arm(q);
      try {
        ws.recover();
      } catch (e) {
        if (!(e instanceof SimulatedCrash)) throw e;
      }
      hooks.disarmAll();
      ws.recover();
      const after = ws.attempt(at!.id);
      expect(after.state, q).toBe('interrupted');
      expect(after.final, q).toBe(true);
      expect(ws.recordState(at!.id), q).toEqual({ kind: 'intact' });
      expect(ws.t.attempts.filter((x) => x.taskId === at!.taskId), q).toHaveLength(1);
    }
  });
});

describe('recovery details', () => {
  it('quarantines a mismatched record file and a leftover temporary file, and lists them as not valid records', async () => {
    const { ws, at: at0 } = await crashRun('claude', OK, 'publish:1-draft.md:linked');
    const at = at0!;
    const fs = ws.cloneOf(at.projectId);
    const dir = attemptDir(at.taskId, at.id);
    fs.externalWrite(`${dir}/1-draft.md`, 'partially written or corrupted');
    expect(fs.list(`${dir}/.tmp-`)).toHaveLength(1);
    ws.recover();
    expect(fs.exists(`${dir}/1-draft.md`)).toBe(false);
    const q = fs.list(`${dir}/quarantine/`);
    expect(q.some((p) => p.includes('/quarantine/1-draft.md-w-'))).toBe(true);
    expect(q.some((p) => p.includes('/quarantine/.tmp-'))).toBe(true);
    const row = ws.t.recordFiles.find((r) => r.attemptId === at.id && r.name === '1-draft.md')!;
    expect(row.state).toBe('not_published');
    expect(ws.attempt(at.id).state).toBe('interrupted');
    expect(ws.recordState(at.id)).toEqual({ kind: 'intact' });
  });

  it('handles quarantine name collisions with -2, -3 and is repeatable', () => {
    const { ws, a } = makeWorkspace();
    const fs = ws.cloneOf(a.id);
    const dir = 'app-records/t-x/a-x';
    fs.externalWrite(`${dir}/quarantine/file.md-w1`, 'other content');
    fs.externalWrite(`${dir}/quarantine/file.md-w1-2`, 'more other content');
    fs.externalWrite(`${dir}/file.md`, 'mine');
    expect(ws.quarantine(fs, dir, 'file.md', 'w1')).toBe(`${dir}/quarantine/file.md-w1-3`);
    // Repeat after a crash between link and removal: same content already there, only the old name is removed.
    fs.externalWrite(`${dir}/file.md`, 'mine');
    expect(ws.quarantine(fs, dir, 'file.md', 'w1')).toBe(`${dir}/quarantine/file.md-w1-3`);
    expect(fs.exists(`${dir}/file.md`)).toBe(false);
  });

  it('rule (b): adopts a consistent published final-status.json when the database has no outcome', async () => {
    const { ws, a } = makeWorkspace();
    const t = makeTask(ws, a.id, 'claude');
    const at = await runToEnd(ws, t.id);
    // Simulate a database that never recorded finalizing, while the file exists.
    ws.db.transact('test:lose-finalizing', (d) => {
      const row = d.attempts.find((x) => x.id === at.id)!;
      row.finalizing = null;
      row.final = false;
      row.state = 'validating';
      d.recordFiles = d.recordFiles.filter((r) => !(r.attemptId === at.id && r.name === 'final-status.json'));
    });
    ws.recover();
    expect(ws.attempt(at.id).state).toBe('complete');
    expect(ws.attempt(at.id).final).toBe(true);
    expect(ws.recordState(at.id)).toEqual({ kind: 'intact' });
  });

  it('rule (b) refuses an inconsistent final-status.json, quarantines it and falls to (c) interrupted', async () => {
    const { ws, a } = makeWorkspace();
    const t = makeTask(ws, a.id, 'codex');
    const at = await runToEnd(ws, t.id);
    const fs = ws.cloneOf(a.id);
    const dir = attemptDir(t.id, at.id);
    ws.db.transact('test:lose-finalizing', (d) => {
      const row = d.attempts.find((x) => x.id === at.id)!;
      row.finalizing = null;
      row.final = false;
      row.state = 'validating';
      d.recordFiles = d.recordFiles.filter((r) => !(r.attemptId === at.id && r.name === 'final-status.json'));
    });
    fs.externalDelete(`${dir}/final-status.json`);
    fs.externalWrite(`${dir}/final-status.json`, JSON.stringify({ attemptId: 'a-someone-else', outcome: 'complete', files: [] }));
    ws.recover();
    expect(ws.attempt(at.id).state).toBe('interrupted');
    expect(fs.list(`${dir}/quarantine/`).some((p) => p.includes('final-status.json-unadoptable'))).toBe(true);
  });

  it('damage after completion never changes the outcome: "Complete — record damaged", before and after restart', async () => {
    const { ws, a } = makeWorkspace();
    const t = makeTask(ws, a.id, 'claude');
    const at = await runToEnd(ws, t.id);
    ws.damageRecord(at.id, '2-review.md', 'delete');
    ws.damageRecord(at.id, 'packet.md', 'alter');
    const rs = ws.recordState(at.id);
    expect(rs.kind).toBe('damaged');
    if (rs.kind === 'damaged') expect(rs.problems.map((p) => [p.file, p.kind])).toEqual([
      ['packet.md', 'mismatched'],
      ['2-review.md', 'missing'],
    ]);
    ws.recover();
    expect(ws.attempt(at.id).state).toBe('complete');
    expect(ws.recordState(at.id).kind).toBe('damaged');
  });

  it('marks queued and running attempts interrupted at once, never resuming them', async () => {
    const { ws, a, b } = makeWorkspace();
    const t1 = makeTask(ws, a.id, 'claude', { ...OK, review: 'timeout' });
    const t2 = makeTask(ws, b.id, 'codex', { ...OK, draft: 'timeout' });
    const x = start(ws, t1.id);
    const y = start(ws, t2.id);
    await new Promise((r) => setTimeout(r, 15));
    ws.crash('test');
    ws.recover();
    for (const id of [x.id, y.id]) {
      expect(ws.attempt(id).state).toBe('interrupted');
      for (const s of STAGES) expect(['confirmed', 'uncertain', 'not_prepared', 'prepared_not_dispatched']).toContain(ws.dispatchStatus(id, s));
    }
    const sent = receivedCount(ws);
    await new Promise((r) => setTimeout(r, 60));
    expect(receivedCount(ws)).toBe(sent);
  });
});
