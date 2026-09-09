/**
 * tests/unit/daemon/cron-phase-and-lateness.test.ts
 *
 * The two properties added on 2026-09-09, driven through the real scheduler:
 *   1. a LATE fire does not move the phase, and missed slots are skipped, not burst;
 *   2. the execution log records the DUE instant beside the fire instant.
 *
 * ⛔ WHY, and it is a measured incident rather than a hypothetical. A host sleep
 * beginning 15:25:02Z suspended the daemon; it ran only inside ~2s macOS DarkWake
 * windows roughly 16 minutes apart. Fires landed up to 15m29s late against a 30s
 * tick, and every one of them was written to cron-execution.log as
 * `{"status":"fired"}` with a `ts` and nothing else — a late fire and an on-time
 * fire in identical words. The 1h `lane-watch` cron moved from :24 to :36 and
 * STAYED there, because the post-fire advance counted from the actual fire.
 *
 * ⭐ THE SLEEP IS SIMULATED BY MOVING THE CLOCK WITHOUT RUNNING THE TICKS —
 * `vi.setSystemTime` then a single `advanceTimersByTimeAsync(TICK)`. Using
 * `advanceTimersByTimeAsync(15m)` would run all 30 intervening ticks, which is
 * an AWAKE daemon that was merely idle. That is a different scenario and it
 * would not reproduce the bug.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CronExecutionLogEntry } from '../../../src/types/index.js';

const mockReadCrons = vi.fn();
const mockUpdateCron = vi.fn();
const mockReadCronsWithStatus = vi.fn();
const mockCronsFileMtimeMs = vi.fn();

vi.mock('../../../src/bus/crons.js', () => ({
  readCrons: (...a: unknown[]) => mockReadCrons(...a),
  readCronsWithStatus: (...a: unknown[]) => mockReadCronsWithStatus(...a),
  updateCron: (...a: unknown[]) => mockUpdateCron(...a),
  cronsFileMtimeMs: (...a: unknown[]) => mockCronsFileMtimeMs(...a),
}));

const logEntries: CronExecutionLogEntry[] = [];
vi.mock('../../../src/daemon/cron-execution-log.js', () => ({
  appendExecutionLog: (_agent: string, entry: CronExecutionLogEntry) => { logEntries.push(entry); },
}));

import { CronScheduler } from '../../../src/daemon/cron-scheduler';

const TICK = 30_000;
const HOUR = 3_600_000;
const T0 = Date.parse('2026-09-09T12:00:00.000Z');

describe('cron phase preservation and fire lateness', () => {
  let scheduler: CronScheduler;
  let fired: { name: string; at: number }[];

  const makeCron = (over: Record<string, unknown> = {}) => ({
    name: 'lane-watch', schedule: '1h', prompt: 'p', enabled: true, ...over,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    fired = [];
    logEntries.length = 0;
    mockReadCrons.mockReset();
    mockUpdateCron.mockReset().mockReturnValue(true);
    mockReadCronsWithStatus.mockReset().mockImplementation((a: string) => ({
      crons: mockReadCrons(a) ?? [], corrupt: false,
    }));
    mockCronsFileMtimeMs.mockReset().mockReturnValue(1000);
    scheduler = new CronScheduler({
      agentName: 'test-agent',
      onFire: (c) => { fired.push({ name: c.name, at: Date.now() }); },
      logger: () => {},
    });
  });

  afterEach(() => { scheduler.stop(); vi.useRealTimers(); });

  /** Jump the clock as a suspended process would, then let exactly one tick run. */
  async function sleepThenOneTick(toMs: number) {
    vi.setSystemTime(toMs);
    await vi.advanceTimersByTimeAsync(TICK);
  }

  it('a 15-minute-late fire leaves the phase UNCHANGED', async () => {
    mockReadCrons.mockReturnValue([makeCron()]);
    scheduler.start();

    // Due at T0+1h; the host is asleep until 15 minutes past that.
    const due = T0 + HOUR;
    await sleepThenOneTick(due + 15 * 60_000);
    expect(fired).toHaveLength(1);
    expect(fired[0].at).toBeGreaterThanOrEqual(due + 15 * 60_000);

    // ⭐ THE ASSERTION THAT MATTERS, and it is behavioural rather than a peek at a
    // private field: the next fire must arrive on the ORIGINAL phase (T0+2h), so
    // it must NOT have fired by one tick before that instant...
    await sleepThenOneTick(T0 + 2 * HOUR - 2 * TICK);
    expect(fired).toHaveLength(1);

    // ...and must have fired by just after it.
    await sleepThenOneTick(T0 + 2 * HOUR + TICK);
    expect(fired).toHaveLength(2);
  });

  it('the OLD behaviour is excluded, not merely unobserved', async () => {
    // Under the pre-fix code the next slot was actual_fire + interval =
    // T0 + 1h15m + 1h = T0 + 2h15m. If the phase had re-anchored, the second fire
    // could not have happened by T0+2h+1tick — which the test above asserts it
    // did. This test states the same fact from the other side: at T0 + 2h05m the
    // count is already 2, which is impossible if the next slot were T0+2h15m.
    mockReadCrons.mockReturnValue([makeCron()]);
    scheduler.start();
    await sleepThenOneTick(T0 + HOUR + 15 * 60_000);
    await sleepThenOneTick(T0 + 2 * HOUR + 5 * 60_000);
    expect(fired).toHaveLength(2);
  });

  it('a long sleep SKIPS missed slots — one fire, not a burst, and still on phase', async () => {
    mockReadCrons.mockReturnValue([makeCron()]);
    scheduler.start();

    // Asleep across six whole 1h slots.
    await sleepThenOneTick(T0 + 6 * HOUR + 30 * 60_000);
    expect(fired).toHaveLength(1); // ⛔ one catch-up, never six

    // Next fire is the next slot ON PHASE: T0+7h, not wake+1h.
    await sleepThenOneTick(T0 + 7 * HOUR - 2 * TICK);
    expect(fired).toHaveLength(1);
    await sleepThenOneTick(T0 + 7 * HOUR + TICK);
    expect(fired).toHaveLength(2);
  });

  it('an ON-TIME fire is unaffected — the phase logic must not perturb the normal path', async () => {
    // Negative control. Without it, anything that made fires happen early would
    // pass every assertion above.
    mockReadCrons.mockReturnValue([makeCron()]);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(HOUR + TICK);
    expect(fired).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(fired).toHaveLength(2);
    expect(fired[1].at - fired[0].at).toBe(HOUR);
  });

  describe('due_at in the execution log', () => {
    it('records the DUE instant beside the fire instant, so lateness is derivable', async () => {
      mockReadCrons.mockReturnValue([makeCron()]);
      scheduler.start();
      const due = T0 + HOUR;
      await sleepThenOneTick(due + 15 * 60_000);

      const entry = logEntries.find((e) => e.status === 'fired');
      expect(entry).toBeDefined();
      expect(entry!.due_at).toBe(new Date(due).toISOString());

      // The point of the field: this subtraction was impossible before.
      const lateness = Date.parse(entry!.ts) - Date.parse(entry!.due_at!);
      expect(lateness).toBeGreaterThanOrEqual(15 * 60_000);
    });

    it('an on-time fire records due_at too, and its lateness is ~0', async () => {
      // Negative control: due_at must not be "the field that appears when late".
      // A reader has to be able to tell on-time from late, which needs both.
      mockReadCrons.mockReturnValue([makeCron()]);
      scheduler.start();
      await vi.advanceTimersByTimeAsync(HOUR + TICK);
      const entry = logEntries.find((e) => e.status === 'fired');
      expect(entry?.due_at).toBeDefined();
      expect(Date.parse(entry!.ts) - Date.parse(entry!.due_at!)).toBeLessThan(2 * TICK);
    });
  });
});
