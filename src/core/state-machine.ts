// Attempt state machine (plan "Task lifecycle"; carried item C2 adds needs_attention).
//
//   queued -> drafting -> reviewing -> synthesizing -> validating -> complete | needs_attention
//
// Explicit alternatives: failed, cancelling, cancelled, interrupted, and
// cancellation_unconfirmed (cancelling whose owned process did not confirm exit).
// Terminal states equal the attempt's outcome and never change.

import type { AttemptState, Outcome } from '../shared/types.js';

export const TERMINAL_STATES: readonly Outcome[] = ['complete', 'needs_attention', 'failed', 'cancelled', 'interrupted'];

const RUNNING: AttemptState[] = ['queued', 'drafting', 'reviewing', 'synthesizing', 'validating'];

export const TRANSITIONS: Readonly<Record<AttemptState, readonly AttemptState[]>> = {
  queued: ['drafting', 'failed', 'cancelling', 'cancelled', 'interrupted'],
  drafting: ['reviewing', 'failed', 'cancelling', 'cancelled', 'interrupted'],
  reviewing: ['synthesizing', 'failed', 'cancelling', 'cancelled', 'interrupted'],
  synthesizing: ['validating', 'failed', 'cancelling', 'cancelled', 'interrupted'],
  validating: ['complete', 'needs_attention', 'failed', 'cancelled', 'interrupted'],
  // A timeout follows cancellation semantics and ends as failed.
  cancelling: ['cancelled', 'failed', 'cancellation_unconfirmed', 'interrupted'],
  // Only an explicit resolution (or an app restart) leaves this state.
  cancellation_unconfirmed: ['cancelled', 'failed', 'interrupted'],
  complete: [],
  needs_attention: [],
  failed: [],
  cancelled: [],
  interrupted: [],
};

export function isTerminal(state: AttemptState): state is Outcome {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

export function isRunning(state: AttemptState): boolean {
  return RUNNING.includes(state);
}

/** Active means the attempt still owns, or may still own, provider activity. Blocks retry and deletion. */
export function isActive(state: AttemptState): boolean {
  return !isTerminal(state);
}

export function canTransition(from: AttemptState, to: AttemptState): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransition extends Error {
  constructor(
    readonly from: AttemptState,
    readonly to: AttemptState,
  ) {
    super(`Invalid attempt state change: ${from} -> ${to}`);
  }
}

export function assertTransition(from: AttemptState, to: AttemptState): void {
  if (!canTransition(from, to)) throw new InvalidTransition(from, to);
}
