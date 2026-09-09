/**
 * tests/unit/daemon/cron-scheduler-one-shot.test.ts
 *
 * One-shot (`fire_at`) crons in CronScheduler.
 *
 * The type carried `fire_at` and documented that "the daemon treats this as a
 * one-shot", while the scheduler never read the field. These tests exist so
 * that sentence is checked rather than believed.
 *
 * ⛔ THE LOAD-BEARING TEST IS THE RESTART ONE. "Fires once" is trivially true
 * inside a single process; the property that matters is that the fired state is
 * PERSISTED, because a one-shot that only remembers in memory re-fires on the
 * next daemon boot — and nothing in a single-process test can tell those apart.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockReadCrons = vi.fn();
const mockUpdateCron = vi.fn();
const mockReadCronsWithStatus = vi.fn();
const mockCronsFileMtimeMs = vi.fn();

vi.mock('../../../src/bus/crons.js', () => ({
  readCrons: (...args: unknown[]) => mockReadCrons(...args),
  readCronsWithStatus: (...args: unknown[]) => mockReadCronsWithStatus(...args),
  updateCron: (...args: unknown[]) => mockUpdateCron(...args),
  cronsFileMtimeMs: (...args: unknown[]) => mockCronsFileMtimeMs(...args),
}));

import { CronScheduler } from '../../../src/daemon/cron-scheduler';
import type { CronDefinition } from '../../../src/types/index';

const TICK = CronScheduler.TICK_INTERVAL_MS;

function makeOneShot(overrides: Partial<CronDefinition> = {}): CronDefinition {
  return {
    name: 'one-shot',
    prompt: 'Fire exactly once.',
    // `schedule` is deliberately left as a normally-recurring value: the point
    // of the feature is that `fire_at` OVERRIDES it. If the implementation ever
    // falls back to the schedule, these tests fail rather than quietly passing
    // on a 1m interval that happens to fire at roughly the right time.
    schedule: '1m',
    enabled: true,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('CronScheduler one-shot (fire_at)', () => {
  let fired: CronDefinition[];
  let logs: string[];
  let scheduler: CronScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    fired = [];
    logs = [];
    mockReadCrons.mockReset();
    mockUpdateCron.mockReset();
    mockReadCronsWithStatus.mockReset();
    mockCronsFileMtimeMs.mockReset();
    mockReadCronsWithStatus.mockImplementation((agent: string) => ({
      crons: mockReadCrons(agent) ?? [],
      corrupt: false,
    }));
    mockCronsFileMtimeMs.mockReturnValue(1000);
    scheduler = new CronScheduler({
      agentName: 'test-agent',
      onFire: (cron) => { fired.push(cron); },
      logger: (msg) => { logs.push(msg); },
    });
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
  });

  it('does NOT fire before fire_at', async () => {
    const at = new Date(Date.now() + 10 * 60_000).toISOString();
    mockReadCrons.mockReturnValue([makeOneShot({ fire_at: at })]);
    scheduler.start();

    // Five minutes: past the '1m' schedule many times over, short of fire_at.
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(fired).toHaveLength(0);
  });

  it('fires ONCE at fire_at and never again', async () => {
    const at = new Date(Date.now() + 2 * 60_000).toISOString();
    mockReadCrons.mockReturnValue([makeOneShot({ fire_at: at })]);
    scheduler.start();

    await vi.advanceTimersByTimeAsync(2 * 60_000 + TICK);
    expect(fired).toHaveLength(1);

    // An hour of ticks after the fire — a recurring '1m' cron would fire ~60
    // more times here, so this interval is the control for "never again".
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(fired).toHaveLength(1);
  });

  it('fires ONCE when fire_at is already past at boot (daemon was down)', async () => {
    const at = new Date(Date.now() - 6 * 60 * 60_000).toISOString();
    mockReadCrons.mockReturnValue([makeOneShot({ fire_at: at })]);
    scheduler.start();

    await vi.advanceTimersByTimeAsync(TICK);
    expect(fired).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(fired).toHaveLength(1);
  });

  it('does NOT fire a disabled one-shot', async () => {
    const at = new Date(Date.now() + 60_000).toISOString();
    mockReadCrons.mockReturnValue([makeOneShot({ fire_at: at, enabled: false })]);
    scheduler.start();

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(fired).toHaveLength(0);
  });

  it('PERSISTS the fired state, and a restarted daemon reading it does not re-fire', async () => {
    const at = new Date(Date.now() - 60 * 60_000).toISOString();
    const def = makeOneShot({ fire_at: at });
    mockReadCrons.mockReturnValue([def]);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(TICK);
    expect(fired).toHaveLength(1);

    // The persistence is the requirement, so assert the WRITE, not just the
    // in-memory outcome: a scheduler that fired once and wrote nothing passes
    // every test above and re-fires on the next boot.
    const persisted = mockUpdateCron.mock.calls
      .filter((c) => c[1] === 'one-shot')
      .map((c) => c[2] as Partial<CronDefinition>);
    const fireState = persisted.find((p) => p.fire_count !== undefined);
    expect(fireState).toBeDefined();
    expect(fireState!.fire_count).toBe(1);
    expect(fireState!.last_fired_at).toBeTruthy();

    scheduler.stop();

    // A FRESH scheduler over the crons.json a restarted daemon would read:
    // the same definition, now carrying the persisted fire state.
    const afterRestart: CronDefinition = {
      ...def,
      fire_count: fireState!.fire_count,
      last_fired_at: fireState!.last_fired_at,
    };
    const firedAfter: CronDefinition[] = [];
    mockReadCrons.mockReturnValue([afterRestart]);
    const restarted = new CronScheduler({
      agentName: 'test-agent',
      onFire: (cron) => { firedAfter.push(cron); },
      logger: (msg) => { logs.push(msg); },
    });
    restarted.start();
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
    restarted.stop();

    expect(firedAfter).toHaveLength(0);
  });

  it('NEGATIVE CONTROL: the same harness DOES fire a recurring cron repeatedly', async () => {
    // Without this, every assertion above is satisfiable by a scheduler that
    // fires nothing at all. This proves the harness can produce fires.
    mockReadCrons.mockReturnValue([makeOneShot({ fire_at: undefined })]);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(5 * 60_000 + TICK);
    expect(fired.length).toBeGreaterThan(1);
  });
});
