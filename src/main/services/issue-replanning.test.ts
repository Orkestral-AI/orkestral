import { describe, expect, it } from 'vitest';
import { canReplan, shouldForcePremiumReplan } from './issue-replanning';

describe('closed-loop replanning eligibility', () => {
  it('does not replan when there is no origin session (no CEO in chat)', () => {
    expect(canReplan({ hasOriginSession: false, replanCount: 0, maxReplanAttempts: 2 })).toBe(
      false,
    );
  });

  it('replans on the first divergence when there is an origin session and budget left', () => {
    expect(canReplan({ hasOriginSession: true, replanCount: 0, maxReplanAttempts: 2 })).toBe(true);
  });

  it('still replans while under the per-plan budget cap', () => {
    expect(canReplan({ hasOriginSession: true, replanCount: 1, maxReplanAttempts: 2 })).toBe(true);
  });

  it('stops replanning once the per-plan budget is exhausted (no infinite loop)', () => {
    expect(canReplan({ hasOriginSession: true, replanCount: 2, maxReplanAttempts: 2 })).toBe(false);
    expect(canReplan({ hasOriginSession: true, replanCount: 3, maxReplanAttempts: 2 })).toBe(false);
  });
});

describe('closed-loop replanning premium escalation', () => {
  it('stays Forge-first/cheap for low-stakes divergence regardless of autonomy', () => {
    expect(shouldForcePremiumReplan({ highStakes: false, autonomyLevel: 'high' })).toBe(false);
    expect(shouldForcePremiumReplan({ highStakes: false, autonomyLevel: 'low' })).toBe(false);
  });

  it('stays cheap on high-stakes divergence when autonomy is not high (human still in the loop)', () => {
    expect(shouldForcePremiumReplan({ highStakes: true, autonomyLevel: 'medium' })).toBe(false);
    expect(shouldForcePremiumReplan({ highStakes: true, autonomyLevel: 'low' })).toBe(false);
  });

  it('escalates to premium only on high-stakes divergence under high autonomy', () => {
    expect(shouldForcePremiumReplan({ highStakes: true, autonomyLevel: 'high' })).toBe(true);
  });
});
