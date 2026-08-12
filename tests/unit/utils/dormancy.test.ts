/**
 * tests/unit/utils/dormancy.test.ts
 *
 * Unit tests for computeDormancy() — the pure silent-dormancy predicate.
 * No I/O — all inputs (including `nowMs`) are injected. Every numeric input is
 * DERIVED from the exported constants so the tests stay valid if the tunable
 * proposals change.
 *
 * Coverage:
 *  - Face A: mapped + frozen heartbeat + enabled + past grace ⇒ dormant
 *  - Face B: unmapped/absent + stale heartbeat + enabled + past daemon grace ⇒
 *    dormant (proves the gate ignores `mapped` and Face B works)
 *  - Face A bounce guard: fresh mapped agent, uptime < grace ⇒ NOT dormant
 *  - Face B bounce guard: fresh daemon (uptime < grace) + absent stale agent ⇒
 *    NOT dormant (the fleet-bounce false-positive killer)
 *  - disabled ⇒ never dormant (both faces)
 *  - healthy recent heartbeat ⇒ NOT dormant
 *  - staleness locked to the baseline (uptime), not wall-clock
 */

import { describe, it, expect } from 'vitest';
import {
  computeDormancy,
  BOOT_GRACE_MS,
  STALENESS_MULTIPLIER,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  type DormancyInput,
} from '../../../src/utils/dormancy';

// Fixed injected "now". Value is arbitrary — nothing reads the wall clock.
const NOW = 1_000_000_000_000;

// Default threshold the helper derives when no expectedIntervalMs is given.
const THRESHOLD = Math.max(BOOT_GRACE_MS, STALENESS_MULTIPLIER * DEFAULT_HEARTBEAT_INTERVAL_MS);

// Sanity: with the default interval the multiplier term dominates the grace,
// so the threshold is strictly greater than the grace. Several tests below rely
// on this ordering to separate "past grace" from "past threshold".
const ONE_MIN = 60 * 1000;

function base(overrides: Partial<DormancyInput>): DormancyInput {
  return {
    agent: 'agent-x',
    org: 'testorg',
    enabled: true,
    mapped: true,
    nowMs: NOW,
    lastSeenMs: NOW, // fresh by default
    uptimeMs: THRESHOLD + 10 * ONE_MIN, // well past grace by default
    daemonUptimeMs: THRESHOLD + 10 * ONE_MIN,
    ...overrides,
  };
}

describe('computeDormancy — Face A (mapped, uptime baseline)', () => {
  it('threshold is strictly greater than the boot grace under the default interval', () => {
    expect(THRESHOLD).toBeGreaterThan(BOOT_GRACE_MS);
  });

  it('mapped + frozen heartbeat + enabled + past grace ⇒ dormant', () => {
    const r = computeDormancy(base({
      mapped: true,
      lastSeenMs: NOW - (THRESHOLD + ONE_MIN), // stale beyond threshold
      uptimeMs: THRESHOLD + 10 * ONE_MIN,      // up long enough to see the staleness
    }));
    expect(r.dormant).toBe(true);
    expect(r.mapped).toBe(true);
    expect(r.reason).toContain('mapped');
  });

  it('fresh mapped agent with uptime below grace ⇒ NOT dormant (Face-A bounce guard)', () => {
    const r = computeDormancy(base({
      mapped: true,
      uptimeMs: BOOT_GRACE_MS - ONE_MIN,        // still inside boot grace
      lastSeenMs: NOW - (THRESHOLD + ONE_MIN),  // heartbeat would otherwise be stale
    }));
    expect(r.dormant).toBe(false);
  });

  it('healthy recent heartbeat ⇒ NOT dormant', () => {
    const r = computeDormancy(base({
      mapped: true,
      lastSeenMs: NOW - ONE_MIN, // one minute ago, well within threshold
      uptimeMs: THRESHOLD + 10 * ONE_MIN,
    }));
    expect(r.dormant).toBe(false);
  });

  it('staleness is locked to the baseline (uptime), not wall-clock', () => {
    // Heartbeat is ancient in wall-clock terms, but the agent has only been up
    // a little past grace (still under threshold). Clamping to uptime keeps it
    // healthy — proves the min(., uptimeMs) mechanism.
    const r = computeDormancy(base({
      mapped: true,
      lastSeenMs: NOW - 10 * THRESHOLD,      // wall-clock age >> threshold
      uptimeMs: BOOT_GRACE_MS + ONE_MIN,     // past grace but under threshold
    }));
    expect(r.dormant).toBe(false);
    // The reported age is clamped to uptime, not the raw wall-clock gap.
    expect(r.ageMs).toBe(BOOT_GRACE_MS + ONE_MIN);
  });

  it('disabled mapped agent ⇒ never dormant', () => {
    const r = computeDormancy(base({
      mapped: true,
      enabled: false,
      lastSeenMs: NOW - (THRESHOLD + ONE_MIN),
      uptimeMs: THRESHOLD + 10 * ONE_MIN,
    }));
    expect(r.dormant).toBe(false);
  });

  it('mapped agent with no uptime yet ⇒ NOT dormant', () => {
    const r = computeDormancy(base({
      mapped: true,
      uptimeMs: null,
      lastSeenMs: null,
    }));
    expect(r.dormant).toBe(false);
  });
});

describe('computeDormancy — Face B (unmapped/absent, daemon-uptime baseline)', () => {
  it('unmapped + stale heartbeat + enabled + past daemon grace ⇒ dormant (gate ignores mapped)', () => {
    const r = computeDormancy(base({
      mapped: false,
      uptimeMs: null, // no agent uptime — it is absent from the map
      lastSeenMs: NOW - (THRESHOLD + ONE_MIN),
      daemonUptimeMs: THRESHOLD + 10 * ONE_MIN,
    }));
    expect(r.dormant).toBe(true);
    expect(r.mapped).toBe(false);
    expect(r.reason).toContain('unmapped');
  });

  it('never-heartbeating absent agent past daemon grace ⇒ dormant', () => {
    // null last-seen is treated as "stale for the whole daemon uptime".
    const r = computeDormancy(base({
      mapped: false,
      uptimeMs: null,
      lastSeenMs: null,
      daemonUptimeMs: THRESHOLD + ONE_MIN, // exceeds threshold
    }));
    expect(r.dormant).toBe(true);
  });

  it('fresh daemon (uptime below grace) + absent stale agent ⇒ NOT dormant (fleet-bounce guard)', () => {
    const r = computeDormancy(base({
      mapped: false,
      uptimeMs: null,
      lastSeenMs: NOW - (THRESHOLD + ONE_MIN), // heartbeat is genuinely stale
      daemonUptimeMs: BOOT_GRACE_MS - ONE_MIN, // but the daemon just started
    }));
    expect(r.dormant).toBe(false);
  });

  it('disabled absent agent ⇒ never dormant', () => {
    const r = computeDormancy(base({
      mapped: false,
      enabled: false,
      uptimeMs: null,
      lastSeenMs: NOW - (THRESHOLD + ONE_MIN),
      daemonUptimeMs: THRESHOLD + 10 * ONE_MIN,
    }));
    expect(r.dormant).toBe(false);
  });
});
