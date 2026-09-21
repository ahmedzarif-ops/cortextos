/**
 * Coverage for the anti-forgery core extracted from validate-plan.mjs.
 *
 * Guard's adversarial pass left SEVEN mutants alive in this region while the
 * suite stayed 57/57 green, because removing the fetch-injection fixture
 * removed the only route to a successful usage read. Each test below is named
 * for the mutant it exists to kill.
 *
 * Fabricating `usage` here is legitimate and is NOT the removed injection: at
 * this layer usage is a plain function ARGUMENT, and nothing in this module
 * decides whether it is trustworthy. That judgement lives in
 * launch-trusted-usage-read.mjs, outside any caller-controlled surface.
 */
import { describe, expect, it } from 'vitest';

import {
  evaluateCanonicalUsage,
  buildAcceptOutput,
} from '../../../community/skills/hermes-runtime-failover/scripts/evaluate-canonical-usage.mjs';
import { usageApiEndpoint } from '../../../community/skills/hermes-runtime-failover/scripts/read-authenticated-usage.mjs';

const NOW = Date.parse('2026-09-03T19:00:00.000Z');
const FETCHED = '2026-09-03T18:59:00.000Z';

/** A usage object that passes every check. Mutate one field per test. */
const goodUsage = (over: Record<string, unknown> = {}) => ({
  account: 'fleet-canonical',
  provider: 'anthropic',
  endpoint: usageApiEndpoint,
  authentication: 'oauth-bearer',
  cached: false,
  five_hour_utilization: 0.5,
  seven_day_utilization: 0.91,
  fetched_at: FETCHED,
  ...over,
});

// 1 - 0.91 = 0.09 -> 9 percent remaining
const REMAINING = 9;
const goodPlan = (over: Record<string, unknown> = {}) => ({
  trigger: { observed_value: REMAINING, observed_at_utc: FETCHED, ...over },
});
const goodReceipt = { observed_value: REMAINING };

const evaluate = (args: Record<string, unknown> = {}) => evaluateCanonicalUsage({
  usage: goodUsage(),
  plan: goodPlan(),
  triggerReceipt: goodReceipt,
  maxAgeMinutes: 30,
  usageApiEndpoint,
  nowMs: NOW,
  ...args,
});

describe('evaluateCanonicalUsage', () => {
  it('POSITIVE CONTROL: a fully consistent measurement produces no errors', () => {
    const { errors, canonicalRemainingPercent } = evaluate();
    expect(errors).toEqual([]);
    expect(canonicalRemainingPercent).toBe(REMAINING);
  });

  // --- kills M10: originIsAuthenticated forced true ------------------------
  it.each([
    ['provider', { provider: 'not-anthropic' }],
    ['endpoint', { endpoint: 'https://evil.example/usage' }],
    ['authentication', { authentication: 'none' }],
    ['cached', { cached: true }],
    ['account absent', { account: '' }],
  ])('rejects an unauthenticated origin (%s)', (_label, over) => {
    const { errors } = evaluate({ usage: goodUsage(over) });
    expect(errors).toContain('usage measurement is unauthenticated, cached, or from an unexpected origin');
  });

  // --- kills M9: both trigger-value comparisons ---------------------------
  it('rejects a plan trigger value that does not match the measurement', () => {
    const { errors } = evaluate({ plan: goodPlan({ observed_value: 42 }) });
    expect(errors).toContain('trigger.observed_value does not match authenticated usage measurement');
  });

  it('rejects a trigger RECEIPT value that does not match the measurement', () => {
    const { errors } = evaluate({ triggerReceipt: { observed_value: 42 } });
    expect(errors).toContain('trigger receipt observed_value does not match authenticated usage measurement');
  });

  it('rejects a forged plan AND receipt that agree with each other but not with the measurement', () => {
    // The joint forgery: internally consistent, externally false.
    const { errors } = evaluate({ plan: goodPlan({ observed_value: 0 }), triggerReceipt: { observed_value: 0 } });
    expect(errors).toContain('trigger.observed_value does not match authenticated usage measurement');
    expect(errors).toContain('trigger receipt observed_value does not match authenticated usage measurement');
  });

  // --- kills M13: utilization validity disabled ---------------------------
  it.each([
    ['seven_day missing', { seven_day_utilization: undefined }],
    ['seven_day NaN', { seven_day_utilization: Number.NaN }],
    ['seven_day > 1', { seven_day_utilization: 1.5 }],
    ['seven_day < 0', { seven_day_utilization: -0.1 }],
    ['five_hour non-numeric', { five_hour_utilization: '0.5' }],
    ['five_hour > 1', { five_hour_utilization: 2 }],
  ])('rejects invalid utilization (%s)', (_label, over) => {
    const { errors, canonicalRemainingPercent } = evaluate({ usage: goodUsage(over) });
    expect(errors).toContain('authenticated usage measurement is missing valid utilization fields');
    // And it must NOT go on to compute a percentage from a bad number.
    expect(canonicalRemainingPercent).toBeUndefined();
  });

  // --- kills M12: fetched_at ISO validity disabled -------------------------
  it.each([
    ['absent', { fetched_at: undefined }],
    ['not ISO', { fetched_at: 'yesterday' }],
    ['no zone', { fetched_at: '2026-09-03T18:59:00' }],
  ])('rejects an invalid fetched_at (%s)', (_label, over) => {
    const { errors } = evaluate({ usage: goodUsage(over) });
    expect(errors).toContain('authenticated usage measurement fetched_at is missing or invalid');
  });

  it('rejects a stale fetched_at', () => {
    const { errors } = evaluate({ usage: goodUsage({ fetched_at: '2026-09-03T17:00:00.000Z' }) });
    expect(errors.join('\n')).toContain('is stale or future-dated');
  });

  // --- kills M11b: contemporaneity window widened -------------------------
  it('rejects a trigger observation not contemporaneous with the measurement', () => {
    const { errors } = evaluate({ plan: goodPlan({ observed_at_utc: '2026-09-03T12:00:00.000Z' }) });
    expect(errors).toContain('trigger.observed_at_utc is not contemporaneous with authenticated usage measurement');
  });

  it('accepts a trigger observation inside the window', () => {
    // Non-over-trigger control: the contemporaneity check must not fire on
    // everything, or widening the window would still look "caught".
    const { errors } = evaluate({ plan: goodPlan({ observed_at_utc: '2026-09-03T18:45:00.000Z' }) });
    expect(errors).not.toContain('trigger.observed_at_utc is not contemporaneous with authenticated usage measurement');
  });

  it('returns no errors when there is no usage — the caller reports unavailability', () => {
    expect(evaluate({ usage: null }).errors).toEqual([]);
  });
});

// --- kills M1 (canary) and M2 (trigger_percent) in the accept output --------

describe('buildAcceptOutput', () => {
  const args = {
    canonicalRemainingPercent: REMAINING,
    usage: goodUsage(),
    canonicalTriggerSource: 'cortextos-check-usage-api:anthropic-oauth',
    triggerBinding: { sha256: 'trigger-sha' },
    plan: { restore: { occurrence_utc: '2026-09-06T20:00:00Z' } },
    binding: { sha256: 'restore-sha' },
    fleetBinding: { sha256: 'fleet-sha' },
    spend: { total_expected_weekly_usd: 12.5 },
    planNames: ['a', 'b', 'c', 'd', 'e', 'f'],
    profiles: new Set(['p1', 'p2', 'p3', 'p4', 'p5']),
    mcpReceipts: 5,
    cutover: { canary_seat: 'city', coordinator_seat: 'chief' },
  };

  it('reports the canary and coordinator seats from the cutover plan', () => {
    const out = buildAcceptOutput(args);
    expect(out.canary).toBe('city');
    expect(out.coordinator_last).toBe('chief');
  });

  it('reports trigger_percent as the measured remaining percentage', () => {
    expect(buildAcceptOutput(args).trigger_percent).toBe(REMAINING);
  });

  it('carries the counted seats, profiles and receipts, and asserts zero live changes', () => {
    const out = buildAcceptOutput(args);
    expect(out).toMatchObject({
      ok: true, seats: 6, hermes_profiles: 5, mcp_receipts: 5,
      native_cron_collisions: 0, live_changes: 0,
      trigger_observed_at_utc: FETCHED,
    });
  });
});
