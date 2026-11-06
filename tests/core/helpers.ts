import { Workspace, type EngineTiming } from '../../src/core/engine.js';
import { scenarioById } from '../../src/core/fixtures.js';
import { CrashHooks } from '../../src/core/sim-store.js';
import type { Provider, Scenario } from '../../src/shared/types.js';

export const FAST: EngineTiming = { responseMs: 1, lateResultMs: 25, stageTimeoutMs: 40, attemptLimitMs: 5000, cancelGraceMs: 15 };

export function makeWorkspace(timing: EngineTiming = FAST, hooks = new CrashHooks()) {
  const ws = new Workspace({ timing, hooks });
  const a = ws.registerProject({ folderId: 'folder-a', business: 'fictional-a', name: 'Test Project A', repoConfirmed: true });
  const b = ws.registerProject({ folderId: 'folder-b', business: 'fictional-b', name: 'Test Project B', repoConfirmed: true });
  return { ws, a, b, hooks };
}

export const OK: Scenario = { draft: 'ok', review: 'ok', synthesis: 'ok' };

export function makeTask(ws: Workspace, projectId: string, drafter: Provider, scenario: Scenario | string = OK) {
  const sc = typeof scenario === 'string' ? scenarioById(scenario)!.scenario : scenario;
  return ws.createTask({
    projectId,
    title: 'Made-up test task',
    brief: 'Example brief for a made-up test task.',
    acceptanceCriteria: ['Example criterion one', 'Example criterion two'],
    sourceIds: ws.sourcesOf(projectId).map((s) => s.sourceId),
    drafter,
    scenarioId: typeof scenario === 'string' ? scenario : 'success-issues',
    scenario: sc,
  });
}

let key = 0;
export function start(ws: Workspace, taskId: string, ack = false) {
  const t = ws.task(taskId);
  return ws.startAttempt({ taskId, approvedPacketHash: t.packetHash, idempotencyKey: `k-${++key}`, acknowledgePriorStopped: ack });
}

export async function runToEnd(ws: Workspace, taskId: string) {
  const a = start(ws, taskId);
  await ws.settled(a.id);
  return ws.attempt(a.id);
}

export async function waitFor(cond: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 1));
  }
}

export const BOTH: Provider[] = ['claude', 'codex'];
