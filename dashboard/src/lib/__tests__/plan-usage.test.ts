import { afterAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Real files under a temp CTX_ROOT; reports.ts resolves CTX_ROOT at import time.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-usage-'));
process.env.CTX_ROOT = root;
const usageDir = path.join(root, 'state', 'usage');
fs.mkdirSync(usageDir, { recursive: true });
const latest = path.join(usageDir, 'latest.json');

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('getPlanUsage', () => {
  it('OAuth-shaped latest.json (no session/week windows) yields null windows with a reason, not undefined', async () => {
    // The exact file src/bus/oauth.ts writes; before the fix this was returned verbatim
    // and the analytics page threw "Cannot read properties of undefined (reading 'used_pct')".
    fs.writeFileSync(latest, JSON.stringify({ account: 'env', five_hour_utilization: 0, seven_day_utilization: 1, fetched_at: '2026-08-27T08:06:23.608Z' }));
    const { getPlanUsage } = await import('../data/reports');
    const usage = getPlanUsage();
    expect(usage).not.toBeNull();
    expect(usage!.week_all_models).toBeNull();
    expect(usage!.session).toBeNull();
    expect(usage!.week_sonnet).toBeNull();
    expect(usage!.unavailable_reason).toMatch(/OAuth usage snapshot/);
    expect(usage!.timestamp).toBe('2026-08-27T08:06:23.608Z');
  });

  it('scrape-usage shaped latest.json passes through; a missing window is null, never 0', async () => {
    fs.writeFileSync(latest, JSON.stringify({ agent: 'a', timestamp: 't', session: { used_pct: 12, resets: 'x' }, week_all_models: { used_pct: 40, resets: 'y' } }));
    const { getPlanUsage } = await import('../data/reports');
    const usage = getPlanUsage()!;
    expect(usage.session).toEqual({ used_pct: 12, resets: 'x' });
    expect(usage.week_all_models).toEqual({ used_pct: 40, resets: 'y' });
    expect(usage.week_sonnet).toBeNull();
    expect(usage.unavailable_reason).toBeUndefined();
  });
});
