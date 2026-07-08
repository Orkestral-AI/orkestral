import { describe, expect, it } from 'vitest';
import { matchesObservabilityRule, shouldRunObservabilityRule } from './observability';

describe('observability service helpers', () => {
  it('runs watcher rules immediately when they have no prior tick', () => {
    expect(
      shouldRunObservabilityRule({
        nowMs: 60_000,
        lastRunMs: null,
        refreshIntervalMin: 5,
      }),
    ).toBe(true);
  });

  it('respects per-rule refresh intervals', () => {
    expect(
      shouldRunObservabilityRule({
        nowMs: 4 * 60_000,
        lastRunMs: 60_000,
        refreshIntervalMin: 5,
      }),
    ).toBe(false);

    expect(
      shouldRunObservabilityRule({
        nowMs: 7 * 60_000,
        lastRunMs: 60_000,
        refreshIntervalMin: 5,
      }),
    ).toBe(true);
  });

  it('disables watcher rules with zero refresh interval', () => {
    expect(
      shouldRunObservabilityRule({
        nowMs: 60_000,
        lastRunMs: null,
        refreshIntervalMin: 0,
      }),
    ).toBe(false);
  });

  it('matches signals by kind, severity text and service/message text', () => {
    const signal = {
      kind: 'error' as const,
      severity: 'fatal',
      service: 'checkout-api',
      title: 'Payment webhook failed',
      summary: 'Stripe callback returned 500',
    };

    expect(
      matchesObservabilityRule(signal, {
        kind: 'error',
        severity: 'fatal',
        serviceQuery: 'checkout',
      }),
    ).toBe(true);

    expect(
      matchesObservabilityRule(signal, {
        kind: 'incident',
        severity: 'fatal',
        serviceQuery: 'checkout',
      }),
    ).toBe(false);

    expect(
      matchesObservabilityRule(signal, {
        kind: 'error',
        severity: 'warning',
        serviceQuery: 'checkout',
      }),
    ).toBe(false);

    expect(
      matchesObservabilityRule(signal, {
        kind: 'error',
        severity: 'fatal',
        serviceQuery: 'mobile',
      }),
    ).toBe(false);
  });
});
