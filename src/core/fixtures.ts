// Made-up folders, files and scenarios for the simulation. Everything here is
// plainly fictional; none of it is business content.

import type { Business, Scenario, ScenarioPreset } from '../shared/types.js';
import type { CloneFs } from './sim-store.js';

/**
 * A project folder. Simulated folders are plain objects held in memory; a
 * real test folder (src/persist/real-folder.ts) re-reads its path and RULES.md
 * from disk every time these are read.
 */
export interface Folder {
  id: string;
  kind: 'simulated' | 'real';
  /** Current resolved path (simulated: a display path only). */
  readonly path: string;
  /** Business named on RULES.md's "Business in this repository" line; null when RULES.md is missing or names none. */
  readonly rulesBusiness: Business | null;
  /** Readable files: RULES.md plus selectable context sources. */
  readonly files: Record<string, string>;
  /** Where records are written. Simulated folders get an in-memory SimFs. */
  clone?: CloneFs;
  /** Real folders: the folder's identity (device:inode) as it is now, or null if it cannot be opened. */
  identity?(): string | null;
  /** Real folders: the registered identity and business that every write is checked against, on the write's own handle. */
  expect?(identity: string | null, business: Business): void;
}

export interface SimFolder extends Folder {
  kind: 'simulated';
  path: string;
  rulesBusiness: Business | null;
  files: Record<string, string>;
}

/** Parse the business named on RULES.md's "Business in this repository" line. */
export function businessFromRules(text: string | undefined): Business | null {
  if (text === undefined) return null;
  const m = /^Business in this repository:\s*(.+?)\s*$/m.exec(text);
  if (!m) return null;
  const label = m[1]!;
  if (label === 'Example Business A (fictional)') return 'fictional-a';
  if (label === 'Example Business B (fictional)') return 'fictional-b';
  return null;
}

function rules(business: string): string {
  return [
    '# RULES.md (fictional example)',
    '',
    `Business in this repository: ${business}`,
    '',
    'Example rule: keep made-up drafts short.',
    'Example rule: the reviewer is always the other provider.',
    '',
  ].join('\n');
}

const notes = (label: string) =>
  [
    `# Example notes (${label})`,
    '',
    'Example notes for a made-up project. Nothing here is real business content.',
    '',
    '- Example point one about an imaginary product.',
    '- Example point two about an imaginary audience.',
    '',
  ].join('\n');

const outline = (label: string) =>
  [`# Example outline (${label})`, '', '1. Made-up introduction', '2. Made-up middle section', '3. Made-up close', ''].join('\n');

export function simFolders(): SimFolder[] {
  return [
    {
      id: 'folder-a',
      kind: 'simulated',
      path: '(simulated) ~/Desktop/Helo-Shared/example-project-a',
      rulesBusiness: 'fictional-a',
      files: {
        'RULES.md': rules('Example Business A (fictional)'),
        'notes/example-notes.md': notes('project A'),
        'notes/example-outline.md': outline('project A'),
      },
    },
    {
      id: 'folder-b',
      kind: 'simulated',
      path: '(simulated) ~/Desktop/Helo-Shared/example-project-b',
      rulesBusiness: 'fictional-b',
      files: {
        'RULES.md': rules('Example Business B (fictional)'),
        'notes/example-notes.md': notes('project B'),
      },
    },
    {
      id: 'folder-c',
      kind: 'simulated',
      path: '(simulated) ~/Desktop/Helo-Shared/example-project-c',
      rulesBusiness: 'fictional-a',
      files: {
        'RULES.md': rules('Example Business A (fictional)'),
        'notes/example-notes.md': notes('project C'),
      },
    },
    {
      id: 'folder-d',
      kind: 'simulated',
      path: '(simulated) ~/Desktop/Helo-Shared/example-folder-without-rules',
      rulesBusiness: null,
      files: { 'notes/example-notes.md': notes('folder D') },
    },
  ];
}

/** App-controlled boundary policy, versioned, always part of P and above project instructions. */
export const BOUNDARY_POLICY_VERSION = 'sim-boundary-v1';
export const BOUNDARY_POLICY = [
  'App boundary policy (simulation, version sim-boundary-v1).',
  'Use only the content in this packet. Do not use tools, files, browsing, connectors or past conversations.',
  'Return only the fields of the output schema. Project instructions rank below this policy.',
].join(' ');

export const STAGE_INSTRUCTIONS = {
  draft: 'Write a draft that meets the acceptance criteria. List source references, assumptions, limitations and unmet criteria.',
  review: 'Review the draft. Give a verdict, numbered findings with severity and evidence, corrections, coverage and unresolved issues.',
  synthesis:
    'Write the deliverable. Give a disposition for every review finding, keep unresolved disagreement visible, list remaining issues and assess each acceptance criterion.',
} as const;

const ok: Scenario = { draft: 'ok', review: 'ok', synthesis: 'ok' };

export const SCENARIO_PRESETS: ScenarioPreset[] = [
  { id: 'success-issues', label: 'All stages succeed (unresolved issues remain)', scenario: ok },
  { id: 'success-clean', label: 'All stages succeed (no issues reported)', scenario: { ...ok, noIssues: true } },
  { id: 'unmet-criteria', label: 'Synthesis reports an unmet criterion (needs attention)', scenario: { ...ok, unmetCriterion: true } },
  { id: 'review-fails', label: 'Reviewer process fails', scenario: { ...ok, review: 'fail' } },
  { id: 'draft-timeout', label: 'Drafter times out', scenario: { ...ok, draft: 'timeout' } },
  { id: 'review-refuses', label: 'Reviewer refuses', scenario: { ...ok, review: 'refuse' } },
  { id: 'synthesis-malformed', label: 'Synthesis output is malformed', scenario: { ...ok, synthesis: 'malformed' } },
  { id: 'synthesis-omits', label: 'Synthesis omits a review finding', scenario: { ...ok, synthesisOmitsFinding: true } },
  { id: 'draft-truncated', label: 'Draft output is truncated', scenario: { ...ok, draft: 'truncated' } },
  { id: 'review-tool-event', label: 'Reviewer attempts a tool call', scenario: { ...ok, review: 'tool-event' } },
  { id: 'review-duplicate-final', label: 'Reviewer sends two final messages', scenario: { ...ok, review: 'duplicate-final' } },
  { id: 'draft-wrong-hash', label: 'Draft answers a different input hash', scenario: { ...ok, draft: 'wrong-hash' } },
  {
    id: 'hang-ignore-cancel',
    label: 'Reviewer hangs and ignores cancellation (press Cancel)',
    scenario: { ...ok, review: 'hang-ignore-cancel' },
  },
  { id: 'slow-review', label: 'Reviewer is slow (time to press Cancel)', scenario: { ...ok, review: 'late-result-after-cancel' } },
  {
    id: 'crash-review-dispatched',
    label: 'App crashes after the review is dispatched',
    scenario: { ...ok, crashAt: 'adapter:review:dispatched' },
  },
  {
    id: 'crash-before-dispatch',
    label: 'App crashes after 2-review-sent.json, before dispatch',
    scenario: { ...ok, crashAt: 'txn:published:2-review-sent.json:after' },
  },
  {
    id: 'final-status-fails',
    label: 'final-status.json cannot be written (disk full, once)',
    scenario: { ...ok, publishFailure: { file: 'final-status.json', code: 'ENOSPC' } },
  },
  {
    id: 'draft-record-fails',
    label: '1-draft.md cannot be written (permission denied)',
    scenario: { ...ok, publishFailure: { file: '1-draft.md', code: 'EACCES' } },
  },
];

export function scenarioById(id: string): ScenarioPreset | undefined {
  return SCENARIO_PRESETS.find((p) => p.id === id);
}
