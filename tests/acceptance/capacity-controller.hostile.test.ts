import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Adversarial pass over sentinel's capacity controller.
 *
 * The module claims four properties. This suite tries to BREAK each one rather
 * than demonstrate it, and carries mutation checks so a suite that has stopped
 * discriminating is visible as such.
 */

const candidatePath = process.env.CAPACITY_CONTROLLER_CANDIDATE;
if (!candidatePath) {
  throw new Error('CAPACITY_CONTROLLER_CANDIDATE must name the controller source under review');
}

const mod = await import(/* @vite-ignore */ pathToFileURL(resolve(candidatePath)).href);
const decideCapacityAction = mod.decideCapacityAction as
  | ((s: unknown, o: unknown) => Record<string, unknown>)
  | undefined;
if (typeof decideCapacityAction !== 'function') {
  throw new Error(`${candidatePath} does not export decideCapacityAction`);
}

const NOW = '2026-09-03T21:00:00.000Z';

/** A fully valid, attested signal. Overrides let each test attack one field. */
function signal(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    state: 'low',
    reason: 'measured',
    evaluated_at: NOW,
    observed_at: '2026-09-03T20:59:00.000Z',
    expires_at: '2026-09-03T21:05:00.000Z',
    weekly_used_pct: 95,
    weekly_remaining_pct: 5,
    low_at_pct: 90,
    authenticated: true,
    evidence_level: 'advisory',
    decision_authority: 'owner_required',
    route_change_allowed: false,
    next_step: 'request_owner_failover_approval',
    ...overrides,
  };
}

function decide(s: unknown, currentRoute = 'claude') {
  return decideCapacityAction!(s, { currentRoute, now: NOW });
}

const HOLD_STATES = ['unknown'] as const;

describe('capacity controller — adversarial', () => {
  describe('positive controls (a suite that only asserts holds proves nothing)', () => {
    it('an attested low signal on claude DOES propose failover', () => {
      const d = decide(signal());
      expect(d.action).toBe('propose_failover');
      expect(d.weekly_used_pct).toBe(95);
    });

    it('an attested available signal on fallback DOES propose return', () => {
      const d = decide(signal({ state: 'available', weekly_used_pct: 10 }), 'fallback');
      expect(d.action).toBe('propose_return');
    });
  });

  describe('RULE 1 — unknown is not low', () => {
    // Assert the REASON, not just the action. Mutation testing showed that
    // deleting the `unknown` guard entirely leaves every ACTION unchanged —
    // an unknown signal still falls through to a hold on both routes. What it
    // changes is what the owner is TOLD: "within_capacity_no_change", i.e. a
    // false reassurance derived from a reading we do not have. A suite that
    // checks only the action cannot see that, and passed the mutant.
    it.each(HOLD_STATES)('state %s holds on claude FOR THE UNKNOWN REASON', (state) => {
      const d = decide(signal({ state }));
      expect(d.action).toBe('hold');
      expect(d.reason).toBe('signal_unknown_holding');
      expect(d.reason).not.toBe('within_capacity_no_change');
    });

    it.each(HOLD_STATES)('state %s holds on fallback FOR THE UNKNOWN REASON', (state) => {
      const d = decide(signal({ state }), 'fallback');
      expect(d.action).toBe('hold');
      expect(d.reason).toBe('signal_unknown_holding');
      expect(d.reason).not.toBe('already_off_claude');
    });

    it('an unauthenticated signal holds even when it claims exhausted', () => {
      const d = decide(signal({ authenticated: false, state: 'exhausted' }));
      expect(d.action).toBe('hold');
      expect(d.reason).toBe('signal_unauthenticated_holding');
    });

    it.each([undefined, 'true', 1, {}, null])(
      'a non-boolean-true authenticated value (%p) does not pass the gate',
      (authenticated) => {
        expect(decide(signal({ authenticated, state: 'exhausted' })).action).toBe('hold');
      },
    );
  });

  describe('RULE 2 — a due forecast is not a return', () => {
    it('a past weekly_resets_at does not authorize return from fallback', () => {
      const d = decide(
        signal({
          state: 'exhausted',
          weekly_resets_at: '2026-09-01T00:00:00.000Z', // long past
        }),
        'fallback',
      );
      expect(d.action).toBe('hold');
      expect(d.reason).toBe('capacity_not_yet_observed_available');
    });

    it('weekly_resets_at cannot rescue an unknown state into a return', () => {
      const d = decide(
        signal({ state: 'unknown', weekly_resets_at: '2026-09-01T00:00:00.000Z' }),
        'fallback',
      );
      expect(d.action).toBe('hold');
    });

    it('the source does not reference weekly_resets_at at all', () => {
      // The module declares this refusal in NON_INPUTS; assert the CODE, since
      // a declared refusal that nothing enforces is prose in an array.
      const src = readFileSync(resolve(candidatePath), 'utf-8');
      const withoutComments = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/NON_INPUTS\s*=\s*\[[^\]]*\]/, '');
      expect(withoutComments).not.toMatch(/weekly_resets_at/);
    });
  });

  describe('RULE 3 — nothing is ever applied', () => {
    const cases: Array<[string, unknown, string]> = [
      ['low/claude', signal(), 'claude'],
      ['exhausted/claude', signal({ state: 'exhausted' }), 'claude'],
      ['available/fallback', signal({ state: 'available' }), 'fallback'],
      ['unknown/claude', signal({ state: 'unknown' }), 'claude'],
      ['unauthenticated', signal({ authenticated: false }), 'claude'],
    ];

    it.each(cases)('%s never applies and always requires the owner', (_l, s, route) => {
      const d = decide(s, route);
      expect(d.applied).toBe(false);
      expect(d.owner_approval_required).toBe(true);
    });

    it('a signal asserting route_change_allowed cannot flip the decision', () => {
      // Hostile input: the receipt lies about its own authority.
      const d = decide(signal({
        route_change_allowed: true,
        decision_authority: 'agent_allowed',
        applied: true,
        owner_approval_required: false,
      }));
      expect(d.applied).toBe(false);
      expect(d.owner_approval_required).toBe(true);
    });
  });

  describe('RULE 4 — no utilization number on any hold path', () => {
    const holds: Array<[string, unknown, string]> = [
      ['unknown', signal({ state: 'unknown' }), 'claude'],
      ['unauthenticated', signal({ authenticated: false }), 'claude'],
      ['expired', signal({ expires_at: '2026-09-03T20:00:00.000Z' }), 'claude'],
      ['available on claude', signal({ state: 'available' }), 'claude'],
      ['low on fallback', signal({ state: 'low' }), 'fallback'],
    ];

    it.each(holds)('%s carries no weekly_used_pct', (_l, s, route) => {
      const d = decide(s, route);
      expect(d.action).toBe('hold');
      expect(d).not.toHaveProperty('weekly_used_pct');
      expect(d).not.toHaveProperty('weekly_remaining_pct');
      // and the number must not leak via serialization either
      expect(JSON.stringify(d)).not.toContain('95');
    });
  });

  describe('freshness gate — attacks on expires_at', () => {
    it('an expired signal holds', () => {
      const d = decide(signal({ expires_at: '2026-09-03T20:00:00.000Z' }));
      expect(d.action).toBe('hold');
      expect(d.reason).toBe('signal_expired_holding');
    });

    // THE ATTACK: a malformed expiry is not a proven-fresh signal. Rule 4 of the
    // module's own header says every path that is not a proven state change
    // resolves to hold. `Number.isFinite(NaN)` is false, so a malformed value
    // SKIPS the staleness check rather than failing it.
    it.each(['not-a-date', '', 'Invalid Date', '2026-13-45T99:99:99Z'])(
      'a malformed expires_at (%p) must not be treated as fresh',
      (expires_at) => {
        const d = decide(signal({ expires_at }));
        expect(d.action, 'malformed expiry should fail closed to hold').toBe('hold');
      },
    );

    it('a null expires_at must not be treated as fresh', () => {
      expect(decide(signal({ expires_at: null })).action).toBe('hold');
    });
  });
});
