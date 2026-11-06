// C2 (required record files per outcome) and the F5 inventory.

import { describe, expect, it } from 'vitest';
import { ALL_RECORD_FILES, attemptDir, fileListIsConsistent, inventoryEntries, requiredFiles } from '../../src/core/records.js';
import { Service } from '../../src/core/service.js';
import { BOTH, makeTask, makeWorkspace, OK, runToEnd, start, waitFor } from './helpers.js';

describe('C2: required record files for every outcome', () => {
  it('complete and needs attention require all nine', () => {
    expect(requiredFiles('complete', [])).toEqual([...ALL_RECORD_FILES]);
    expect(requiredFiles('needs_attention', [])).toEqual([...ALL_RECORD_FILES]);
  });

  it('failed, cancelled and interrupted require final-status.json plus exactly the frozen list', () => {
    const listed = ['packet.md', 'sharing-plan.json', '1-draft-sent.json'];
    for (const o of ['failed', 'cancelled', 'interrupted'] as const) {
      expect(requiredFiles(o, listed)).toEqual([...listed, 'final-status.json']);
      expect(requiredFiles(o, [])).toEqual(['final-status.json']);
    }
  });

  it('rejects inconsistent lists (a gap, or complete without every stage)', () => {
    expect(fileListIsConsistent('failed', ['packet.md', '1-draft-sent.json'])).toMatch(/sharing-plan\.json is not/);
    expect(fileListIsConsistent('complete', ['packet.md'])).toMatch(/requires/);
    expect(fileListIsConsistent('interrupted', ['packet.md', 'sharing-plan.json'])).toBeNull();
  });

  it.each(BOTH)('each real outcome publishes exactly its required files (%s drafting)', async (drafter) => {
    const cases = [
      [OK, 'complete', 9],
      [{ ...OK, unmetCriterion: true }, 'needs_attention', 9],
      [{ ...OK, draft: 'fail' as const }, 'failed', 4],
      [{ ...OK, review: 'refuse' as const }, 'failed', 6],
      [{ ...OK, synthesis: 'malformed' as const }, 'failed', 8],
      [{ ...OK, crashAt: 'adapter:synthesis:dispatched' }, 'interrupted', 8],
    ] as const;
    for (const [scenario, outcome, count] of cases) {
      const { ws, a } = makeWorkspace();
      const t = makeTask(ws, a.id, drafter, scenario);
      const at = await runToEnd(ws, t.id);
      if (ws.crashedAt) ws.recover();
      const row = ws.attempt(at.id);
      expect(row.state).toBe(outcome);
      const fin = row.finalizing!;
      const required = requiredFiles(fin.outcome, fin.files.map((f) => f.name));
      expect(required).toHaveLength(count);
      const onDisk = ws
        .cloneOf(a.id)
        .list(`${attemptDir(t.id, at.id)}/`)
        .map((p) => p.split('/').pop());
      expect(onDisk.sort()).toEqual([...required].sort());
      expect(ws.recordState(at.id)).toEqual({ kind: 'intact' });
    }
  });

  it('a cancelled attempt requires what was published before cancellation', async () => {
    const { ws, a } = makeWorkspace();
    const t = makeTask(ws, a.id, 'claude', { ...OK, draft: 'timeout' });
    const at = start(ws, t.id);
    await waitFor(() => ws.dispatchStatus(at.id, 'draft') === 'confirmed');
    ws.cancelAttempt(at.id);
    await ws.settled(at.id);
    const fin = ws.attempt(at.id).finalizing!;
    expect(fin.outcome).toBe('cancelled');
    expect(requiredFiles(fin.outcome, fin.files.map((f) => f.name))).toEqual(['packet.md', 'sharing-plan.json', '1-draft-sent.json', 'final-status.json']);
  });
});

describe('F5 inventory', () => {
  it('lists record files, outside reviews, temporary leftovers and quarantine content exactly, with full paths', async () => {
    const { ws, a } = makeWorkspace();
    const t = makeTask(ws, a.id, 'claude');
    const done = await runToEnd(ws, t.id);
    ws.saveOutsideReview({ taskId: t.id, source: 'chatgpt', text: 'Example outside review, made up.' });
    // A crash mid-publication of a second attempt leaves a temporary file; recovery quarantines it.
    ws.hooks.arm('publish:1-draft.md:tmp-written');
    const second = start(ws, t.id);
    await ws.settled(second.id);
    const fs = ws.cloneOf(a.id);
    const leftover = fs.list(`${attemptDir(t.id, second.id)}/.tmp-`);
    expect(leftover).toHaveLength(1);
    let entries = inventoryEntries(fs, t.id);
    expect(entries.filter((e) => e.kind === 'temporary-leftover').map((e) => e.path)).toEqual(leftover);
    ws.recover();
    entries = inventoryEntries(fs, t.id);
    const by = (k: string) => entries.filter((e) => e.kind === k);
    expect(by('record').filter((e) => e.attemptId === done.id)).toHaveLength(9);
    expect(by('outside-review')).toHaveLength(1);
    expect(by('outside-review')[0]!.flag).toBe('Pasted by Ahmed; source not verified by the app');
    expect(by('temporary-leftover')).toHaveLength(0);
    expect(by('quarantine')).toHaveLength(1);
    expect(by('quarantine')[0]!.flag).toBe('Quarantine: not a valid record');
    expect(entries.every((e) => e.path.startsWith(`app-records/${t.id}/`))).toBe(true);
    expect(entries.length).toBe(fs.list(`app-records/${t.id}/`).length);
    const sent = by('record').find((e) => e.path.endsWith('2-review-sent.json'))!;
    expect(sent.holds).toMatch(/Prepared payload and dispatch intent/);
    const svc = new Service(ws);
    const inv = await svc.getInventory({ taskId: t.id });
    expect(inv.ok && inv.value.warning).toMatch(/everyone with access to the repository can read them/);
    expect(inv.ok && inv.value.warning).toMatch(/The app pushes nothing/);
    expect(inv.ok && inv.value.attempts.map((x) => x.recordState.kind)).toEqual(['intact', 'intact']);
  });
});
