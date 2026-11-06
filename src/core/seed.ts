// Fictional starting data so every state can be clicked through straight
// away. Each showcase task is produced by running the real (simulated)
// engine, not by writing view data by hand.

import { DEFAULT_DRAFTER, type Provider } from '../shared/types.js';
import { Workspace, type EngineTiming } from './engine.js';
import { scenarioById } from './fixtures.js';

export const SEED_TIMING: EngineTiming = {
  responseMs: 1,
  lateResultMs: 30,
  stageTimeoutMs: 40,
  attemptLimitMs: 5000,
  cancelGraceMs: 20,
};

interface Showcase {
  title: string;
  scenarioId: string;
  drafter?: Provider;
  project: 'A' | 'B';
  /** Cancel while the review is running. */
  cancelDuringReview?: boolean;
  damage?: { file: string; mode: 'delete' | 'alter' };
  /** Run nothing: only create the task so its sharing screen shows. */
  noRun?: boolean;
}

const SHOWCASES: Showcase[] = [
  { title: 'Example: made-up task, not started yet', scenarioId: 'success-issues', project: 'A', noRun: true },
  { title: 'Example: complete, unresolved issues remain', scenarioId: 'success-issues', project: 'A' },
  { title: 'Example: complete, no issues reported', scenarioId: 'success-clean', project: 'A' },
  { title: 'Example: needs attention (unmet criterion)', scenarioId: 'unmet-criteria', project: 'A' },
  { title: 'Example: failed (reviewer process fails)', scenarioId: 'review-fails', project: 'A' },
  { title: 'Example: failed (synthesis omits a finding)', scenarioId: 'synthesis-omits', project: 'A' },
  // Recovery after this crash marks anything still running as interrupted, so it runs before the cancellation showcases.
  { title: 'Example: interrupted (app crash after review dispatch)', scenarioId: 'crash-review-dispatched', project: 'A' },
  { title: 'Example: cancelled by the user', scenarioId: 'slow-review', project: 'A', cancelDuringReview: true },
  { title: 'Example: cancellation unconfirmed', scenarioId: 'hang-ignore-cancel', project: 'A', cancelDuringReview: true },
  { title: 'Example: Complete — record damaged', scenarioId: 'success-issues', project: 'A', damage: { file: '2-review.md', mode: 'delete' } },
  { title: 'Example: final-status.json not on disk', scenarioId: 'final-status-fails', project: 'A' },
  { title: 'Example: Codex drafts, Claude reviews', scenarioId: 'success-issues', drafter: 'codex', project: 'B' },
];

/** Registers the two fictional projects and runs the showcase tasks. */
export async function seedWorkspace(ws: Workspace): Promise<void> {
  const a = ws.registerProject({ folderId: 'folder-a', business: 'fictional-a', name: 'Example Project A', repoConfirmed: true });
  const b = ws.registerProject({ folderId: 'folder-b', business: 'fictional-b', name: 'Example Project B', repoConfirmed: true });
  const saved = ws.options.timing;
  ws.setTiming(SEED_TIMING);
  try {
    let n = 0;
    for (const s of SHOWCASES) {
      const project = s.project === 'A' ? a : b;
      const preset = scenarioById(s.scenarioId)!;
      const task = ws.createTask({
        projectId: project.id,
        title: s.title,
        brief: 'Example brief for a made-up task: write one short placeholder paragraph about an imaginary product.',
        acceptanceCriteria: ['Example criterion: one short paragraph', 'Example criterion: names its assumption'],
        sourceIds: ws.sourcesOf(project.id).slice(0, 1).map((x) => x.sourceId),
        drafter: s.drafter ?? DEFAULT_DRAFTER,
        scenarioId: s.scenarioId,
        scenario: preset.scenario,
      });
      if (s.noRun) continue;
      const attempt = ws.startAttempt({ taskId: task.id, approvedPacketHash: task.packetHash, idempotencyKey: `seed-${++n}`, acknowledgePriorStopped: false });
      if (s.cancelDuringReview) {
        await waitFor(() => ws.attempt(attempt.id).state === 'reviewing' && ws.dispatchStatus(attempt.id, 'review') !== 'not_prepared');
        await new Promise((r) => setTimeout(r, 5));
        ws.cancelAttempt(attempt.id);
      }
      await ws.settled(attempt.id);
      if (ws.crashedAt) ws.recover();
      if (s.damage) ws.damageRecord(attempt.id, s.damage.file, s.damage.mode);
    }
    // Let late results from the cancelled showcases arrive.
    await new Promise((r) => setTimeout(r, SEED_TIMING.lateResultMs * 2));
  } finally {
    ws.setTiming(saved);
  }
  ws.events.length = 0;
  ws.note('Started with two fictional projects and example tasks in every state. Nothing here is real.');
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('seed: condition not reached');
    await new Promise((r) => setTimeout(r, 1));
  }
}
