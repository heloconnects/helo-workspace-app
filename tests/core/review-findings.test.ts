// Regression tests for the findings of the independent Codex code review of
// simulated v1 (2026-11-06). Each describe block names the finding.

import { describe, expect, it } from 'vitest';
import { attemptDir } from '../../src/core/records.js';
import { BOTH, makeTask, makeWorkspace, OK, runToEnd, start, waitFor } from './helpers.js';

describe.each(BOTH)('finding 1 (High): retry after unconfirmed activity (%s drafting)', (drafter) => {
  it('cancellation unconfirmed with a confirmed dispatch → restart → interrupted still requires acknowledgement before a retry', async () => {
    const { ws, a } = makeWorkspace();
    const t = makeTask(ws, a.id, drafter, { ...OK, review: 'hang-ignore-cancel' });
    const at = start(ws, t.id);
    await waitFor(() => ws.attempt(at.id).state === 'reviewing' && ws.dispatchStatus(at.id, 'review') === 'confirmed');
    ws.cancelAttempt(at.id);
    await ws.settled(at.id);
    expect(ws.attempt(at.id).state).toBe('cancellation_unconfirmed');
    ws.crash('test');
    ws.recover();
    expect(ws.attempt(at.id).state).toBe('interrupted');
    expect(ws.dispatchStatus(at.id, 'review')).toBe('confirmed');
    // Acknowledgement of dispatch is not evidence that the activity stopped.
    expect(ws.unresolvedStages(at.id)).toEqual(['review']);
    expect(ws.needsStopAcknowledgement(t.id)).toBe(true);
    expect(() => start(ws, t.id, false)).toThrow(/may still have a provider stage running/);
    // The explicit acknowledgement is recorded as the resolution.
    ws.db.transact('test:fix-scenario', (d) => {
      d.tasks.find((x) => x.id === t.id)!.scenario = OK;
    });
    const second = start(ws, t.id, true);
    const row = ws.t.dispatch.find((d) => d.attemptId === at.id && d.stage === 'review')!;
    expect(row.endEvidence).toBe('resolved');
    expect(ws.needsStopAcknowledgement(t.id)).toBe(false);
    await ws.settled(second.id);
    expect(ws.attempt(second.id).state).toBe('complete');
  });

  it('a crash after the dispatch was confirmed but before any result also requires acknowledgement', async () => {
    const { ws, a } = makeWorkspace();
    const t = makeTask(ws, a.id, drafter, { ...OK, crashAt: 'txn:dispatch-confirmed:review:after' });
    const at = start(ws, t.id);
    await ws.settled(at.id);
    await new Promise((r) => setTimeout(r, 10));
    ws.recover();
    expect(ws.attempt(at.id).state).toBe('interrupted');
    expect(ws.dispatchStatus(at.id, 'review')).toBe('confirmed');
    expect(ws.needsStopAcknowledgement(t.id)).toBe(true);
  });

  it('does not ask when every dispatched stage ended (result, confirmed stop, or explicit resolution)', async () => {
    const { ws, a } = makeWorkspace();
    // Result: a failed stage still came back.
    const t1 = makeTask(ws, a.id, drafter, { ...OK, review: 'fail' });
    await runToEnd(ws, t1.id);
    expect(ws.needsStopAcknowledgement(t1.id)).toBe(false);
    // Confirmed stop: cancellation with a confirmed exit.
    const t2 = makeTask(ws, a.id, drafter, { ...OK, review: 'timeout' });
    const x = start(ws, t2.id);
    await waitFor(() => ws.dispatchStatus(x.id, 'review') === 'confirmed');
    ws.cancelAttempt(x.id);
    await ws.settled(x.id);
    expect(ws.attempt(x.id).state).toBe('cancelled');
    expect(ws.needsStopAcknowledgement(t2.id)).toBe(false);
    // Explicit resolution of cancellation unconfirmed.
    const t3 = makeTask(ws, a.id, drafter, { ...OK, review: 'hang-ignore-cancel' });
    const y = start(ws, t3.id);
    await waitFor(() => ws.dispatchStatus(y.id, 'review') === 'confirmed');
    ws.cancelAttempt(y.id);
    await ws.settled(y.id);
    ws.resolveCancellation(y.id);
    expect(ws.needsStopAcknowledgement(t3.id)).toBe(false);
  });
});

describe('finding 2 (Medium): recovery reconciles records already marked published', () => {
  it('quarantines a corrupted published record of a finished attempt; the outcome is unchanged and the record shows quarantined', async () => {
    const { ws, a } = makeWorkspace();
    const t = makeTask(ws, a.id, 'claude');
    const at = await runToEnd(ws, t.id);
    const fs = ws.cloneOf(a.id);
    const dir = attemptDir(t.id, at.id);
    ws.damageRecord(at.id, 'packet.md', 'alter');
    ws.recover();
    expect(fs.exists(`${dir}/packet.md`)).toBe(false);
    expect(fs.list(`${dir}/quarantine/`).some((p) => p.includes('/quarantine/packet.md-'))).toBe(true);
    expect(ws.attempt(at.id).state).toBe('complete');
    const rs = ws.recordState(at.id);
    expect(rs.kind === 'damaged' && rs.problems.map((p) => [p.file, p.kind])).toEqual([['packet.md', 'quarantined']]);
    // Repeatable.
    ws.recover();
    expect(fs.list(`${dir}/quarantine/`)).toHaveLength(1);
  });

  it('republishes a missing final-status.json of an already-final attempt with the same bytes and outcome', async () => {
    const { ws, a } = makeWorkspace();
    const t = makeTask(ws, a.id, 'codex', { ...OK, unmetCriterion: true });
    const at = await runToEnd(ws, t.id);
    const fs = ws.cloneOf(a.id);
    const path = `${attemptDir(t.id, at.id)}/final-status.json`;
    const bytes = fs.read(path);
    ws.damageRecord(at.id, 'final-status.json', 'delete');
    expect(ws.recordState(at.id).kind).toBe('damaged');
    ws.recover();
    expect(fs.read(path)).toBe(bytes);
    expect(ws.attempt(at.id).state).toBe('needs_attention');
    expect(ws.recordState(at.id)).toEqual({ kind: 'intact' });
  });

  it('a changed final-status.json of a final attempt is quarantined and replaced with the recorded bytes', async () => {
    const { ws, a } = makeWorkspace();
    const t = makeTask(ws, a.id, 'claude');
    const at = await runToEnd(ws, t.id);
    const fs = ws.cloneOf(a.id);
    const dir = attemptDir(t.id, at.id);
    ws.damageRecord(at.id, 'final-status.json', 'alter');
    ws.recover();
    expect(fs.read(`${dir}/final-status.json`)).toBe(at.finalizing!.finalStatusBytes);
    expect(fs.list(`${dir}/quarantine/`).some((p) => p.includes('/quarantine/final-status.json-'))).toBe(true);
    expect(ws.attempt(at.id).state).toBe('complete');
  });

  it('a published record corrupted while the attempt was running is quarantined and stays required (damaged, not intact)', async () => {
    const { ws, a } = makeWorkspace();
    const t = makeTask(ws, a.id, 'claude', { ...OK, crashAt: 'adapter:review:dispatched' });
    const at = start(ws, t.id);
    await ws.settled(at.id);
    const fs = ws.cloneOf(a.id);
    fs.externalWrite(`${attemptDir(t.id, at.id)}/1-draft.md`, 'changed while the app was down');
    ws.recover();
    expect(ws.attempt(at.id).state).toBe('interrupted');
    const rs = ws.recordState(at.id);
    expect(rs.kind === 'damaged' && rs.problems.map((p) => [p.file, p.kind])).toEqual([['1-draft.md', 'quarantined']]);
  });
});

describe('finding 3 (Medium): rule (b) never adopts an impossible or malformed final-status.json', () => {
  function lostOutcome(ws: ReturnType<typeof makeWorkspace>['ws'], attemptId: string) {
    ws.db.transact('test:lose-finalizing', (d) => {
      const row = d.attempts.find((x) => x.id === attemptId)!;
      row.finalizing = null;
      row.final = false;
      row.state = 'drafting';
      d.recordFiles = d.recordFiles.filter((r) => !(r.attemptId === attemptId && r.name === 'final-status.json'));
    });
  }

  it('refuses "complete" with matching IDs when the published files cannot support it', async () => {
    const { ws, a } = makeWorkspace();
    const t = makeTask(ws, a.id, 'claude', { ...OK, crashAt: 'txn:attempt-create:after' });
    let attemptId = '';
    try {
      start(ws, t.id);
    } catch {
      /* simulated crash inside the start call */
    }
    attemptId = ws.t.attempts.find((x) => x.taskId === t.id)!.id;
    const fs = ws.cloneOf(a.id);
    const dir = attemptDir(t.id, attemptId);
    fs.externalWrite(`${dir}/final-status.json`, JSON.stringify({ attemptId, taskId: t.id, outcome: 'complete', files: [] }));
    ws.recover();
    expect(ws.attempt(attemptId).state).toBe('interrupted');
    expect(fs.list(`${dir}/quarantine/`).some((p) => p.includes('final-status.json-unadoptable'))).toBe(true);
  });

  it.each([
    ['JSON null', 'null'],
    ['a list', '[]'],
    ['a null file entry', 'NULL_ENTRY'],
    ['a file entry without a hash', 'NO_HASH'],
    ['files not a list', 'FILES_OBJECT'],
    ['not JSON', '{oops'],
  ])('quarantines %s and settles interrupted without throwing', async (_label, kind) => {
    const { ws, a } = makeWorkspace();
    const t = makeTask(ws, a.id, 'codex');
    const at = await runToEnd(ws, t.id);
    lostOutcome(ws, at.id);
    const fs = ws.cloneOf(a.id);
    const dir = attemptDir(t.id, at.id);
    const ids = { attemptId: at.id, taskId: t.id, outcome: 'failed' };
    const text =
      kind === 'NULL_ENTRY'
        ? JSON.stringify({ ...ids, files: [null] })
        : kind === 'NO_HASH'
          ? JSON.stringify({ ...ids, files: [{ name: 'packet.md' }] })
          : kind === 'FILES_OBJECT'
            ? JSON.stringify({ ...ids, files: {} })
            : kind;
    fs.externalDelete(`${dir}/final-status.json`);
    fs.externalWrite(`${dir}/final-status.json`, text);
    expect(() => ws.recover()).not.toThrow();
    expect(ws.attempt(at.id).state).toBe('interrupted');
    expect(ws.attempt(at.id).final).toBe(true);
    expect(fs.list(`${dir}/quarantine/`).some((p) => p.includes('final-status.json-unadoptable'))).toBe(true);
  });
});

describe('finding 4 (Medium): project identity is rechecked before every write', () => {
  it('a RULES.md business change during a run blocks every later write; the attempt still gets exactly one outcome', async () => {
    const { ws, a } = makeWorkspace();
    const t = makeTask(ws, a.id, 'claude', { ...OK, review: 'late-result-after-cancel' });
    const at = start(ws, t.id);
    await waitFor(() => ws.attempt(at.id).state === 'reviewing' && ws.dispatchStatus(at.id, 'review') === 'confirmed');
    const fs = ws.cloneOf(a.id);
    ws.folder('folder-a').rulesBusiness = 'fictional-b';
    const before = fs.snapshot();
    await ws.settled(at.id);
    expect(fs.snapshot()).toEqual(before); // nothing written after the change
    const row = ws.attempt(at.id);
    expect(row.state).toBe('failed');
    expect(row.finalizing?.reason).toMatch(/2-review\.md could not be published: project blocked, nothing written/);
    expect(row.final).toBe(false);
    expect(() => ws.saveOutsideReview({ taskId: t.id, source: 'chatgpt', text: 'Made-up.' })).toThrow(/Not saved/);
    // Recovery settles in the database but still writes nothing into the blocked clone.
    ws.recover();
    expect(fs.snapshot()).toEqual(before);
    expect(ws.attempt(at.id).state).toBe('failed');
    // Once the folder matches again, the missing final-status.json is published on the next start.
    ws.folder('folder-a').rulesBusiness = 'fictional-a';
    ws.recover();
    expect(ws.attempt(at.id).final).toBe(true);
    expect(ws.recordState(at.id)).toEqual({ kind: 'intact' });
  });

  it('a folder path change also blocks writes', async () => {
    const { ws, a } = makeWorkspace();
    const t = makeTask(ws, a.id, 'codex');
    ws.folder('folder-a').path = '(simulated) somewhere else';
    expect(() => start(ws, t.id)).toThrow(/folder path changed/);
    expect(() => ws.saveOutsideReview({ taskId: t.id, source: 'claude-app', text: 'Made-up.' })).toThrow(/folder path changed/);
    expect(ws.cloneOf(a.id).list('')).toEqual([]);
  });
});
