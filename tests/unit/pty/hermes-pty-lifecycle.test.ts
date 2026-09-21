import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { homedir } from 'os';

/**
 * PTY LIFECYCLE: the context reporter must not outlive the PTY.
 *
 * WHY THIS FILE EXISTS (guard's review of cortextos PR #61, 2026-09-21): the eight arms in
 * `hermes-context-reporter.test.ts` all cover what the reporter READS — cumulative totals, a NULL
 * `token_count` not becoming a confident zero, idle not rewriting `written_at`. Not one of them
 * covers what happens when the seat DIES, and `HermesPTY` shipped with no `override kill()` while
 * the sibling `OpencodePTY` has one. Nothing failed, because nothing asked.
 *
 * The two consequences, both silent:
 *   1. the 20s interval keeps writing `context_status.json` for a session that is gone, so the
 *      daemon's context gate reads a FRESH file for a DEAD seat — the "at rest is indistinguishable
 *      from failed" shape this PR exists to remove, reintroduced at the other end;
 *   2. every restart constructs a new HermesPTY whose `startContextReporter` stops only ITS OWN
 *      (null) timer, so each restart leaks another reporter and they all write the same path.
 *
 * `timer.unref()` does not help: it stops the timer holding the process open, it does not stop it
 * firing, and the PTY object lives as long as the daemon.
 *
 * ⚠ THE ASSERTION IS ON THE PROPERTY, NOT THE MECHANISM. It counts reporter writes after kill()
 * rather than asserting `clearInterval` was called, so an implementation that stops the timer some
 * other way still passes and one that calls `clearInterval` on the wrong timer still fails.
 */

const fsMocks = {
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    get existsSync() { return fsMocks.existsSync; },
    get readFileSync() { return fsMocks.readFileSync; },
    get writeFileSync() { return fsMocks.writeFileSync; },
  };
});

vi.mock('node-pty', () => ({
  spawn: vi.fn().mockReturnValue({
    pid: 99, write: vi.fn(), onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), resize: vi.fn(),
  }),
}));

// Count the reporter's writes without touching sqlite. reportOnce IS the write.
const reporterMocks = vi.hoisted(() => ({ reportOnce: vi.fn() }));
vi.mock('../../../src/pty/hermes-context-reporter.js', () => ({
  // A real class, not vi.fn().mockImplementation(() => ({...})): the adapter calls
  // `new HermesContextReporter(...)`, and an arrow function is not a constructor.
  HermesContextReporter: class {
    reportOnce = reporterMocks.reportOnce;
  },
}));

const { HermesPTY } = await import('../../../src/pty/hermes-pty.js');

const CONTEXT_REPORT_INTERVAL_MS = 20000;

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'hermes-agent',
  agentDir: '/tmp/fw/orgs/acme/agents/hermes-agent',
  org: 'acme',
  projectRoot: '/tmp/fw',
};

const PROFILE_HOME = join(homedir(), '.hermes', 'profiles', 'hermes-agent');

let originalHermesHome: string | undefined;

beforeEach(() => {
  fsMocks.existsSync.mockReset().mockImplementation((p: string) => p === PROFILE_HOME);
  fsMocks.readFileSync.mockReset().mockReturnValue('');
  fsMocks.writeFileSync.mockReset();
  reporterMocks.reportOnce.mockReset();
  originalHermesHome = process.env['HERMES_HOME'];
  delete process.env['HERMES_HOME'];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  if (originalHermesHome === undefined) delete process.env['HERMES_HOME'];
  else process.env['HERMES_HOME'] = originalHermesHome;
});

async function spawnedPty() {
  const pty = new HermesPTY(mockEnv, {
    hermes_profile: 'hermes-agent',
    model: 'z-ai/glm-5.3-flash',
    hermes_provider: 'nous',
    hermes_reasoning: 'high',
  });
  (pty as unknown as { spawnFn: unknown }).spawnFn = vi.fn().mockReturnValue({
    pid: 99, write: vi.fn(), onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), resize: vi.fn(),
  });
  pty.getOutputBuffer().push('⚔ ❯ ');
  await pty.spawn('fresh', 'bootstrap');
  return pty;
}

describe('HermesPTY context reporter lifecycle', () => {
  it('POSITIVE CONTROL: the reporter fires on spawn and keeps firing on the interval', async () => {
    const pty = await spawnedPty();

    // startContextReporter() calls reportOnce() immediately, before arming the interval.
    expect(reporterMocks.reportOnce).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(CONTEXT_REPORT_INTERVAL_MS);
    expect(reporterMocks.reportOnce).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(CONTEXT_REPORT_INTERVAL_MS);
    expect(reporterMocks.reportOnce).toHaveBeenCalledTimes(3);

    // Without this arm, the kill assertion below would pass against an implementation whose
    // reporter never ran at all — a vacuous green.
    pty.kill();
  });

  it('stops writing context_status.json once the PTY is killed', async () => {
    const pty = await spawnedPty();
    vi.advanceTimersByTime(CONTEXT_REPORT_INTERVAL_MS * 2);
    const callsBeforeKill = reporterMocks.reportOnce.mock.calls.length;
    expect(callsBeforeKill).toBeGreaterThan(1);

    pty.kill();

    // Three more intervals. A live timer would add three writes for a dead session.
    vi.advanceTimersByTime(CONTEXT_REPORT_INTERVAL_MS * 3);

    expect(reporterMocks.reportOnce).toHaveBeenCalledTimes(callsBeforeKill);
  });

  it('does not leak the previous session reporter when a seat restarts', async () => {
    const first = await spawnedPty();
    vi.advanceTimersByTime(CONTEXT_REPORT_INTERVAL_MS);
    first.kill();

    const callsAfterFirstDied = reporterMocks.reportOnce.mock.calls.length;

    // A restart builds a NEW HermesPTY. Its startContextReporter() can only stop its own timer,
    // so if the first instance's timer survived kill() both would now be writing the same path.
    const second = await spawnedPty();
    vi.advanceTimersByTime(CONTEXT_REPORT_INTERVAL_MS);

    // second contributes exactly: 1 immediate + 1 interval tick.
    expect(reporterMocks.reportOnce).toHaveBeenCalledTimes(callsAfterFirstDied + 2);

    second.kill();
  });
});
