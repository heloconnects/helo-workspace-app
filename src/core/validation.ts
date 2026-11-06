// Valid completion (plan "Valid completion"): exactly one recognised final
// message, provenance, bounded schema, required non-empty content, matching
// task/attempt/input identifiers and hashes, and no tool events, truncation,
// refusal or protocol errors. Exit status or non-empty text alone is not enough.

import type { Provider, StageName } from '../shared/types.js';
import type { AdapterEvent } from './fake-adapters.js';

export const MAX_OUTPUT_BYTES = 64 * 1024;

export interface DraftOutput {
  kind: 'draft';
  draft: string;
  sourceRefs: string[];
  assumptions: string[];
  limitations: string[];
  unmetCriteria: string[];
}

export interface ReviewFinding {
  id: string;
  severity: 'high' | 'medium' | 'low';
  evidence: string;
  text: string;
}

export interface ReviewOutput {
  kind: 'review';
  verdict: string;
  findings: ReviewFinding[];
  corrections: string[];
  coverage: string;
  unresolved: string[];
}

export interface SynthesisOutput {
  kind: 'synthesis';
  deliverable: string;
  dispositions: { findingId: string; disposition: 'accepted' | 'rejected' | 'unresolved'; note: string }[];
  remainingIssues: string[];
  criteriaAssessment: { criterion: string; met: boolean; note: string }[];
}

export type StageOutput = DraftOutput | ReviewOutput | SynthesisOutput;

export interface Validated {
  ok: true;
  output: StageOutput;
  reportedProvider: string;
  reportedModel: string;
}

export interface Rejected {
  ok: false;
  reason: string;
}

export interface Expectation {
  stage: StageName;
  provider: Provider;
  taskId: string;
  attemptId: string;
  inputHash: string;
  acceptanceCriteria: string[];
  /** For synthesis: every finding id the validated review produced. */
  reviewFindingIds?: string[];
}

class Invalid extends Error {}

function fail(msg: string): never {
  throw new Invalid(msg);
}

function str(o: Record<string, unknown>, key: string, nonEmpty = true): string {
  const v = o[key];
  if (typeof v !== 'string') fail(`field "${key}" is missing or not text`);
  if (nonEmpty && v.trim() === '') fail(`field "${key}" is empty`);
  return v;
}

function strArr(o: Record<string, unknown>, key: string): string[] {
  const v = o[key];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) fail(`field "${key}" is not a list of text`);
  return v as string[];
}

function objArr(o: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const v = o[key];
  if (!Array.isArray(v) || !v.every((x) => x !== null && typeof x === 'object' && !Array.isArray(x))) fail(`field "${key}" is not a list of objects`);
  return v as Record<string, unknown>[];
}

export function validateStage(events: AdapterEvent[], exp: Expectation): Validated | Rejected {
  try {
    return validateOrThrow(events, exp);
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, reason: e.message };
    throw e;
  }
}

function validateOrThrow(events: AdapterEvent[], exp: Expectation): Validated {
  if (!Array.isArray(events) || events.length === 0) fail('no events received');
  const errors = events.filter((e) => e.type === 'error');
  if (errors.length) fail(`provider reported an error: ${errors.map((e) => (e.type === 'error' ? e.message : '')).join('; ')}`);
  if (events.some((e) => e.type === 'tool_use')) fail('forbidden tool event in output');
  if (events.some((e) => !['start', 'final', 'tool_use', 'error'].includes((e as { type: string }).type))) fail('unrecognised event type');
  if (events[0]?.type !== 'start') fail('events out of order: first event is not "start"');
  const finals = events.filter((e) => e.type === 'final');
  if (finals.length === 0) fail('no final message');
  if (finals.length > 1) fail('duplicate final messages');
  if (events[events.length - 1]?.type !== 'final') fail('events out of order: final message is not last');
  const final = finals[0]!;
  if (final.type !== 'final') fail('no final message');
  if (final.stopReason !== 'end') fail(`output truncated or stopped early (stop reason: ${final.stopReason})`);
  if (Buffer.byteLength(final.text, 'utf8') > MAX_OUTPUT_BYTES) fail(`output larger than ${MAX_OUTPUT_BYTES} bytes`);
  if (!final.reportedProvider || !final.reportedModel) fail('provenance missing: no reported provider or model');
  if (final.reportedProvider !== exp.provider) fail(`provenance mismatch: requested ${exp.provider}, reported ${final.reportedProvider}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(final.text);
  } catch {
    fail('final message is not valid JSON for the output schema');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) fail('final message is not an object');
  const o = parsed as Record<string, unknown>;
  if (typeof o.refusal === 'string' && o.refusal.length > 0) fail(`provider refused: ${o.refusal}`);
  if (o.protocol !== 'helo-sim-v1') fail('wrong protocol identifier');
  if (o.taskId !== exp.taskId) fail('wrong task identifier');
  if (o.attemptId !== exp.attemptId) fail('wrong attempt identifier');
  if (o.inputHash !== exp.inputHash) fail('input hash does not match the payload sent');
  if (o.kind !== exp.stage) fail(`expected a ${exp.stage} output, got "${String(o.kind)}"`);

  const output = parseOutput(exp, o);
  return { ok: true, output, reportedProvider: final.reportedProvider, reportedModel: final.reportedModel };
}

function parseOutput(exp: Expectation, o: Record<string, unknown>): StageOutput {
  if (exp.stage === 'draft') {
    return {
      kind: 'draft',
      draft: str(o, 'draft'),
      sourceRefs: strArr(o, 'sourceRefs'),
      assumptions: strArr(o, 'assumptions'),
      limitations: strArr(o, 'limitations'),
      unmetCriteria: strArr(o, 'unmetCriteria'),
    };
  }
  if (exp.stage === 'review') {
    const findings = objArr(o, 'findings').map((f, i) => {
      const severity = f.severity;
      if (severity !== 'high' && severity !== 'medium' && severity !== 'low') fail(`finding ${i + 1} has no valid severity`);
      return { id: str(f, 'id'), severity, evidence: str(f, 'evidence'), text: str(f, 'text') } as ReviewFinding;
    });
    const ids = new Set(findings.map((f) => f.id));
    if (ids.size !== findings.length) fail('duplicate finding identifiers');
    return {
      kind: 'review',
      verdict: str(o, 'verdict'),
      findings,
      corrections: strArr(o, 'corrections'),
      coverage: str(o, 'coverage'),
      unresolved: strArr(o, 'unresolved'),
    };
  }
  const dispositions = objArr(o, 'dispositions').map((d) => {
    const disposition = d.disposition;
    if (disposition !== 'accepted' && disposition !== 'rejected' && disposition !== 'unresolved') fail('disposition is not accepted, rejected or unresolved');
    return { findingId: str(d, 'findingId'), disposition, note: str(d, 'note', false) } as SynthesisOutput['dispositions'][number];
  });
  const covered = new Set(dispositions.map((d) => d.findingId));
  const missing = (exp.reviewFindingIds ?? []).filter((id) => !covered.has(id));
  if (missing.length) fail(`synthesis does not account for review finding(s) ${missing.join(', ')}`);
  const criteriaAssessment = objArr(o, 'criteriaAssessment').map((c) => {
    if (typeof c.met !== 'boolean') fail('criterion assessment has no met/unmet value');
    return { criterion: str(c, 'criterion'), met: c.met, note: str(c, 'note', false) };
  });
  const assessed = new Set(criteriaAssessment.map((c) => c.criterion));
  const unassessed = exp.acceptanceCriteria.filter((c) => !assessed.has(c));
  if (unassessed.length) fail(`synthesis does not assess acceptance criteria: ${unassessed.join('; ')}`);
  return {
    kind: 'synthesis',
    deliverable: str(o, 'deliverable'),
    dispositions,
    remainingIssues: strArr(o, 'remainingIssues'),
    criteriaAssessment,
  };
}
