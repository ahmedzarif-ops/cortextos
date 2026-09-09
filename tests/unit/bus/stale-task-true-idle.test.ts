import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { checkStaleTasks, lastTransitionEpoch } from '../../../src/bus/task';
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
});
