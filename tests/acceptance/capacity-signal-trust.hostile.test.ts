import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type Evaluator = (input: unknown, options?: Record<string, unknown>) => Record<string, unknown>;

const candidatePath = process.env.CAPACITY_SIGNAL_CANDIDATE;
if (!candidatePath) {
  throw new Error('CAPACITY_SIGNAL_CANDIDATE must name the exact capacity-signal source under review');
}

const candidate = await import(/* @vite-ignore */ pathToFileURL(resolve(candidatePath)).href);
const evaluateCapacityReceipt = candidate.evaluateCapacityReceipt as Evaluator | undefined;
if (typeof evaluateCapacityReceipt !== 'function') {
  throw new Error(`${candidatePath} does not export evaluateCapacityReceipt`);
}

const NOW = '2026-09-03T19:00:00.000Z';

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    provider: 'anthropic',
    source: 'claude_code_native_status',
    observed_at: '2026-09-03T18:59:00.000Z',
    measurement: {
      weekly_used_pct: 95,
      session_used_pct: 20,
      weekly_resets_at: '2026-09-06T20:00:00.000Z',
    },
    ...overrides,
  };
}

/**
 * Unattested evaluation — the default trust posture. Used ONLY by the
 * label-trust test.
 */
function evaluate(input: unknown) {
  return evaluateCapacityReceipt!(input, { now: NOW, maxAgeMs: 5 * 60_000 });
}

/**
 * Attested evaluation: the caller proves the receipt came from the trusted
 * fetch path, via an option the receipt body cannot set about itself.
 *
 * Every test that is about something OTHER than authentication must use this.
 * Run unattested, those tests would pass because the input was unsigned rather
 * than because of the defect they name — passing for the wrong reason, and
 * indistinguishable from a real pass.
 */
function evaluateSigned(input: unknown) {
  return evaluateCapacityReceipt!(input, {
    now: NOW,
    maxAgeMs: 5 * 60_000,
    authenticated: true,
  });
}

function expectHeldWithoutNumbers(result: Record<string, unknown>) {
  expect(result).toMatchObject({
    state: 'unknown',
    route_change_allowed: false,
    decision_authority: 'owner_required',
  });
  expect(result).not.toHaveProperty('weekly_used_pct');
  expect(result).not.toHaveProperty('weekly_remaining_pct');
}

describe('capacity signal trust boundary', () => {
  it('positive control: recognizes an explicit, fresh low-capacity measurement', () => {
    expect(evaluateSigned(receipt())).toMatchObject({
      state: 'low',
      weekly_used_pct: 95,
      weekly_remaining_pct: 5,
      route_change_allowed: false,
      decision_authority: 'owner_required',
    });
  });

  it('does not treat fixed provider/source labels as proof of authentication', () => {
    const unsigned = receipt();

    const result = evaluate(unsigned);

    expectHeldWithoutNumbers(result);
    expect(result.reason).toMatch(/auth|trust|signature|provenance/i);
  });

  it.each([
    ['missing measurement', receipt({ measurement: {} })],
    ['unavailable measurement', receipt({ measurement: null, unavailable_reason: 'no_measurement' })],
    ['stale observation', receipt({ observed_at: '2026-09-03T18:54:59.999Z' })],
    ['future observation', receipt({ observed_at: '2026-09-03T19:01:00.001Z' })],
    ['caller-labelled cache', receipt({ cached: true })],
  ])('fails closed for %s even when attested', (_label, input) => {
    expectHeldWithoutNumbers(evaluateSigned(input));
  });

  it('never turns an advisory low/exhausted signal into route authority', () => {
    for (const used of [90, 95, 100]) {
      const input = receipt({
        measurement: {
          weekly_used_pct: used,
          weekly_resets_at: '2026-09-06T20:00:00.000Z',
        },
      });

      expect(evaluateSigned(input)).toMatchObject({
        route_change_allowed: false,
        decision_authority: 'owner_required',
        evidence_level: 'advisory',
      });
    }
  });

  it('does not let a forecast/reset timestamp alone authorize Sunday restoration', () => {
    const result = evaluateSigned(receipt({
      measurement: {
        weekly_used_pct: 100,
        weekly_resets_at: '2026-09-06T20:00:00.000Z',
      },
    }));

    expect(result).toMatchObject({
      state: 'exhausted',
      weekly_resets_at: '2026-09-06T20:00:00.000Z',
      route_change_allowed: false,
      decision_authority: 'owner_required',
    });
  });

  it('does not echo forbidden credential-bearing fields in a rejection', () => {
    const input = receipt({
      authorization_header: 'synthetic-do-not-use',
      raw_response: 'synthetic-provider-body',
    });

    const result = evaluateSigned(input);
    const serialized = JSON.stringify(result);

    expectHeldWithoutNumbers(result);
    expect(serialized).not.toContain('synthetic-do-not-use');
    expect(serialized).not.toContain('synthetic-provider-body');
  });
});
