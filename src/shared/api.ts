// The only operations the renderer can ask for. Each is a named, typed
// operation; there is no generic IPC, filesystem or command execution.

import type {
  AttemptView,
  Business,
  ConnectionView,
  EventNote,
  InventoryView,
  ModeView,
  ProjectView,
  Provider,
  ScenarioPreset,
  SharingPlanView,
  SimFolderView,
  TaskSummary,
  TaskView,
} from './types.js';

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface RegisterProjectInput {
  folderId: string;
  business: Business;
  name: string;
  repoConfirmed: boolean;
}

export interface ComposeInput {
  projectId: string;
  title: string;
  brief: string;
  acceptanceCriteria: string[];
  sourceIds: string[];
  drafter: Provider;
  scenarioId: string;
}

export interface StartAttemptInput {
  taskId: string;
  approvedPacketHash: string;
  idempotencyKey: string;
  acknowledgePriorStopped: boolean;
}

export interface OutsideReviewInput {
  taskId: string;
  source: 'chatgpt' | 'claude-app';
  text: string;
}

export interface DamageInput {
  attemptId: string;
  file: string;
  mode: 'delete' | 'alter';
}

export interface HeloApi {
  listSimFolders(): Promise<Result<SimFolderView[]>>;
  listScenarios(): Promise<Result<ScenarioPreset[]>>;
  listProjects(): Promise<Result<ProjectView[]>>;
  registerProject(input: RegisterProjectInput): Promise<Result<ProjectView>>;
  renameProject(input: { projectId: string; name: string }): Promise<Result<ProjectView>>;
  archiveProject(input: { projectId: string; archived: boolean }): Promise<Result<ProjectView>>;
  deleteProject(input: { projectId: string }): Promise<Result<{ removed: true }>>;
  listTasks(input: { projectId: string }): Promise<Result<TaskSummary[]>>;
  previewSharing(input: ComposeInput): Promise<Result<SharingPlanView>>;
  createTask(input: ComposeInput): Promise<Result<{ taskId: string }>>;
  getTask(input: { taskId: string }): Promise<Result<TaskView>>;
  deleteTask(input: { taskId: string }): Promise<Result<{ removed: true }>>;
  startAttempt(input: StartAttemptInput): Promise<Result<{ attemptId: string }>>;
  cancelAttempt(input: { attemptId: string }): Promise<Result<AttemptView>>;
  resolveCancellation(input: { attemptId: string }): Promise<Result<AttemptView>>;
  saveOutsideReview(input: OutsideReviewInput): Promise<Result<{ saveId: string }>>;
  getInventory(input: { taskId: string }): Promise<Result<InventoryView>>;
  exportArtifacts(input: { taskId: string }): Promise<Result<{ text: string }>>;
  getConnection(): Promise<Result<ConnectionView>>;
  getEvents(): Promise<Result<EventNote[]>>;
  getMode(): Promise<Result<ModeView>>;
  /** Persistent mode: opens the system folder picker in the main process. The interface never sends a path. */
  chooseTestFolder(): Promise<Result<SimFolderView | null>>;
  simulateCrashAndRestart(): Promise<Result<{ recovered: number }>>;
  simulateDamage(input: DamageInput): Promise<Result<AttemptView>>;
}

/** Allow-list of operation names. The preload and main process both use exactly this list. */
export const API_METHODS = [
  'listSimFolders',
  'listScenarios',
  'listProjects',
  'registerProject',
  'renameProject',
  'archiveProject',
  'deleteProject',
  'listTasks',
  'previewSharing',
  'createTask',
  'getTask',
  'deleteTask',
  'startAttempt',
  'cancelAttempt',
  'resolveCancellation',
  'saveOutsideReview',
  'getInventory',
  'exportArtifacts',
  'getConnection',
  'getEvents',
  'getMode',
  'chooseTestFolder',
  'simulateCrashAndRestart',
  'simulateDamage',
] as const satisfies readonly (keyof HeloApi)[];

export type ApiMethod = (typeof API_METHODS)[number];

/** The renderer-side object exposed by the preload as window.helo. */
export interface HeloBridge extends HeloApi {
  /** Subscribe to "state changed" notifications. Returns an unsubscribe function. */
  onChanged(callback: () => void): () => void;
}

export const IPC_CHANNEL_PREFIX = 'helo:';
export const IPC_CHANGED_CHANNEL = 'helo:changed';
