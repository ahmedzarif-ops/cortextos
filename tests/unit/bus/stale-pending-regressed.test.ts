import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { checkStaleTasks, lastTransition } from '../../../src/bus/task';
import { atomicWriteSync } from '../../../src/utils/atomic';
import type { BusPaths, Task, TaskStatus } from '../../../src/types';

/**
 * REGRESSED PENDING — the bucket that can tell a wedge from a backlog.
 *
 * THE DEFECT THESE TESTS PIN. `stale_pending` is "pending and created >24h ago".
 * Measured 2026-09-10 against a live 889-task store it returned 162 rows, and an
 * alarm that fires 162 times fires zero times: nothing in the output separated a
 * task WEDGED mid-flight from an idea filed three weeks ago and correctly waiting.
 *
 * WHY THE OBVIOUS FIX IS NOT IN THIS FILE. Selecting on `updated_at` instead of
 * `created_at` — staleness-since-last-touch — was specified first and MEASURED
 * DEAD: 162 -> 159. Only 56 of the 162 rows had ever been touched at all and only
 * 3 inside 24h, because nobody annotates a backlog. Raising the constant is worse:
 * the age histogram has no cliff (3/28/42/3/41/0/45 across <1d..30d), so every
 * candidate threshold reproduces the defect at a new number.
 *
 * ⭐ THE REASON NO CLOCK CAN WORK: AGE CANNOT TELL "NOBODY STARTED THIS" FROM
 * "SOMEBODY STARTED THIS AND STOPPED". Both are a row that has not moved. Only the
 * second is a wedge. The discriminator is structural — did the task ever make a
 * real status transition — and the audit log already records it. 162 -> 33.
 *
 * BOTH ARMS ARE MANDATORY AND THE SECOND IS THE LOAD-BEARING ONE. A bucket that
 * flagged every stale pending task would pass the wedge arm perfectly; "it catches
 * the wedge" and "it discriminates" are the same observation until a born-pending
 * task is asserted ABSENT. And a bucket that goes quiet is indistinguishable from a
 * bucket that works, which is why the wedge arm exists at all.
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
    status: o.status ?? 'pending',
    assigned_to: o.assigned_to ?? 'agent1',
    created_by: 'agent1',
    org: 'testorg',
    priority: 'normal',
    project: o.project ?? '',
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

/** Raw audit line. Deliberately NOT via appendTaskAudit: these tests need
 *  backdated `ts` values, and appendTaskAudit stamps `now`. */
function audit(
  paths: BusPaths,
  taskId: string,
  entry: {
    ts: string;
    event: string;
    agent: string;
    from?: TaskStatus | null;
    to?: TaskStatus | null;
    note?: string;
  },
): void {
  const dir = join(paths.taskDir, 'audit');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `${taskId}.jsonl`), JSON.stringify(entry) + '\n');
}

describe('stale_pending_regressed: worked-then-fell-back, beside the backlog', () => {
  let tmp: string;
  let paths: BusPaths;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'regressed-'));
    const taskDir = join(tmp, 'tasks');
    mkdirSync(taskDir, { recursive: true });
    paths = {
      ctxRoot: tmp, inbox: tmp, inflight: tmp, processed: tmp, logDir: tmp,
      stateDir: tmp, taskDir, approvalDir: tmp, analyticsDir: tmp, deliverablesDir: tmp,
    } as BusPaths;
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  /**
   * THE CONTROL THAT MUST FIRE — the reconstructed 21-hour wedge.
   *
   * The incident this bucket exists for: a task was claimed, hit a blocker, went
   * back on the queue and sat 21 hours while every instrument read clean. Its
   * audit log says plainly that it was worked. Its clocks say only that it is old,
   * which is what the backlog says too.
   */
  it('FIRES on a task claimed, blocked, and back on the queue untouched for 21h', () => {
    writeTask(paths, {
      id: 'task_rg_wedge',
      status: 'pending',
      created_at: hoursAgo(72),
      updated_at: hoursAgo(21),
    });
    audit(paths, 'task_rg_wedge', { ts: hoursAgo(48), event: 'claim', agent: 'a', from: 'pending', to: 'in_progress' });
    audit(paths, 'task_rg_wedge', { ts: hoursAgo(30), event: 'block', agent: 'a', from: 'in_progress', to: 'blocked' });
    audit(paths, 'task_rg_wedge', { ts: hoursAgo(21), event: 'requeue', agent: 'a', from: 'blocked', to: 'pending' });

    const report = checkStaleTasks(paths);
    expect(report.stale_pending_regressed.map((t) => t.id)).toContain('task_rg_wedge');
  });

  /**
   * THE CONTROL THAT MUST STAY SILENT, and it is the one that makes the other
   * arm mean anything. Filed three weeks ago, never claimed by anyone, correctly
   * waiting. It is stale by every clock in this report and it is not a wedge.
   */
  it('STAYS SILENT on a born-pending backlog task that is far past the gate', () => {
    writeTask(paths, {
      id: 'task_rg_backlog',
      status: 'pending',
      created_at: hoursAgo(24 * 21),
      updated_at: hoursAgo(24 * 21),
    });
    audit(paths, 'task_rg_backlog', { ts: hoursAgo(24 * 21), event: 'create', agent: 'a', to: 'pending' });

    const report = checkStaleTasks(paths);
    expect(report.stale_pending.map((t) => t.id)).toContain('task_rg_backlog');
    expect(report.stale_pending_regressed.map((t) => t.id)).not.toContain('task_rg_backlog');
  });

  /**
   * THE ADD-ONLY GUARANTEE, asserted rather than described. `checkStaleTasks`
   * states twice that a change to it may only ever ADD rows. The whole reason
   * this is a second bucket instead of a narrower predicate on the first is that
   * narrowing would have removed 129 live rows. If a later edit "tidies up" by
   * moving the filter into `stale_pending`, this fails.
   */
  it('leaves stale_pending intact: BOTH tasks stay in it, and regressed is a strict subset', () => {
    writeTask(paths, { id: 'task_rg_wedge', status: 'pending', created_at: hoursAgo(72), updated_at: hoursAgo(21) });
    audit(paths, 'task_rg_wedge', { ts: hoursAgo(48), event: 'claim', agent: 'a', from: 'pending', to: 'in_progress' });
    audit(paths, 'task_rg_wedge', { ts: hoursAgo(21), event: 'requeue', agent: 'a', from: 'in_progress', to: 'pending' });
    writeTask(paths, { id: 'task_rg_backlog', status: 'pending', created_at: hoursAgo(24 * 21) });

    const report = checkStaleTasks(paths);
    const pending = report.stale_pending.map((t) => t.id);
    const regressed = report.stale_pending_regressed.map((t) => t.id);

    expect(pending).toContain('task_rg_wedge');
    expect(pending).toContain('task_rg_backlog');
    expect(pending.length).toBe(2);
    expect(regressed).toEqual(['task_rg_wedge']);
    for (const id of regressed) expect(pending).toContain(id);
  });

  /**
   * A REJECTED LINE IS NOT EVIDENCE OF WORK.
   *
   * `lastTransition` already refuses four kinds of audit line: `from === to`
   * (`updateTask` writes both ends unconditionally, so re-setting a status emits a
   * transition that moved nothing), an endpoint that is not a real status, an
   * unparseable `ts`, and a future date. Every one of them is a line the reader
   * decided not to trust — so none of them may promote a backlog row into the
   * wedge bucket. This is why the predicate reads `transitions_valid` and not
   * "the audit file is non-empty".
   */
  it('does not count no-op, invalid-endpoint, unparseable or future lines as work', () => {
    writeTask(paths, { id: 'task_rg_junk', status: 'pending', created_at: hoursAgo(72), updated_at: hoursAgo(72) });
    audit(paths, 'task_rg_junk', { ts: hoursAgo(40), event: 'update', agent: 'a', from: 'pending', to: 'pending' });
    audit(paths, 'task_rg_junk', { ts: hoursAgo(39), event: 'update', agent: 'a', from: null, to: 'in_progress' });
    audit(paths, 'task_rg_junk', { ts: 'not-a-date', event: 'update', agent: 'a', from: 'pending', to: 'in_progress' });
    audit(paths, 'task_rg_junk', { ts: hoursAgo(-72), event: 'update', agent: 'a', from: 'pending', to: 'in_progress' });
    audit(paths, 'task_rg_junk', { ts: hoursAgo(38), event: 'annotate', agent: 'a', note: 'still waiting' });

    const readout = lastTransition(paths, { id: 'task_rg_junk', created_at: hoursAgo(72) } as Task);
    expect(readout.transitions_valid).toBe(0);
    expect(readout.transitions_no_op).toBe(1);
    expect(readout.transitions_invalid_endpoint).toBe(1);
    expect(readout.transitions_unparseable_ts).toBe(1);
    expect(readout.transitions_future).toBe(1);

    const report = checkStaleTasks(paths);
    expect(report.stale_pending.map((t) => t.id)).toContain('task_rg_junk');
    expect(report.stale_pending_regressed.map((t) => t.id)).not.toContain('task_rg_junk');
  });

  /**
   * `transitions_valid` IS A COUNT, NOT AN INFERENCE FROM `epoch`.
   *
   * `lastTransition().epoch` falls back to `created_at` when nothing was accepted,
   * so the tempting test — `epoch !== createdEpoch` — asks whether the newest
   * transition happened to land on a different second than creation. That is a
   * question about coincidence. A task created and claimed inside the same second
   * answers "no" and would read as never-worked. Pinned here because the cheap
   * version passes every other test in this file.
   */
  it('counts a transition that lands on the same second as creation', () => {
    const t = hoursAgo(72);
    writeTask(paths, { id: 'task_rg_samesec', status: 'pending', created_at: t, updated_at: t });
    audit(paths, 'task_rg_samesec', { ts: t, event: 'claim', agent: 'a', from: 'pending', to: 'in_progress' });

    const readout = lastTransition(paths, { id: 'task_rg_samesec', created_at: t } as Task);
    expect(readout.transitions_valid).toBe(1);
    expect(checkStaleTasks(paths).stale_pending_regressed.map((x) => x.id)).toContain('task_rg_samesec');
  });

  /**
   * ⛔ A LIMITATION, PINNED SO IT IS VISIBLE RATHER THAN DISCOVERED.
   *
   * This bucket sits INSIDE the `stale_pending` branch so that it is a strict
   * subset, which means it inherits that branch's gate: `created_at` older than
   * 24h. A task CREATED 22 hours ago and wedged for 21 of them is a real instance
   * of the incident class and this bucket cannot see it — not because the
   * structural predicate fails, but because the age gate in front of it does.
   *
   * The subset property was chosen deliberately (it is what makes the change
   * add-only and safe to ship). This test states the price. Anyone widening the
   * bucket to catch young wedges must give it its own gate and must then re-derive
   * the subset assertion above, which will correctly start failing.
   */
  it('KNOWN GAP: a wedge on a task created <24h ago is invisible, because the gate is inherited', () => {
    writeTask(paths, { id: 'task_rg_young', status: 'pending', created_at: hoursAgo(22), updated_at: hoursAgo(21) });
    audit(paths, 'task_rg_young', { ts: hoursAgo(22), event: 'claim', agent: 'a', from: 'pending', to: 'in_progress' });
    audit(paths, 'task_rg_young', { ts: hoursAgo(21), event: 'requeue', agent: 'a', from: 'in_progress', to: 'pending' });

    const report = checkStaleTasks(paths);
    expect(report.stale_pending.map((t) => t.id)).not.toContain('task_rg_young');
    expect(report.stale_pending_regressed.map((t) => t.id)).not.toContain('task_rg_young');
  });
});
