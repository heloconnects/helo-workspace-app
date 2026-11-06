// Lifecycle, validation, transmission and cancellation tests. Every test runs
// in both role orders (R4).

import { describe, expect, it } from 'vitest';
import { sha256 } from '../../src/core/hash.js';
import { attemptDir } from '../../src/core/records.js';
import { otherProvider, type Scenario, type StageBehaviour } from '../../src/shared/types.js';
import { BOTH, makeTask, makeWorkspace, OK, runToEnd, start, waitFor } from './helpers.js';

describe.each(BOTH)('lifecycle with %s drafting', (drafter) => {
  const reviewer = otherProvider(drafter);

  it('completes three stages, each produced by the right provider, with unresolved issues kept', async () => {
    const { ws, a } = makeWorkspace();
    const t = makeTask(ws, a.id, drafter);
    const at = await runToEnd(ws, t.id);
    expect(at.state).toBe('complete');
    expect(at.finalizing?.completionLabel).toBe('Workflow complete — unresolved issues remain');
    expect(at.final).toBe(true);
    const arts = ws.t.artifacts.filter((x) => x.attemptId === at.id);
    expect(arts.map((x) => [x.stage, x.provider])).toEqual([
      ['draft', drafter],
      ['review', reviewer],
      ['synthesis', drafter],
    ]);
    for (const x of arts) expect(x.reportedProvider).toBe(x.provider);
    expect(ws.recordState(at.id)).toEqual({ kind: 'intact' });
  });

  it('reports "no issues reported" when the review has no findings', async () => {
    const { ws, a } = makeWorkspace();
    const at = await runToEnd(ws, makeTask(ws, a.id, drafter, { ...OK, noIssues: true }).id);
    expect(at.state).toBe('complete');
    expect(at.finalizing?.completionLabel).toBe('Workflow complete — no issues reported');
  });

  it('gives needs attention for an unmet acceptance criterion, with all nine record files', async () => {
    const { ws, a } = makeWorkspace();
    const at = await runToEnd(ws, makeTask(ws, a.id, drafter, { ...OK, unmetCriterion: true }).id);
    expect(at.state).toBe('needs_attention');
    expect(at.finalizing?.files.length).toBe(8);
    expect(ws.recordState(at.id).kind).toBe('intact');
  });

  const failures: [keyof Scenario & ('draft' | 'review' | 'synthesis'), StageBehaviour, RegExp][] = [
    ['draft', 'fail', /process exited/],
    ['review', 'fail', /process exited/],
    ['synthesis', 'fail', /process exited/],
    ['draft', 'refuse', /refused/],
    ['review', 'refuse', /refused/],
    ['synthesis', 'malformed', /not valid JSON/],
    ['draft', 'empty', /empty/],
    ['review', 'duplicate-final', /duplicate final/],
    ['review', 'missing-final', /no final message/],
    ['draft', 'wrong-hash', /input hash/],
    ['review', 'tool-event', /tool event/],
    ['draft', 'truncated', /truncated/],
    ['synthesis', 'wrong-provenance', /provenance mismatch/],
  ];

  it.each(failures)('fails cleanly when %s is %s, and never forwards rejected output', async (stage, behaviour, reason) => {
    const { ws, a } = makeWorkspace();
    const at = await runToEnd(ws, makeTask(ws, a.id, drafter, { ...OK, [stage]: behaviour }).id);
    expect(at.state).toBe('failed');
    expect(at.finalizing?.reason).toMatch(reason);
    expect(at.final).toBe(true);
    // No later stage was prepared or dispatched.
    const order = ['draft', 'review', 'synthesis'] as const;
    for (const later of order.slice(order.indexOf(stage) + 1)) {
      expect(ws.dispatchStatus(at.id, later)).toBe('not_prepared');
    }
    // Nothing produced after the failing stage was received by any adapter.
    const received = [...ws.adapters.claude.received, ...ws.adapters.codex.received].map((r) => r.stage);
    expect(received.filter((s) => order.indexOf(s) > order.indexOf(stage))).toEqual([]);
    expect(ws.recordState(at.id).kind).toBe('intact');
  });

  it('rejects a synthesis that omits a review finding', async () => {
    const { ws, a } = makeWorkspace();
    const at = await runToEnd(ws, makeTask(ws, a.id, drafter, { ...OK, synthesisOmitsFinding: true }).id);
    expect(at.state).toBe('failed');
    expect(at.finalizing?.reason).toMatch(/does not account for review finding\(s\) F1/);
  });

  it('sends exactly the R4 payloads, and each -sent.json hash matches the bytes actually sent', async () => {
    const { ws, a } = makeWorkspace();
    const t = makeTask(ws, a.id, drafter);
    const at = await runToEnd(ws, t.id);
    const received = [...ws.adapters.claude.received, ...ws.adapters.codex.received];
    const byStage = (s: string) => received.find((r) => r.stage === s)!;
    const draft = JSON.parse(byStage('draft').payload);
    const review = JSON.parse(byStage('review').payload);
    const synth = JSON.parse(byStage('synthesis').payload);
    expect(byStage('draft').provider).toBe(drafter);
    expect(byStage('review').provider).toBe(reviewer);
    expect(byStage('synthesis').provider).toBe(drafter);
    expect(draft.draft).toBeUndefined();
    expect(draft.review).toBeUndefined();
    expect(review.draft.kind).toBe('draft');
    expect(review.review).toBeUndefined();
    expect(synth.draft.kind).toBe('draft');
    expect(synth.review.kind).toBe('review');
    for (const p of [draft, review, synth]) {
      expect(p.packet.taskId).toBe(t.id);
      expect(sha256(JSON.stringify(sortedClone(p.packet)))).toBe(t.packetHash);
      // No absolute paths, credentials or debug output in what is sent.
      const text = JSON.stringify(p);
      expect(text).not.toMatch(/\/Users\/|Desktop\/Helo-Shared|stderr|password|token/i);
    }
    const fs = ws.cloneOf(a.id);
    const dir = attemptDir(t.id, at.id);
    for (const [n, s] of [
      [1, 'draft'],
      [2, 'review'],
      [3, 'synthesis'],
    ] as const) {
      const sent = JSON.parse(fs.read(`${dir}/${n}-${s}-sent.json`)!);
      expect(sent.meaning).toBe('Prepared payload and dispatch intent');
      expect(sent.payloadSha256).toBe(byStage(s).payloadHash);
      expect(sent.payloadSha256).toBe(sha256(byStage(s).payload));
      expect(sent.provider).toBe(s === 'review' ? reviewer : drafter);
      expect(JSON.stringify(sent)).not.toContain('Example notes'); // no content in -sent.json
      expect(ws.dispatchStatus(at.id, s)).toBe('confirmed');
    }
  });

  it('does not dispatch a stage whose -sent.json cannot be published', async () => {
    const { ws, a } = makeWorkspace();
    const t = makeTask(ws, a.id, drafter, { ...OK, publishFailure: { file: '2-review-sent.json', code: 'ENOSPC' } });
    const at = await runToEnd(ws, t.id);
    expect(at.state).toBe('failed');
    expect(at.finalizing?.reason).toMatch(/2-review-sent\.json could not be published: ENOSPC/);
    expect(at.finalizing?.reason).toContain(`app-records/${t.id}/${at.id}/.tmp-`);
    expect([...ws.adapters.claude.received, ...ws.adapters.codex.received].map((r) => r.stage)).toEqual(['draft']);
    expect(ws.dispatchStatus(at.id, 'review')).toBe('not_prepared');
  });

  it('fails with "collision" and replaces nothing when a record name already exists', async () => {
    const { ws, a } = makeWorkspace();
    const t = makeTask(ws, a.id, drafter);
    const fs = ws.cloneOf(a.id);
    // Another process creates the destination name after the temporary file was made.
    const openDir = fs.openDir.bind(fs);
    fs.openDir = (dir: string) => {
      const h = openDir(dir);
      const create = h.createExclusive.bind(h);
      h.createExclusive = (name: string, content: string, key?: string) => {
        create(name, content, key);
        if (key === '1-draft.md') fs.externalWrite(`${dir}/1-draft.md`, 'someone else wrote this');
      };
      return h;
    };
    const at = await runToEnd(ws, t.id);
    expect(at.state).toBe('failed');
    expect(at.finalizing?.reason).toMatch(/collision/);
    expect(fs.read(`${attemptDir(t.id, at.id)}/1-draft.md`)).toBe('someone else wrote this');
  });

  it('shows disk-full and permission failures with the path', async () => {
    const { ws, a } = makeWorkspace();
    const at = await runToEnd(ws, makeTask(ws, a.id, drafter, { ...OK, publishFailure: { file: '1-draft.md', code: 'EACCES' } }).id);
    expect(at.state).toBe('failed');
    expect(at.finalizing?.reason).toMatch(/EACCES: permission denied \(simulated\) \(app-records\//);
  });

  it('keeps the outcome when final-status.json cannot be written, and republishes it on restart', async () => {
    const { ws, a } = makeWorkspace();
    const t = makeTask(ws, a.id, drafter, { ...OK, publishFailure: { file: 'final-status.json', code: 'ENOSPC' } });
    const at = await runToEnd(ws, t.id);
    expect(at.state).toBe('complete');
    expect(at.final).toBe(false);
    const rs = ws.recordState(at.id);
    expect(rs.kind).toBe('damaged');
    expect(rs.kind === 'damaged' && rs.problems[0]!.kind).toBe('final-status-not-on-disk');
    ws.recover();
    const after = ws.attempt(at.id);
    expect(after.state).toBe('complete');
    expect(after.final).toBe(true);
    expect(ws.recordState(at.id)).toEqual({ kind: 'intact' });
    expect(ws.cloneOf(a.id).read(`${attemptDir(t.id, at.id)}/final-status.json`)).toBe(at.finalizing!.finalStatusBytes);
  });

  it('ignores a duplicate submission (same idempotency key)', async () => {
    const { ws, a } = makeWorkspace();
    const t = makeTask(ws, a.id, drafter);
    const input = { taskId: t.id, approvedPacketHash: t.packetHash, idempotencyKey: 'double-click', acknowledgePriorStopped: false };
    const first = ws.startAttempt(input);
    const second = ws.startAttempt(input);
    expect(second.id).toBe(first.id);
    await ws.settled(first.id);
    expect(ws.attemptsOf(t.id)).toHaveLength(1);
    expect(ws.adapters[drafter].received.filter((r) => r.stage === 'draft')).toHaveLength(1);
  });

  it('refuses a start whose approval does not match the frozen packet', () => {
    const { ws, a } = makeWorkspace();
    const t = makeTask(ws, a.id, drafter);
    expect(() => ws.startAttempt({ taskId: t.id, approvedPacketHash: 'x'.repeat(64), idempotencyKey: 'k', acknowledgePriorStopped: false })).toThrow(
      /does not match/,
    );
  });

  it('cancels during the review: the owned process confirms exit and the outcome is cancelled', async () => {
    const { ws, a } = makeWorkspace();
    const t = makeTask(ws, a.id, drafter, { ...OK, review: 'timeout' });
    const at = start(ws, t.id);
    await waitFor(() => ws.attempt(at.id).state === 'reviewing' && ws.dispatchStatus(at.id, 'review') === 'confirmed');
    ws.cancelAttempt(at.id);
    expect(ws.attempt(at.id).state).toBe('cancelling');
    await ws.settled(at.id);
    const after = ws.attempt(at.id);
    expect(after.state).toBe('cancelled');
    expect(after.finalizing?.files.map((f) => f.name)).toEqual(['packet.md', 'sharing-plan.json', '1-draft-sent.json', '1-draft.md', '2-review-sent.json']);
    expect(ws.recordState(at.id).kind).toBe('intact');
    expect(ws.dispatchStatus(at.id, 'synthesis')).toBe('not_prepared');
  });

  it('turns a stage timeout into failed through cancellation semantics', async () => {
    const { ws, a } = makeWorkspace();
    const at = await runToEnd(ws, makeTask(ws, a.id, drafter, { ...OK, draft: 'timeout' }).id);
    expect(at.state).toBe('failed');
    expect(at.finalizing?.reason).toMatch(/timed out/);
  });

  it('shows cancellation unconfirmed when the process ignores cancellation, blocks retry, quarantines the late result, and resolves explicitly', async () => {
    const { ws, a } = makeWorkspace();
    const t = makeTask(ws, a.id, drafter, { ...OK, review: 'hang-ignore-cancel' });
    const at = start(ws, t.id);
    await waitFor(() => ws.attempt(at.id).state === 'reviewing' && ws.dispatchStatus(at.id, 'review') === 'confirmed');
    ws.cancelAttempt(at.id);
    await ws.settled(at.id);
    expect(ws.attempt(at.id).state).toBe('cancellation_unconfirmed');
    expect(ws.attempt(at.id).finalizing).toBeNull();
    expect(ws.startBlock(t.id)).toMatch(/Cancellation unconfirmed/);
    expect(() => start(ws, t.id)).toThrow(/Cancellation unconfirmed/);
    expect(() => ws.deleteTask(t.id)).toThrow(/blocked/);
    await waitFor(() => ws.t.lateResults.some((l) => l.attemptId === at.id));
    expect(ws.t.artifacts.filter((x) => x.attemptId === at.id).map((x) => x.stage)).toEqual(['draft']); // late result never used
    ws.resolveCancellation(at.id);
    expect(ws.attempt(at.id).state).toBe('cancelled');
    expect(ws.attempt(at.id).final).toBe(true);
    expect(ws.startBlock(t.id)).toBeNull();
  });

  it('a late result after a confirmed cancel cannot change the terminal state', async () => {
    const { ws, a } = makeWorkspace();
    const t = makeTask(ws, a.id, drafter, { ...OK, review: 'late-result-after-cancel' });
    const at = start(ws, t.id);
    await waitFor(() => ws.attempt(at.id).state === 'reviewing' && ws.dispatchStatus(at.id, 'review') === 'confirmed');
    ws.cancelAttempt(at.id);
    await ws.settled(at.id);
    expect(ws.attempt(at.id).state).toBe('cancelled');
    await waitFor(() => ws.t.lateResults.some((l) => l.attemptId === at.id));
    expect(ws.attempt(at.id).state).toBe('cancelled');
  });

  it('a new attempt re-runs all three stages from the frozen packet and keeps the earlier attempt', async () => {
    const { ws, a } = makeWorkspace();
    const t = makeTask(ws, a.id, drafter, { ...OK, review: 'fail' });
    const first = await runToEnd(ws, t.id);
    expect(first.state).toBe('failed');
    ws.db.transact('test:fix-scenario', (d) => {
      d.tasks.find((x) => x.id === t.id)!.scenario = OK;
    });
    const second = await runToEnd(ws, t.id);
    expect(second.state).toBe('complete');
    expect(second.number).toBe(2);
    expect(ws.attempt(first.id).state).toBe('failed');
    const drafts = ws.adapters[drafter].received.filter((r) => r.stage === 'draft');
    expect(drafts).toHaveLength(2);
    expect(JSON.parse(drafts[0]!.payload).packet).toEqual(JSON.parse(drafts[1]!.payload).packet);
    expect(JSON.parse(drafts[1]!.payload).attemptId).toBe(second.id);
  });
});

function sortedClone(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortedClone);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, sortedClone((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}
