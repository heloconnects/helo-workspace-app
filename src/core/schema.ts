// Tables of the simulated SQLite store. Run state, manifests and hashes.

import type { AttemptState, Business, Outcome, Provider, Scenario, StageName } from '../shared/types.js';
import type { Packet, SourceSnapshot } from './packet.js';
import type { StageOutput } from './validation.js';

export interface ProjectRow {
  id: string;
  name: string;
  business: Business;
  folderId: string;
  folderPath: string;
  /** Real folders: device:inode at registration. Null for simulated folders. */
  folderIdentity: string | null;
  repoConfirmed: true;
  archived: boolean;
  registeredAt: string;
  /**
   * Plan revision 9, "block and warn": set when a write into this folder detected that something
   * was swapped in at the file being saved. While set, no task and no write runs in this project.
   * Only Ahmed lifts it, with the "I have checked this folder" action. Absent in older stores.
   */
  swapBlock?: SwapBlock | null;
  /** Every lifted swap block, with when it was lifted. Never shortened. Absent in older stores. */
  swapBlockHistory?: SwapBlockLifted[];
}

export interface SwapBlock {
  detectedAt: string;
  /** Absolute path of the folder the write went into. */
  folder: string;
  /** The name the entry was moved from (the app's temporary file, or a file being quarantined). */
  sourceName: string;
  /** The name it was moved to (a record name, a quarantine name, an outside-review name). */
  destinationName: string;
  /** True when the swapped-in entry was moved back to sourceName; false when it may still be at destinationName. */
  movedBack: boolean;
  during: 'record' | 'quarantine' | 'outside-review';
  taskId: string | null;
  attemptId: string | null;
  error: string;
}

export interface SwapBlockLifted {
  block: SwapBlock;
  liftedAt: string;
  action: 'I have checked this folder';
}

export interface TaskRow {
  id: string;
  projectId: string;
  title: string;
  brief: string;
  acceptanceCriteria: string[];
  drafter: Provider;
  sources: SourceSnapshot[];
  packet: Packet;
  packetHash: string;
  scenarioId: string;
  scenario: Scenario;
  createdAt: string;
}

export interface FinalizingRecord {
  outcome: Outcome;
  reason: string | null;
  completionLabel: string | null;
  /** Record files recorded as published when the outcome was decided, with their hashes. */
  files: { name: string; sha256: string }[];
  /** Exact serialized bytes of final-status.json, kept so republishing never rebuilds it from disk. */
  finalStatusBytes: string;
  finalStatusHash: string;
  decidedAt: string;
}

export interface AttemptRow {
  id: string;
  taskId: string;
  projectId: string;
  number: number;
  idempotencyKey: string;
  approvedPacketHash: string;
  state: AttemptState;
  /** Why the attempt is cancelling (user or timeout); null otherwise. */
  cancelReason: 'user' | 'timeout' | null;
  stateBeforeCancel: AttemptState | null;
  failureNote: string | null;
  finalizing: FinalizingRecord | null;
  final: boolean;
  createdAt: string;
  /**
   * Set when start-up recovery could not fully check this attempt's files (for example an
   * unreadable folder). The attempt is then not settled on a partial picture: it stays waiting,
   * blocks retry, and recovery tries again on every start. Absent in older stores.
   */
  recoveryPending?: string | null;
}

export type RecordFileState = 'intended' | 'published' | 'not_published';

export interface RecordFileRow {
  attemptId: string;
  name: string;
  writeId: string;
  plannedHash: string;
  state: RecordFileState;
  error: string | null;
  /** Set when this write detected a swap (plan revision 9). Absent in older stores and for ordinary failures. */
  swap?: 'moved-back' | 'not-moved-back';
}

export interface DispatchRow {
  attemptId: string;
  stage: StageName;
  provider: Provider;
  payloadHash: string;
  /** Journaled immediately before the adapter is called. */
  startedAt: string | null;
  /** Journaled when the adapter acknowledged the request. Acknowledgement is not evidence that activity stopped. */
  confirmedAt: string | null;
  dispatchId: string | null;
  /**
   * Journaled when the stage's activity is known to have ended: a result or
   * error came back, the owned process confirmed exit, or Ahmed explicitly
   * resolved it. Null means the provider may still be working.
   */
  endedAt: string | null;
  endEvidence: 'result' | 'stopped' | 'resolved' | null;
}

export interface ArtifactRow {
  attemptId: string;
  stage: StageName;
  provider: Provider;
  output: StageOutput;
  sha256: string;
  requestedModel: string;
  reportedProvider: string;
  reportedModel: string;
}

export interface RejectionRow {
  attemptId: string;
  stage: StageName;
  reason: string;
}

export interface LateResultRow {
  attemptId: string;
  stage: StageName;
  note: string;
}

export interface OutsideSaveRow {
  saveId: string;
  taskId: string;
  projectId: string;
  source: 'chatgpt' | 'claude-app';
  textHash: string;
  /** Exact file bytes, header included. */
  content: string;
  date: string;
  number: number;
  state: 'intended' | 'published' | 'not_saved';
  damaged: string | null;
}

export interface Tables {
  projects: ProjectRow[];
  tasks: TaskRow[];
  attempts: AttemptRow[];
  recordFiles: RecordFileRow[];
  dispatch: DispatchRow[];
  artifacts: ArtifactRow[];
  rejections: RejectionRow[];
  lateResults: LateResultRow[];
  outsideSaves: OutsideSaveRow[];
}

export function emptyTables(): Tables {
  return {
    projects: [],
    tasks: [],
    attempts: [],
    recordFiles: [],
    dispatch: [],
    artifacts: [],
    rejections: [],
    lateResults: [],
    outsideSaves: [],
  };
}
