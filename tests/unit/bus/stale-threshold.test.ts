/**
 * tests/unit/bus/stale-threshold.test.ts
 *
 * `read-all-heartbeats` marked an agent [STALE] after a flat 2 hours, for every agent.
 * The documented alerting rule is different: alert when a heartbeat is older than TWICE THE AGENT'S
 * OWN LOOP INTERVAL. A fixed threshold cannot agree with a per-agent rule at more than one cadence.
 *
 * It was wrong in BOTH directions, which is the part worth pinning:
 *   - 4h heartbeat -> marked STALE at 2h, alertable only at 8h. Six hours of a red marker that means
 *     nothing actionable, and a marker that cries wolf is one people learn to skip.
 *   - 30m heartbeat -> alertable at 1h, but not marked until 2h. Silent for an hour after the agent
 *     is genuinely overdue.
 *
 * So the same constant was simultaneously too eager and too lazy, depending on the one thing it did
 * not look at.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stale-threshold-'));
  process.env.CTX_ROOT = root;
  vi.resetModules();
});

afterEach(() => {
  try { rmSync(root, { recursive: true }); } catch { /* ignore */ }
});

/** Write a crons.json for an agent with a single `heartbeat` cron on the given schedule. */
function writeHeartbeatCron(agent: string, schedule: string): void {
  const dir = join(root, '.cortextOS', 'state', 'agents', agent);
  mkdirSync(dir, { recursive: true });
  // Shape matters: parseCronsRaw requires an OBJECT with a `crons` array, not a bare array. My first
  // fixture was a bare array and every derived case silently fell back to the default — the code was
  // right and the FIXTURE was wrong, which is the harder of the two to spot because the failure looks
  // exactly like the bug under test still being present.
  writeFileSync(
    join(dir, 'crons.json'),
    JSON.stringify(
      { updated_at: new Date().toISOString(), crons: [{ name: 'heartbeat', schedule, prompt: 'x', enabled: true }] },
      null,
      2,
    ),
  );
}

async function load() {
  return await import('../../../src/cli/bus');
}

describe('resolveStaleThresholdMs', () => {
  it('derives 2x the loop for a 4h heartbeat — 8h, not the old flat 2h', async () => {
    writeHeartbeatCron('slowseat', '4h');
    const { resolveStaleThresholdMs } = await load();

    expect(resolveStaleThresholdMs('slowseat')).toEqual({ ms: 8 * 60 * 60 * 1000, derived: true });
  });

  it('derives a SHORTER threshold for a fast seat — the old constant was too lazy here', async () => {
    // This direction is the one a "2h is fine" intuition misses entirely.
    writeHeartbeatCron('fastseat', '30m');
    const { resolveStaleThresholdMs } = await load();

    const { ms, derived } = resolveStaleThresholdMs('fastseat');
    expect(derived).toBe(true);
    expect(ms).toBe(60 * 60 * 1000);
    expect(ms).toBeLessThan(2 * 60 * 60 * 1000); // strictly earlier than the old marker
  });

  it('falls back to 2h AND SAYS SO when the agent has no heartbeat cron', async () => {
    const { resolveStaleThresholdMs } = await load();

    expect(resolveStaleThresholdMs('nosuchagent')).toEqual({ ms: 2 * 60 * 60 * 1000, derived: false });
  });

  it('falls back for a CLOCK schedule, which has no single interval to double', async () => {
    // `0 * * * *` is hourly in effect, but a cron expression has no duration to multiply — and
    // guessing one would be inventing a threshold rather than deriving it.
    writeHeartbeatCron('clockseat', '0 * * * *');
    const { resolveStaleThresholdMs } = await load();

    expect(resolveStaleThresholdMs('clockseat')).toEqual({ ms: 2 * 60 * 60 * 1000, derived: false });
  });

  it('reports derived and defaulted as DIFFERENT, so a reader can tell them apart', async () => {
    writeHeartbeatCron('derivedseat', '1h');
    const { resolveStaleThresholdMs } = await load();

    // Both can yield 2h — a 1h loop derives 2h, and the fallback IS 2h. The number alone is therefore
    // NOT enough to know whether anything was derived, which is exactly why `derived` is reported
    // separately rather than inferred from the value.
    const a = resolveStaleThresholdMs('derivedseat');
    const b = resolveStaleThresholdMs('nosuchagent');
    expect(a.ms).toBe(b.ms);
    expect(a.derived).toBe(true);
    expect(b.derived).toBe(false);
  });
});

describe('fmtDuration', () => {
  it('renders whole hours, minutes and seconds readably', async () => {
    const { fmtDuration } = await load();
    expect(fmtDuration(8 * 60 * 60 * 1000)).toBe('8h');
    expect(fmtDuration(90 * 60 * 1000)).toBe('90m');
    expect(fmtDuration(45 * 1000)).toBe('45s');
  });
});
