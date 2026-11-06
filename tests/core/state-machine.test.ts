import { describe, expect, it } from 'vitest';
import { assertTransition, canTransition, isActive, isTerminal, TERMINAL_STATES, TRANSITIONS } from '../../src/core/state-machine.js';
import type { AttemptState } from '../../src/shared/types.js';

const ALL = Object.keys(TRANSITIONS) as AttemptState[];

describe('attempt state machine', () => {
  it('has the happy path queued → drafting → reviewing → synthesizing → validating → complete', () => {
    const path: AttemptState[] = ['queued', 'drafting', 'reviewing', 'synthesizing', 'validating', 'complete'];
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
  });

  it('includes needs attention as an outcome of validating (C2)', () => {
    expect(canTransition('validating', 'needs_attention')).toBe(true);
    expect(TERMINAL_STATES).toContain('needs_attention');
  });

  it('has failed, cancelling, cancelled and interrupted as explicit alternatives from every running stage', () => {
    for (const s of ['drafting', 'reviewing', 'synthesizing'] as AttemptState[]) {
      for (const alt of ['failed', 'cancelling', 'interrupted'] as AttemptState[]) expect(canTransition(s, alt)).toBe(true);
    }
    expect(canTransition('cancelling', 'cancelled')).toBe(true);
    expect(canTransition('cancelling', 'cancellation_unconfirmed')).toBe(true);
    expect(canTransition('cancellation_unconfirmed', 'cancelled')).toBe(true);
  });

  it('never leaves a terminal state (late or duplicate events cannot change it)', () => {
    for (const t of TERMINAL_STATES) {
      expect(isTerminal(t)).toBe(true);
      for (const to of ALL) expect(canTransition(t, to)).toBe(false);
      expect(() => assertTransition(t, 'drafting')).toThrow(/Invalid attempt state change/);
    }
  });

  it('cannot skip stages', () => {
    expect(canTransition('queued', 'reviewing')).toBe(false);
    expect(canTransition('drafting', 'synthesizing')).toBe(false);
    expect(canTransition('reviewing', 'complete')).toBe(false);
    expect(canTransition('synthesizing', 'complete')).toBe(false);
  });

  it('treats cancellation unconfirmed as active (blocks retry and deletion)', () => {
    expect(isActive('cancellation_unconfirmed')).toBe(true);
    expect(isActive('cancelling')).toBe(true);
    expect(isActive('complete')).toBe(false);
  });
});
