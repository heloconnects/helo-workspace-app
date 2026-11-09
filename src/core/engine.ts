// The simulated workspace: projects (F2), tasks, attempts and their state
// machine, safe publication (F3), finishing, cancellation, recovery after
// simulated crashes, and outside reviews (F4). Everything is in memory.

import {
  rolesFor,
  STAGES,
  type AttemptState,
  type Business,
  type DispatchStatus,
  type Outcome,
  type Provider,
  type RecordState,
  type Scenario,
  type StageName,
} from '../shared/types.js';
import { FakeAdapter, type AdapterEvent, type AdapterTiming } from './fake-adapters.js';
import { simFolders, type Folder } from './fixtures.js';
import { byteLength, newId, sha256 } from './hash.js';
import {
  artifactHash,
  buildPacket,
  buildPayload,
  outputFileName,
  outputMarkdown,
  packetMarkdown,
  sentFileName,
  sentJson,
  sharingPlanJson,
  type ForwardedArtifact,
  type SourceSnapshot,
} from './packet.js';
import { ALL_RECORD_FILES, attemptDir, computeRecordState, FINAL_STATUS, fileListIsConsistent, finalStatusBytes, taskDir } from './records.js';
import { CrashHooks, SimDb, SimFs, SimFsError, SimulatedCrash, swapKind, type CloneFs, type DbLike, type DirHandle } from './sim-store.js';
import { emptyTables, type AttemptRow, type FinalizingRecord, type OutsideSaveRow, type SwapBlock, type Tables, type TaskRow } from './schema.js';
import { assertTransition, isActive, isTerminal } from './state-machine.js';
import { validateStage, type ReviewOutput, type StageOutput, type SynthesisOutput } from './validation.js';

export interface EngineTiming extends AdapterTiming {
  /** Proposed 180 s in the plan; shortened in the simulation. */
  stageTimeoutMs: number;
  /** Proposed 600 s in the plan; shortened in the simulation. */
  attemptLimitMs: number;
  /** Proposed 5 s graceful window in the plan; shortened in the simulation. */
  cancelGraceMs: number;
}

export const UI_TIMING: EngineTiming = {
  responseMs: 900,
  lateResultMs: 4000,
  stageTimeoutMs: 6000,
  attemptLimitMs: 30000,
  cancelGraceMs: 1500,
};

export const MAX_PACKET_BYTES = 256 * 1024;
export const MAX_SOURCE_BYTES = 64 * 1024;

export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

class StaleRun extends Error {}

interface RunHandle {
  attemptId: string;
  epoch: number;
  controller: AbortController | null;
  cancelRequested: 'user' | null;
  wake: (() => void) | null;
  done: Promise<void>;
}

type Listener = () => void;

export interface WorkspaceOptions {
  timing: EngineTiming;
  hooks?: CrashHooks;
  now?: () => Date;
  /** Called after a simulated crash has stopped the runtime (the UI restarts automatically). */
  onCrash?: (point: string) => void;
  /** Run-state store. Default: in-memory SimDb. Persistent mode passes a SQLite store. */
  db?: (hooks: CrashHooks) => DbLike<Tables>;
  /** Project folders. Default: the fictional simulated folders. */
  folders?: Folder[];
  /** Re-creates a real test folder for a project loaded from the store. */
  realFolder?: (path: string) => Folder;
}

export class Workspace {
  readonly hooks: CrashHooks;
  readonly db: DbLike<Tables>;
  readonly folders: Folder[];
  /** Where each folder's records are written, by folder id. */
  readonly clones = new Map<string, CloneFs>();
  readonly adapters: Record<Provider, FakeAdapter>;
  readonly events: { at: string; text: string }[] = [];
  private epoch = 0;
  private runs = new Map<string, RunHandle>();
  private listeners = new Set<Listener>();
  private recovering = false;
  crashedAt: string | null = null;

  constructor(readonly options: WorkspaceOptions) {
    this.hooks = options.hooks ?? new CrashHooks();
    this.db = options.db ? options.db(this.hooks) : new SimDb(emptyTables(), this.hooks);
    this.folders = [];
    for (const f of options.folders ?? simFolders()) this.addFolder(f);
    // Projects loaded from a persistent store that live in real test folders.
    for (const p of this.db.tables.projects) {
      if (p.folderId.startsWith('real:') && !this.folders.some((f) => f.id === p.folderId)) {
        if (!options.realFolder) throw new Error('A stored project uses a real folder, but no real-folder support was given.');
        this.addFolder(options.realFolder(p.folderPath)).expect?.(p.folderIdentity ?? null, p.business);
      }
    }
    this.adapters = { claude: new FakeAdapter('claude', () => this.options.timing), codex: new FakeAdapter('codex', () => this.options.timing) };
  }

  // ---------- plumbing ----------

  setTiming(timing: EngineTiming): void {
    this.options.timing = timing;
  }

  now(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  onChange(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }

  note(text: string): void {
    this.events.unshift({ at: this.now(), text });
    if (this.events.length > 50) this.events.pop();
  }

  get t(): Readonly<Tables> {
    return this.db.tables;
  }

  /** Add a folder (a real test folder chosen by Ahmed, or one reloaded for a stored project). */
  addFolder(f: Folder): Folder {
    const existing = this.folders.find((x) => x.id === f.id);
    if (existing) return existing;
    this.folders.push(f);
    this.clones.set(f.id, f.clone ?? new SimFs(f.path));
    return f;
  }

  folder(id: string): Folder {
    const f = this.folders.find((x) => x.id === id);
    if (!f) throw new UserError('Unknown folder.');
    return f;
  }

  cloneOf(projectId: string): CloneFs {
    const p = this.project(projectId);
    return this.clones.get(p.folderId)!;
  }

  project(id: string) {
    const p = this.t.projects.find((x) => x.id === id);
    if (!p) throw new UserError('Unknown project.');
    return p;
  }

  task(id: string): TaskRow {
    const t = this.t.tasks.find((x) => x.id === id);
    if (!t) throw new UserError('Unknown task.');
    return t;
  }

  attempt(id: string): AttemptRow {
    const a = this.t.attempts.find((x) => x.id === id);
    if (!a) throw new UserError('Unknown attempt.');
    return a;
  }

  attemptsOf(taskId: string): AttemptRow[] {
    return this.t.attempts.filter((a) => a.taskId === taskId).sort((a, b) => a.number - b.number);
  }

  // ---------- projects (F2) ----------

  /** F2 re-check: folder path and RULES.md business line unchanged. Returns a blocking reason or null. */
  projectBlock(projectId: string): string | null {
    const p = this.project(projectId);
    if (p.swapBlock) return swapBlockMessage(p.swapBlock);
    const f = this.folder(p.folderId);
    if (f.path !== p.folderPath) return 'The folder path changed since registration. Register the project again.';
    if (f.kind === 'real' && !p.folderIdentity) return 'This folder was registered by an older version of the app, which did not record its identity. Confirm the folder on the Projects page to continue.';
    if (f.identity && p.folderIdentity && f.identity() !== p.folderIdentity) return 'The folder was replaced by a different folder since registration. Register the project again.';
    if (f.rulesBusiness === null) return 'RULES.md is missing from the folder. Register the project again.';
    if (f.rulesBusiness !== p.business) return 'The RULES.md business line no longer matches. Register the project again.';
    return null;
  }

  registerProject(input: { folderId: string; business: Business; name: string; repoConfirmed: boolean }) {
    const f = this.folder(input.folderId);
    const name = input.name.trim();
    if (!name) throw new UserError('Give the project a name.');
    if (!input.repoConfirmed) throw new UserError('Confirm which GitHub repository this folder belongs to. The app does not check it.');
    if (f.rulesBusiness === null) throw new UserError('Refused: this folder has no RULES.md at its top level.');
    if (f.rulesBusiness !== input.business) throw new UserError('Refused: the RULES.md "Business in this repository" line does not match the business you picked.');
    if (this.t.projects.some((p) => p.folderId === f.id)) throw new UserError('Refused: this folder is already registered as a project.');
    if (this.t.projects.some((p) => p.business === input.business)) throw new UserError('Refused: a project for this business already exists. One project per business.');
    const folderIdentity = f.identity ? f.identity() : null;
    if (f.kind === 'real' && folderIdentity === null) throw new UserError('Refused: the folder could not be opened safely.');
    const id = newId('p');
    this.db.transact('project-register', (d) => {
      d.projects.push({ id, name, business: input.business, folderId: f.id, folderPath: f.path, folderIdentity, repoConfirmed: true, archived: false, registeredAt: this.now() });
    });
    f.expect?.(folderIdentity, input.business);
    this.changed();
    return this.project(id);
  }

  /**
   * Older stores (persistence v1 before the Codex review fixes) have real projects without a recorded
   * folder identity. Ahmed confirms the folder once; it must still pass every check (same path, a
   * RULES.md naming the same business). Nothing in the folder or the task history is changed.
   */
  confirmFolderIdentity(projectId: string) {
    const p = this.project(projectId);
    const f = this.folder(p.folderId);
    if (f.kind !== 'real' || !f.identity || !f.expect) throw new UserError('Only real test folders have an identity to confirm.');
    if (p.folderIdentity) throw new UserError('This folder is already confirmed.');
    if (f.path !== p.folderPath) throw new UserError('The folder path changed since registration; it cannot be confirmed.');
    if (f.rulesBusiness !== p.business) throw new UserError('RULES.md no longer names the registered business; it cannot be confirmed.');
    const identity = f.identity();
    if (!identity) throw new UserError('The folder could not be opened safely.');
    this.db.transact('project-confirm-identity', (d) => {
      d.projects.find((x) => x.id === projectId)!.folderIdentity = identity;
    });
    f.expect(identity, p.business);
    this.note(`Folder confirmed for ${p.name}: ${p.folderPath}`);
    this.changed();
    return this.project(projectId);
  }

  /**
   * Plan revision 9, "block and warn": record that a write detected a swap. The block is kept in
   * the store, survives restarts, and stops every task and write in the project until Ahmed lifts
   * it. A block already in place is kept (the first detection is the one shown).
   */
  private blockForSwap(d: Tables, projectId: string, block: SwapBlock): void {
    const p = d.projects.find((x) => x.id === projectId);
    if (p && !p.swapBlock) p.swapBlock = block;
  }

  private swapBlockFor(fs: CloneFs, dir: string, from: string, to: string, e: SimFsError, during: SwapBlock['during'], ids: { taskId: string | null; attemptId: string | null }): SwapBlock {
    return {
      detectedAt: this.now(),
      folder: `${fs.root}/${dir}`,
      sourceName: from,
      destinationName: to,
      movedBack: swapKind(e) === 'moved-back',
      during,
      taskId: ids.taskId,
      attemptId: ids.attemptId,
      error: e.message,
    };
  }

  private noteSwap(projectId: string, b: SwapBlock): void {
    this.note(
      `Project ${this.project(projectId).name} is blocked: something replaced a file while the app was saving it in ${b.folder} (${b.sourceName} → ${b.destinationName}). ${
        b.movedBack ? 'The swapped-in entry was moved back.' : 'The swapped-in entry could NOT be moved back and may still be at the record name.'
      } Nothing was published from that write.`,
    );
  }

  /** Ahmed's deliberate "I have checked this folder" action. Recorded, with the block it lifts. */
  liftSwapBlock(projectId: string) {
    const p = this.project(projectId);
    if (!p.swapBlock) throw new UserError('This project is not blocked by a detected swap.');
    const block = p.swapBlock;
    this.db.transact('project-swap-block-lifted', (d) => {
      const row = d.projects.find((x) => x.id === projectId)!;
      row.swapBlockHistory = [...(row.swapBlockHistory ?? []), { block, liftedAt: this.now(), action: 'I have checked this folder' }];
      row.swapBlock = null;
    });
    this.note(`Ahmed checked ${block.folder} ("I have checked this folder"); the block on ${p.name} was lifted. Recovery runs on the next start.`);
    this.changed();
    return this.project(projectId);
  }

  renameProject(projectId: string, name: string) {
    this.project(projectId);
    const n = name.trim();
    if (!n) throw new UserError('Give the project a name.');
    this.db.transact('project-rename', (d) => {
      d.projects.find((p) => p.id === projectId)!.name = n;
    });
    this.changed();
    return this.project(projectId);
  }

  archiveProject(projectId: string, archived: boolean) {
    this.project(projectId);
    this.db.transact('project-archive', (d) => {
      d.projects.find((p) => p.id === projectId)!.archived = archived;
    });
    this.changed();
    return this.project(projectId);
  }

  /** F6: removes only the app's own records. Never touches the clone. */
  deleteProject(projectId: string): void {
    this.project(projectId);
    const taskIds = this.t.tasks.filter((t) => t.projectId === projectId).map((t) => t.id);
    if (this.t.attempts.some((a) => taskIds.includes(a.taskId) && isActive(a.state))) {
      throw new UserError('Deletion is blocked while an attempt is running or its cancellation is unconfirmed.');
    }
    this.db.transact('project-delete', (d) => {
      d.projects = d.projects.filter((p) => p.id !== projectId);
      removeTaskRows(d, taskIds);
    });
    this.changed();
  }

  deleteTask(taskId: string): void {
    this.task(taskId);
    if (this.attemptsOf(taskId).some((a) => isActive(a.state))) {
      throw new UserError('Deletion is blocked while an attempt is running or its cancellation is unconfirmed.');
    }
    this.db.transact('task-delete', (d) => removeTaskRows(d, [taskId]));
    this.changed();
  }

  // ---------- tasks ----------

  sourcesOf(projectId: string): { sourceId: string; path: string; content: string }[] {
    const f = this.folder(this.project(projectId).folderId);
    return Object.entries(f.files)
      .filter(([path]) => path !== 'RULES.md')
      .map(([path, content]) => ({ sourceId: `${f.id}:${path}`, path, content }));
  }

  /** Builds the frozen packet. Sources must belong to this project's own folder. */
  composePacket(input: { projectId: string; taskId: string; brief: string; acceptanceCriteria: string[]; sourceIds: string[]; drafter: Provider }) {
    const p = this.project(input.projectId);
    const f = this.folder(p.folderId);
    const available = this.sourcesOf(p.id);
    const sources: SourceSnapshot[] = [];
    input.sourceIds.forEach((sid, i) => {
      const src = available.find((s) => s.sourceId === sid);
      if (!src) throw new UserError('A selected source is not a file in this project\'s folder.');
      if (byteLength(src.content) > MAX_SOURCE_BYTES) throw new UserError(`${src.path} is larger than the source limit. Reduce the selection.`);
      sources.push({ sourceId: `S${i + 1}`, displayName: src.path, sha256: sha256(src.content), content: src.content });
    });
    const rulesText = f.files['RULES.md'];
    if (rulesText === undefined) throw new UserError('RULES.md is missing.');
    const rules: SourceSnapshot = { sourceId: 'RULES', displayName: 'RULES.md', sha256: sha256(rulesText), content: rulesText };
    const built = buildPacket({
      taskId: input.taskId,
      brief: input.brief,
      acceptanceCriteria: input.acceptanceCriteria,
      rules,
      roles: rolesFor(input.drafter),
      sources,
    });
    if (byteLength(built.json) > MAX_PACKET_BYTES) throw new UserError('The task is larger than the input limit. Reduce the selection; nothing is truncated or summarised.');
    return { ...built, sources };
  }

  createTask(input: {
    projectId: string;
    title: string;
    brief: string;
    acceptanceCriteria: string[];
    sourceIds: string[];
    drafter: Provider;
    scenarioId: string;
    scenario: Scenario;
  }): TaskRow {
    const p = this.project(input.projectId);
    if (p.archived) throw new UserError('Archived projects cannot start tasks.');
    const block = this.projectBlock(p.id);
    if (block) throw new UserError(block);
    if (!input.title.trim()) throw new UserError('Give the task a title.');
    if (!input.brief.trim()) throw new UserError('Write a brief.');
    if (input.acceptanceCriteria.length === 0) throw new UserError('Add at least one acceptance criterion.');
    const id = newId('t');
    const built = this.composePacket({ ...input, taskId: id });
    this.db.transact('task-create', (d) => {
      d.tasks.push({
        id,
        projectId: p.id,
        title: input.title.trim(),
        brief: input.brief,
        acceptanceCriteria: input.acceptanceCriteria,
        drafter: input.drafter,
        sources: built.sources,
        packet: built.packet,
        packetHash: built.hash,
        scenarioId: input.scenarioId,
        scenario: input.scenario,
        createdAt: this.now(),
      });
    });
    this.changed();
    return this.task(id);
  }

  // ---------- starting attempts ----------

  /** Why a new attempt cannot start now, or null. */
  startBlock(taskId: string): string | null {
    const task = this.task(taskId);
    const p = this.project(task.projectId);
    if (p.archived) return 'Archived projects cannot start tasks.';
    const block = this.projectBlock(p.id);
    if (block) return block;
    const attempts = this.attemptsOf(taskId);
    const pending = attempts.find((a) => a.recoveryPending);
    if (pending) return `Recovery of attempt ${pending.number} is waiting: ${pending.recoveryPending}. Fix the folder and restart the app.`;
    const unconfirmed = attempts.find((a) => a.state === 'cancellation_unconfirmed');
    if (unconfirmed) return 'Cancellation unconfirmed: resolve the earlier attempt before starting a new one.';
    if (attempts.some((a) => isActive(a.state))) return 'An attempt is already running.';
    return null;
  }

  /**
   * True when a stage of an earlier, finished attempt was dispatched and its
   * activity was never known to end (no result, no confirmed exit, no explicit
   * resolution). Dispatch acknowledgement alone is not evidence of stopping.
   */
  needsStopAcknowledgement(taskId: string): boolean {
    return this.attemptsOf(taskId).some((a) => isTerminal(a.state) && this.unresolvedStages(a.id).length > 0);
  }

  /** Stages whose dispatched activity may still be running. */
  unresolvedStages(attemptId: string): StageName[] {
    return this.t.dispatch.filter((d) => d.attemptId === attemptId && d.startedAt && !d.endedAt).map((d) => d.stage);
  }

  private markEnded(attemptId: string, stage: StageName | null, evidence: 'result' | 'stopped' | 'resolved', label: string): void {
    this.db.transact(label, (d) => {
      for (const row of d.dispatch) {
        if (row.attemptId === attemptId && (stage === null || row.stage === stage) && row.startedAt && !row.endedAt) {
          row.endedAt = this.now();
          row.endEvidence = evidence;
        }
      }
    });
  }

  startAttempt(input: { taskId: string; approvedPacketHash: string; idempotencyKey: string; acknowledgePriorStopped: boolean }): AttemptRow {
    const task = this.task(input.taskId);
    const existing = this.t.attempts.find((a) => a.taskId === task.id && a.idempotencyKey === input.idempotencyKey);
    if (existing) return existing; // duplicate submission (double click)
    if (input.approvedPacketHash !== task.packetHash) throw new UserError('The sharing approval does not match this task packet. Review the sharing screen again.');
    const block = this.startBlock(task.id);
    if (block) throw new UserError(block);
    if (this.needsStopAcknowledgement(task.id)) {
      if (!input.acknowledgePriorStopped) {
        throw new UserError(
          'An earlier attempt may still have a provider stage running (it was dispatched and never confirmed stopped). Confirm the earlier activity has stopped before starting a new attempt (possible duplicate billing).',
        );
      }
      // The explicit acknowledgement is the resolution: record it before anything new is dispatched.
      for (const prior of this.attemptsOf(task.id)) {
        if (this.unresolvedStages(prior.id).length) this.markEnded(prior.id, null, 'resolved', 'dispatch-resolved-by-acknowledgement');
      }
    }
    const id = newId('a');
    const number = this.attemptsOf(task.id).length + 1;
    this.db.transact('attempt-create', (d) => {
      d.attempts.push({
        id,
        taskId: task.id,
        projectId: task.projectId,
        number,
        idempotencyKey: input.idempotencyKey,
        approvedPacketHash: input.approvedPacketHash,
        state: 'queued',
        cancelReason: null,
        stateBeforeCancel: null,
        failureNote: null,
        finalizing: null,
        final: false,
        createdAt: this.now(),
      });
    });
    const handle: RunHandle = { attemptId: id, epoch: this.epoch, controller: null, cancelRequested: null, wake: null, done: Promise.resolve() };
    this.runs.set(id, handle);
    handle.done = this.run(handle).catch((e) => this.onRunError(handle, e));
    this.changed();
    return this.attempt(id);
  }

  /** Awaitable completion of the current run of an attempt (tests and seeding). */
  async settled(attemptId: string): Promise<void> {
    await this.runs.get(attemptId)?.done;
  }

  async idle(): Promise<void> {
    await Promise.all([...this.runs.values()].map((r) => r.done));
  }

  private onRunError(handle: RunHandle, e: unknown): void {
    if (e instanceof StaleRun) return;
    if (e instanceof SimulatedCrash) {
      this.crash(e.point);
      return;
    }
    // Unexpected programming error: stop the attempt as failed if possible.
    try {
      const a = this.attempt(handle.attemptId);
      if (!a.finalizing) this.finalize(handle, 'failed', `Internal error: ${(e as Error).message}`, null);
    } catch {
      /* the crash path or recovery will handle it */
    }
  }

  /** Simulated crash: every runtime handle is dropped. Durable tables and clones survive. */
  crash(point: string): void {
    this.epoch += 1;
    for (const r of this.runs.values()) r.controller?.abort();
    this.runs.clear();
    this.crashedAt = point;
    this.note(`Simulated app crash at "${point}". The runtime was lost; durable records survived.`);
    this.changed();
    this.options.onCrash?.(point);
  }

  private alive(handle: RunHandle): void {
    if (handle.epoch !== this.epoch) throw new StaleRun();
  }

  private setState(handle: RunHandle, to: AttemptState, label: string, extra?: (a: AttemptRow) => void): void {
    this.alive(handle);
    this.db.transact(label, (d) => {
      const a = d.attempts.find((x) => x.id === handle.attemptId)!;
      assertTransition(a.state, to);
      a.state = to;
      extra?.(a);
    });
    this.changed();
  }

  // ---------- safe publication (F3) ----------

  /**
   * (1) transaction records the intent and planned hash; (2) the file is
   * written to .tmp-<write-id> (exclusive create), flushed, and moved to its
   * final name with a no-replace move, which fails if the name exists (approved
   * change to F3, replacing hard link + removal, so nothing is ever deleted);
   * (3) transaction records it as published.
   */
  private publishRecord(fs: CloneFs, dir: string, attemptId: string, name: string, content: string, handle: RunHandle | null): { ok: true } | { ok: false; error: string } {
    if (handle) this.alive(handle);
    // F2: re-check the folder path and RULES.md business line before every write.
    const block = this.projectBlock(this.attempt(attemptId).projectId);
    if (block) return { ok: false, error: `project blocked, nothing written: ${block}` };
    const writeId = newId('w');
    const plannedHash = sha256(content);
    this.db.transact(`intent:${name}`, (d) => {
      d.recordFiles = d.recordFiles.filter((r) => !(r.attemptId === attemptId && r.name === name));
      d.recordFiles.push({ attemptId, name, writeId, plannedHash, state: 'intended', error: null });
    });
    const tmpName = `.tmp-${writeId}`;
    const final = `${dir}/${name}`;
    // One folder handle for the whole publication: every step is relative to it.
    let dh: DirHandle | null = null;
    let created = false;
    try {
      dh = fs.openDir(dir);
      dh.createExclusive(tmpName, content, name);
      created = true;
      this.hooks.point(`publish:${name}:tmp-written`);
      dh.publish(tmpName, name, name); // no-replace move of a regular file: fails if the name exists; nothing is deleted
      this.hooks.point(`publish:${name}:moved`);
    } catch (e) {
      dh?.close();
      dh = null;
      if (!(e instanceof SimFsError)) throw e;
      const swap = swapKind(e);
      if (swap) {
        // Plan revision 9: a swap was detected. Nothing is published from this write, whether or
        // not the swapped-in entry was moved back, and the project is blocked (recorded in the same
        // transaction). Nothing is quarantined now: whatever is at either name stays where it is.
        const a = this.attempt(attemptId);
        const block = this.swapBlockFor(fs, dir, tmpName, name, e, 'record', { taskId: a.taskId, attemptId });
        const error = `swapped: something replaced ${dir}/${tmpName} while it was being moved to ${name}; ${
          swap === 'moved-back' ? 'the swapped-in entry was moved back' : `the swapped-in entry could NOT be moved back and may still be at ${final}`
        }. Nothing was published; the project is blocked.`;
        this.db.transact(`not-published:${name}`, (d) => {
          const r = d.recordFiles.find((x) => x.attemptId === attemptId && x.name === name)!;
          r.state = 'not_published';
          r.error = error;
          r.swap = swap;
          this.blockForSwap(d, a.projectId, block);
        });
        this.noteSwap(a.projectId, block);
        return { ok: false, error };
      }
      // Our own temporary file, if we created it, goes to quarantine (moved, never deleted).
      // A ".tmp-" name that already existed is someone else's and is left alone.
      if (created) {
        try {
          this.quarantine(fs, dir, tmpName, writeId);
        } catch (q) {
          if (!(q instanceof SimFsError)) throw q;
        }
      }
      const error = e.code === 'EEXIST' ? `collision: ${final} already exists; nothing was replaced` : e.message;
      this.db.transact(`not-published:${name}`, (d) => {
        const r = d.recordFiles.find((x) => x.attemptId === attemptId && x.name === name)!;
        r.state = 'not_published';
        r.error = error;
      });
      return { ok: false, error };
    }
    // The move happened, so the record is published under its final name. The flush is a separate
    // step: if it fails, the record is still counted as published (it is there), and the problem is
    // noted rather than being mistaken for "not published".
    try {
      dh.sync(name);
      this.hooks.point(`publish:${name}:synced`);
    } catch (e) {
      if (!(e instanceof SimFsError)) {
        dh.close();
        throw e;
      }
      this.note(`${final} was published, but flushing its folder failed: ${e.message}. It is counted as published; durability after a power loss is not confirmed.`);
    }
    dh.close();
    this.db.transact(`published:${name}`, (d) => {
      d.recordFiles.find((x) => x.attemptId === attemptId && x.name === name)!.state = 'published';
    });
    return { ok: true };
  }

  publishedFiles(attemptId: string): { name: string; sha256: string }[] {
    const rows = this.t.recordFiles.filter((r) => r.attemptId === attemptId && r.state === 'published' && r.name !== FINAL_STATUS);
    return ALL_RECORD_FILES.flatMap((n) => {
      const r = rows.find((x) => x.name === n);
      return r ? [{ name: n, sha256: r.plannedHash }] : [];
    });
  }

  // ---------- finishing ----------

  /** (1) "finalizing" transaction fixes the outcome; (2) final-status.json is published; (3) "final". */
  private finalize(handle: RunHandle | null, outcome: Outcome, reason: string | null, completionLabel: string | null): void {
    if (handle) this.alive(handle);
    const attempt = this.attempt(handle?.attemptId ?? '');
    this.decideOutcome(attempt, outcome, reason, completionLabel);
    this.publishFinalStatus(attempt.id, handle);
  }

  private decideOutcome(attempt: AttemptRow, outcome: Outcome, reason: string | null, completionLabel: string | null): void {
    const files = this.publishedFiles(attempt.id);
    const inconsistent = fileListIsConsistent(outcome, files.map((f) => f.name));
    if (inconsistent && (outcome === 'complete' || outcome === 'needs_attention')) {
      // Never choose complete without every stage output published.
      outcome = 'failed';
      reason = `Internal check failed: ${inconsistent}`;
      completionLabel = null;
    }
    const decidedAt = this.now();
    const bytes = finalStatusBytes({ taskId: attempt.taskId, attemptId: attempt.id, outcome, reason, completionLabel, files, decidedAt });
    const fin: FinalizingRecord = { outcome, reason, completionLabel, files, finalStatusBytes: bytes, finalStatusHash: sha256(bytes), decidedAt };
    this.db.transact('finalizing', (d) => {
      const a = d.attempts.find((x) => x.id === attempt.id)!;
      if (a.finalizing) return; // an outcome is decided once and never changed
      if (a.state !== outcome) assertTransition(a.state, outcome);
      a.state = outcome;
      a.finalizing = fin;
    });
    this.changed();
  }

  /** For an already-final attempt: put back a missing final-status.json with the same bytes and outcome. */
  private republishFinalStatus(attemptId: string): void {
    const a = this.attempt(attemptId);
    if (!a.finalizing) return;
    const fs = this.cloneOf(a.projectId);
    const dir = attemptDir(a.taskId, a.id);
    if (fs.exists(`${dir}/${FINAL_STATUS}`)) return; // present (a mismatched copy was quarantined in step 1)
    const res = this.publishRecord(fs, dir, a.id, FINAL_STATUS, a.finalizing.finalStatusBytes, null);
    this.note(
      res.ok
        ? `Recovery: final-status.json for attempt ${a.number} was missing and was written again with the same outcome (${a.finalizing.outcome}).`
        : `Recovery: final-status.json for attempt ${a.number} is missing and could not be written: ${res.error}.`,
    );
  }

  private publishFinalStatus(attemptId: string, handle: RunHandle | null): void {
    const a = this.attempt(attemptId);
    if (!a.finalizing || a.final) return;
    const fs = this.cloneOf(a.projectId);
    const dir = attemptDir(a.taskId, a.id);
    const existing = fs.hash(`${dir}/${FINAL_STATUS}`);
    if (existing === a.finalizing.finalStatusHash) {
      this.db.transact('published:final-status.json', (d) => {
        const row = d.recordFiles.find((r) => r.attemptId === a.id && r.name === FINAL_STATUS);
        if (row) row.state = 'published';
      });
    } else {
      // During recovery, a different file left at the final name (for example an unadoptable
      // final-status.json that could not be quarantined while the project was blocked) is moved
      // to quarantine first, so the recorded bytes can be published. Never during a run.
      if (existing !== undefined && this.recovering && !this.projectBlock(a.projectId)) this.quarantine(fs, dir, FINAL_STATUS, 'mismatched');
      const res = this.publishRecord(fs, dir, a.id, FINAL_STATUS, a.finalizing.finalStatusBytes, handle);
      if (!res.ok) {
        // The outcome stays as recorded; only the record state shows the problem.
        this.note(`final-status.json was not written for attempt ${a.number}: ${res.error}. The outcome stays ${a.finalizing.outcome}; publishing is retried on every start.`);
        this.changed();
        return;
      }
    }
    this.db.transact('final', (d) => {
      d.attempts.find((x) => x.id === a.id)!.final = true;
    });
    this.changed();
  }

  // ---------- the run ----------

  private async run(handle: RunHandle): Promise<void> {
    await Promise.resolve();
    this.alive(handle);
    const attempt = this.attempt(handle.attemptId);
    const task = this.task(attempt.taskId);
    const fs = this.cloneOf(task.projectId);
    const dir = attemptDir(task.id, attempt.id);
    const scenario = task.scenario;
    if (scenario.publishFailure) fs.injectFault(scenario.publishFailure.file, scenario.publishFailure.code, 1);
    if (scenario.crashAt) this.hooks.arm(scenario.crashAt);
    const deadline = Date.now() + this.options.timing.attemptLimitMs;

    const stopFor = (res: { ok: false; error: string }, what: string) => this.finalize(handle, 'failed', `${what} could not be published: ${res.error}`, null);

    let r = this.publishRecord(fs, dir, attempt.id, 'packet.md', packetMarkdown(task.packet, task.packetHash, attempt.id), handle);
    if (!r.ok) return stopFor(r, 'packet.md');
    r = this.publishRecord(fs, dir, attempt.id, 'sharing-plan.json', sharingPlanJson(task.packet.roles, task.packetHash, attempt.createdAt), handle);
    if (!r.ok) return stopFor(r, 'sharing-plan.json');

    const forwarded: Partial<Record<StageName, ForwardedArtifact>> = {};
    const stageState: Record<StageName, AttemptState> = { draft: 'drafting', review: 'reviewing', synthesis: 'synthesizing' };

    for (const stage of STAGES) {
      if (handle.cancelRequested) return this.finalize(handle, 'cancelled', 'Cancelled before the next stage was dispatched.', null);
      const provider = stage === 'review' ? task.packet.roles.reviewer : stage === 'draft' ? task.packet.roles.drafter : task.packet.roles.synthesizer;
      this.setState(handle, stageState[stage], `state:${stageState[stage]}`);
      const adapter = this.adapters[provider];
      const payload = buildPayload({
        stage,
        taskId: task.id,
        attemptId: attempt.id,
        packet: task.packet,
        packetHash: task.packetHash,
        ...(forwarded.draft ? { draft: forwarded.draft } : {}),
        ...(forwarded.review ? { review: forwarded.review } : {}),
      });
      // C3: -sent.json = prepared payload and dispatch intent. If it cannot be published, the stage is not dispatched.
      r = this.publishRecord(
        fs,
        dir,
        attempt.id,
        sentFileName(stage),
        sentJson({
          stage,
          provider,
          adapterVersion: adapter.version,
          requestedModel: adapter.requestedModel,
          payloadHash: payload.hash,
          payloadBytes: byteLength(payload.bytes),
          packetHash: task.packetHash,
          includes: payload.includes,
          preparedAt: this.now(),
        }),
        handle,
      );
      if (!r.ok) return stopFor(r, sentFileName(stage));
      if (handle.cancelRequested) return this.finalize(handle, 'cancelled', 'Cancelled before the next stage was dispatched.', null);

      // Dispatch journal: started (before the adapter call), confirmed (on acknowledgement).
      this.alive(handle);
      this.db.transact(`dispatch-started:${stage}`, (d) => {
        d.dispatch.push({
          attemptId: attempt.id,
          stage,
          provider,
          payloadHash: payload.hash,
          startedAt: this.now(),
          confirmedAt: null,
          dispatchId: null,
          endedAt: null,
          endEvidence: null,
        });
      });
      const controller = new AbortController();
      handle.controller = controller;
      const run = adapter.start({ stage, payload: payload.bytes, requestedModel: adapter.requestedModel }, controller.signal, scenario);
      this.hooks.point(`adapter:${stage}:dispatched`);

      const outcome = await this.awaitStage(handle, stage, run, deadline);
      if (outcome.kind === 'stopped') return; // finalised or left unconfirmed by awaitStage
      if (outcome.kind === 'error') return this.finalize(handle, 'failed', `${stage} stage failed: ${outcome.message}`, null);

      this.hooks.point(`adapter:${stage}:result`);
      const validated = validateStage(outcome.events, {
        stage,
        provider,
        taskId: task.id,
        attemptId: attempt.id,
        inputHash: payload.hash,
        acceptanceCriteria: task.acceptanceCriteria,
        ...(stage === 'synthesis' ? { reviewFindingIds: (forwarded.review!.content as ReviewOutput).findings.map((f) => f.id) } : {}),
      });
      if (!validated.ok) {
        // Partial or rejected output is never forwarded.
        this.alive(handle);
        this.db.transact(`rejected:${stage}`, (d) => {
          d.rejections.push({ attemptId: attempt.id, stage, reason: validated.reason });
        });
        return this.finalize(handle, 'failed', `${stage} output rejected: ${validated.reason}`, null);
      }
      const sha = artifactHash(validated.output);
      this.alive(handle);
      this.db.transact(`artifact:${stage}`, (d) => {
        d.artifacts.push({
          attemptId: attempt.id,
          stage,
          provider,
          output: validated.output,
          sha256: sha,
          requestedModel: adapter.requestedModel,
          reportedProvider: validated.reportedProvider,
          reportedModel: validated.reportedModel,
        });
      });
      r = this.publishRecord(fs, dir, attempt.id, outputFileName(stage), outputMarkdown(stage, provider, validated.output, validated), handle);
      if (!r.ok) return stopFor(r, outputFileName(stage));
      forwarded[stage] = { stage, sha256: sha, content: validated.output };
    }

    if (handle.cancelRequested) return this.finalize(handle, 'cancelled', 'Cancelled after the last stage, before the outcome was decided.', null);
    this.setState(handle, 'validating', 'state:validating');
    const synth = forwarded.synthesis!.content as SynthesisOutput;
    const review = forwarded.review!.content as ReviewOutput;
    const unmet = synth.criteriaAssessment.filter((c) => !c.met);
    if (unmet.length) {
      return this.finalize(handle, 'needs_attention', `Unmet acceptance criteria: ${unmet.map((c) => c.criterion).join('; ')}`, null);
    }
    const issues = synth.remainingIssues.length > 0 || review.unresolved.length > 0 || synth.dispositions.some((d) => d.disposition === 'unresolved');
    this.finalize(handle, 'complete', null, issues ? 'Workflow complete — unresolved issues remain' : 'Workflow complete — no issues reported');
  }

  private async awaitStage(
    handle: RunHandle,
    stage: StageName,
    run: ReturnType<FakeAdapter['start']>,
    deadline: number,
  ): Promise<{ kind: 'events'; events: AdapterEvent[] } | { kind: 'error'; message: string } | { kind: 'stopped' }> {
    const attemptId = handle.attemptId;
    run.accepted.then(
      ({ dispatchId }) => {
        if (handle.epoch !== this.epoch) return;
        try {
          this.db.transact(`dispatch-confirmed:${stage}`, (d) => {
            const row = d.dispatch.find((x) => x.attemptId === attemptId && x.stage === stage);
            if (row && !row.confirmedAt) {
              row.confirmedAt = this.now();
              row.dispatchId = dispatchId;
            }
          });
          this.changed();
        } catch (e) {
          if (e instanceof SimulatedCrash) this.crash(e.point);
          else throw e;
        }
      },
      () => undefined,
    );

    const timeoutMs = Math.max(0, Math.min(this.options.timing.stageTimeoutMs, deadline - Date.now()));
    type Race = { kind: 'events'; events: AdapterEvent[] } | { kind: 'error'; message: string } | { kind: 'cancel' } | { kind: 'timeout' };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancelled = new Promise<Race>((resolve) => {
      handle.wake = () => resolve({ kind: 'cancel' });
    });
    const timedOut = new Promise<Race>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
    });
    const result = run.events.then(
      (events): Race => ({ kind: 'events', events }),
      (e: Error): Race => ({ kind: 'error', message: e.message }),
    );
    const first = await Promise.race([result, cancelled, timedOut]);
    clearTimeout(timer);
    handle.wake = null;
    this.alive(handle);
    if (first.kind === 'events' || first.kind === 'error') {
      handle.controller = null;
      this.markEnded(attemptId, stage, 'result', `dispatch-ended:${stage}`);
      return first;
    }

    // Cancellation semantics (also used for a timeout).
    if (first.kind === 'timeout') {
      this.setState(handle, 'cancelling', 'state:cancelling', (a) => {
        a.stateBeforeCancel = a.state;
        a.cancelReason = 'timeout';
      });
    }
    // Any result that still arrives is a late result: quarantined, never used.
    result.then((r) => {
      if (handle.epoch !== this.epoch || r.kind !== 'events') return;
      try {
        this.db.transact(`late-result:${stage}`, (d) => {
          d.lateResults.push({ attemptId, stage, note: 'A result arrived after cancellation or timeout. It was quarantined and not used or forwarded.' });
        });
        this.changed();
      } catch (e) {
        if (e instanceof SimulatedCrash) this.crash(e.point);
        else throw e;
      }
    });
    handle.controller?.abort();
    const grace = new Promise<boolean>((r) => setTimeout(() => r(false), this.options.timing.cancelGraceMs));
    const stopped = await Promise.race([run.stopped, grace]);
    this.alive(handle);
    handle.controller = null;
    if (stopped) this.markEnded(attemptId, stage, 'stopped', `dispatch-stopped:${stage}`);
    const a = this.attempt(attemptId);
    if (stopped) {
      if (a.cancelReason === 'timeout') this.finalize(handle, 'failed', `${stage} stage timed out after ${this.options.timing.stageTimeoutMs} ms (simulated; the plan proposes 180 s).`, null);
      else this.finalize(handle, 'cancelled', `Cancelled during the ${stage} stage. The owned (simulated) process confirmed exit.`, null);
    } else {
      this.setState(handle, 'cancellation_unconfirmed', 'state:cancellation-unconfirmed', (row) => {
        row.failureNote = `The owned (simulated) ${stage} process did not confirm exit within the ${this.options.timing.cancelGraceMs} ms grace window. Retry is blocked until this is resolved. Local cancellation does not promise that remote generation or billing stopped.`;
      });
    }
    return { kind: 'stopped' };
  }

  // ---------- cancellation ----------

  cancelAttempt(attemptId: string): AttemptRow {
    const a = this.attempt(attemptId);
    const handle = this.runs.get(attemptId);
    if (!handle || isTerminal(a.state) || a.state === 'cancelling' || a.state === 'cancellation_unconfirmed') {
      throw new UserError('This attempt is not running, so it cannot be cancelled.');
    }
    handle.cancelRequested = 'user';
    if (handle.wake) {
      this.setState(handle, 'cancelling', 'state:cancelling', (row) => {
        row.stateBeforeCancel = row.state;
        row.cancelReason = 'user';
      });
      handle.wake();
    }
    this.changed();
    return this.attempt(attemptId);
  }

  /** Explicit resolution of "Cancellation unconfirmed" (simulated: Ahmed confirms the owned process has stopped). */
  resolveCancellation(attemptId: string): AttemptRow {
    const a = this.attempt(attemptId);
    if (a.state !== 'cancellation_unconfirmed') throw new UserError('Only an attempt with unconfirmed cancellation can be resolved.');
    const reason =
      a.cancelReason === 'timeout'
        ? 'Stage timed out; the owned process was later confirmed stopped by an explicit resolution.'
        : 'Cancelled; the owned process was later confirmed stopped by an explicit resolution.';
    this.markEnded(a.id, null, 'resolved', 'dispatch-resolved-by-resolution');
    this.decideOutcome(a, a.cancelReason === 'timeout' ? 'failed' : 'cancelled', reason, null);
    this.publishFinalStatus(a.id, null);
    this.runs.delete(a.id);
    return this.attempt(attemptId);
  }

  // ---------- dispatch status (C3) ----------

  dispatchStatus(attemptId: string, stage: StageName): DispatchStatus {
    const row = this.t.dispatch.find((d) => d.attemptId === attemptId && d.stage === stage);
    if (row?.confirmedAt) return 'confirmed';
    if (row?.startedAt) return 'uncertain';
    const sent = this.t.recordFiles.find((r) => r.attemptId === attemptId && r.name === sentFileName(stage));
    if (sent && (sent.state === 'published' || sent.state === 'intended')) return 'prepared_not_dispatched';
    return 'not_prepared';
  }

  // ---------- recovery after a (simulated) crash ----------

  /**
   * F3 recovery. Every step can be repeated, so it is safe if recovery itself
   * crashes. 1: reconcile files without changing any outcome. 2: settle the
   * outcome (a, b, c). 3: record state is recomputed whenever shown.
   * Then F4 recovery for outside reviews.
   */
  recover(): { interrupted: number } {
    this.epoch += 1;
    this.runs.clear();
    this.recovering = true;
    let interrupted = 0;
    try {
      // Each attempt is reconciled and then settled on its own. If its files cannot be fully checked,
      // it is NOT settled on a partial picture: it is marked "recovery pending" (retry blocked) and
      // tried again on every start. One damaged folder never stops recovery for the others.
      for (const a of this.t.attempts) if (this.recoverAttempt(a.id)) interrupted += 1;
      this.recoverOutsideSaves();
    } finally {
      this.recovering = false;
    }
    this.crashedAt = null;
    this.note(`Recovery ran: ${interrupted} attempt(s) marked interrupted. No stage was re-run.`);
    this.changed();
    return { interrupted };
  }

  /** F3 steps 1 and 2 for one attempt. Returns true when it was marked interrupted. */
  private recoverAttempt(attemptId: string): boolean {
    try {
      this.reconcileFiles(attemptId);
      const interrupted = this.settleOutcome(attemptId);
      if (this.attempt(attemptId).recoveryPending) {
        this.db.transact('recovery:pending-cleared', (d) => {
          d.attempts.find((x) => x.id === attemptId)!.recoveryPending = null;
        });
      }
      return interrupted;
    } catch (e) {
      if (!(e instanceof SimFsError)) throw e;
      const a = this.attempt(attemptId);
      const reason = `its files could not be fully checked (${e.message})`;
      if (!a.final) {
        this.db.transact('recovery:pending', (d) => {
          d.attempts.find((x) => x.id === attemptId)!.recoveryPending = reason;
        });
      }
      this.note(`Recovery of attempt ${a.number} is waiting: ${reason}. It was not settled on a partial picture; it is tried again on every start.`);
      return false;
    }
  }

  /** Run one recovery step; a file error (an unreadable or odd entry) is noted, the step is retried on the next start, and recovery goes on. */
  private isolated(what: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      if (!(e instanceof SimFsError)) throw e;
      this.note(`Recovery: a file problem while ${what}: ${e.message}. It is tried again on the next start; everything else was still recovered.`);
    }
  }

  /** The simulated relaunch after a crash: runs recovery only if the app is still in the crashed state. */
  restartIfCrashed(): void {
    if (this.crashedAt !== null) this.recover();
  }

  get isRecovering(): boolean {
    return this.recovering;
  }

  /** The F2 block reason for the project that owns this clone, or null. */
  private blockedClone(fs: CloneFs): string | null {
    const p = this.t.projects.find((x) => this.clones.get(x.folderId) === fs);
    return p ? this.projectBlock(p.id) : null;
  }

  /**
   * F3 step 1. Reading the clone and updating the database always happen, so
   * the outcome settled in step 2 always sees every record that really was
   * published. Only the writes into the clone (quarantine moves) are held back
   * while the project is blocked (F2); they happen on the first start after the
   * folder matches again.
   */
  private reconcileFiles(attemptId: string): void {
    const a = this.attempt(attemptId);
    const blocked = this.projectBlock(a.projectId) !== null;
    const fs = this.cloneOf(a.projectId);
    const dir = attemptDir(a.taskId, a.id);
    for (const row of this.t.recordFiles.filter((r) => r.attemptId === a.id && r.state === 'intended')) {
      const path = `${dir}/${row.name}`;
      const have = fs.hash(path);
      if (have === row.plannedHash) {
        this.db.transact(`recovery:published:${row.name}`, (d) => {
          d.recordFiles.find((x) => x.attemptId === a.id && x.name === row.name)!.state = 'published';
        });
      } else if (have === undefined) {
        // Nothing readable at the name. Something that is not a regular file there (a folder, a
        // symlink) is never counted as published; it is left in place and the inventory lists it.
        const kind = fs.entryKind(path);
        this.db.transact(`recovery:not-published:${row.name}`, (d) => {
          const x = d.recordFiles.find((y) => y.attemptId === a.id && y.name === row.name)!;
          x.state = 'not_published';
          x.error = kind === null ? 'missing after restart' : `after restart, something that is not a regular file (${kind === 'dir' ? 'a folder' : 'another kind of entry'}) is at this name; not a valid record, left in place`;
        });
      } else if (!blocked) {
        this.quarantine(fs, dir, row.name, row.writeId);
        this.db.transact(`recovery:not-published:${row.name}`, (d) => {
          const x = d.recordFiles.find((y) => y.attemptId === a.id && y.name === row.name)!;
          x.state = 'not_published';
          x.error = 'mismatched after restart; moved to quarantine';
        });
      }
      // Blocked and mismatched: the row stays "intended" (not published, so never required),
      // and the quarantine move waits until the project is unblocked.
    }
    // A row recorded "not published" whose file is nevertheless at its final name with the planned
    // content: the move happened but its acknowledgement was lost. Adopt it before any outcome is
    // decided, so it is counted (and required). Different content there is someone else's: left alone.
    if (!a.finalizing) {
      for (const row of this.t.recordFiles.filter((r) => r.attemptId === a.id && r.state === 'not_published')) {
        if (fs.hash(`${dir}/${row.name}`) === row.plannedHash) {
          this.db.transact(`recovery:adopted:${row.name}`, (d) => {
            const x = d.recordFiles.find((y) => y.attemptId === a.id && y.name === row.name)!;
            x.state = 'published';
            x.error = null;
          });
        }
      }
    }
    if (blocked) return;
    // A write that detected a swap and could not move the swapped-in entry back: whatever is at the
    // record name is not the app's record. A regular file there goes to quarantine; anything else is
    // left in place and listed in the inventory. Never counted as published.
    for (const row of this.t.recordFiles.filter((r) => r.attemptId === a.id && r.state === 'not_published' && r.swap === 'not-moved-back')) {
      const path = `${dir}/${row.name}`;
      if (fs.entryKind(path) === 'file' && fs.hash(path) !== row.plannedHash) this.quarantine(fs, dir, row.name, row.writeId);
    }
    // Records already published: content that no longer matches its recorded hash is moved to
    // quarantine. The row stays "published", so the file stays required and the record state
    // shows it as quarantined (damaged). Nothing here changes an outcome.
    for (const row of this.t.recordFiles.filter((r) => r.attemptId === a.id && r.state === 'published')) {
      const have = fs.hash(`${dir}/${row.name}`);
      if (have !== undefined && have !== row.plannedHash) this.quarantine(fs, dir, row.name, row.writeId);
    }
    for (const path of fs.list(`${dir}/.tmp-`)) {
      const name = path.slice(dir.length + 1);
      this.quarantine(fs, dir, name, name.slice('.tmp-'.length));
    }
  }

  /** F3 safe quarantine move: no-replace link to quarantine/<name>-<write-id>(-n), then remove the old name. Repeatable. */
  quarantine(fs: CloneFs, dir: string, name: string, writeId: string): string {
    // F2: a quarantine move is a write; never write into a project that is blocked.
    if (this.blockedClone(fs)) return '';
    // Only regular files are moved; anything else (a symlink, a FIFO) is left for the inventory to show.
    if (fs.read(`${dir}/${name}`) === undefined) return '';
    const base = `${name}-${writeId}`;
    const label = name.startsWith('.tmp-') ? '.tmp' : name; // stable crash-point name
    for (let n = 1; n <= 100; n++) {
      const qName = n === 1 ? base : `${base}-${n}`;
      if (fs.hash(`${dir}/quarantine/${qName}`) !== undefined) continue;
      try {
        // Atomic no-replace move: whatever is at the name is moved, never deleted. Repeatable: after a
        // crash the source is simply gone.
        fs.quarantineMove(dir, name, qName);
      } catch (e) {
        if (e instanceof SimFsError && e.code === 'EEXIST') continue;
        if (e instanceof SimFsError && swapKind(e)) {
          // Plan revision 9: block and warn, as for a record write.
          const p = this.t.projects.find((x) => this.clones.get(x.folderId) === fs);
          if (p) {
            const parts = dir.split('/');
            const taskId = parts[1] ?? null;
            const attemptId = parts[2] && parts[2] !== 'outside' ? parts[2] : null;
            const block = this.swapBlockFor(fs, dir, name, `quarantine/${qName}`, e, 'quarantine', { taskId, attemptId });
            this.db.transact('project-swap-block', (d) => this.blockForSwap(d, p.id, block));
            this.noteSwap(p.id, block);
            this.changed();
          }
        }
        throw e;
      }
      this.hooks.point(`quarantine:${label}:moved`);
      try {
        fs.flush(`${dir}/quarantine`);
        fs.flush(dir);
      } catch (e) {
        if (!(e instanceof SimFsError)) throw e;
        this.note(`${dir}/${name} was moved to quarantine, but flushing failed: ${e.message}.`);
      }
      return `${dir}/quarantine/${qName}`;
    }
    throw new Error('quarantine: too many name collisions');
  }



  /** Returns true when the attempt was marked interrupted by this call. */
  private settleOutcome(attemptId: string): boolean {
    const a = this.attempt(attemptId);
    if (a.final) {
      // Already final: the outcome is left alone, but a missing final-status.json is
      // republished from the exact bytes kept when the outcome was decided.
      this.republishFinalStatus(a.id);
      return false;
    }
    // (a) An outcome is already recorded: keep it and (re)publish the same final-status bytes.
    if (a.finalizing) {
      this.publishFinalStatus(a.id, null);
      return false;
    }
    // (b) No outcome recorded, but a published final-status.json for this attempt exists and is consistent.
    const fs = this.cloneOf(a.projectId);
    const dir = attemptDir(a.taskId, a.id);
    const text = fs.read(`${dir}/${FINAL_STATUS}`);
    if (text !== undefined) {
      const adopted = this.tryAdopt(a, text);
      if (adopted) return false;
      this.quarantine(fs, dir, FINAL_STATUS, 'unadoptable');
    }
    // (c) Neither: it was still running (or cancelling, or cancellation unconfirmed).
    const was = a.state;
    this.decideOutcome(a, 'interrupted', `The app stopped while this attempt was ${was.replace('_', ' ')}. No stage is re-run automatically; unknown remote completion stays unknown.`, null);
    this.publishFinalStatus(a.id, null);
    return true;
  }

  /** Rule (b) check: is this final-status.json a valid, consistent record for this attempt? Never throws. */
  private adoptable(a: AttemptRow, text: string): { outcome: Outcome; reason: string | null; completionLabel: string | null; decidedAt: string | null } | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const o = parsed as Record<string, unknown>;
    const outcomes: Outcome[] = ['complete', 'needs_attention', 'failed', 'cancelled', 'interrupted'];
    if (o.attemptId !== a.id || o.taskId !== a.taskId || !outcomes.includes(o.outcome as Outcome)) return null;
    if (!Array.isArray(o.files)) return null;
    const listed: { name: string; sha256: string }[] = [];
    for (const f of o.files) {
      if (f === null || typeof f !== 'object' || Array.isArray(f)) return null;
      const { name, sha256: hash } = f as Record<string, unknown>;
      if (typeof name !== 'string' || typeof hash !== 'string') return null;
      listed.push({ name, sha256: hash });
    }
    const outcome = o.outcome as Outcome;
    // The listed files must be exactly the record files the database knows as published ...
    const known = this.publishedFiles(a.id);
    const same = listed.length === known.length && listed.every((f, i) => known[i]?.name === f.name && known[i]?.sha256 === f.sha256);
    if (!same) return null;
    // ... and they must be able to support the outcome (C2): never adopt "complete" without every stage.
    if (fileListIsConsistent(outcome, listed.map((f) => f.name))) return null;
    return {
      outcome,
      reason: typeof o.reason === 'string' ? o.reason : null,
      completionLabel: typeof o.completionLabel === 'string' ? o.completionLabel : null,
      decidedAt: typeof o.decidedAt === 'string' ? o.decidedAt : null,
    };
  }

  private tryAdopt(a: AttemptRow, text: string): boolean {
    const ok = this.adoptable(a, text);
    if (!ok) return false;
    const known = this.publishedFiles(a.id);
    const parsed = ok;
    const outcome = parsed.outcome;
    const fin: FinalizingRecord = {
      outcome,
      reason: parsed.reason,
      completionLabel: parsed.completionLabel,
      files: known,
      finalStatusBytes: text,
      finalStatusHash: sha256(text),
      decidedAt: parsed.decidedAt ?? this.now(),
    };
    this.db.transact('recovery:adopt-finalizing', (d) => {
      const row = d.attempts.find((x) => x.id === a.id)!;
      row.state = outcome;
      row.finalizing = fin;
      d.recordFiles = d.recordFiles.filter((r) => !(r.attemptId === a.id && r.name === FINAL_STATUS));
      d.recordFiles.push({ attemptId: a.id, name: FINAL_STATUS, writeId: 'adopted', plannedHash: fin.finalStatusHash, state: 'published', error: null });
    });
    this.db.transact('recovery:adopt-final', (d) => {
      d.attempts.find((x) => x.id === a.id)!.final = true;
    });
    return true;
  }

  // ---------- outside reviews (F4) ----------

  saveOutsideReview(input: { taskId: string; source: 'chatgpt' | 'claude-app'; text: string }): OutsideSaveRow {
    const task = this.task(input.taskId);
    if (!input.text.trim()) throw new UserError('Paste the review text first.');
    const block = this.projectBlock(task.projectId);
    if (block) throw new UserError(`Not saved: ${block}`);
    const fs = this.cloneOf(task.projectId);
    const dir = `${taskDir(task.id)}/outside`;
    const date = this.now().slice(0, 10);
    const content = `Pasted by Ahmed; source not verified by the app\n\nSource chosen: ${input.source === 'chatgpt' ? 'ChatGPT' : 'Claude app'}\nSaved: ${date}\n\n---\n\n${input.text}\n`;
    const saveId = newId('o');
    const used = this.t.outsideSaves.filter((s) => s.taskId === task.id).map((s) => s.number);
    let number = Math.max(0, ...used) + 1;
    this.db.transact('outside:intended', (d) => {
      d.outsideSaves.push({ saveId, taskId: task.id, projectId: task.projectId, source: input.source, textHash: sha256(content), content, date, number, state: 'intended', damaged: null });
    });
    const tmpName = `.tmp-${saveId}`;
    const dh = fs.openDir(dir);
    try {
      dh.createExclusive(tmpName, content);
      this.hooks.point('outside:tmp-written');
      for (let tries = 0; ; tries++) {
        if (tries >= 100) {
          this.db.transact('outside:not-saved', (d) => {
            d.outsideSaves.find((s) => s.saveId === saveId)!.state = 'not_saved';
          });
          throw new UserError('Could not find a free outside-review number after 100 tries. The pasted text was kept as a temporary file; it is moved to quarantine on the next start.');
        }
        const target = `${number}-${input.source}-${date}.md`;
        try {
          dh.publish(tmpName, target); // no-replace move
          this.hooks.point('outside:moved');
          break;
        } catch (e) {
          if (e instanceof SimFsError && swapKind(e)) {
            // Plan revision 9: nothing is saved from this write, and the project is blocked.
            const block = this.swapBlockFor(fs, dir, tmpName, target, e, 'outside-review', { taskId: task.id, attemptId: null });
            this.db.transact('outside:not-saved', (d) => {
              d.outsideSaves.find((s) => s.saveId === saveId)!.state = 'not_saved';
              this.blockForSwap(d, task.projectId, block);
            });
            this.noteSwap(task.projectId, block);
            this.changed();
            throw new UserError(`Not saved. ${swapBlockMessage(block)}`);
          }
          if (!(e instanceof SimFsError) || e.code !== 'EEXIST') throw e;
          number += 1;
          this.db.transact('outside:renumber', (d) => {
            d.outsideSaves.find((s) => s.saveId === saveId)!.number = number;
          });
        }
      }
      try {
        dh.sync();
      } catch (e) {
        if (!(e instanceof SimFsError)) throw e;
        this.note(`The outside review was saved, but flushing its folder failed: ${e.message}.`);
      }
    } finally {
      dh.close();
    }
    this.db.transact('outside:published', (d) => {
      d.outsideSaves.find((s) => s.saveId === saveId)!.state = 'published';
    });
    this.changed();
    return this.t.outsideSaves.find((s) => s.saveId === saveId)!;
  }

  outsidePath(s: OutsideSaveRow): string {
    return `${taskDir(s.taskId)}/outside/${s.number}-${s.source}-${s.date}.md`;
  }

  /**
   * F4 recovery. Each save, and each task's outside/ folder, is recovered on its own: an unreadable
   * one is noted, left as it is, and tried again on the next start; the others are still recovered
   * and their temporary files cleaned up.
   */
  private recoverOutsideSaves(): void {
    for (const s of this.t.outsideSaves) {
      this.isolated(`recovering outside review ${this.outsidePath(s)}`, () => this.recoverOutsideSave(s.saveId));
    }
    // Any .tmp- file left in a task's outside/ folder, whatever its save's state, goes to
    // outside/quarantine/. Only each task's own outside/ folder is listed.
    for (const t of this.t.tasks) {
      if (this.projectBlock(t.projectId)) continue;
      const fs = this.cloneOf(t.projectId);
      const dir = `${taskDir(t.id)}/outside`;
      this.isolated(`cleaning temporary files in ${dir}`, () => {
        for (const path of fs.list(`${dir}/.tmp-`)) {
          const name = path.slice(dir.length + 1);
          this.isolated(`cleaning ${path}`, () => void this.quarantine(fs, dir, name, name.slice('.tmp-'.length)));
        }
      });
    }
  }

  private recoverOutsideSave(saveId: string): void {
    const s = this.t.outsideSaves.find((x) => x.saveId === saveId)!;
    if (this.projectBlock(s.projectId)) return;
    const fs = this.cloneOf(s.projectId);
    const path = this.outsidePath(s);
    const have = fs.hash(path);
    if (s.state === 'intended') {
      const next = have === s.textHash ? 'published' : 'not_saved';
      this.db.transact(`recovery:outside:${next}`, (d) => {
        d.outsideSaves.find((x) => x.saveId === s.saveId)!.state = next;
      });
    } else if (s.state === 'published') {
      let damaged: string | null = null;
      if (have === undefined) damaged = 'file is missing';
      else if (have !== s.textHash) {
        damaged = 'content does not match; moved to quarantine';
        this.quarantine(fs, `${taskDir(s.taskId)}/outside`, path.split('/').pop()!, s.saveId);
      }
      if (damaged !== s.damaged) {
        this.db.transact('recovery:outside:damaged', (d) => {
          d.outsideSaves.find((x) => x.saveId === s.saveId)!.damaged = damaged;
        });
      }
    }
  }

  // ---------- record state ----------

  /**
   * Record state of one attempt. If its files cannot be read right now (an unreadable folder, a
   * disk error), that attempt alone shows "cannot be checked right now" with the path and error;
   * it never stops other attempts or tasks from loading.
   */
  recordState(attemptId: string): RecordState {
    const a = this.attempt(attemptId);
    const fs = this.cloneOf(a.projectId);
    try {
      return computeRecordState(a, fs, this.t.recordFiles);
    } catch (e) {
      if (!(e instanceof SimFsError)) throw e;
      return { kind: 'unchecked', path: `${fs.root}/${attemptDir(a.taskId, a.id)}`, error: e.message };
    }
  }

  /** Simulation control: change or remove a record file behind the app's back. */
  damageRecord(attemptId: string, file: string, mode: 'delete' | 'alter'): void {
    const a = this.attempt(attemptId);
    if (!(ALL_RECORD_FILES as readonly string[]).includes(file)) throw new UserError('Unknown record file.');
    const fs = this.cloneOf(a.projectId);
    if (!fs.supportsExternalEdits) {
      throw new UserError('In persistent mode the app never changes its own records. Edit or delete the file yourself (for example in Finder) to see a damaged record.');
    }
    const path = `${attemptDir(a.taskId, a.id)}/${file}`;
    if (!fs.exists(path)) throw new UserError('That record file is not on disk.');
    if (mode === 'delete') fs.externalDelete(path);
    else fs.externalWrite(path, `${fs.read(path)}\n(simulated outside change)\n`);
    this.note(`Simulation: ${file} of attempt ${a.number} was ${mode === 'delete' ? 'deleted' : 'changed'} outside the app.`);
    this.changed();
  }
}

/** The blocking reason shown everywhere for a detected swap (plan revision 9). */
export function swapBlockMessage(b: SwapBlock): string {
  return `Check this folder. Something replaced a file while the app was saving it: ${b.folder} (${b.sourceName} → ${b.destinationName}). ${
    b.movedBack ? 'The entry that was swapped in was moved back to its original name.' : `The entry that was swapped in could NOT be moved back; it may still be at ${b.destinationName}.`
  } Nothing was published from that write. No task or write runs in this project until you choose "I have checked this folder".`;
}

function removeTaskRows(d: Tables, taskIds: string[]): void {
  const attemptIds = d.attempts.filter((a) => taskIds.includes(a.taskId)).map((a) => a.id);
  d.tasks = d.tasks.filter((t) => !taskIds.includes(t.id));
  d.attempts = d.attempts.filter((a) => !taskIds.includes(a.taskId));
  d.recordFiles = d.recordFiles.filter((r) => !attemptIds.includes(r.attemptId));
  d.dispatch = d.dispatch.filter((r) => !attemptIds.includes(r.attemptId));
  d.artifacts = d.artifacts.filter((r) => !attemptIds.includes(r.attemptId));
  d.rejections = d.rejections.filter((r) => !attemptIds.includes(r.attemptId));
  d.lateResults = d.lateResults.filter((r) => !attemptIds.includes(r.attemptId));
  d.outsideSaves = d.outsideSaves.filter((s) => !taskIds.includes(s.taskId));
}

export type { StageOutput };
