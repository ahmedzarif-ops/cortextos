import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

/**
 * The statusLine hook is the daemon's only window onto a Claude seat's session.
 * Besides context usage it must record the transcript path: the turn watch reads
 * that file's mtime as the evidence that the seat is taking turns.
 */

const hookSource = resolve(__dirname, '../../../src/hooks/hook-context-status.ts');
const tsxLoader = require.resolve('tsx');

describe('hook-context-status', () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function run(input: Record<string, unknown>) {
    root = mkdtempSync(join(tmpdir(), 'hook-ctx-status-'));
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (!k.startsWith('CTX_') && v !== undefined) env[k] = v;
    }
    const result = spawnSync(process.execPath, ['--import', tsxLoader, hookSource], {
      input: JSON.stringify(input),
      env: { ...env, CTX_ROOT: root, CTX_AGENT_NAME: 'seat' },
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(readFileSync(join(root, 'state', 'seat', 'context_status.json'), 'utf8'));
  }

  it('records the transcript path alongside context usage', () => {
    const out = run({
      session_id: 's-1',
      transcript_path: '/somewhere/s-1.jsonl',
      context_window: { used_percentage: 42, context_window_size: 200000 },
    });
    expect(out).toMatchObject({ used_percentage: 42, session_id: 's-1', transcript_path: '/somewhere/s-1.jsonl' });
  });

  it('feeds the usage meter from rate_limits in the same input', () => {
    run({ session_id: 's-3', context_window: { used_percentage: 9 }, rate_limits: { five_hour: { used_percentage: 12 }, seven_day: { used_percentage: 70 } } });
    const usage = JSON.parse(readFileSync(join(root, 'state', 'usage', 'latest.json'), 'utf8'));
    expect(usage).toMatchObject({ account: 'statusline', five_hour_utilization: 0.12, seven_day_utilization: 0.7 });
  });

  it('writes null when the runtime sends no transcript path', () => {
    const out = run({ session_id: 's-2', context_window: { used_percentage: 7 } });
    expect(out.transcript_path).toBeNull();
    expect(out.used_percentage).toBe(7);
  });
});
