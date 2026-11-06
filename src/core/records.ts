// Record files, required files per outcome (carried item C2), record state
// (F3, revision 7) and the F5 inventory.

import {
  OUTCOME_LABEL,
  STATE_LABEL,
  type AttemptState,
  type InventoryEntry,
  type InventoryKind,
  type Outcome,
  type RecordProblem,
  type RecordState,
} from '../shared/types.js';
import { prettyCanonicalJson, sha256 } from './hash.js';
import type { AttemptRow, RecordFileRow } from './schema.js';
import type { SimFs } from './sim-store.js';

export const FINAL_STATUS = 'final-status.json';

/** The nine record files, in publication order. */
export const ALL_RECORD_FILES = [
  'packet.md',
  'sharing-plan.json',
  '1-draft-sent.json',
  '1-draft.md',
  '2-review-sent.json',
  '2-review.md',
  '3-synthesis-sent.json',
  '3-synthesis.md',
  FINAL_STATUS,
] as const;

export function attemptDir(taskId: string, attemptId: string): string {
  return `app-records/${taskId}/${attemptId}`;
}

export function taskDir(taskId: string): string {
  return `app-records/${taskId}`;
}

/**
 * C2: the required record files for every outcome.
 *
 * - complete and needs_attention: all nine. Both outcomes need all three
 *   stage outputs published and validated.
 * - failed, cancelled and interrupted: final-status.json plus exactly the
 *   record files the finalizing transaction listed as published (its frozen
 *   file list). Stages that never ran are not required, and files whose
 *   publication failed are not required (the failure is the reason given).
 *
 * The file list is frozen when the outcome is decided, so damage found later
 * can only make the record state damaged; it never changes what is required.
 */
export function requiredFiles(outcome: Outcome, listed: readonly string[]): string[] {
  if (outcome === 'complete' || outcome === 'needs_attention') return [...ALL_RECORD_FILES];
  const set = new Set(listed);
  set.delete(FINAL_STATUS);
  return [...ALL_RECORD_FILES.filter((f) => set.has(f) && f !== FINAL_STATUS), FINAL_STATUS];
}

/** Structural check on a frozen file list: a stage output needs its -sent.json, and each stage needs the earlier ones. */
export function fileListIsConsistent(outcome: Outcome, listed: readonly string[]): string | null {
  const has = (f: string) => listed.includes(f);
  if (outcome === 'complete' || outcome === 'needs_attention') {
    const missing = ALL_RECORD_FILES.filter((f) => f !== FINAL_STATUS && !has(f));
    return missing.length ? `outcome ${outcome} requires ${missing.join(', ')}` : null;
  }
  const order = ALL_RECORD_FILES.filter((f) => f !== FINAL_STATUS);
  let gap: string | null = null;
  for (const f of order) {
    // Files are published strictly in order and a stage is prepared only after
    // the previous stage's output is published, so a gap is never valid.
    if (!has(f)) gap ??= f;
    else if (gap) return `${f} is listed but ${gap} is not`;
  }
  return null;
}

export function finalStatusBytes(input: {
  taskId: string;
  attemptId: string;
  outcome: Outcome;
  reason: string | null;
  completionLabel: string | null;
  files: { name: string; sha256: string }[];
  decidedAt: string;
}): string {
  return prettyCanonicalJson({
    file: FINAL_STATUS,
    taskId: input.taskId,
    attemptId: input.attemptId,
    outcome: input.outcome,
    reason: input.reason,
    completionLabel: input.completionLabel,
    files: input.files,
    decidedAt: input.decidedAt,
  });
}

export function quarantinedCopies(fs: SimFs, dir: string, name: string): string[] {
  return fs.list(`${dir}/quarantine/${name}-`);
}

/** Record state, recomputed every time an attempt is shown and on every start. */
export function computeRecordState(attempt: AttemptRow, fs: SimFs, rows: RecordFileRow[]): RecordState {
  const fin = attempt.finalizing;
  if (!fin) return { kind: 'running' };
  const dir = attemptDir(attempt.taskId, attempt.id);
  const problems: RecordProblem[] = [];
  const expected = new Map(fin.files.map((f) => [f.name, f.sha256]));
  expected.set(FINAL_STATUS, fin.finalStatusHash);
  for (const name of requiredFiles(fin.outcome, fin.files.map((f) => f.name))) {
    const path = `${dir}/${name}`;
    const want = expected.get(name);
    const have = fs.hash(path);
    if (have === undefined) {
      if (name === FINAL_STATUS && !attempt.final) {
        const row = rows.find((r) => r.attemptId === attempt.id && r.name === FINAL_STATUS);
        problems.push({
          file: name,
          path,
          kind: 'final-status-not-on-disk',
          detail: `final-status file not on disk${row?.error ? `: ${row.error}` : ''}. The outcome stays as recorded; publishing is retried on every start.`,
        });
      } else if (quarantinedCopies(fs, dir, name).length) {
        problems.push({ file: name, path, kind: 'quarantined', detail: 'moved to quarantine; not a valid record' });
      } else {
        problems.push({ file: name, path, kind: 'missing', detail: 'file is missing' });
      }
    } else if (want !== undefined && have !== want) {
      problems.push({ file: name, path, kind: 'mismatched', detail: `content does not match the recorded hash ${want.slice(0, 12)}…` });
    }
  }
  return problems.length ? { kind: 'damaged', problems } : { kind: 'intact' };
}

/** The single line shown for an attempt: outcome and record state together. */
export function displayLine(state: AttemptState, outcome: Outcome | null, completionLabel: string | null, record: RecordState): string {
  if (!outcome) return STATE_LABEL[state];
  if (record.kind === 'damaged') return `${OUTCOME_LABEL[outcome]} — record damaged`;
  if (outcome === 'complete' && completionLabel) return completionLabel;
  return OUTCOME_LABEL[outcome];
}

export const INVENTORY_WARNING =
  'Once you commit and push these files, everyone with access to the repository can read them, and so can connected tools (ChatGPT and the Claude app through their GitHub connectors). Git history keeps them even if they are deleted later. The app pushes nothing.';

const HOLDS: Record<string, string> = {
  'packet.md': 'The brief, instructions, frozen roles and the full text of every selected source.',
  'sharing-plan.json': 'Only the sharing that was approved and the hash of P, with no source text.',
  '1-draft-sent.json': 'Prepared payload and dispatch intent for the draft stage: provider, adapter version and hashes, with no content. Not proof of delivery.',
  '2-review-sent.json': 'Prepared payload and dispatch intent for the review stage: provider, adapter version and hashes, with no content. Not proof of delivery.',
  '3-synthesis-sent.json': 'Prepared payload and dispatch intent for the synthesis stage: provider, adapter version and hashes, with no content. Not proof of delivery.',
  '1-draft.md': "The drafter's validated output.",
  '2-review.md': "The reviewer's validated output.",
  '3-synthesis.md': "The drafter's validated synthesis.",
  [FINAL_STATUS]: 'The outcome and the file list.',
};

export function classify(path: string): { kind: InventoryKind; attemptId: string | null; holds: string; flag: string | null } {
  const parts = path.split('/');
  // app-records/<task>/<attempt or outside>/...
  const group = parts[2] ?? '';
  const rest = parts.slice(3);
  const name = rest[rest.length - 1] ?? '';
  const isOutside = group === 'outside';
  const attemptId = isOutside ? null : group;
  if (rest[0] === 'quarantine') {
    return { kind: 'quarantine', attemptId, holds: 'Content moved here during recovery.', flag: 'Quarantine: not a valid record' };
  }
  if (name.startsWith('.tmp-')) {
    return { kind: 'temporary-leftover', attemptId, holds: 'A temporary write left over by an interrupted publication.', flag: 'Temporary leftover: not a valid record' };
  }
  if (isOutside) {
    return { kind: 'outside-review', attemptId: null, holds: 'The pasted text of an outside review.', flag: 'Pasted by Ahmed; source not verified by the app' };
  }
  return { kind: 'record', attemptId, holds: HOLDS[name] ?? 'Unknown file.', flag: HOLDS[name] ? null : 'Not a known record file' };
}

export function inventoryEntries(fs: SimFs, taskId: string): InventoryEntry[] {
  return fs.list(`${taskDir(taskId)}/`).map((path) => {
    const c = classify(path);
    return { path, ...c, bytes: Buffer.byteLength(fs.read(path) ?? '', 'utf8') };
  });
}

export function hashOf(text: string): string {
  return sha256(text);
}
