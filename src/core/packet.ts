// Packet P, the sharing plan, and the role-dependent stage payloads (R4).

import {
  PROVIDER_LABEL,
  PROVIDER_SHORT,
  STAGE_NUMBER,
  type Provider,
  type Roles,
  type SharingPlanView,
  type SharingStep,
  type StageName,
} from '../shared/types.js';
import { BOUNDARY_POLICY, BOUNDARY_POLICY_VERSION, STAGE_INSTRUCTIONS } from './fixtures.js';
import { canonicalJson, prettyCanonicalJson, sha256 } from './hash.js';
import type { DraftOutput, ReviewOutput, StageOutput, SynthesisOutput } from './validation.js';

export const PROTOCOL = 'helo-sim-v1';
export const OUTPUT_SCHEMA_VERSION = 'helo-sim-output-v1';

export interface SourceSnapshot {
  sourceId: string;
  /** Path inside the clone, never absolute. */
  displayName: string;
  sha256: string;
  content: string;
}

export interface Packet {
  schemaVersion: 'helo-packet-v1';
  appInstructionsVersion: string;
  appInstructions: string;
  outputSchemaVersion: string;
  taskId: string;
  brief: string;
  acceptanceCriteria: string[];
  projectInstructions: SourceSnapshot;
  roles: Roles;
  sources: SourceSnapshot[];
}

export function buildPacket(input: {
  taskId: string;
  brief: string;
  acceptanceCriteria: string[];
  rules: SourceSnapshot;
  roles: Roles;
  sources: SourceSnapshot[];
}): { packet: Packet; json: string; hash: string } {
  const packet: Packet = {
    schemaVersion: 'helo-packet-v1',
    appInstructionsVersion: BOUNDARY_POLICY_VERSION,
    appInstructions: BOUNDARY_POLICY,
    outputSchemaVersion: OUTPUT_SCHEMA_VERSION,
    taskId: input.taskId,
    brief: input.brief,
    acceptanceCriteria: input.acceptanceCriteria,
    projectInstructions: input.rules,
    roles: input.roles,
    sources: input.sources,
  };
  const json = canonicalJson(packet);
  return { packet, json, hash: sha256(json) };
}

export function packetMarkdown(packet: Packet, packetHash: string, attemptId: string): string {
  return [
    '# Task packet P (simulation)',
    '',
    `Task: ${packet.taskId}`,
    `Attempt: ${attemptId}`,
    `Packet SHA-256: ${packetHash}`,
    `Roles: drafter ${packet.roles.drafter}, reviewer ${packet.roles.reviewer}, synthesis ${packet.roles.synthesizer}`,
    '',
    'Holds the brief, acceptance criteria, instructions, frozen roles and the full text of every selected source with its hash. No provider output.',
    '',
    '```json',
    prettyCanonicalJson(packet).trimEnd(),
    '```',
    '',
  ].join('\n');
}

const COMPANY: Record<Provider, string> = { claude: 'Anthropic', codex: 'OpenAI' };

export function sharingSteps(roles: Roles): SharingStep[] {
  const d = roles.drafter;
  const r = roles.reviewer;
  return [
    { order: 1, stage: 'draft', provider: d, providerLabel: PROVIDER_LABEL[d], receives: 'P (brief, criteria, instructions and the selected sources)' },
    { order: 2, stage: 'review', provider: r, providerLabel: PROVIDER_LABEL[r], receives: `P and ${PROVIDER_SHORT[d]}'s full draft` },
    {
      order: 3,
      stage: 'synthesis',
      provider: roles.synthesizer,
      providerLabel: PROVIDER_LABEL[roles.synthesizer],
      receives: `P, the draft and ${PROVIDER_SHORT[r]}'s full review`,
    },
  ];
}

/** The R4 sentence, naming the actual providers in order. */
export function sharingSentence(roles: Roles): string {
  const d = roles.drafter;
  const r = roles.reviewer;
  return (
    `${PROVIDER_LABEL[d]} receives P; ` +
    `${PROVIDER_LABEL[r]} receives P and ${PROVIDER_SHORT[d]}'s draft; ` +
    `${COMPANY[d]} receives P, the draft and ${PROVIDER_SHORT[r]}'s review.`
  );
}

export function sharingPlanView(roles: Roles, packetHash: string): SharingPlanView {
  return { packetHash, roles, steps: sharingSteps(roles), sentence: sharingSentence(roles) };
}

export function sharingPlanJson(roles: Roles, packetHash: string, approvedAt: string): string {
  return prettyCanonicalJson({
    file: 'sharing-plan.json',
    holds: 'Only the sharing that was approved and the hash of P. No source text and no payload hashes.',
    packetSha256: packetHash,
    approvedAt,
    roles,
    steps: sharingSteps(roles).map((s) => ({ order: s.order, stage: s.stage, provider: s.provider, receives: s.receives })),
  });
}

export interface ForwardedArtifact {
  stage: StageName;
  sha256: string;
  content: StageOutput;
}

/** R4: exactly what each stage transmits. Nothing else is ever shared across providers. */
export function buildPayload(input: {
  stage: StageName;
  taskId: string;
  attemptId: string;
  packet: Packet;
  packetHash: string;
  draft?: ForwardedArtifact;
  review?: ForwardedArtifact;
}): { bytes: string; hash: string; includes: { stage: StageName; sha256: string }[] } {
  const { stage } = input;
  const body: Record<string, unknown> = {
    protocol: PROTOCOL,
    stage,
    taskId: input.taskId,
    attemptId: input.attemptId,
    packetSha256: input.packetHash,
    packet: input.packet,
    instructions: STAGE_INSTRUCTIONS[stage],
  };
  const includes: { stage: StageName; sha256: string }[] = [];
  if (stage === 'review' || stage === 'synthesis') {
    if (!input.draft) throw new Error(`${stage} payload needs the validated draft`);
    body.draft = input.draft.content;
    includes.push({ stage: 'draft', sha256: input.draft.sha256 });
  }
  if (stage === 'synthesis') {
    if (!input.review) throw new Error('synthesis payload needs the validated review');
    body.review = input.review.content;
    includes.push({ stage: 'review', sha256: input.review.sha256 });
  }
  const bytes = canonicalJson(body);
  return { bytes, hash: sha256(bytes), includes };
}

export function sentFileName(stage: StageName): string {
  return `${STAGE_NUMBER[stage]}-${stage}-sent.json`;
}

export function outputFileName(stage: StageName): string {
  return `${STAGE_NUMBER[stage]}-${stage}.md`;
}

/** C3: the -sent.json file means "prepared payload and dispatch intent", not proof of delivery. */
export function sentJson(input: {
  stage: StageName;
  provider: Provider;
  adapterVersion: string;
  requestedModel: string;
  payloadHash: string;
  payloadBytes: number;
  packetHash: string;
  includes: { stage: StageName; sha256: string }[];
  preparedAt: string;
}): string {
  return prettyCanonicalJson({
    file: sentFileName(input.stage),
    meaning: 'Prepared payload and dispatch intent',
    note: 'Records the payload the app prepared and its intent to dispatch it. It does not prove delivery; dispatch is confirmed or uncertain separately, in the dispatch journal.',
    stage: input.stage,
    provider: input.provider,
    providerLabel: PROVIDER_LABEL[input.provider],
    adapter: 'fake-adapter (simulation)',
    adapterVersion: input.adapterVersion,
    requestedModel: input.requestedModel,
    payloadSha256: input.payloadHash,
    payloadBytes: input.payloadBytes,
    packetSha256: input.packetHash,
    includesArtifacts: input.includes,
    preparedAt: input.preparedAt,
  });
}

export function artifactHash(output: StageOutput): string {
  return sha256(canonicalJson(output));
}

export function outputMarkdown(stage: StageName, provider: Provider, output: StageOutput, provenance: { reportedProvider: string; reportedModel: string }): string {
  const lines: string[] = [
    `# ${STAGE_NUMBER[stage]}. ${stage[0]!.toUpperCase()}${stage.slice(1)} (simulation)`,
    '',
    `Produced by: ${PROVIDER_LABEL[provider]}, simulated adapter. No AI was called.`,
    `Reported provider: ${provenance.reportedProvider}; reported model: ${provenance.reportedModel}`,
    '',
  ];
  if (output.kind === 'draft') lines.push(renderDraft(output));
  if (output.kind === 'review') lines.push(renderReview(output));
  if (output.kind === 'synthesis') lines.push(renderSynthesis(output));
  lines.push('', '```json', prettyCanonicalJson(output).trimEnd(), '```', '');
  return lines.join('\n');
}

function renderDraft(o: DraftOutput): string {
  return [o.draft, '', 'Assumptions:', ...o.assumptions.map((a) => `- ${a}`), '', 'Limitations:', ...o.limitations.map((a) => `- ${a}`)].join('\n');
}

function renderReview(o: ReviewOutput): string {
  return [
    `Verdict: ${o.verdict}`,
    '',
    ...o.findings.map((f) => `${f.id} (${f.severity}): ${f.text} Evidence: ${f.evidence}`),
    '',
    `Coverage: ${o.coverage}`,
  ].join('\n');
}

function renderSynthesis(o: SynthesisOutput): string {
  return [
    o.deliverable,
    '',
    'Dispositions:',
    ...o.dispositions.map((d) => `- ${d.findingId}: ${d.disposition}. ${d.note}`),
    '',
    'Remaining issues:',
    ...(o.remainingIssues.length ? o.remainingIssues.map((r) => `- ${r}`) : ['- none reported']),
  ].join('\n');
}
