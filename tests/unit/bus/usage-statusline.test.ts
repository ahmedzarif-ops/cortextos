import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { spawn } from 'child_process';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import {
  checkUsageApi,
  readStatuslineUsage,
  recordStatuslineUsage,
  STATUSLINE_USAGE_MAX_AGE_MS,
  STATUSLINE_USAGE_MIN_INTERVAL_MS,
} from '../../../src/bus/oauth';

/**
 * The usage meter went silent for weeks because its only source needed an OAuth
 * account store and a rate-limited API. Claude Code already passes the same
 * numbers to every seat's statusLine; these tests pin that feed, its separation
 * from the API cache and the metrics log, and its behaviour under many writers.
 */

const NOW = Date.parse('2026-01-01T12:00:00Z');
const RL = {
  five_hour: { used_percentage: 42, resets_at: '2026-01-01T15:00:00Z' },
  seven_day: { used_percentage: 0.5, resets_at: '2026-01-04T21:00:00Z' },
  model_scoped: [{ label: 'x', used_percentage: 83 }],
};

describe('statusLine usage feed', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'usage-sl-'));
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  const usageDir = () => join(root, 'state', 'usage');
  const statusline = () => JSON.parse(readFileSync(join(usageDir(), 'statusline.json'), 'utf-8'));

  it('writes fractions (percent / 100, so 0.5% is 0.005, not 50%) to its OWN file only', () => {
    expect(recordStatuslineUsage(root, RL, NOW)).toBe(true);
    expect(statusline()).toMatchObject({
      account: 'statusline', five_hour_utilization: 0.42, seven_day_utilization: 0.005,
      fetched_at: new Date(NOW).toISOString(), five_hour_resets_at: '2026-01-01T15:00:00Z',
      seven_day_resets_at: '2026-01-04T21:00:00Z', model_scoped: RL.model_scoped,
    });
    // The API cache, latest.json and the daily log belong to other writers.
    expect(readdirSync(usageDir())).toEqual(['statusline.json']);
  });

  it('converts epoch resets_at (seconds or ms, as Claude Code sends them) to ISO', () => {
    const sec = Date.parse('2026-01-01T15:00:00Z') / 1000;
    expect(recordStatuslineUsage(root, {
      five_hour: { used_percentage: 1, resets_at: sec },
      seven_day: { used_percentage: 1, resets_at: Date.parse('2026-01-04T21:00:00Z') },
    }, NOW)).toBe(true);
    expect(statusline()).toMatchObject({
      five_hour_resets_at: '2026-01-01T15:00:00.000Z',
      seven_day_resets_at: '2026-01-04T21:00:00.000Z',
    });
  });

  it('a missing or junk resets_at is null, never a 1970 date', () => {
    expect(recordStatuslineUsage(root, {
      five_hour: { used_percentage: 1, resets_at: 0 },
      seven_day: { used_percentage: 1, resets_at: Number.NaN },
    }, NOW)).toBe(true);
    expect(statusline()).toMatchObject({ five_hour_resets_at: null, seven_day_resets_at: null });
  });

  it('throttles: a second reading inside the interval is skipped, after it is written', () => {
    expect(recordStatuslineUsage(root, RL, NOW)).toBe(true);
    expect(recordStatuslineUsage(root, { five_hour: { used_percentage: 50 } }, NOW + STATUSLINE_USAGE_MIN_INTERVAL_MS - 1)).toBe(false);
    expect(statusline().five_hour_utilization).toBe(0.42);
    expect(recordStatuslineUsage(root, { five_hour: { used_percentage: 50 } }, NOW + STATUSLINE_USAGE_MIN_INTERVAL_MS)).toBe(true);
    expect(statusline().five_hour_utilization).toBe(0.5);
  });

  it('writes nothing for absent or empty rate limits', () => {
    expect(recordStatuslineUsage(root, undefined, NOW)).toBe(false);
    expect(recordStatuslineUsage(root, { five_hour: {} }, NOW)).toBe(false);
    expect(existsSync(usageDir())).toBe(false);
  });

  it('readStatuslineUsage refuses a stale reading', () => {
    recordStatuslineUsage(root, RL, NOW);
    expect(readStatuslineUsage(root, NOW + STATUSLINE_USAGE_MAX_AGE_MS)).not.toBeNull();
    expect(readStatuslineUsage(root, NOW + STATUSLINE_USAGE_MAX_AGE_MS + 1)).toBeNull();
  });

  it('check-usage-api with no credential answers from a fresh statusLine reading, without the network', async () => {
    const fetchSpy = vi.fn(() => { throw new Error('network must not be used'); });
    vi.stubGlobal('fetch', fetchSpy);
    recordStatuslineUsage(root, RL);
    expect(await checkUsageApi(root, {})).toMatchObject({ account: 'statusline', five_hour_utilization: 0.42, cached: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('check-usage-api falls back to the statusLine reading when the API refuses (429)', async () => {
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'test-token');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 429, text: async () => 'rate limited' })));
    recordStatuslineUsage(root, RL);
    expect(await checkUsageApi(root, {})).toMatchObject({ account: 'statusline', cached: true });
  });

  it('a NAMED account is never answered with the statusLine reading', async () => {
    recordStatuslineUsage(root, RL);
    await expect(checkUsageApi(root, { account: 'work' })).rejects.toThrow(/Account "work" not found/);
  });

  it('a fresh cached reading for ONE account does not answer a request for another', async () => {
    mkdirSync(usageDir(), { recursive: true });
    writeFileSync(join(usageDir(), 'cache.json'), JSON.stringify({
      snapshot: { account: 'personal', five_hour_utilization: 0.9, seven_day_utilization: 0.9, fetched_at: new Date().toISOString() },
      expires_at: Date.now() + 60_000,
    }));
    expect(await checkUsageApi(root, {})).toMatchObject({ account: 'personal', cached: true });
    await expect(checkUsageApi(root, { account: 'work' })).rejects.toThrow(/Account "work" not found/);
  });

  it('a NAMED account the API refuses is an error, never the statusLine reading', async () => {
    mkdirSync(join(root, 'state', 'oauth'), { recursive: true });
    writeFileSync(join(root, 'state', 'oauth', 'accounts.json'), JSON.stringify({
      active: 'work', rotation_log: [],
      accounts: { work: { label: 'work', access_token: 't', refresh_token: 'r', expires_at: Date.now() + 3_600_000, last_refreshed: new Date().toISOString(), five_hour_utilization: 0, seven_day_utilization: 0 } },
    }));
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 429, text: async () => 'rate limited' })));
    recordStatuslineUsage(root, RL);
    await expect(checkUsageApi(root, { account: 'work' })).rejects.toThrow(/429/);
  });

  it('eight concurrent hook processes leave one valid file and append nothing', async () => {
    const hook = resolve(__dirname, '../../../src/hooks/hook-context-status.ts');
    const tsx = require.resolve('tsx');
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('CTX_') && v !== undefined) env[k] = v;
    const runs = Array.from({ length: 8 }, (_, i) => new Promise<number>((done) => {
      const child = spawn(process.execPath, ['--import', tsx, hook], {
        env: { ...env, CTX_ROOT: root, CTX_AGENT_NAME: `seat${i}` },
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      child.stdin.end(JSON.stringify({ session_id: `s${i}`, context_window: { used_percentage: 5 }, rate_limits: { five_hour: { used_percentage: 10 + i } } }));
      child.on('exit', (code) => done(code ?? -1));
    }));
    expect(await Promise.all(runs)).toEqual(Array(8).fill(0));
    const snap = statusline();
    expect(snap.account).toBe('statusline');
    expect(snap.five_hour_utilization).toBeGreaterThanOrEqual(0.1);
    expect(readdirSync(usageDir()).filter((f) => !f.startsWith('statusline.json'))).toEqual([]);
  }, 30_000);
});
