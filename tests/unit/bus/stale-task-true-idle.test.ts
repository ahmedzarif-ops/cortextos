import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, appendFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { checkStaleTasks, lastTransitionEpoch, lastTransition, readTaskAudit, updateTask, annotateTask } from '../../../src/bus/task';
import { CLOCK_SKEW_TOLERANCE_SECONDS } from '../../../src/types';
import { atomicWriteSync } from '../../../src/utils/atomic';
import type { BusPaths, Task, TaskStatus } from '../../../src/types';

/**
 * TRUE IDLE — the clock a no-op write cannot reset.
 *
 * THE DEFECT THESE TESTS PIN. `checkStaleTasks` flagged `in_progress` on
 * `now - updated_at`, and `updated_at` moves on ANY write. `annotateTask` is a
 * write that does no work, so a scheduled sweep annotating every open task
 * RESET THE CLOCK THE ALARM READS — including when the note's own text said
 * nothing had happened. Measured 2026-09-08 over 727 task files: of 10
 * `in_progress` tasks the check CLEARED 5, and all five were idle 4.2h-20.9h.
 * False-clear rate 5 of 5 on what it passed.
 *
 * Not degradation — INVERSION: the seats that annotated most looked healthiest.
 *
 * WHY THE DISCRIMINATOR IS STRUCTURAL AND NOT TEXTUAL. A text-classifying
 * predicate ("byte-identical note AND no resume condition") was specified first
 * and measured DEAD: it flagged 0 of the 9 byte-identical annotation groups on
 * the live corpus, because all nine DO state a resume condition. Negative
 * control on that measurement: the same regex fired on 150 of 249 annotations
 * and not on 99, so it detected conditions rather than English and the zero was
 * real. An annotation is `{event:'update'}` with NO from/to; every genuine
 * lifecycle event carries both. No judgement about wording is required.
 */

function iso(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
function hoursAgo(h: number): string {
  return iso(new Date(Date.now() - h * 3600 * 1000));
}

function writeTask(paths: BusPaths, o: Partial<Task> & { id: string }): Task {
  const now = iso(new Date());
  const task: Task = {
    id: o.id,
    title: o.title ?? 'T',
    description: '',
    type: 'agent',
    needs_approval: false,
    status: o.status ?? 'in_progress',
    assigned_to: 'agent1',
    created_by: 'agent1',
    org: 'testorg',
    priority: 'normal',
    project: '',
    kpi_key: null,
    created_at: o.created_at ?? now,
    updated_at: o.updated_at ?? now,
    completed_at: null,
    due_date: null,
    archived: false,
  };
  atomicWriteSync(join(paths.taskDir, `${task.id}.json`), JSON.stringify(task));
  return task;
}

/** Write a raw audit line. Deliberately NOT via appendTaskAudit: these tests
 *  need backdated `ts` values, and appendTaskAudit stamps `now`. */
function audit(
  paths: BusPaths,
  taskId: string,
  entry: { ts: string; event: string; agent: string; from?: TaskStatus; to?: TaskStatus; note?: string },
): void {
  const dir = join(paths.taskDir, 'audit');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `${taskId}.jsonl`), JSON.stringify(entry) + '\n');
}

describe('stale in_progress: TRUE IDLE beside the clock', () => {
  let tmp: string;
  let paths: BusPaths;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'trueidle-'));
    const taskDir = join(tmp, 'tasks');
    mkdirSync(taskDir, { recursive: true });
    paths = {
      ctxRoot: tmp, inbox: tmp, inflight: tmp, processed: tmp, logDir: tmp,
      stateDir: tmp, taskDir, approvalDir: tmp, analyticsDir: tmp, deliverablesDir: tmp,
    } as BusPaths;
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  /**
   * THE REGRESSION. Fresh clock, ancient last transition — the exact shape a
   * keepalive annotation produces. Before this change the row was CLEARED.
   */
  it('flags a task whose clock is fresh but has not transitioned in 9h', () => {
    writeTask(paths, { id: 'task_ti_001', status: 'in_progress', updated_at: hoursAgo(0.1), created_at: hoursAgo(20) });
    audit(paths, 'task_ti_001', { ts: hoursAgo(9), event: 'claim', agent: 'a', from: 'pending', to: 'in_progress' });
    // the no-op write that refreshed updated_at: an annotation, no from/to
    audit(paths, 'task_ti_001', { ts: hoursAgo(0.1), event: 'update', agent: 'a', note: 'annotated: still waiting, no work executed' });

    const report = checkStaleTasks(paths);
    expect(report.stale_in_progress.map((t) => t.id)).toContain('task_ti_001');
  });

  /**
   * MUST-STAY-GREEN ARM. Without this, a fix that flagged EVERYTHING would pass
   * the arm above perfectly — "the false clear stopped happening" and "the check
   * stopped discriminating" are the same observation on the regression alone.
   */
  it('does NOT flag a genuinely active task that transitioned 10 minutes ago', () => {
    writeTask(paths, { id: 'task_ti_002', status: 'in_progress', updated_at: hoursAgo(0.16), created_at: hoursAgo(20) });
    audit(paths, 'task_ti_002', { ts: hoursAgo(0.16), event: 'update', agent: 'a', from: 'pending', to: 'in_progress' });

    const report = checkStaleTasks(paths);
    expect(report.stale_in_progress.map((t) => t.id)).not.toContain('task_ti_002');
  });

  /**
   * MAX, not replace. A stale clock must still alarm even when the audit log
   * says the task transitioned recently — this change may only ever ADD rows,
   * never remove one the shipped check already caught.
   */
  it('still flags on a stale CLOCK even when the last transition is recent', () => {
    writeTask(paths, { id: 'task_ti_003', status: 'in_progress', updated_at: hoursAgo(5), created_at: hoursAgo(6) });
    audit(paths, 'task_ti_003', { ts: hoursAgo(0.1), event: 'update', agent: 'a', from: 'pending', to: 'in_progress' });

    const report = checkStaleTasks(paths);
    expect(report.stale_in_progress.map((t) => t.id)).toContain('task_ti_003');
  });

  /** No audit log at all -> fall back to created_at, and it must fail LOUD. */
  it('falls back to created_at when no audit log exists', () => {
    writeTask(paths, { id: 'task_ti_004', status: 'in_progress', updated_at: hoursAgo(0.1), created_at: hoursAgo(8) });
    const report = checkStaleTasks(paths);
    expect(report.stale_in_progress.map((t) => t.id)).toContain('task_ti_004');
  });

  /**
   * BOTH clocks are reported for EVERY in_progress row, including cleared ones.
   * A cleared row is the case that previously produced no output at all, so a
   * reader could not see the two clocks disagree precisely when it mattered.
   */
  it('reports both ages for a CLEARED row, not only for stale ones', () => {
    writeTask(paths, { id: 'task_ti_005', status: 'in_progress', updated_at: hoursAgo(0.1), created_at: hoursAgo(0.2) });
    audit(paths, 'task_ti_005', { ts: hoursAgo(0.1), event: 'update', agent: 'a', from: 'pending', to: 'in_progress' });

    const report = checkStaleTasks(paths);
    expect(report.stale_in_progress.map((t) => t.id)).not.toContain('task_ti_005');
    const row = report.idle_ages.find((r) => r.task_id === 'task_ti_005');
    expect(row).toBeDefined();
    expect(row!.true_idle_seconds).toBeLessThan(7200);
    expect(row!.clock_age_seconds).toBeLessThan(7200);
  });

  /** The seam itself: an annotation must not count as a transition. */
  it('lastTransitionEpoch ignores annotations and takes the newest transition', () => {
    const t = writeTask(paths, { id: 'task_ti_006', status: 'in_progress', created_at: hoursAgo(30) });
    audit(paths, 'task_ti_006', { ts: hoursAgo(20), event: 'create', agent: 'a', to: 'pending' });
    audit(paths, 'task_ti_006', { ts: hoursAgo(12), event: 'claim', agent: 'a', from: 'pending', to: 'in_progress' });
    audit(paths, 'task_ti_006', { ts: hoursAgo(1), event: 'update', agent: 'a', note: 'annotated: keepalive' });

    const epoch = lastTransitionEpoch(paths, t);
    const twelveHoursAgo = Math.floor((Date.now() - 12 * 3600 * 1000) / 1000);
    // the 12h claim, not the 1h annotation, and not the 20h create
    expect(Math.abs(epoch - twelveHoursAgo)).toBeLessThan(60);
  });

  /**
   * A `create` entry carries only `to` and no `from`. It is NOT a transition of
   * a live task and must not anchor the idle clock; created_at covers it.
   */
  it('treats a create entry (to only, no from) as not a transition', () => {
    const t = writeTask(paths, { id: 'task_ti_007', status: 'in_progress', created_at: hoursAgo(9) });
    audit(paths, 'task_ti_007', { ts: hoursAgo(1), event: 'create', agent: 'a', to: 'pending' });

    const epoch = lastTransitionEpoch(paths, t);
    const nineHoursAgo = Math.floor((Date.now() - 9 * 3600 * 1000) / 1000);
    expect(Math.abs(epoch - nineHoursAgo)).toBeLessThan(60);
  });

  // ==========================================================================
  // THE FOUR CONTROLS. Each pins one blocking defect found by guard's review of
  // head 9873a860 (REVIEW.md sha256 f5b86cbd…), and each is stated as
  // INPUT -> OBSERVED (before the fix) -> EXPECTED. Each has a must-stay-green
  // companion: without one, a "fix" that flags EVERYTHING passes all four,
  // because "the false clear stopped" and "the check stopped discriminating"
  // are the same observation on the failing arms alone.
  // ==========================================================================

  /**
   * C1 — A NO-OP STATUS WRITE MUST NOT RESET THE IDLE CLOCK.
   *
   * INPUT:    in_progress, idle 9h, then the REAL `updateTask(id, 'in_progress')`
   *           — the status it already has.
   * OBSERVED: TRUE_IDLE 32400 / CLOCK 360 before; BOTH 0 after. Cleared.
   * EXPECTED: TRUE_IDLE stays ~32400 and the row STILL alarms.
   *
   * WHY IT IS THE WORST OF THE FOUR: `updateTask` (src/bus/task.ts) writes
   * `{ from, to }` UNCONDITIONALLY without checking the status changed, and the
   * first predicate here accepted "both ends present" as proof of a transition.
   * That replaced "any write moves the clock" with "any STATUS write moves the
   * clock" — the exact class this check exists to catch, reproduced inside the
   * fix for it. A transition is `from !== to`.
   *
   * Driven through the REAL WRITER, not a handcrafted audit line, precisely
   * because the handcrafted logs are what let the defect through review.
   */
  it('C1: a real same-status updateTask does NOT reset TRUE IDLE', () => {
    writeTask(paths, { id: 'task_ti_c1', status: 'in_progress', updated_at: hoursAgo(0.1), created_at: hoursAgo(20) });
    audit(paths, 'task_ti_c1', { ts: hoursAgo(9), event: 'claim', agent: 'a', from: 'pending', to: 'in_progress' });

    const before = checkStaleTasks(paths);
    expect(before.stale_in_progress.map((t) => t.id)).toContain('task_ti_c1');
    const rowBefore = before.idle_ages.find((r) => r.task_id === 'task_ti_c1')!;
    expect(rowBefore.true_idle_seconds).toBeGreaterThan(8 * 3600);

    // THE REAL WRITER, on the status the task already holds.
    updateTask(paths, 'task_ti_c1', 'in_progress');

    const after = checkStaleTasks(paths);
    const rowAfter = after.idle_ages.find((r) => r.task_id === 'task_ti_c1')!;
    // the write refreshed the clock, as it is entitled to do…
    expect(rowAfter.clock_age_seconds).toBeLessThan(60);
    // …and moved TRUE IDLE not at all, because nothing changed.
    expect(rowAfter.true_idle_seconds).toBeGreaterThan(8 * 3600);
    expect(rowAfter.audit_transitions_no_op).toBe(1);
    expect(after.stale_in_progress.map((t) => t.id)).toContain('task_ti_c1');
  });

  /**
   * C1 MUST-STAY-GREEN. A REAL status change through the same writer MUST reset
   * the idle clock and clear the row. Without this arm, "reject every `update`
   * line" passes C1 while destroying the feature.
   */
  it('C1-green: a real STATUS-CHANGING updateTask does reset TRUE IDLE', () => {
    writeTask(paths, { id: 'task_ti_c1g', status: 'blocked', updated_at: hoursAgo(9), created_at: hoursAgo(20) });
    audit(paths, 'task_ti_c1g', { ts: hoursAgo(9), event: 'update', agent: 'a', from: 'in_progress', to: 'blocked' });

    updateTask(paths, 'task_ti_c1g', 'in_progress'); // blocked -> in_progress: a real move

    const report = checkStaleTasks(paths);
    const row = report.idle_ages.find((r) => r.task_id === 'task_ti_c1g')!;
    expect(row.true_idle_seconds).toBeLessThan(60);
    expect(row.audit_transitions_no_op).toBe(0);
    expect(report.stale_in_progress.map((t) => t.id)).not.toContain('task_ti_c1g');
  });

  /**
   * C2 — AN UNPARSEABLE `updated_at` MUST NOT SUPPRESS A KNOWN-STALE ROW.
   *
   * INPUT:    updated_at = 'invalid-date', valid transition 9h ago.
   * OBSERVED: `Math.max(NaN, 32400)` is NaN, `NaN > 7200` is FALSE -> CLEARED,
   *           and `clock_age_seconds` serialised as JSON `null`.
   * EXPECTED: reads as MAXIMALLY STALE and alarms; the age is a real number.
   *
   * NaN IS NOT A TIME. This input cleared on the base check too — the claimed
   * fail-loud idle arm did not rescue it, because NaN poisons the `max` it
   * enters.
   */
  it('C2: a malformed updated_at reads as maximally stale, never as fresh', () => {
    writeTask(paths, { id: 'task_ti_c2', status: 'in_progress', updated_at: 'invalid-date', created_at: hoursAgo(20) });
    audit(paths, 'task_ti_c2', { ts: hoursAgo(9), event: 'claim', agent: 'a', from: 'pending', to: 'in_progress' });

    const report = checkStaleTasks(paths);
    expect(report.stale_in_progress.map((t) => t.id)).toContain('task_ti_c2');

    const row = report.idle_ages.find((r) => r.task_id === 'task_ti_c2')!;
    expect(row.clock_malformed).toBe(true);
    // never null, never NaN — the three values a reader mistakes for "fine".
    expect(row.clock_age_seconds).not.toBeNull();
    expect(Number.isFinite(row.clock_age_seconds)).toBe(true);
    expect(row.clock_age_seconds).toBeGreaterThan(7200);
    // and it survives the JSON round-trip the CLI performs, still not null
    expect(JSON.parse(JSON.stringify(row)).clock_age_seconds).toBeGreaterThan(7200);
  });

  /**
   * C2 MUST-STAY-GREEN. A WELL-FORMED fresh clock on a genuinely active task is
   * still cleared, and is not mislabelled malformed. Without this, "always
   * report the sentinel" passes C2.
   */
  it('C2-green: a well-formed fresh clock is not flagged and not called malformed', () => {
    writeTask(paths, { id: 'task_ti_c2g', status: 'in_progress', updated_at: hoursAgo(0.1), created_at: hoursAgo(0.2) });
    audit(paths, 'task_ti_c2g', { ts: hoursAgo(0.1), event: 'update', agent: 'a', from: 'pending', to: 'in_progress' });

    const report = checkStaleTasks(paths);
    const row = report.idle_ages.find((r) => r.task_id === 'task_ti_c2g')!;
    expect(row.clock_malformed).toBe(false);
    expect(row.clock_age_seconds).toBeLessThan(7200);
    expect(report.stale_in_progress.map((t) => t.id)).not.toContain('task_ti_c2g');
  });

  /**
   * C3 — ONE VALID-JSON `null` AUDIT LINE MUST NOT SILENCE THE WHOLE REPORT.
   *
   * INPUT:    a line reading exactly `null` in ONE task's audit log.
   * OBSERVED: `JSON.parse('null')` SUCCEEDS, the null entered the entry array,
   *           `entry.from` threw TypeError, and the ENTIRE checkStaleTasks
   *           crashed — all five buckets, including rows with nothing wrong.
   * EXPECTED: that line SKIPPED AND COUNTED, the count surfaced, every other
   *           bucket still reported.
   *
   * WHY IT RANKS AS THE P1: the base check never read the audit log, so this is
   * a fail-OPEN introduced by this feature. Handling syntactically corrupt JSON
   * does not cover valid JSON of the wrong shape.
   */
  it('C3: a valid-JSON null audit line is skipped and counted, not fatal', () => {
    writeTask(paths, { id: 'task_ti_c3', status: 'in_progress', updated_at: hoursAgo(0.1), created_at: hoursAgo(20) });
    audit(paths, 'task_ti_c3', { ts: hoursAgo(9), event: 'claim', agent: 'a', from: 'pending', to: 'in_progress' });
    appendFileSync(join(paths.taskDir, 'audit', 'task_ti_c3.jsonl'), 'null\n');
    // an UNRELATED task that must still be reported: the crash took every bucket
    writeTask(paths, { id: 'task_ti_c3b', status: 'pending', updated_at: hoursAgo(30), created_at: hoursAgo(30) });

    const report = checkStaleTasks(paths);

    expect(report.stale_in_progress.map((t) => t.id)).toContain('task_ti_c3');
    expect(report.stale_pending.map((t) => t.id)).toContain('task_ti_c3b');

    const row = report.idle_ages.find((r) => r.task_id === 'task_ti_c3')!;
    expect(row.audit_lines_malformed).toBe(1);
    // the surrounding VALID line was still read: the skip is surgical, not a bail-out
    expect(row.true_idle_seconds).toBeGreaterThan(8 * 3600);
    // and readTaskAudit's return type is no longer a lie
    expect(readTaskAudit(paths, 'task_ti_c3').every((e) => e !== null)).toBe(true);
    expect(readTaskAudit(paths, 'task_ti_c3')).toHaveLength(1);
  });

  /**
   * C3 MUST-STAY-GREEN. A log with NO bad lines reports zero skips. A counter
   * that is always non-zero says nothing; this is its negative control.
   */
  it('C3-green: a clean audit log reports zero skipped lines', () => {
    writeTask(paths, { id: 'task_ti_c3g', status: 'in_progress', updated_at: hoursAgo(0.1), created_at: hoursAgo(20) });
    audit(paths, 'task_ti_c3g', { ts: hoursAgo(9), event: 'claim', agent: 'a', from: 'pending', to: 'in_progress' });

    const row = checkStaleTasks(paths).idle_ages.find((r) => r.task_id === 'task_ti_c3g')!;
    expect(row.audit_lines_malformed).toBe(0);
    expect(row.audit_lines_unparseable).toBe(0);
  });

  /**
   * C4 — A FUTURE-DATED TRANSITION MUST NOT ESTABLISH PRESENT ACTIVITY.
   *
   * INPUT:    a valid transition 9h ago PLUS a transition timestamped 3h ahead.
   * OBSERVED: TRUE_IDLE -10800, and the row cleared. Nothing rejected a future ts.
   * EXPECTED: the future entry is ignored AND counted, the last valid PAST
   *           transition is retained, the row still alarms, and no age is
   *           negative.
   */
  it('C4: a future-dated transition is ignored and counted, past transition retained', () => {
    writeTask(paths, { id: 'task_ti_c4', status: 'in_progress', updated_at: hoursAgo(0.1), created_at: hoursAgo(20) });
    audit(paths, 'task_ti_c4', { ts: hoursAgo(9), event: 'claim', agent: 'a', from: 'pending', to: 'in_progress' });
    audit(paths, 'task_ti_c4', { ts: hoursAgo(-3), event: 'update', agent: 'a', from: 'in_progress', to: 'blocked' });

    const report = checkStaleTasks(paths);
    const row = report.idle_ages.find((r) => r.task_id === 'task_ti_c4')!;
    expect(row.audit_transitions_future).toBe(1);
    expect(row.true_idle_seconds).toBeGreaterThanOrEqual(0);
    // the 9h transition survived rather than being discarded with the bad one
    expect(row.true_idle_seconds).toBeGreaterThan(8 * 3600);
    expect(report.stale_in_progress.map((t) => t.id)).toContain('task_ti_c4');
  });

  /**
   * C4 boundary, second route: a future-dated `created_at` reaches the idle
   * clock through the FALLBACK, where no audit filter can see it. Clamped at 0
   * AND reported — a silent clamp turns a broken timestamp into a row that
   * merely looks fresh.
   */
  it('C4b: a future-dated created_at clamps idle at 0 and reports the clamp', () => {
    writeTask(paths, { id: 'task_ti_c4b', status: 'in_progress', updated_at: hoursAgo(0.1), created_at: hoursAgo(-3) });

    const row = checkStaleTasks(paths).idle_ages.find((r) => r.task_id === 'task_ti_c4b')!;
    expect(row.idle_clamped).toBe(true);
    expect(row.true_idle_seconds).toBe(0);
  });

  /**
   * C4 MUST-STAY-GREEN. An ordinary past transition is not counted as future and
   * is not clamped. Without it, "treat every entry as future" passes C4.
   */
  it('C4-green: ordinary past transitions are neither future-counted nor clamped', () => {
    writeTask(paths, { id: 'task_ti_c4g', status: 'in_progress', updated_at: hoursAgo(0.1), created_at: hoursAgo(20) });
    audit(paths, 'task_ti_c4g', { ts: hoursAgo(9), event: 'claim', agent: 'a', from: 'pending', to: 'in_progress' });

    const row = checkStaleTasks(paths).idle_ages.find((r) => r.task_id === 'task_ti_c4g')!;
    expect(row.audit_transitions_future).toBe(0);
    expect(row.idle_clamped).toBe(false);
  });

  /**
   * THE POSITIVE CONTROL, established by guard and reused rather than reinvented:
   * a REAL `annotateTask` on a 9h-idle task refreshes the CLOCK to ~0, leaves
   * TRUE IDLE at ~9h, and the row alarms. This is the original defect, driven
   * through the real writer end to end.
   */
  it('positive control: a real annotateTask refreshes the clock and not TRUE IDLE', () => {
    writeTask(paths, { id: 'task_ti_pc', status: 'in_progress', updated_at: hoursAgo(9), created_at: hoursAgo(20) });
    audit(paths, 'task_ti_pc', { ts: hoursAgo(9), event: 'claim', agent: 'a', from: 'pending', to: 'in_progress' });

    annotateTask(paths, 'task_ti_pc', 'still waiting under hold; no work executed', 'agent1');

    const report = checkStaleTasks(paths);
    const row = report.idle_ages.find((r) => r.task_id === 'task_ti_pc')!;
    expect(row.clock_age_seconds).toBeLessThan(60);
    expect(row.true_idle_seconds).toBeGreaterThan(8 * 3600);
    expect(report.stale_in_progress.map((t) => t.id)).toContain('task_ti_pc');
  });

  /**
   * The seam's diagnostics are the seam's, not the report's — asserted directly
   * so a future refactor of checkStaleTasks cannot quietly stop surfacing them.
   */
  it('lastTransition reports its rejections by reason', () => {
    const t = writeTask(paths, { id: 'task_ti_diag', status: 'in_progress', created_at: hoursAgo(20) });
    audit(paths, 'task_ti_diag', { ts: hoursAgo(9), event: 'claim', agent: 'a', from: 'pending', to: 'in_progress' });
    audit(paths, 'task_ti_diag', { ts: hoursAgo(1), event: 'update', agent: 'a', from: 'in_progress', to: 'in_progress' });
    audit(paths, 'task_ti_diag', { ts: hoursAgo(-2), event: 'update', agent: 'a', from: 'in_progress', to: 'blocked' });
    audit(paths, 'task_ti_diag', { ts: 'not-a-date', event: 'update', agent: 'a', from: 'in_progress', to: 'blocked' });
    const auditPath = join(paths.taskDir, 'audit', 'task_ti_diag.jsonl');
    appendFileSync(auditPath, 'null\n');
    appendFileSync(auditPath, '{not json\n');

    const readout = lastTransition(paths, t);
    expect(readout.transitions_no_op).toBe(1);
    expect(readout.transitions_future).toBe(1);
    expect(readout.transitions_unparseable_ts).toBe(1);
    expect(readout.skipped_malformed).toBe(1);
    expect(readout.skipped_unparseable).toBe(1);
    expect(readout.transitions_invalid_endpoint).toBe(0);
    // the one good transition still wins
    const nineHoursAgo = Math.floor((Date.now() - 9 * 3600 * 1000) / 1000);
    expect(Math.abs(readout.epoch - nineHoursAgo)).toBeLessThan(60);
    expect(lastTransitionEpoch(paths, t)).toBe(readout.epoch);
  });

  /**
   * C5 — AN ENDPOINT THAT IS NOT A STATUS IS NOT A TRANSITION.
   *
   * INPUT:    a 9h-idle in_progress task with a valid `pending -> in_progress` claim,
   *           plus a recent line `{from: null, to: 'in_progress'}`.
   * OBSERVED: the row CLEARED. CLOCK 360 / TRUE_IDLE 360, every rejection count 0 —
   *           the invalid endpoint was read as fresh state-change evidence.
   * EXPECTED: rejected AND counted, the 9h transition retained, TRUE_IDLE ~32400, alarm.
   *
   * ⛔ WHY EVERY EARLIER GUARD LET IT THROUGH, and it is the lesson of this arm: the line
   * is a plain OBJECT, so the JSON-shape filter passes it; `null !== undefined`, so the
   * presence check passes it; `null !== 'in_progress'`, so the difference check passes it.
   * Three guards, all asking about the CONTAINER, none about the CONTENTS. A line can be
   * malformed data inside a well-formed object.
   *
   * Written with raw `appendFileSync` on purpose: `null` is a value the TypeScript type
   * says cannot be there, and the whole point is that data read off disk does not obey it.
   */
  it('C5: an audit line with a null endpoint is rejected and counted, not a transition', () => {
    writeTask(paths, { id: 'task_ti_c5', status: 'in_progress', updated_at: hoursAgo(0.1), created_at: hoursAgo(20) });
    audit(paths, 'task_ti_c5', { ts: hoursAgo(9), event: 'claim', agent: 'a', from: 'pending', to: 'in_progress' });
    appendFileSync(
      join(paths.taskDir, 'audit', 'task_ti_c5.jsonl'),
      JSON.stringify({ ts: hoursAgo(0.1), event: 'update', agent: 'a', from: null, to: 'in_progress' }) + '\n',
    );

    const report = checkStaleTasks(paths);
    const row = report.idle_ages.find((r) => r.task_id === 'task_ti_c5')!;

    expect(row.audit_transitions_invalid_endpoint).toBe(1);
    // the 9h claim survived rather than being discarded alongside the bad line
    expect(row.true_idle_seconds).toBeGreaterThan(8 * 3600);
    expect(report.stale_in_progress.map((t) => t.id)).toContain('task_ti_c5');
    // and it is NOT miscounted as one of the other rejection reasons
    expect(row.audit_lines_malformed).toBe(0);
    expect(row.audit_transitions_no_op).toBe(0);
  });

  /**
   * C5 MUST-STAY-GREEN, and it has TWO jobs. A real transition between real statuses is
   * still accepted — without it, "reject every line" passes C5. And an ANNOTATION and a
   * CREATE, which legitimately carry neither/one end, must NOT be counted as invalid
   * endpoints: a diagnostic that fires on every healthy log tells a reader nothing.
   */
  it('C5-green: real endpoints are accepted, and annotations/creates are not counted invalid', () => {
    writeTask(paths, { id: 'task_ti_c5g', status: 'in_progress', updated_at: hoursAgo(0.1), created_at: hoursAgo(20) });
    audit(paths, 'task_ti_c5g', { ts: hoursAgo(20), event: 'create', agent: 'a', to: 'pending' });
    audit(paths, 'task_ti_c5g', { ts: hoursAgo(0.1), event: 'claim', agent: 'a', from: 'pending', to: 'in_progress' });
    audit(paths, 'task_ti_c5g', { ts: hoursAgo(0.05), event: 'update', agent: 'a', note: 'annotated: a note' });

    const report = checkStaleTasks(paths);
    const row = report.idle_ages.find((r) => r.task_id === 'task_ti_c5g')!;
    expect(row.audit_transitions_invalid_endpoint).toBe(0);
    // the 6-minute claim was ACCEPTED, so the row is well inside the 2h threshold
    expect(row.true_idle_seconds).toBeLessThan(7200);
    expect(report.stale_in_progress.map((t) => t.id)).not.toContain('task_ti_c5g');
  });

  /**
   * C6 — THE DECLARED CONTRACT AND THE BEHAVIOUR MUST AGREE ABOUT NEGATIVE AGES.
   *
   * INPUT:    `updated_at` 3h in the FUTURE, a valid transition 6m ago.
   * OBSERVED: `clock_age_seconds` -10800 while the type comment promised no age is ever
   *           negative — only the IDLE clock was clamped.
   * EXPECTED: clamped at 0 like the idle clock, and FLAGGED, because 0 reads as
   *           "just written" and that is the reassuring direction.
   *
   * ⚠ The flag is the load-bearing half. For `in_progress` the clamp is covered — the idle
   * clock is the other half of `max()`. For `blocked`/`pending`/`human` there is no second
   * clock, so a future `updated_at` clears those rows; it did so at -10800 too, so the
   * clamp changes the number and not that outcome. `clock_future` is how a reader sees it.
   */
  it('C6: a future updated_at clamps the clock at 0 and is flagged, never negative', () => {
    writeTask(paths, { id: 'task_ti_c6', status: 'in_progress', updated_at: hoursAgo(-3), created_at: hoursAgo(20) });
    audit(paths, 'task_ti_c6', { ts: hoursAgo(0.1), event: 'claim', agent: 'a', from: 'pending', to: 'in_progress' });

    const row = checkStaleTasks(paths).idle_ages.find((r) => r.task_id === 'task_ti_c6')!;
    // ⛔ BEHAVIOUR CHANGED HERE, DELIBERATELY, AND THE OLD EXPECTATION IS RECORDED SO THE CHANGE IS
    // LEGIBLE: this arm used to assert `clock_age_seconds === 0` — the clamp. Three hours ahead is
    // FAR beyond CLOCK_SKEW_TOLERANCE_SECONDS, so it is no longer treated as skew: it is broken
    // time, and broken time reads as MAXIMALLY STALE, the same rule an unparseable timestamp gets.
    // The clamp survives, but only for genuine skew — see C10, which asserts it at 299s.
    // ⭐ The contract the type declares is unchanged and is what this arm really guards: never
    // null, never NaN, never negative.
    expect(row.clock_age_seconds).toBeGreaterThan(7200);
    expect(row.clock_future).toBe(true);
    expect(row.clock_malformed).toBe(false); // a future time PARSES — a different fault
    // the contract, asserted directly and through the serialisation the CLI performs
    expect(row.clock_age_seconds).toBeGreaterThanOrEqual(0);
    expect(row.true_idle_seconds).toBeGreaterThanOrEqual(0);
    const round = JSON.parse(JSON.stringify(row));
    expect(round.clock_age_seconds).toBeGreaterThanOrEqual(0);
    expect(round.true_idle_seconds).toBeGreaterThanOrEqual(0);
  });

  /** C6 MUST-STAY-GREEN: an ordinary past `updated_at` is neither clamped nor flagged. */
  it('C6-green: a past updated_at keeps its real age and is not flagged future', () => {
    writeTask(paths, { id: 'task_ti_c6g', status: 'in_progress', updated_at: hoursAgo(5), created_at: hoursAgo(20) });
    audit(paths, 'task_ti_c6g', { ts: hoursAgo(0.1), event: 'claim', agent: 'a', from: 'pending', to: 'in_progress' });

    const row = checkStaleTasks(paths).idle_ages.find((r) => r.task_id === 'task_ti_c6g')!;
    expect(row.clock_future).toBe(false);
    expect(row.clock_age_seconds).toBeGreaterThan(4 * 3600);
  });

  // ==========================================================================
  // BROKEN CLOCKS ARE A FACT ABOUT THE TASK, NOT ABOUT THE BUCKET.
  //
  // The earlier `clock_future` flag lived on the `in_progress`-only `idle_ages` row — the ONE
  // bucket that does not need it, because `in_progress` alarms on `max(clock, idle)` and the idle
  // clock still decides. `blocked` reads `updated_at` alone; `pending` and `human` read
  // `created_at` alone; all three were cleared by a broken value with nothing to say so.
  //
  // Derived per bucket from source, because the original description of this defect was too broad:
  //   blocked  -> updated_at   pending -> created_at   human -> created_at   overdue -> due_date
  // ==========================================================================

  const secondsAhead = (sec: number) => iso(new Date(Date.now() + sec * 1000));

  /** C7 — `blocked` reads `updated_at`, and a badly-future value used to clear it silently. */
  it('C7: blocked with a far-future updated_at is MAXIMALLY STALE and is reported', () => {
    writeTask(paths, { id: 'task_ti_c7', status: 'blocked', updated_at: secondsAhead(3 * 3600), created_at: hoursAgo(20) });

    const report = checkStaleTasks(paths);
    expect(report.stale_blocked.map((t) => t.id)).toContain('task_ti_c7');
    const anomaly = report.clock_anomalies.find((a) => a.task_id === 'task_ti_c7')!;
    expect(anomaly).toBeDefined();
    expect(anomaly.status).toBe('blocked');
    expect(anomaly.updated_at_verdict).toBe('future');
    expect(anomaly.updated_at_future_by_seconds).toBeGreaterThan(2 * 3600);
  });

  /** C8 — `pending` reads `created_at`, NOT `updated_at`. The original prose had this wrong. */
  it('C8: pending with a far-future created_at is MAXIMALLY STALE and is reported', () => {
    writeTask(paths, { id: 'task_ti_c8', status: 'pending', updated_at: hoursAgo(0.1), created_at: secondsAhead(3 * 3600) });

    const report = checkStaleTasks(paths);
    expect(report.stale_pending.map((t) => t.id)).toContain('task_ti_c8');
    const anomaly = report.clock_anomalies.find((a) => a.task_id === 'task_ti_c8')!;
    expect(anomaly.created_at_verdict).toBe('future');
    expect(anomaly.updated_at_verdict).toBe('ok');
  });

  /** C9 — `human` also reads `created_at`. Same repair, different bucket, asserted separately. */
  it('C9: a human task with a far-future created_at is MAXIMALLY STALE and is reported', () => {
    writeTask(paths, { id: 'task_ti_c9', status: 'pending', updated_at: hoursAgo(0.1), created_at: secondsAhead(3 * 3600) });
    const f = join(paths.taskDir, 'task_ti_c9.json');
    const t = JSON.parse(readFileSync(f, 'utf-8'));
    t.assigned_to = 'human';
    atomicWriteSync(f, JSON.stringify(t));

    const report = checkStaleTasks(paths);
    expect(report.stale_human.map((x) => x.id)).toContain('task_ti_c9');
    expect(report.clock_anomalies.find((a) => a.task_id === 'task_ti_c9')!.created_at_verdict).toBe('future');
  });

  /**
   * THE BOUNDARY, MEASURED ON BOTH SIDES RATHER THAN ASSUMED. A few seconds of NTP or
   * multi-process skew must NOT read as ~45,000 hours idle — an alarm generator is the same
   * failure as a false clear, pointing the other way, and it is the one that teaches an operator
   * to stop reading alarms.
   */
  it(`C10: ${CLOCK_SKEW_TOLERANCE_SECONDS - 1}s ahead is SKEW — clamped to 0, flagged, NOT stale`, () => {
    writeTask(paths, {
      id: 'task_ti_c10',
      status: 'blocked',
      updated_at: secondsAhead(CLOCK_SKEW_TOLERANCE_SECONDS - 1),
      created_at: hoursAgo(20),
    });

    const report = checkStaleTasks(paths);
    expect(report.stale_blocked.map((t) => t.id)).not.toContain('task_ti_c10');
    const anomaly = report.clock_anomalies.find((a) => a.task_id === 'task_ti_c10')!;
    expect(anomaly.updated_at_verdict).toBe('skew');
  });

  it(`C10b: ${CLOCK_SKEW_TOLERANCE_SECONDS + 1}s ahead is BROKEN — maximally stale and it alarms`, () => {
    writeTask(paths, {
      id: 'task_ti_c10b',
      status: 'blocked',
      updated_at: secondsAhead(CLOCK_SKEW_TOLERANCE_SECONDS + 1),
      created_at: hoursAgo(20),
    });

    const report = checkStaleTasks(paths);
    expect(report.stale_blocked.map((t) => t.id)).toContain('task_ti_c10b');
    expect(report.clock_anomalies.find((a) => a.task_id === 'task_ti_c10b')!.updated_at_verdict).toBe('future');
  });

  /**
   * ⛔ `overdue` IS DELIBERATELY UNTOUCHED. It reads `due_date`, where a value in the future is
   * exactly what "not overdue yet" MEANS. Asserted so a later change does not sweep it in by
   * symmetry with the three buckets above — the symmetry is superficial and the semantics differ.
   */
  it('C11: a future due_date is NOT overdue and is NOT a clock anomaly', () => {
    writeTask(paths, { id: 'task_ti_c11', status: 'pending', updated_at: hoursAgo(0.1), created_at: hoursAgo(0.2) });
    const f = join(paths.taskDir, 'task_ti_c11.json');
    const t = JSON.parse(readFileSync(f, 'utf-8'));
    t.due_date = secondsAhead(48 * 3600);
    atomicWriteSync(f, JSON.stringify(t));

    const report = checkStaleTasks(paths);
    expect(report.overdue.map((x) => x.id)).not.toContain('task_ti_c11');
    expect(report.clock_anomalies.find((a) => a.task_id === 'task_ti_c11')).toBeUndefined();
  });

  /**
   * MUST-STAY-GREEN. Ordinary timestamps produce NO anomalies at all. Without this, "record an
   * anomaly for everything" passes C7-C10b, and a diagnostic that fires on every healthy task is
   * indistinguishable from one that fires on none.
   */
  it('C7-green: well-formed past timestamps produce an EMPTY clock_anomalies array', () => {
    writeTask(paths, { id: 'task_ti_c7g1', status: 'blocked', updated_at: hoursAgo(5), created_at: hoursAgo(20) });
    writeTask(paths, { id: 'task_ti_c7g2', status: 'pending', updated_at: hoursAgo(1), created_at: hoursAgo(30) });
    writeTask(paths, { id: 'task_ti_c7g3', status: 'in_progress', updated_at: hoursAgo(1), created_at: hoursAgo(3) });

    const report = checkStaleTasks(paths);
    expect(report.clock_anomalies).toHaveLength(0);
    // and the buckets still work — the fix must not have disabled what it guards
    expect(report.stale_blocked.map((t) => t.id)).toContain('task_ti_c7g1');
    expect(report.stale_pending.map((t) => t.id)).toContain('task_ti_c7g2');
  });

  /**
   * A malformed timestamp lands in the SAME array with its own verdict — the two unusable-time
   * cases are now reported through one channel instead of one being flagged and one not.
   */
  it('C12: a malformed updated_at is reported as an anomaly, not only as a stale row', () => {
    writeTask(paths, { id: 'task_ti_c12', status: 'blocked', updated_at: 'invalid-date', created_at: hoursAgo(20) });

    const report = checkStaleTasks(paths);
    expect(report.stale_blocked.map((t) => t.id)).toContain('task_ti_c12');
    expect(report.clock_anomalies.find((a) => a.task_id === 'task_ti_c12')!.updated_at_verdict).toBe('malformed');
  });
});
