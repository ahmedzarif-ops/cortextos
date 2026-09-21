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

  /**
   * ⛔ THE ARM THAT COUNTS WRITES CANNOT SEE A LEAKED TIMER. (guard, re-review of 9e1a6b00)
   *
   * The interval body is `this.contextReporter?.reportOnce()`. An implementation whose kill()
   * nulls `contextReporter` but never calls clearInterval SILENCES EVERY WRITE while the interval
   * goes on firing forever — and the three arms above, which count writes, see silence and call it
   * stopped. Guard mutated exactly that and it survived 3/3.
   *
   * That splits the two consequences apart: the write-counting arms cover consequence 1 (a fresh
   * context_status.json for a dead seat) and are blind to consequence 2 (one 20s interval leaked
   * per restart, in a daemon that lives for days).
   *
   * This arm asserts on `vi.getTimerCount()` — whether a scheduled timer still EXISTS. That is
   * still the property, not the mechanism: it does not care that clearInterval was the means, only
   * that one fewer timer remains scheduled. An implementation that stops the timer some other way
   * passes; one that leaves it armed fails, however quiet it is.
   *
   * ⚠ THE BASELINE IS `armed - 1`, NOT ZERO, AND THE REASON IS MEASURED: a spawn arms TWO timers,
   * the reporter interval AND the startup-injection retry loop. `kill()` is responsible for the
   * reporter only. My first version asserted a return to the pre-spawn count and FAILED AGAINST
   * THE CORRECT CODE (before=0, armed=2, afterKill=1) — the test was wrong, not the fix. Relative
   * to `armed` it also survives a future change to how the injection loop schedules itself.
   */
  it('leaves no timer armed after kill — silence is not the same as stopped', async () => {
    const before = vi.getTimerCount();

    const pty = await spawnedPty();
    // Drain the startup-injection timers so the only survivor is the reporter interval.
    await vi.advanceTimersByTimeAsync(CONTEXT_REPORT_INTERVAL_MS);

    const armed = vi.getTimerCount();
    // Positive control: without this, the assertion below would hold for an implementation that
    // never armed a timer at all.
    expect(armed).toBeGreaterThan(before);

    pty.kill();

    expect(vi.getTimerCount()).toBe(armed - 1);
  });
});
