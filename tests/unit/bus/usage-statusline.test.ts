import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { checkUsageApi, recordStatuslineUsage, STATUSLINE_USAGE_MIN_INTERVAL_MS } from '../../../src/bus/oauth';

/**
 * The usage meter went silent for weeks because its only source needed an OAuth
 * account store and a rate-limited API. Claude Code already passes the same
 * numbers to every seat's statusLine; these tests pin that feed.
 */

const NOW = Date.parse('2026-01-01T12:00:00Z');
const RL = {
  five_hour: { used_percentage: 42, resets_at: '2026-01-01T15:00:00Z' },
  seven_day: { used_percentage: 0.5, resets_at: '2026-01-04T21:00:00Z' },
  model_scoped: [{ label: 'x', used_percentage: 83 }],
};

describe('recordStatuslineUsage', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'usage-sl-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.unstubAllGlobals(); });
  const latest = () => JSON.parse(readFileSync(join(root, 'state', 'usage', 'latest.json'), 'utf-8'));

  it('writes fractions (percent / 100, so 0.5% is 0.005, not 50%) with reset times and model windows', () => {
    expect(recordStatuslineUsage(root, RL, NOW)).toBe(true);
    expect(latest()).toMatchObject({
      account: 'statusline', five_hour_utilization: 0.42, seven_day_utilization: 0.005,
      fetched_at: new Date(NOW).toISOString(), five_hour_resets_at: '2026-01-01T15:00:00Z',
      seven_day_resets_at: '2026-01-04T21:00:00Z', model_scoped: RL.model_scoped,
    });
  });

  it('throttles: a second reading inside the interval is skipped, after it is written', () => {
    expect(recordStatuslineUsage(root, RL, NOW)).toBe(true);
    expect(recordStatuslineUsage(root, { five_hour: { used_percentage: 50 } }, NOW + STATUSLINE_USAGE_MIN_INTERVAL_MS - 1)).toBe(false);
    expect(latest().five_hour_utilization).toBe(0.42);
    expect(recordStatuslineUsage(root, { five_hour: { used_percentage: 50 } }, NOW + STATUSLINE_USAGE_MIN_INTERVAL_MS)).toBe(true);
    expect(latest().five_hour_utilization).toBe(0.5);
  });

  it('writes nothing for absent or empty rate limits', () => {
    expect(recordStatuslineUsage(root, undefined, NOW)).toBe(false);
    expect(recordStatuslineUsage(root, { five_hour: {} }, NOW)).toBe(false);
    expect(() => latest()).toThrow();
  });

  it('check-usage-api (no --force) answers from the statusLine reading without calling the API', async () => {
    const fetchSpy = vi.fn(() => { throw new Error('network must not be used'); });
    vi.stubGlobal('fetch', fetchSpy);
    recordStatuslineUsage(root, RL); // real clock: the cache must still be fresh
    const r = await checkUsageApi(root, {});
    expect(r).toMatchObject({ account: 'statusline', five_hour_utilization: 0.42, cached: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
