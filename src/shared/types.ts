// Shared domain types. Type-only imports from the renderer; runtime helpers here
// are tiny pure functions with no Node or DOM dependency.

export const SIMULATION_BANNER = 'SIMULATION: no real AI calls';

export type Provider = 'claude' | 'codex';

export const PROVIDER_LABEL: Record<Provider, string> = {
  claude: 'Anthropic (Claude)',
  codex: 'OpenAI (Codex)',
};

export const PROVIDER_SHORT: Record<Provider, string> = {
  claude: 'Claude',
  codex: 'Codex',
};

export function otherProvider(p: Provider): Provider {
  return p === 'claude' ? 'codex' : 'claude';
}

/** Default role order (brief): Claude drafts, Codex reviews, Claude writes the synthesis. */
export const DEFAULT_DRAFTER: Provider = 'claude';

export interface Roles {
  drafter: Provider;
  reviewer: Provider;
  synthesizer: Provider;
}

export function rolesFor(drafter: Provider): Roles {
  return { drafter, reviewer: otherProvider(drafter), synthesizer: drafter };
}

export type StageName = 'draft' | 'review' | 'synthesis';
export const STAGES: readonly StageName[] = ['draft', 'review', 'synthesis'];
export const STAGE_NUMBER: Record<StageName, 1 | 2 | 3> = { draft: 1, review: 2, synthesis: 3 };
export const STAGE_TITLE: Record<StageName, string> = { draft: 'Draft', review: 'Review', synthesis: 'Synthesis' };

/** The attempt's fixed outcome (F3). Decided once in the finalizing transaction. */
export type Outcome = 'complete' | 'needs_attention' | 'failed' | 'cancelled' | 'interrupted';

/**
 * Attempt state machine (plan "Task lifecycle" plus carried item C2).
 * Terminal states equal the outcome.
 */
export type AttemptState =
  | 'queued'
  | 'drafting'
  | 'reviewing'
  | 'synthesizing'
  | 'validating'
  | 'cancelling'
  | 'cancellation_unconfirmed'
  | Outcome;

export const OUTCOME_LABEL: Record<Outcome, string> = {
  complete: 'Complete',
  needs_attention: 'Needs attention',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};

export const STATE_LABEL: Record<AttemptState, string> = {
  queued: 'Queued',
  drafting: 'Drafting',
  reviewing: 'Reviewing',
  synthesizing: 'Writing synthesis',
  validating: 'Validating',
  cancelling: 'Cancelling',
  cancellation_unconfirmed: 'Cancellation unconfirmed',
  ...OUTCOME_LABEL,
};

export type RecordProblemKind = 'missing' | 'mismatched' | 'quarantined' | 'final-status-not-on-disk';

export interface RecordProblem {
  file: string;
  path: string;
  kind: RecordProblemKind;
  detail: string;
}

export type RecordState =
  | { kind: 'running' }
  | { kind: 'intact' }
  | { kind: 'damaged'; problems: RecordProblem[] }
  /** The attempt's files cannot be read right now (an unreadable folder, a disk error). The outcome still shows, from the store. */
  | { kind: 'unchecked'; path: string; error: string };

/** Carried item C3: dispatch status, from the dispatch journal, shown separately from the -sent.json file. */
export type DispatchStatus = 'not_prepared' | 'prepared_not_dispatched' | 'uncertain' | 'confirmed';

export const DISPATCH_LABEL: Record<DispatchStatus, string> = {
  not_prepared: 'Not prepared',
  prepared_not_dispatched: 'Payload prepared; not dispatched',
  uncertain: 'Dispatch uncertain',
  confirmed: 'Dispatch confirmed',
};

export type Business = 'fictional-a' | 'fictional-b';
export const BUSINESS_LABEL: Record<Business, string> = {
  'fictional-a': 'Example Business A (fictional)',
  'fictional-b': 'Example Business B (fictional)',
};

// ---------- simulation controls ----------

export type StageBehaviour =
  | 'ok'
  | 'fail'
  | 'timeout'
  | 'refuse'
  | 'malformed'
  | 'empty'
  | 'duplicate-final'
  | 'missing-final'
  | 'wrong-hash'
  | 'tool-event'
  | 'truncated'
  | 'wrong-provenance'
  | 'hang-ignore-cancel'
  | 'late-result-after-cancel';

export interface Scenario {
  draft: StageBehaviour;
  review: StageBehaviour;
  synthesis: StageBehaviour;
  /** Review returns no findings and synthesis reports no remaining issues. */
  noIssues?: boolean;
  /** Synthesis leaves out the disposition of one review finding. */
  synthesisOmitsFinding?: boolean;
  /** Synthesis marks one acceptance criterion as unmet. */
  unmetCriterion?: boolean;
  /** Simulated app crash at a named boundary (see the crash-point list in core/sim-store.ts). */
  crashAt?: string;
  /** Simulated disk failure when publishing a named record file. */
  publishFailure?: { file: string; code: 'ENOSPC' | 'EACCES' };
}

export interface ScenarioPreset {
  id: string;
  label: string;
  scenario: Scenario;
}

// ---------- view models sent to the renderer ----------

export interface SimFolderView {
  id: string;
  path: string;
  /** null: the folder has no RULES.md. */
  rulesBusiness: Business | null;
  files: { path: string; bytes: number }[];
}

export interface SwapBlockView {
  detectedAt: string;
  folder: string;
  sourceName: string;
  destinationName: string;
  movedBack: boolean;
  during: 'record' | 'quarantine' | 'outside-review';
  advice: string;
  error: string;
}

export interface ProjectView {
  id: string;
  name: string;
  business: Business;
  folder: string;
  repoConfirmed: boolean;
  archived: boolean;
  instructions: string;
  sources: { sourceId: string; path: string; bytes: number }[];
  blocked: string | null;
  /** A real folder registered by an older version, waiting for Ahmed to confirm it. */
  identityUnconfirmed: boolean;
  /** Plan revision 9: a detected swap blocks the project until Ahmed chooses "I have checked this folder". */
  swapBlock: SwapBlockView | null;
  /** How many swap blocks were lifted before, each recorded. */
  swapBlocksLifted: number;
  taskCount: number;
}

export interface TaskSummary {
  id: string;
  title: string;
  drafter: Provider;
  createdAt: string;
  latest: { attemptId: string; state: AttemptState; recordState: RecordState; display: string } | null;
}

export interface StageView {
  stage: StageName;
  provider: Provider;
  providerLabel: string;
  dispatch: DispatchStatus;
  /** Dispatched, and never known to have stopped (no result, no confirmed exit, no explicit resolution). */
  activityUnresolved: boolean;
  sentFile: string;
  outputFile: string;
  payloadHash: string | null;
  /** Validated output only. Rejected output is never shown as a result or forwarded. */
  output: StageOutputView | null;
  rejection: string | null;
  requestedModel: string | null;
  reportedProvider: string | null;
  reportedModel: string | null;
}

export type StageOutputView =
  | { kind: 'draft'; draft: string; sourceRefs: string[]; assumptions: string[]; limitations: string[]; unmetCriteria: string[] }
  | {
      kind: 'review';
      verdict: string;
      findings: { id: string; severity: string; evidence: string; text: string }[];
      corrections: string[];
      coverage: string;
      unresolved: string[];
    }
  | {
      kind: 'synthesis';
      deliverable: string;
      dispositions: { findingId: string; disposition: string; note: string }[];
      remainingIssues: string[];
      criteriaAssessment: { criterion: string; met: boolean; note: string }[];
    };

export interface AttemptView {
  id: string;
  number: number;
  state: AttemptState;
  outcome: Outcome | null;
  /** "Complete — record damaged", "Workflow complete — unresolved issues remain", etc. */
  display: string;
  completionLabel: string | null;
  reason: string | null;
  recordState: RecordState;
  finalStatusOnDisk: boolean;
  stages: StageView[];
  lateResults: { stage: StageName; note: string }[];
  canCancel: boolean;
  canResolveCancellation: boolean;
  /** Start-up recovery could not fully check this attempt; it is not settled yet. */
  recoveryPending: string | null;
  startedAt: string;
  usage: string;
}

export interface SharingStep {
  order: 1 | 2 | 3;
  stage: StageName;
  provider: Provider;
  providerLabel: string;
  receives: string;
}

export interface SharingPlanView {
  packetHash: string;
  roles: Roles;
  steps: SharingStep[];
  sentence: string;
}

export interface TaskView {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  brief: string;
  acceptanceCriteria: string[];
  roles: Roles;
  sources: { sourceId: string; displayName: string; sha256: string; bytes: number }[];
  packetHash: string;
  sharing: SharingPlanView;
  scenarioLabel: string;
  attempts: AttemptView[];
  outsideReviews: OutsideReviewView[];
  canStartAttempt: boolean;
  startBlockedReason: string | null;
  needsStopAcknowledgement: boolean;
}

export interface OutsideReviewView {
  saveId: string;
  number: number | null;
  source: 'chatgpt' | 'claude-app';
  state: 'intended' | 'published' | 'not_saved' | 'damaged';
  path: string | null;
  text: string | null;
  note: string | null;
}

export type InventoryKind = 'record' | 'outside-review' | 'temporary-leftover' | 'quarantine' | 'not-a-file' | 'unreadable';

export interface InventoryEntry {
  path: string;
  kind: InventoryKind;
  attemptId: string | null;
  holds: string;
  flag: string | null;
  bytes: number;
}

export interface InventoryView {
  taskId: string;
  root: string;
  entries: InventoryEntry[];
  attempts: { attemptId: string; number: number; display: string; recordState: RecordState }[];
  warning: string;
}

export interface ConnectionRow {
  check: string;
  codex: string;
  claude: string;
}

export interface ConnectionView {
  providers: {
    provider: Provider;
    label: string;
    adapter: string;
    executable: string;
    signedIn: string;
    diagnostic: string;
  }[];
  checklist: ConnectionRow[];
  note: string;
}

export interface ModeView {
  mode: 'showcase' | 'persistent';
  /** Persistent mode: where the run-state store lives (the app's own data folder). */
  dataDir: string | null;
  note: string;
}

export interface EventNote {
  at: string;
  text: string;
}
