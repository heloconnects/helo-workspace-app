// The operation layer behind the typed IPC. Every argument from the renderer
// is untrusted: it is schema- and size-checked here, and ownership is always
// derived from stored records, never from IDs the renderer supplies alone.

import { API_METHODS, type ApiMethod, type HeloApi, type Result } from '../shared/api.js';
import {
  PROVIDER_LABEL,
  STAGES,
  type AttemptView,
  type Business,
  type ConnectionView,
  type InventoryView,
  type ProjectView,
  type Provider,
  type StageView,
  type TaskSummary,
  type TaskView,
} from '../shared/types.js';
import { UserError, type Workspace } from './engine.js';
import { SCENARIO_PRESETS, scenarioById } from './fixtures.js';
import { byteLength } from './hash.js';
import { outputFileName, sentFileName, sharingPlanView } from './packet.js';
import { attemptDir, displayLine, INVENTORY_WARNING, inventoryEntries, taskDir } from './records.js';
import { isTerminal } from './state-machine.js';
import { SimulatedCrash } from './sim-store.js';

// Compile-time check that API_METHODS lists every HeloApi operation.
type MissingMethods = Exclude<keyof HeloApi, ApiMethod>;
const _allListed: [MissingMethods] extends [never] ? true : never = true;
void _allListed;

export const LIMITS = {
  name: 120,
  title: 200,
  brief: 20_000,
  criterion: 500,
  criteria: 20,
  sources: 20,
  outsideText: 100_000,
  id: 64,
  key: 128,
};

class BadInput extends Error {}

function obj(v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new BadInput('expected an object');
  return v as Record<string, unknown>;
}

function str(o: Record<string, unknown>, k: string, max: number): string {
  const v = o[k];
  if (typeof v !== 'string') throw new BadInput(`${k} must be text`);
  if (v.length > max) throw new BadInput(`${k} is longer than ${max} characters`);
  return v;
}

function bool(o: Record<string, unknown>, k: string): boolean {
  const v = o[k];
  if (typeof v !== 'boolean') throw new BadInput(`${k} must be true or false`);
  return v;
}

function oneOf<T extends string>(o: Record<string, unknown>, k: string, allowed: readonly T[]): T {
  const v = o[k];
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) throw new BadInput(`${k} is not an allowed value`);
  return v as T;
}

function strList(o: Record<string, unknown>, k: string, maxItems: number, maxLen: number): string[] {
  const v = o[k];
  if (!Array.isArray(v) || v.length > maxItems || !v.every((x) => typeof x === 'string' && x.length <= maxLen)) {
    throw new BadInput(`${k} must be a list of at most ${maxItems} short texts`);
  }
  return v as string[];
}

const PROVIDERS: readonly Provider[] = ['claude', 'codex'];
const BUSINESSES: readonly Business[] = ['fictional-a', 'fictional-b'];

export class Service implements HeloApi {
  constructor(readonly ws: Workspace) {}

  /** Entry point for IPC: method name from the allow-list, one untrusted argument. */
  async dispatch(method: string, arg: unknown): Promise<Result<unknown>> {
    if (!(API_METHODS as readonly string[]).includes(method)) return { ok: false, error: 'Unknown operation.' };
    const fn = (this as unknown as Record<string, (a: unknown) => Promise<Result<unknown>>>)[method]!;
    return fn.call(this, arg);
  }

  private wrap<T>(f: () => T): Promise<Result<T>> {
    try {
      return Promise.resolve({ ok: true, value: f() });
    } catch (e) {
      if (e instanceof UserError) return Promise.resolve({ ok: false, error: e.message });
      if (e instanceof BadInput) return Promise.resolve({ ok: false, error: `Rejected input: ${e.message}.` });
      if (e instanceof SimulatedCrash) {
        this.ws.crash(e.point);
        return Promise.resolve({ ok: false, error: `The app crashed (simulated) at ${e.point}.` });
      }
      return Promise.resolve({ ok: false, error: `Unexpected error: ${(e as Error).message}` });
    }
  }

  // ---------- views ----------

  projectView(id: string): ProjectView {
    const p = this.ws.project(id);
    const f = this.ws.folder(p.folderId);
    return {
      id: p.id,
      name: p.name,
      business: p.business,
      folder: p.folderPath,
      repoConfirmed: p.repoConfirmed,
      archived: p.archived,
      instructions: f.files['RULES.md'] ?? '(RULES.md missing)',
      sources: this.ws.sourcesOf(p.id).map((s) => ({ sourceId: s.sourceId, path: s.path, bytes: byteLength(s.content) })),
      blocked: this.ws.projectBlock(p.id),
      taskCount: this.ws.t.tasks.filter((t) => t.projectId === p.id).length,
    };
  }

  attemptView(attemptId: string): AttemptView {
    const ws = this.ws;
    const a = ws.attempt(attemptId);
    const task = ws.task(a.taskId);
    const record = ws.recordState(a.id);
    const outcome = a.finalizing?.outcome ?? null;
    const stages: StageView[] = STAGES.map((stage) => {
      const provider = stage === 'review' ? task.packet.roles.reviewer : stage === 'draft' ? task.packet.roles.drafter : task.packet.roles.synthesizer;
      const art = ws.t.artifacts.find((x) => x.attemptId === a.id && x.stage === stage);
      const rej = ws.t.rejections.find((x) => x.attemptId === a.id && x.stage === stage);
      const disp = ws.t.dispatch.find((x) => x.attemptId === a.id && x.stage === stage);
      return {
        stage,
        provider,
        providerLabel: PROVIDER_LABEL[provider],
        dispatch: ws.dispatchStatus(a.id, stage),
        sentFile: `${attemptDir(task.id, a.id)}/${sentFileName(stage)}`,
        outputFile: `${attemptDir(task.id, a.id)}/${outputFileName(stage)}`,
        payloadHash: disp?.payloadHash ?? null,
        output: art ? (art.output as StageView['output']) : null,
        rejection: rej?.reason ?? null,
        requestedModel: art?.requestedModel ?? (disp ? ws.adapters[provider].requestedModel : null),
        reportedProvider: art?.reportedProvider ?? null,
        reportedModel: art?.reportedModel ?? null,
      };
    });
    const live = !isTerminal(a.state);
    return {
      id: a.id,
      number: a.number,
      state: a.state,
      outcome,
      display: displayLine(a.state, outcome, a.finalizing?.completionLabel ?? null, record),
      completionLabel: a.finalizing?.completionLabel ?? null,
      reason: a.finalizing?.reason ?? a.failureNote ?? null,
      recordState: record,
      finalStatusOnDisk: a.final,
      stages,
      lateResults: ws.t.lateResults.filter((l) => l.attemptId === a.id).map((l) => ({ stage: l.stage, note: l.note })),
      canCancel: live && a.state !== 'cancelling' && a.state !== 'cancellation_unconfirmed',
      canResolveCancellation: a.state === 'cancellation_unconfirmed',
      startedAt: a.createdAt,
      usage: 'Unavailable (the simulated adapters report no usage)',
    };
  }

  taskView(taskId: string): TaskView {
    const ws = this.ws;
    const t = ws.task(taskId);
    const p = ws.project(t.projectId);
    const block = ws.startBlock(t.id);
    return {
      id: t.id,
      projectId: p.id,
      projectName: p.name,
      title: t.title,
      brief: t.brief,
      acceptanceCriteria: t.acceptanceCriteria,
      roles: t.packet.roles,
      sources: t.sources.map((s) => ({ sourceId: s.sourceId, displayName: s.displayName, sha256: s.sha256, bytes: byteLength(s.content) })),
      packetHash: t.packetHash,
      sharing: sharingPlanView(t.packet.roles, t.packetHash),
      scenarioLabel: scenarioById(t.scenarioId)?.label ?? t.scenarioId,
      attempts: ws.attemptsOf(t.id).map((a) => this.attemptView(a.id)),
      outsideReviews: ws.t.outsideSaves
        .filter((s) => s.taskId === t.id)
        .sort((a, b) => a.number - b.number)
        .map((s) => ({
          saveId: s.saveId,
          number: s.state === 'published' ? s.number : null,
          source: s.source,
          state: s.damaged ? 'damaged' : s.state,
          path: s.state === 'published' ? ws.outsidePath(s) : null,
          text: s.state === 'published' ? s.content : null,
          note: s.damaged ?? (s.state === 'not_saved' ? 'Not saved. Paste it again.' : null),
        })),
      canStartAttempt: block === null,
      startBlockedReason: block,
      needsStopAcknowledgement: ws.needsStopAcknowledgement(t.id),
    };
  }

  taskSummary(taskId: string): TaskSummary {
    const t = this.ws.task(taskId);
    const attempts = this.ws.attemptsOf(t.id);
    const last = attempts[attempts.length - 1];
    let latest: TaskSummary['latest'] = null;
    if (last) {
      const v = this.attemptView(last.id);
      latest = { attemptId: v.id, state: v.state, recordState: v.recordState, display: v.display };
    }
    return { id: t.id, title: t.title, drafter: t.drafter, createdAt: t.createdAt, latest };
  }

  // ---------- operations ----------

  listSimFolders() {
    return this.wrap(() =>
      this.ws.folders.map((f) => ({
        id: f.id,
        path: f.path,
        rulesBusiness: f.rulesBusiness,
        files: Object.entries(f.files).map(([path, c]) => ({ path, bytes: byteLength(c) })),
      })),
    );
  }

  listScenarios() {
    return this.wrap(() => SCENARIO_PRESETS);
  }

  listProjects() {
    return this.wrap(() => this.ws.t.projects.map((p) => this.projectView(p.id)));
  }

  registerProject(arg: unknown) {
    return this.wrap(() => {
      const o = obj(arg);
      const p = this.ws.registerProject({
        folderId: str(o, 'folderId', LIMITS.id),
        business: oneOf(o, 'business', BUSINESSES),
        name: str(o, 'name', LIMITS.name),
        repoConfirmed: bool(o, 'repoConfirmed'),
      });
      return this.projectView(p.id);
    });
  }

  renameProject(arg: unknown) {
    return this.wrap(() => {
      const o = obj(arg);
      return this.projectView(this.ws.renameProject(str(o, 'projectId', LIMITS.id), str(o, 'name', LIMITS.name)).id);
    });
  }

  archiveProject(arg: unknown) {
    return this.wrap(() => {
      const o = obj(arg);
      return this.projectView(this.ws.archiveProject(str(o, 'projectId', LIMITS.id), bool(o, 'archived')).id);
    });
  }

  deleteProject(arg: unknown) {
    return this.wrap(() => {
      this.ws.deleteProject(str(obj(arg), 'projectId', LIMITS.id));
      return { removed: true as const };
    });
  }

  listTasks(arg: unknown) {
    return this.wrap(() => {
      const projectId = str(obj(arg), 'projectId', LIMITS.id);
      this.ws.project(projectId);
      return this.ws.t.tasks
        .filter((t) => t.projectId === projectId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((t) => this.taskSummary(t.id));
    });
  }

  private compose(arg: unknown) {
    const o = obj(arg);
    const scenarioId = str(o, 'scenarioId', LIMITS.id);
    const preset = scenarioById(scenarioId);
    if (!preset) throw new BadInput('unknown simulation scenario');
    const criteria = strList(o, 'acceptanceCriteria', LIMITS.criteria, LIMITS.criterion).map((c) => c.trim()).filter(Boolean);
    return {
      projectId: str(o, 'projectId', LIMITS.id),
      title: str(o, 'title', LIMITS.title),
      brief: str(o, 'brief', LIMITS.brief),
      acceptanceCriteria: criteria,
      sourceIds: strList(o, 'sourceIds', LIMITS.sources, LIMITS.id + 200),
      drafter: oneOf(o, 'drafter', PROVIDERS),
      scenarioId,
      scenario: preset.scenario,
    };
  }

  previewSharing(arg: unknown) {
    return this.wrap(() => {
      const c = this.compose(arg);
      const built = this.ws.composePacket({ ...c, taskId: 't-preview' });
      return sharingPlanView(built.packet.roles, built.hash);
    });
  }

  createTask(arg: unknown) {
    return this.wrap(() => ({ taskId: this.ws.createTask(this.compose(arg)).id }));
  }

  getTask(arg: unknown) {
    return this.wrap(() => this.taskView(str(obj(arg), 'taskId', LIMITS.id)));
  }

  deleteTask(arg: unknown) {
    return this.wrap(() => {
      this.ws.deleteTask(str(obj(arg), 'taskId', LIMITS.id));
      return { removed: true as const };
    });
  }

  startAttempt(arg: unknown) {
    return this.wrap(() => {
      const o = obj(arg);
      const a = this.ws.startAttempt({
        taskId: str(o, 'taskId', LIMITS.id),
        approvedPacketHash: str(o, 'approvedPacketHash', 64),
        idempotencyKey: str(o, 'idempotencyKey', LIMITS.key),
        acknowledgePriorStopped: bool(o, 'acknowledgePriorStopped'),
      });
      return { attemptId: a.id };
    });
  }

  cancelAttempt(arg: unknown) {
    return this.wrap(() => this.attemptView(this.ws.cancelAttempt(str(obj(arg), 'attemptId', LIMITS.id)).id));
  }

  resolveCancellation(arg: unknown) {
    return this.wrap(() => this.attemptView(this.ws.resolveCancellation(str(obj(arg), 'attemptId', LIMITS.id)).id));
  }

  saveOutsideReview(arg: unknown) {
    return this.wrap(() => {
      const o = obj(arg);
      const s = this.ws.saveOutsideReview({
        taskId: str(o, 'taskId', LIMITS.id),
        source: oneOf(o, 'source', ['chatgpt', 'claude-app'] as const),
        text: str(o, 'text', LIMITS.outsideText),
      });
      return { saveId: s.saveId };
    });
  }

  getInventory(arg: unknown) {
    return this.wrap((): InventoryView => {
      const taskId = str(obj(arg), 'taskId', LIMITS.id);
      const t = this.ws.task(taskId);
      const fs = this.ws.cloneOf(t.projectId);
      return {
        taskId,
        root: `${fs.root}/${taskDir(taskId)}`,
        entries: inventoryEntries(fs, taskId),
        attempts: this.ws.attemptsOf(taskId).map((a) => {
          const v = this.attemptView(a.id);
          return { attemptId: a.id, number: a.number, display: v.display, recordState: v.recordState };
        }),
        warning: INVENTORY_WARNING,
      };
    });
  }

  exportArtifacts(arg: unknown) {
    return this.wrap(() => {
      const t = this.taskView(str(obj(arg), 'taskId', LIMITS.id));
      const lines = [`Export preview (simulation; no file is written): ${t.title}`, ''];
      for (const a of t.attempts) {
        lines.push(`Attempt ${a.number}: ${a.display}`);
        for (const s of a.stages) {
          lines.push(`  ${s.stage} by ${s.providerLabel} (simulated adapter): ${s.output ? 'validated output' : s.rejection ? `rejected: ${s.rejection}` : 'no output'}`);
        }
      }
      return { text: lines.join('\n') };
    });
  }

  getConnection() {
    return this.wrap((): ConnectionView => {
      const row = (check: string, v = 'UNVERIFIED (simulation; nothing checked)') => ({ check, codex: v, claude: v });
      return {
        providers: (['claude', 'codex'] as const).map((p) => ({
          provider: p,
          label: PROVIDER_LABEL[p],
          adapter: `Simulated adapter (${this.ws.adapters[p].version}). Not connected to any real service.`,
          executable: 'Not checked. The simulation does not look for, start or run any provider program.',
          signedIn: 'Not applicable in the simulation. The app never reads credentials.',
          diagnostic: 'Fake adapter responds with canned, made-up text.',
        })),
        checklist: [
          row('Supported versions', 'UNVERIFIED; none selected'),
          row('Authentication'),
          row('Account eligibility'),
          row('Billing'),
          row('Invocation'),
          row('Tools and context', 'UNVERIFIED — BLOCKER'),
          row('Output validation'),
          row('Cancellation'),
          row('Data handling'),
        ],
        note: 'No live route is approved. Fake adapter tests do not prove real provider controls.',
      };
    });
  }

  getEvents() {
    return this.wrap(() => [...this.ws.events]);
  }

  simulateCrashAndRestart() {
    return this.wrap(() => {
      this.ws.crash('manual crash button');
      const r = this.ws.recover();
      return { recovered: r.interrupted };
    });
  }

  simulateDamage(arg: unknown) {
    return this.wrap(() => {
      const o = obj(arg);
      const attemptId = str(o, 'attemptId', LIMITS.id);
      this.ws.damageRecord(attemptId, str(o, 'file', 64), oneOf(o, 'mode', ['delete', 'alter'] as const));
      return this.attemptView(attemptId);
    });
  }
}

