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
    // ⛔ THE REAL updateCron RETURNS A BOOLEAN — `false` when no cron of that
    // name exists. This double returned `undefined`, which is falsy, so a
    // scheduler that checks the return value would read every write in these
    // tests as a failure. That gap is not cosmetic: an under-specified return on
    // the double is exactly why the missing return-value check went unnoticed in
    // review. Model the contract.
    mockUpdateCron.mockReturnValue(true);
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

  // =========================================================================
  // HARDENING — guard's REQUEST CHANGES on this PR, folded in.
  //
  // All three findings are ONE ERROR: the first pass verified the guards it had
  // in mind rather than the ones that exist. The remedy in the tests is the same
  // as in the code — drive the FAILURE PATHS, not the happy path.
  // =========================================================================

  // ── P1: NO MARKER, NO FIRE ────────────────────────────────────────────────

  it('P1 FAIL CLOSED: a one-shot is NOT dispatched when the attempt marker THROWS', async () => {
    // The promise this feature makes is exactly-once ACROSS RESTARTS, and it is
    // kept by a durable marker. If the marker cannot be written there is no
    // durable claim, so a restart re-reads an untouched definition and fires
    // again. Dispatching anyway trades a broken guarantee for one extra fire.
    const at = new Date(Date.now() - 60_000).toISOString();
    mockReadCrons.mockReturnValue([makeOneShot({ fire_at: at })]);
    mockUpdateCron.mockImplementation(() => { throw new Error('EACCES: read-only file system'); });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(60 * 60_000);

    expect(fired).toHaveLength(0);
    expect(logs.some((l) => l.includes('NOT dispatched') && l.includes('Fail-closed'))).toBe(true);
  });

  it('P1 FAIL CLOSED: a one-shot is NOT dispatched when the attempt marker returns FALSE', async () => {
    // The SECOND failure channel, and the one a try/catch cannot see. The real
    // updateCron returns false — it does not throw — when no cron of that name
    // is in crons.json (deleted or renamed between load and fire). Nothing is
    // written, and a scheduler that only catches exceptions reads that as a
    // successful claim.
    const at = new Date(Date.now() - 60_000).toISOString();
    mockReadCrons.mockReturnValue([makeOneShot({ fire_at: at })]);
    mockUpdateCron.mockReturnValue(false);

    scheduler.start();
    await vi.advanceTimersByTimeAsync(60 * 60_000);

    expect(fired).toHaveLength(0);
    expect(logs.some((l) => l.includes('NOT dispatched') && l.includes('deleted or renamed'))).toBe(true);
  });

  it('P1: once the marker write recovers the one-shot fires EXACTLY ONCE, and a restart does not repeat it', async () => {
    // ⛔ THIS IS THE REPRODUCTION OF THE REVIEWED DEFECT, END TO END. Before the
    // fix the failed-marker tick dispatched (1) and a fresh scheduler over the
    // unchanged crons.json dispatched again (2). Fail-closed makes the first
    // dispatch not happen at all, so the total across the whole episode is one.
    const at = new Date(Date.now() - 60_000).toISOString();
    const def = makeOneShot({ fire_at: at });
    mockReadCrons.mockReturnValue([def]);
    mockUpdateCron.mockImplementation(() => { throw new Error('EACCES: read-only file system'); });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(2 * TICK);
    expect(fired).toHaveLength(0);

    // Writes come back (the read-only mount is remounted, disk space freed…).
    mockUpdateCron.mockReset();
    mockUpdateCron.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(2 * TICK);
    expect(fired).toHaveLength(1);

    const persisted = mockUpdateCron.mock.calls
      .filter((c) => c[1] === 'one-shot')
      .map((c) => c[2] as Partial<CronDefinition>);
    const fireState = persisted.find((p) => p.fire_count !== undefined);
    expect(fireState).toBeDefined();

    scheduler.stop();

    // The restart half: a fresh scheduler over what a restarted daemon reads.
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

  it('SCOPE CONTROL: a RECURRING cron still dispatches when its marker write fails', async () => {
    // ⚠ NAMED AS A CONTROL, NOT A MUTANT: this passes against the unfixed code
    // too, and that is the point. Fail-closed is scoped to one-shots. For a
    // recurring cron a lost marker costs one duplicate slot, not a broken
    // guarantee, and the inherited warn-and-dispatch behaviour is deliberate.
    // Without this test, "fail closed on a failed marker" could be widened to
    // every cron and nothing would object.
    mockReadCrons.mockReturnValue([makeOneShot({ fire_at: undefined })]);
    mockUpdateCron.mockImplementation(() => { throw new Error('EACCES: read-only file system'); });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(5 * 60_000 + TICK);

    expect(fired.length).toBeGreaterThan(1);
    expect(logs.some((l) => l.includes('Continuing dispatch'))).toBe(true);
  });

  // ── P2: RELOAD IDENTITY INCLUDES fire_at ──────────────────────────────────

  it('P2 reload: moving fire_at LATER moves the due time', async () => {
    const t0 = Date.now();
    const early = new Date(t0 + 2 * 60_000).toISOString();
    const late = new Date(t0 + 20 * 60_000).toISOString();
    mockReadCrons.mockReturnValue([makeOneShot({ fire_at: early })]);
    scheduler.start();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fired).toHaveLength(0);

    // Edit fire_at on disk and let the mtime change drive the reload.
    mockReadCrons.mockReturnValue([makeOneShot({ fire_at: late })]);
    mockCronsFileMtimeMs.mockReturnValue(2000);
    await vi.advanceTimersByTimeAsync(TICK);

    // Assert the EPOCH, not only the absence of a fire: a scheduler that had
    // dropped the cron entirely would also fire zero times.
    expect(scheduler.getNextFireTimes()).toEqual([
      { name: 'one-shot', nextFireAt: Date.parse(late) },
    ]);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fired).toHaveLength(0);
  });

  it('P2 reload: moving fire_at EARLIER moves the due time', async () => {
    const t0 = Date.now();
    const late = new Date(t0 + 20 * 60_000).toISOString();
    const early = new Date(t0 + 2 * 60_000).toISOString();
    mockReadCrons.mockReturnValue([makeOneShot({ fire_at: late })]);
    scheduler.start();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fired).toHaveLength(0);

    mockReadCrons.mockReturnValue([makeOneShot({ fire_at: early })]);
    mockCronsFileMtimeMs.mockReturnValue(2000);
    await vi.advanceTimersByTimeAsync(TICK);

    expect(scheduler.getNextFireTimes()).toEqual([
      { name: 'one-shot', nextFireAt: Date.parse(early) },
    ]);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fired).toHaveLength(1);
  });

  it('P2 reload: turning a RECURRING cron into a one-shot stops the recurring fires', async () => {
    // The transition case. `schedule` is '1m' on both sides, so name|schedule is
    // identical and only fire_at distinguishes them.
    mockReadCrons.mockReturnValue([makeOneShot({ fire_at: undefined })]);
    scheduler.start();

    await vi.advanceTimersByTimeAsync(3 * 60_000);
    const beforeEdit = fired.length;
    expect(beforeEdit).toBeGreaterThan(1);

    const far = new Date(Date.now() + 60 * 60_000).toISOString();
    mockReadCrons.mockReturnValue([makeOneShot({ fire_at: far })]);
    mockCronsFileMtimeMs.mockReturnValue(2000);
    await vi.advanceTimersByTimeAsync(TICK);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fired.length - beforeEdit).toBe(0);
  });

  // ── P2: AN EXHAUSTED ONE-SHOT RENDERS AS WORDS, NOT AS A DATE ─────────────

  it('P2 terminal: an exhausted one-shot does not reject the tick with RangeError', async () => {
    // computeNextFireAt correctly returns POSITIVE_INFINITY once the attempt
    // marker exists. Formatting it with new Date(Infinity).toISOString() throws
    // RangeError, which rejected the whole tick and skipped the `firing = false`
    // cleanup below it — wedging the cron mid-fire forever.
    //
    // Driven through tick() directly rather than the interval so the rejection
    // is observable instead of becoming an unhandled rejection nobody asserts on.
    const at = new Date(Date.now() - 60_000).toISOString();
    mockReadCrons.mockReturnValue([makeOneShot({ fire_at: at })]);
    const failing = new CronScheduler({
      agentName: 'test-agent',
      onFire: () => { throw new Error('agent unreachable'); },
      logger: (msg) => { logs.push(msg); },
    });
    (failing as unknown as { loadCrons(isReload: boolean): void }).loadCrons(false);

    let outcome = 'pending';
    let rejectionMessage = '';
    const tickPromise = (failing as unknown as { tick(): Promise<void> }).tick().then(
      () => { outcome = 'resolved'; },
      (err: unknown) => {
        outcome = 'rejected';
        rejectionMessage = err instanceof Error ? err.message : String(err);
      },
    );
    // 4 attempts with 1s + 4s + 16s of backoff between them.
    await vi.advanceTimersByTimeAsync(60_000);
    await tickPromise;

    expect(outcome).toBe('resolved');
    expect(rejectionMessage).toBe('');
    expect(logs.some((l) => l.includes('terminal, it will not fire again'))).toBe(true);
    expect(failing.getNextFireTimes()).toEqual([
      { name: 'one-shot', nextFireAt: Number.POSITIVE_INFINITY },
    ]);
  });
});
