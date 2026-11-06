// F2 project registration and separation, F6 deletion, and the operation
// layer's input checks and ownership rules.

import { describe, expect, it } from 'vitest';
import { Workspace } from '../../src/core/engine.js';
import { Service } from '../../src/core/service.js';
import { FAST, makeTask, makeWorkspace, runToEnd, start } from './helpers.js';

describe('F2 projects', () => {
  it('refuses a second project for the same folder or the same business, a RULES.md mismatch, and a missing RULES.md', () => {
    const ws = new Workspace({ timing: FAST });
    ws.registerProject({ folderId: 'folder-a', business: 'fictional-a', name: 'A', repoConfirmed: true });
    expect(() => ws.registerProject({ folderId: 'folder-a', business: 'fictional-b', name: 'A2', repoConfirmed: true })).toThrow(/mismatch|does not match|already registered/);
    expect(() => ws.registerProject({ folderId: 'folder-c', business: 'fictional-a', name: 'C', repoConfirmed: true })).toThrow(/One project per business/);
    expect(() => ws.registerProject({ folderId: 'folder-b', business: 'fictional-a', name: 'B', repoConfirmed: true })).toThrow(/does not match/);
    expect(() => ws.registerProject({ folderId: 'folder-d', business: 'fictional-b', name: 'D', repoConfirmed: true })).toThrow(/no RULES\.md/);
    expect(() => ws.registerProject({ folderId: 'folder-b', business: 'fictional-b', name: 'B', repoConfirmed: false })).toThrow(/does not check/);
    expect(ws.registerProject({ folderId: 'folder-b', business: 'fictional-b', name: 'B', repoConfirmed: true }).repoConfirmed).toBe(true);
  });

  it('blocks a project whose RULES.md business line changed, until it is registered again', () => {
    const { ws, a } = makeWorkspace();
    const t = makeTask(ws, a.id, 'claude');
    ws.folder('folder-a').rulesBusiness = 'fictional-b';
    expect(ws.projectBlock(a.id)).toMatch(/no longer matches/);
    expect(() => start(ws, t.id)).toThrow(/no longer matches/);
    expect(() => makeTask(ws, a.id, 'claude')).toThrow(/no longer matches/);
  });

  it('archived projects cannot start tasks', () => {
    const { ws, a } = makeWorkspace();
    const t = makeTask(ws, a.id, 'claude');
    ws.archiveProject(a.id, true);
    expect(() => makeTask(ws, a.id, 'claude')).toThrow(/Archived/);
    expect(() => start(ws, t.id)).toThrow(/Archived/);
  });

  it('a task can use sources from its own project folder only', () => {
    const { ws, a, b } = makeWorkspace();
    const foreign = ws.sourcesOf(b.id)[0]!.sourceId;
    expect(() =>
      ws.createTask({ projectId: a.id, title: 'x', brief: 'x', acceptanceCriteria: ['x'], sourceIds: [foreign], drafter: 'claude', scenarioId: 'success-issues', scenario: { draft: 'ok', review: 'ok', synthesis: 'ok' } }),
    ).toThrow(/not a file in this project/);
  });

  it('keeps project records in their own clone: project A writes nothing into project B', async () => {
    const { ws, a, b } = makeWorkspace();
    const before = ws.cloneOf(b.id).snapshot();
    await runToEnd(ws, makeTask(ws, a.id, 'claude').id);
    expect(ws.cloneOf(b.id).snapshot()).toEqual(before);
    expect(ws.cloneOf(a.id).list('').every((p) => p.startsWith('app-records/'))).toBe(true);
  });
});

describe('F6 deleting', () => {
  it('removes only the app records and leaves the clone byte-for-byte unchanged', async () => {
    const { ws, a } = makeWorkspace();
    const t = makeTask(ws, a.id, 'codex');
    await runToEnd(ws, t.id);
    ws.saveOutsideReview({ taskId: t.id, source: 'chatgpt', text: 'Made-up.' });
    const clone = ws.cloneOf(a.id).snapshot();
    ws.deleteTask(t.id);
    expect(ws.t.tasks.find((x) => x.id === t.id)).toBeUndefined();
    expect(ws.t.attempts.filter((x) => x.taskId === t.id)).toEqual([]);
    expect(ws.cloneOf(a.id).snapshot()).toEqual(clone);
    ws.deleteProject(a.id);
    expect(ws.t.projects.find((p) => p.id === a.id)).toBeUndefined();
    expect(ws.clones.get('folder-a')!.snapshot()).toEqual(clone);
  });

  it('blocks deletion while an attempt is running', () => {
    const { ws, a } = makeWorkspace();
    const t = makeTask(ws, a.id, 'claude', { draft: 'timeout', review: 'ok', synthesis: 'ok' });
    start(ws, t.id);
    expect(() => ws.deleteTask(t.id)).toThrow(/blocked/);
    expect(() => ws.deleteProject(a.id)).toThrow(/blocked/);
  });
});

describe('operation layer (what the renderer can call)', () => {
  it('rejects unknown operations and malformed or oversized input', async () => {
    const { ws } = makeWorkspace();
    const svc = new Service(ws);
    expect(await svc.dispatch('runShell', {})).toEqual({ ok: false, error: 'Unknown operation.' });
    expect(await svc.dispatch('__proto__', {})).toEqual({ ok: false, error: 'Unknown operation.' });
    expect((await svc.dispatch('getTask', null)).ok).toBe(false);
    expect((await svc.dispatch('getTask', { taskId: 42 })).ok).toBe(false);
    expect((await svc.dispatch('registerProject', { folderId: 'folder-c', business: 'other', name: 'x', repoConfirmed: true })).ok).toBe(false);
    const big = 'x'.repeat(20_001);
    const r = await svc.dispatch('createTask', { projectId: 'p', title: 't', brief: big, acceptanceCriteria: [], sourceIds: [], drafter: 'claude', scenarioId: 'success-issues' });
    expect(r).toEqual({ ok: false, error: 'Rejected input: brief is longer than 20000 characters.' });
    expect((await svc.dispatch('createTask', { projectId: 'p', title: 't', brief: 'b', acceptanceCriteria: ['c'], sourceIds: [], drafter: 'gpt', scenarioId: 'success-issues' })).ok).toBe(false);
  });

  it('derives ownership from stored records: a project ID from the renderer cannot reach another project', async () => {
    const { ws, a, b } = makeWorkspace();
    const svc = new Service(ws);
    const foreign = ws.sourcesOf(b.id)[0]!.sourceId;
    const r = await svc.dispatch('createTask', {
      projectId: a.id,
      title: 't',
      brief: 'b',
      acceptanceCriteria: ['c'],
      sourceIds: [foreign],
      drafter: 'claude',
      scenarioId: 'success-issues',
    });
    expect(r.ok).toBe(false);
    const tasks = await svc.dispatch('listTasks', { projectId: b.id });
    expect(tasks).toEqual({ ok: true, value: [] });
  });

  it('refuses a drafter equal to the reviewer by construction: the reviewer is always the other provider', async () => {
    const { ws, a } = makeWorkspace();
    const svc = new Service(ws);
    for (const drafter of ['claude', 'codex'] as const) {
      const r = await svc.previewSharing({ projectId: a.id, title: 't', brief: 'b', acceptanceCriteria: ['c'], sourceIds: [], drafter, scenarioId: 'success-issues' });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.roles.reviewer).not.toBe(r.value.roles.drafter);
        expect(r.value.roles.synthesizer).toBe(drafter);
      }
    }
  });

  it('names the actual providers in order on the sharing screen, for both role orders (R4)', async () => {
    const { ws, a } = makeWorkspace();
    const svc = new Service(ws);
    const base = { projectId: a.id, title: 't', brief: 'b', acceptanceCriteria: ['c'], sourceIds: [], scenarioId: 'success-issues' };
    const c = await svc.previewSharing({ ...base, drafter: 'claude' });
    const x = await svc.previewSharing({ ...base, drafter: 'codex' });
    expect(c.ok && c.value.sentence).toBe(
      "Anthropic (Claude) receives P; OpenAI (Codex) receives P and Claude's draft; Anthropic receives P, the draft and Codex's review.",
    );
    expect(x.ok && x.value.sentence).toBe(
      "OpenAI (Codex) receives P; Anthropic (Claude) receives P and Codex's draft; OpenAI receives P, the draft and Claude's review.",
    );
  });
});
