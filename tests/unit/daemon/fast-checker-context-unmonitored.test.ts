import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('child_process', () => ({ execFile: vi.fn() }));

import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FastChecker } from '../../../src/daemon/fast-checker';
import type { BusPaths } from '../../../src/types';

/**
 * checkContextStatus() skips when the status file is missing or too old. Both skips are
 * CORRECT — acting on a percentage nobody wrote would fire handoffs on stale numbers.
 * What was wrong is that they returned in SILENCE: a seat that had fallen out of
 * monitoring produced the same output as a seat sitting comfortably below threshold,
 * which is none.
 *
 * Measured 2026-09-04: two hermes seats ran 203 messages against a frozen status file
 * because no runtime hook writes it for hermes, and nothing anywhere reported it.
 *
 * ⭐ THE STALL ARM IS THE POINT OF THIS FILE AND IT RUNS FIRST. A reader that cannot
 * report UNKNOWN has not been tested — and that is precisely the arm that was broken.
 */

function createMockAgent(name = 'test-agent') {
  return {
    name,
    isBootstrapped: vi.fn().mockReturnValue(true),
    injectMessage: vi.fn(),
    write: vi.fn(),
    // The FRESH path continues into the threshold logic, which reads the PTY buffer.
    // A mock that stops at the boundary of the thing under test would fail the
    // must-stay-green arms for a reason that has nothing to do with the change.
    getOutputBuffer: vi.fn().mockReturnValue({ getRecent: () => '' }),
    getConfig: vi.fn().mockReturnValue({}),
  } as any;
}

function createTestPaths(testDir: string): BusPaths {
  const paths = {
    ctxRoot: testDir,
    inbox: join(testDir, 'inbox'),
    inflight: join(testDir, 'inflight'),
    processed: join(testDir, 'processed'),
    logDir: join(testDir, 'logs'),
    stateDir: join(testDir, 'state'),
    taskDir: join(testDir, 'tasks'),
    approvalDir: join(testDir, 'approvals'),
    analyticsDir: join(testDir, 'analytics'),
    heartbeatDir: join(testDir, 'heartbeats'),
  } as unknown as BusPaths;
  for (const dir of Object.values(paths)) {
    if (typeof dir === 'string' && dir !== testDir) mkdirSync(dir, { recursive: true });
  }
  return paths;
}

describe('FastChecker: context monitoring reports UNKNOWN instead of skipping silently', () => {
  let testDir: string;
  let paths: BusPaths;
  let logs: string[];

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'fc-ctxmon-'));
    paths = createTestPaths(testDir);
    logs = [];
  });
  afterEach(() => rmSync(testDir, { recursive: true, force: true }));

  function checker() {
    return new FastChecker(createMockAgent(), paths, '/tmp/framework', {
      log: (m: string) => logs.push(m),
    });
  }
  const monitorFile = () => join(paths.stateDir, 'context_monitor.json');
  const statusFile = () => join(paths.stateDir, 'context_status.json');
  const readMonitor = () => JSON.parse(readFileSync(monitorFile(), 'utf-8'));

  it('THE STALL ARM: a status file older than the cut-off produces a reported UNKNOWN', async () => {
    // 45 minutes old — comfortably past the 10-minute cut-off.
    writeFileSync(statusFile(), JSON.stringify({
      used_percentage: 33.9,
      written_at: new Date(Date.now() - 45 * 60_000).toISOString(),
    }));

    await (checker() as any).checkContextStatus();

    expect(existsSync(monitorFile())).toBe(true);
    const m = readMonitor();
    expect(m.monitored).toBe(false);
    expect(m.state).toBe('UNKNOWN');
    expect(m.reason).toBe('status-stale');
    // The last-known percentage is carried as DETAIL, never as the state: 33.9 must not
    // be readable as a live figure by anything downstream.
    expect(m.detail.last_percentage).toBe(33.9);
    expect(logs.join('\n')).toMatch(/CONTEXT MONITORING UNKNOWN/);
  });

  it('a MISSING status file is also reported, not silently skipped', async () => {
    await (checker() as any).checkContextStatus();
    const m = readMonitor();
    expect(m.monitored).toBe(false);
    expect(m.reason).toBe('no-status-file');
  });

  it('a FRESH status file leaves monitoring OK — the guard must not cry wolf', async () => {
    writeFileSync(statusFile(), JSON.stringify({
      used_percentage: 12,
      written_at: new Date().toISOString(),
      session_id: 'sess-fresh',
    }));

    const c = checker();
    await (c as any).checkContextStatus();

    // Either no monitor file at all, or one that says monitored — never UNKNOWN.
    if (existsSync(monitorFile())) {
      expect(readMonitor().monitored).toBe(true);
    }
    expect(logs.join('\n')).not.toMatch(/CONTEXT MONITORING UNKNOWN/);
  });

  it('recovery is reported too: UNKNOWN then fresh clears back to OK', async () => {
    const c = checker();
    writeFileSync(statusFile(), JSON.stringify({
      used_percentage: 33.9,
      written_at: new Date(Date.now() - 45 * 60_000).toISOString(),
    }));
    await (c as any).checkContextStatus();
    expect(readMonitor().monitored).toBe(false);

    writeFileSync(statusFile(), JSON.stringify({
      used_percentage: 12,
      written_at: new Date().toISOString(),
      session_id: 'sess-recovered',
    }));
    await (c as any).checkContextStatus();

    expect(readMonitor().monitored).toBe(true);
    expect(logs.join('\n')).toMatch(/Context monitoring resumed/);
  });

  it('checked_at advances on every tick so a reader can tell "unmonitored NOW" from "was, once"', async () => {
    writeFileSync(statusFile(), JSON.stringify({
      used_percentage: 33.9,
      written_at: new Date(Date.now() - 45 * 60_000).toISOString(),
    }));
    const c = checker();
    await (c as any).checkContextStatus();
    const first = readMonitor();
    await new Promise(r => setTimeout(r, 5));
    await (c as any).checkContextStatus();
    const second = readMonitor();

    expect(second.unmonitored_since).toBe(first.unmonitored_since); // the onset does not move
    expect(new Date(second.checked_at).getTime()).toBeGreaterThanOrEqual(new Date(first.checked_at).getTime());
  });
});
