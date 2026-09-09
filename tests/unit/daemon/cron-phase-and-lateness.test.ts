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

// ---------------------------------------------------------------------------
// GUARD'S PR41 SEAMS (2026-09-09). Three findings, each a claim in this change's
// own title failing — not a test failing. Covered here so they are guarded by
// THIS suite and not only by guard's proof directory.
// ---------------------------------------------------------------------------

describe('guard PR41 seams', () => {
  let scheduler: CronScheduler;
  let fired: { name: string; at: number }[];
  const makeCron = (over: Record<string, unknown> = {}) => ({
    name: 'lane-watch', schedule: '1h', prompt: 'p', enabled: true, ...over,
  });

  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(T0);
    fired = []; logEntries.length = 0;
    mockReadCrons.mockReset();
    mockUpdateCron.mockReset().mockReturnValue(true);
    mockReadCronsWithStatus.mockReset().mockImplementation((a: string) => ({ crons: mockReadCrons(a) ?? [], corrupt: false }));
    mockCronsFileMtimeMs.mockReset().mockReturnValue(1000);
    scheduler = new CronScheduler({
      agentName: 'test-agent',
      onFire: (c) => { fired.push({ name: c.name, at: Date.now() }); },
      logger: () => {},
    });
  });
  afterEach(() => { scheduler.stop(); vi.useRealTimers(); });

  // F3 — the catch-up branch used to overwrite the only copy of the overdue slot
  // with `now`, so a fire an hour late logged 30s of lateness.
  it('F3: startup catch-up logs the ORIGINAL slot, not the start time', async () => {
    mockReadCrons.mockReturnValue([makeCron({ last_fired_at: new Date(T0 - 2 * HOUR).toISOString(), fire_count: 1 })]);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(TICK);

    const entry = logEntries.find((e) => e.status === 'fired');
    expect(entry?.due_at).toBe(new Date(T0 - HOUR).toISOString());
    // The number the field exists to make derivable, and the one that read 30s.
    expect(Date.parse(entry!.ts) - Date.parse(entry!.due_at!)).toBe(HOUR + TICK);
  });

  // F2 — the phase lived only in memory, so it died at the next stop/start.
  it('F2: the restored phase SURVIVES a restart', async () => {
    const persisted: Record<string, unknown> = {};
    mockUpdateCron.mockImplementation((_a: string, _n: string, patch: Record<string, unknown>) => {
      Object.assign(persisted, patch); return true;
    });
    mockReadCrons.mockImplementation(() => [makeCron(persisted)]);

    scheduler.start();
    vi.setSystemTime(T0 + HOUR + 15 * 60_000);   // 15m30s-late fire
    await vi.advanceTimersByTimeAsync(TICK);
    expect(fired).toHaveLength(1);

    // ⭐ THE ASSERTION IS ON THE PERSISTED ANCHOR, because that is what a restart
    // reads. Checking only in-memory state is what let this ship.
    expect(persisted.last_slot_at).toBe(new Date(T0 + HOUR).toISOString());
    expect(persisted.last_fired_at).not.toBe(persisted.last_slot_at); // they are genuinely different

    scheduler.stop();
    scheduler = new CronScheduler({
      agentName: 'test-agent',
      onFire: (c) => { fired.push({ name: c.name, at: Date.now() }); },
      logger: () => {},
    });
    scheduler.start();

    // Behavioural: after the restart the next fire is still on the ORIGINAL phase.
    vi.setSystemTime(T0 + 2 * HOUR - 2 * TICK);
    await vi.advanceTimersByTimeAsync(TICK);
    expect(fired).toHaveLength(1);
    vi.setSystemTime(T0 + 2 * HOUR + TICK);
    await vi.advanceTimersByTimeAsync(TICK);
    expect(fired).toHaveLength(2);
  });

  it('F2 control: a legacy cron with no last_slot_at still schedules', async () => {
    // Negative control for the fallback. Without it, making the anchor mandatory
    // would silently stop every cron whose file predates the field.
    mockReadCrons.mockReturnValue([makeCron({ last_fired_at: new Date(T0 - 30 * 60_000).toISOString(), fire_count: 1 })]);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(30 * 60_000 + TICK);
    expect(fired.length).toBeGreaterThanOrEqual(1);
  });

  // M4 — guard's independent control, adopted BY NAME. The rewritten (f) test
  // passed a mutant that made an unchanged-definition reload set nextFireAt=now;
  // this one fails it, which is the coverage gap guard measured.
  it('reload before due cannot create an early fire', async () => {
    mockReadCrons.mockReturnValue([makeCron()]);
    scheduler.start();
    mockCronsFileMtimeMs.mockReturnValue(2000); // force a reload
    scheduler.reload();
    await vi.advanceTimersByTimeAsync(TICK);
    expect(fired).toHaveLength(0);
  });

  // R1 — guard's round-2 P1, and it was a REGRESSION my own previous head introduced.
  // The attempt marker was written pre-dispatch while last_slot_at was written only on
  // success, so a fire interrupted between them left an OLDER slot that won the next
  // load over the NEWER attempt marker, and the slot was dispatched twice.
  it('R1: an in-flight attempted slot is never dispatched twice', async () => {
    const persisted: Record<string, unknown> = {};
    mockUpdateCron.mockImplementation((_a: string, _n: string, patch: Record<string, unknown>) => {
      Object.assign(persisted, patch); return true;
    });
    mockReadCrons.mockImplementation(() => [makeCron(persisted)]);

    // A dispatch that never completes: the marker lands, the success write never does.
    scheduler.stop();
    scheduler = new CronScheduler({
      agentName: 'test-agent',
      onFire: () => { throw new Error('interrupted mid-fire'); },
      logger: () => {},
    });
    scheduler.start();
    vi.setSystemTime(T0 + HOUR);
    await vi.advanceTimersByTimeAsync(TICK);

    // ⭐ THE ASSERTION IS ON DISK, because disk is all a restart can see.
    expect(persisted.last_fire_attempted_at).toBeDefined();
    expect(persisted.last_slot_at).toBe(new Date(T0 + HOUR).toISOString());
    expect(persisted.last_fired_at).toBeUndefined(); // the fire genuinely did not succeed

    // Restart against exactly that file: the attempted slot must not come round again.
    scheduler.stop();
    const after: number[] = [];
    scheduler = new CronScheduler({
      agentName: 'test-agent', onFire: () => { after.push(Date.now()); }, logger: () => {},
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(2 * TICK);
    expect(after).toHaveLength(0);
  });

  // R2 — the persisted slot must be the one the LIVE scheduler is anchored on after
  // skipping missed slots, not the oldest slot the catch-up fire served. Otherwise a
  // restart and both displays advance one interval from a slot already skipped past.
  it('R2: after a multi-slot sleep, disk and memory describe the SAME next fire', async () => {
    const persisted: Record<string, unknown> = {};
    mockUpdateCron.mockImplementation((_a: string, _n: string, patch: Record<string, unknown>) => {
      Object.assign(persisted, patch); return true;
    });
    mockReadCrons.mockImplementation(() => [makeCron(persisted)]);

    scheduler.start();
    vi.setSystemTime(T0 + 6 * HOUR + 30 * 60_000); // asleep across six slots
    await vi.advanceTimersByTimeAsync(TICK);
    expect(fired).toHaveLength(1); // one catch-up, not six

    // In memory the next fire is T0+7h. On disk the anchor must be T0+6h, so that
    // anchor + interval reproduces it exactly — for a restart AND for both displays.
    expect(persisted.last_slot_at).toBe(new Date(T0 + 6 * HOUR).toISOString());

    // Behavioural confirmation through a real restart.
    scheduler.stop();
    scheduler = new CronScheduler({
      agentName: 'test-agent',
      onFire: (c) => { fired.push({ name: c.name, at: Date.now() }); },
      logger: () => {},
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(TICK);
    expect(fired).toHaveLength(1); // ⛔ no re-dispatch of a skipped slot
    vi.setSystemTime(T0 + 7 * HOUR + TICK);
    await vi.advanceTimersByTimeAsync(TICK);
    expect(fired).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // ROUND 4 — guard's P1 and P2.
  //
  // ⭐ WHAT MAKES THESE DIFFERENT FROM R1/R2 ABOVE, and it is the whole point of
  // the round: R1 and R2 are the SINGLE-SLOT and the SUCCESS cases of one rule.
  // Every round of this fix closed an instance and left the next one open, because
  // `crons.json` and the in-memory schedule are two descriptions of one thing and
  // nothing forced them to agree. The rule is now stated once —
  //
  //     PERSIST THE ACCOUNTED SLOT, ON EVERY EXIT FROM A FIRE, FOR BOTH SCHEDULE
  //     FORMS. Accounted = the slot the skip policy actually landed on.
  //
  // — and these four tests are its remaining corners: interrupted, exhausted, and
  // the cron-expression form of each question. A fifth special case here would mean
  // the rule is still wrong.
  // -------------------------------------------------------------------------

  // P1a — the INTERRUPTED multi-slot dispatch. R1 proved the single-slot case: the
  // marker and the slot go down together, so there is no window where disk is older
  // than memory. That closed the WINDOW and left the VALUE stale — the slot written
  // was the one this fire SERVED, and after a six-slot sleep the live scheduler has
  // already advanced past it. A restart then read an anchor the scheduler had
  // abandoned and dispatched again.
  it('P1a: an interrupted multi-slot dispatch leaves the ACCOUNTED slot on disk', async () => {
    const persisted: Record<string, unknown> = {};
    mockUpdateCron.mockImplementation((_a: string, _n: string, patch: Record<string, unknown>) => {
      Object.assign(persisted, patch); return true;
    });
    mockReadCrons.mockImplementation(() => [makeCron(persisted)]);

    scheduler.stop();
    const first: number[] = [];
    scheduler = new CronScheduler({
      agentName: 'test-agent',
      // Never resolves: the dispatch is in flight when the process dies.
      onFire: () => { first.push(Date.now()); return new Promise<void>(() => {}); },
      logger: () => {},
    });
    scheduler.start();
    vi.setSystemTime(T0 + 6 * HOUR + 30 * 60_000);
    await vi.advanceTimersByTimeAsync(TICK);
    expect(first).toHaveLength(1);

    // The claim is about DISK, because disk is all a restart can see. T0+6h — the
    // slot the live scheduler landed on — not T0+1h, the slot this fire served.
    expect(persisted.last_slot_at).toBe(new Date(T0 + 6 * HOUR).toISOString());
    expect(persisted.last_fire_attempted_at).toBe(new Date(T0 + 6 * HOUR + 30 * 60_000 + TICK).toISOString());
    expect(persisted.last_fired_at).toBeUndefined();

    scheduler.stop();
    const after: number[] = [];
    scheduler = new CronScheduler({
      agentName: 'test-agent', onFire: () => { after.push(Date.now()); }, logger: () => {},
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(TICK);
    expect(after).toHaveLength(0); // ⛔ no second dispatch of an accounted window
  });

  // P1b — the EXHAUSTED multi-slot dispatch, and it is the path that persisted
  // NOTHING. The failed branch advanced memory to the accounted slot and wrote no
  // file at all, which reads as harmless (there is no successful fire to record)
  // and is not: disk kept a slot six hours stale, so a restart re-opened a window
  // whose four attempts were already spent — a FIFTH callback.
  it('P1b: an exhausted multi-slot failure persists the accounted slot and stays closed', async () => {
    const persisted: Record<string, unknown> = {};
    mockUpdateCron.mockImplementation((_a: string, _n: string, patch: Record<string, unknown>) => {
      Object.assign(persisted, patch); return true;
    });
    mockReadCrons.mockImplementation(() => [makeCron(persisted)]);

    scheduler.stop();
    const attempts: number[] = [];
    scheduler = new CronScheduler({
      agentName: 'test-agent',
      onFire: () => { attempts.push(Date.now()); throw new Error('dispatch failure'); },
      logger: () => {},
    });
    scheduler.start();
    vi.setSystemTime(T0 + 6 * HOUR + 30 * 60_000);
    await vi.advanceTimersByTimeAsync(TICK + 21_000); // tick + the 1s/4s/16s retries
    expect(attempts).toHaveLength(4);                 // the 4-attempt boundary is intact
    expect(persisted.last_fired_at).toBeUndefined();  // nothing succeeded

    expect(persisted.last_slot_at).toBe(new Date(T0 + 6 * HOUR).toISOString());

    scheduler.stop();
    scheduler = new CronScheduler({
      agentName: 'test-agent', onFire: () => { attempts.push(Date.now()); }, logger: () => {},
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(TICK);
    expect(attempts).toHaveLength(4); // ⛔ no fifth callback
  });

  // P2 — the CRON-EXPRESSION form. An interval names its own previous slot by
  // subtracting its duration; an expression cannot, and the old code fell back to
  // the served occurrence with a comment asserting that was exact. True for one
  // slot, false after a skip: `0 * * * *` slept 12:00 -> 18:30 persisted 13:00 while
  // the scheduler held 19:00.
  // ⚠ TZ is stubbed because the expression parser resolves fields in LOCAL time;
  // without it this test asserts UTC instants against a runner-dependent calendar.
  it('P2: a cron expression persists the accounted OCCURRENCE, not the served one', async () => {
    vi.stubEnv('TZ', 'UTC');
    const persisted: Record<string, unknown> = {};
    mockUpdateCron.mockImplementation((_a: string, _n: string, patch: Record<string, unknown>) => {
      Object.assign(persisted, patch); return true;
    });
    mockReadCrons.mockImplementation(() => [makeCron({ schedule: '0 * * * *', ...persisted })]);

    scheduler.start();
    vi.setSystemTime(T0 + 6 * HOUR + 30 * 60_000);
    await vi.advanceTimersByTimeAsync(TICK);
    expect(fired).toHaveLength(1);

    // 18:00Z — the occurrence immediately before the live next fire of 19:00Z — so
    // that anchor walked forward one occurrence reproduces the live value exactly.
    expect(persisted.last_slot_at).toBe(new Date(T0 + 6 * HOUR).toISOString());

    scheduler.stop();
    scheduler = new CronScheduler({
      agentName: 'test-agent',
      onFire: (c) => { fired.push({ name: c.name, at: Date.now() }); },
      logger: () => {},
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(TICK);
    expect(fired).toHaveLength(1);      // ⛔ 19:00 has not arrived; nothing re-fires
    vi.setSystemTime(T0 + 7 * HOUR + TICK);
    await vi.advanceTimersByTimeAsync(TICK);
    expect(fired).toHaveLength(2);      // and the real occurrence still fires
    vi.unstubAllEnvs();
  });

  // P1c — THE FAILURE-PATH WRITE, ISOLATED. Found by an UNKILLED MUTANT, and the
  // finding is worth more than the test: removing the failed-dispatch persistence
  // entirely broke NOTHING in P1a/P1b, because the pre-dispatch marker had already
  // written the same value. Two writes independently defended one property, so no
  // single mutation could reach it — a defence with two providers is invisible to a
  // one-at-a-time grid exactly the way a symmetric loss is invisible to a diff.
  //
  // ⭐ The one case where the marker is NOT there to help is the case the code comment
  // already claimed: the marker write FAILED (updateCron returns false — the cron was
  // renamed or deleted between load and fire) and a RECURRING cron dispatches anyway.
  // Then disk still holds the stale anchor, all four attempts are spent, and only the
  // failure branch can close the window. The comment asserted it; nothing tested it.
  it('P1c: a failed dispatch persists the accounted slot even when the attempt marker did not land', async () => {
    // Disk starts on a real, OLD anchor — without one the fallback would be "now" and
    // a restart would not re-dispatch for unrelated reasons, hiding the defect.
    const persisted: Record<string, unknown> = {
      last_slot_at: new Date(T0).toISOString(),
      last_fired_at: new Date(T0).toISOString(),
    };
    let call = 0;
    mockUpdateCron.mockImplementation((_a: string, _n: string, patch: Record<string, unknown>) => {
      call += 1;
      if (call === 1) return false;          // the pre-dispatch marker fails to land
      Object.assign(persisted, patch); return true;
    });
    mockReadCrons.mockImplementation(() => [makeCron(persisted)]);

    scheduler.stop();
    const attempts: number[] = [];
    scheduler = new CronScheduler({
      agentName: 'test-agent',
      onFire: () => { attempts.push(Date.now()); throw new Error('dispatch failure'); },
      logger: () => {},
    });
    scheduler.start();
    vi.setSystemTime(T0 + 6 * HOUR + 30 * 60_000);
    await vi.advanceTimersByTimeAsync(TICK + 21_000);
    expect(attempts).toHaveLength(4);
    expect(persisted.last_fire_attempted_at).toBeUndefined(); // the marker genuinely did not land
    expect(persisted.last_slot_at).toBe(new Date(T0 + 6 * HOUR).toISOString());

    scheduler.stop();
    scheduler = new CronScheduler({
      agentName: 'test-agent', onFire: () => { attempts.push(Date.now()); }, logger: () => {},
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(TICK);
    expect(attempts).toHaveLength(4); // ⛔ the spent window stays closed
  });

  // P2 control — the SINGLE-slot expression case, which the old code got right.
  // Without this, P2 above could be satisfied by any change that moves the anchor
  // forward, including one that skips an occurrence that was never accounted for.
  it('P2 control: a single-slot cron expression still persists the slot it served', async () => {
    vi.stubEnv('TZ', 'UTC');
    const persisted: Record<string, unknown> = {};
    mockUpdateCron.mockImplementation((_a: string, _n: string, patch: Record<string, unknown>) => {
      Object.assign(persisted, patch); return true;
    });
    mockReadCrons.mockImplementation(() => [makeCron({ schedule: '0 * * * *', ...persisted })]);

    scheduler.start();
    vi.setSystemTime(T0 + HOUR);       // 13:00Z exactly — one slot, no skipping
    await vi.advanceTimersByTimeAsync(TICK);
    expect(fired).toHaveLength(1);
    expect(persisted.last_slot_at).toBe(new Date(T0 + HOUR).toISOString());
    vi.unstubAllEnvs();
  });
});
