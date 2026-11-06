// Fake provider adapters. They make no network call and start no process.
// They return canned, plainly fictional text after a short delay, and can be
// told to fail, time out, refuse, hang or return malformed output so that
// every state can be shown. They do not prove anything about real provider
// controls.

import { PROVIDER_LABEL, type Provider, type Scenario, type StageBehaviour, type StageName } from '../shared/types.js';
import { sha256 } from './hash.js';

export const FAKE_ADAPTER_VERSION = 'fake-adapter 0.1.0';

export type AdapterEvent =
  | { type: 'start' }
  | { type: 'tool_use'; name: string }
  | { type: 'error'; message: string }
  | { type: 'final'; text: string; reportedProvider: string; reportedModel: string; stopReason: 'end' | 'max_tokens' };

export interface AdapterRequest {
  stage: StageName;
  payload: string;
  requestedModel: string;
}

export interface AdapterRun {
  /** Resolves when the (fake) provider acknowledges the request. */
  accepted: Promise<{ dispatchId: string }>;
  /** Resolves with the event stream, or never (timeout / hang). */
  events: Promise<AdapterEvent[]>;
  /** After abort: resolves true once the owned (fake) process has confirmed exit. Never resolves if it ignores cancellation. */
  stopped: Promise<boolean>;
}

export interface AdapterTiming {
  /** Delay before the fake provider answers. */
  responseMs: number;
  /** How long a hanging adapter takes to deliver its late result. */
  lateResultMs: number;
}

export interface ReceivedRequest {
  provider: Provider;
  stage: StageName;
  payload: string;
  payloadHash: string;
}

export class FakeAdapter {
  readonly version = FAKE_ADAPTER_VERSION;
  readonly requestedModel: string;
  /** Every payload this adapter received, byte for byte (for transmission tests). */
  readonly received: ReceivedRequest[] = [];
  private counter = 0;

  constructor(
    readonly provider: Provider,
    private readonly getTiming: () => AdapterTiming,
  ) {
    this.requestedModel = `simulated-${provider}-model`;
  }

  start(req: AdapterRequest, signal: AbortSignal, scenario: Scenario): AdapterRun {
    const behaviour: StageBehaviour = scenario[req.stage];
    const payloadHash = sha256(req.payload);
    this.received.push({ provider: this.provider, stage: req.stage, payload: req.payload, payloadHash });
    const dispatchId = `sim-${this.provider}-${++this.counter}`;
    const timing = this.getTiming();
    const ms = timing.responseMs;

    let resolveStopped!: (v: boolean) => void;
    const stopped = new Promise<boolean>((r) => (resolveStopped = r));

    const accepted = delay(Math.min(ms, 5)).then(() => ({ dispatchId }));

    const events = new Promise<AdapterEvent[]>((resolve, reject) => {
      const finish = () => resolve(this.respond(req, payloadHash, behaviour, scenario));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const neverAnswers = behaviour === 'timeout' || behaviour === 'hang-ignore-cancel';
      const slow = behaviour === 'late-result-after-cancel';

      if (behaviour === 'fail') {
        timer = setTimeout(() => reject(new AdapterProcessError('simulated provider process exited with code 1')), ms);
      } else if (!neverAnswers) {
        timer = setTimeout(finish, slow ? timing.lateResultMs : ms);
      }

      signal.addEventListener(
        'abort',
        () => {
          if (behaviour === 'hang-ignore-cancel') {
            // Ignores cancellation, never confirms exit, and delivers a late result later.
            setTimeout(() => resolve(this.respond(req, payloadHash, 'ok', scenario)), timing.lateResultMs);
            return;
          }
          if (behaviour === 'late-result-after-cancel') {
            // Confirms exit, but a result still arrives afterwards (a late event).
            resolveStopped(true);
            return;
          }
          if (timer) clearTimeout(timer);
          resolveStopped(true);
        },
        { once: true },
      );
    });
    // Unhandled rejections are expected when the engine has stopped listening.
    events.catch(() => undefined);
    return { accepted, events, stopped };
  }

  private respond(req: AdapterRequest, inputHash: string, behaviour: StageBehaviour, scenario: Scenario): AdapterEvent[] {
    const payload = JSON.parse(req.payload) as {
      taskId: string;
      attemptId: string;
      packet: { acceptanceCriteria: string[]; sources: { sourceId: string }[] };
      review?: { findings: { id: string }[]; unresolved: string[] };
    };
    const base = {
      protocol: 'helo-sim-v1',
      kind: req.stage,
      taskId: payload.taskId,
      attemptId: payload.attemptId,
      inputHash: behaviour === 'wrong-hash' ? sha256('a different payload') : inputHash,
    };
    const who = `${PROVIDER_LABEL[this.provider]} (simulated adapter)`;
    let body: Record<string, unknown>;
    if (req.stage === 'draft') {
      body = {
        ...base,
        draft:
          behaviour === 'empty'
            ? ''
            : `Example draft for a made-up task. ${who} wrote this placeholder text. It is not real AI output and contains no business content.`,
        sourceRefs: payload.packet.sources.map((s) => s.sourceId),
        assumptions: ['Example assumption: the made-up task needs one short paragraph.'],
        limitations: ['Simulated output: nothing was checked or researched.'],
        unmetCriteria: [],
      };
    } else if (req.stage === 'review') {
      const findings = scenario.noIssues
        ? []
        : [
            { id: 'F1', severity: 'medium', evidence: 'Example evidence: the first sentence of the made-up draft.', text: 'Example finding: the made-up draft could state its assumption more plainly.' },
            { id: 'F2', severity: 'low', evidence: 'Example evidence: the closing line of the made-up draft.', text: 'Example finding: the made-up draft could be shorter.' },
          ];
      body = {
        ...base,
        verdict: behaviour === 'empty' ? '' : scenario.noIssues ? 'Example verdict: no issues found (simulated).' : 'Example verdict: acceptable with changes (simulated).',
        findings,
        corrections: scenario.noIssues ? [] : ['Example correction: name the assumption in the first sentence.'],
        coverage: 'Example coverage note: the whole made-up draft was read by the simulated reviewer.',
        unresolved: scenario.noIssues ? [] : ['Example unresolved disagreement: the simulated reviewer prefers shorter wording than the simulated drafter.'],
      };
    } else {
      const findings = payload.review?.findings ?? [];
      const kept = scenario.synthesisOmitsFinding ? findings.slice(1) : findings;
      body = {
        ...base,
        deliverable: behaviour === 'empty' ? '' : `Example synthesis for a made-up task. ${who} combined the made-up draft and review. Placeholder text only.`,
        dispositions: kept.map((f, i) => ({
          findingId: f.id,
          disposition: i === 0 ? 'accepted' : 'unresolved',
          note: i === 0 ? 'Example: change made in the made-up deliverable.' : 'Example: disagreement kept visible.',
        })),
        remainingIssues: payload.review?.unresolved ?? [],
        criteriaAssessment: payload.packet.acceptanceCriteria.map((criterion, i) => ({
          criterion,
          met: !(scenario.unmetCriterion && i === 0),
          note: scenario.unmetCriterion && i === 0 ? 'Example: the simulated synthesis says this criterion is not met.' : 'Example: met in the made-up deliverable.',
        })),
      };
    }
    if (behaviour === 'refuse') body = { ...base, refusal: 'Example refusal from the simulated adapter.' };

    const text = behaviour === 'malformed' ? '{"protocol": "helo-sim-v1", "kind": ' : JSON.stringify(body);
    const final: AdapterEvent = {
      type: 'final',
      text,
      reportedProvider: behaviour === 'wrong-provenance' ? (this.provider === 'claude' ? 'codex' : 'claude') : this.provider,
      reportedModel: this.requestedModel,
      stopReason: behaviour === 'truncated' ? 'max_tokens' : 'end',
    };
    const events: AdapterEvent[] = [{ type: 'start' }];
    if (behaviour === 'tool-event') events.push({ type: 'tool_use', name: 'simulated_shell' });
    if (behaviour === 'missing-final') return events;
    events.push(final);
    if (behaviour === 'duplicate-final') events.push({ ...final });
    return events;
  }
}

export class AdapterProcessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterProcessError';
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
