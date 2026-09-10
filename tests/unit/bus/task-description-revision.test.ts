import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { updateTask, annotateTask, readTaskAudit, lastTransition, checkStaleTasks } from '../../../src/bus/task';
import { atomicWriteSync } from '../../../src/utils/atomic';
import type { BusPaths, Task } from '../../../src/types';

/**
 * REVISING A DESCRIPTION WITHOUT LOSING THE OLD ONE.
 *
 * THE DEFECT. `description` had no write route at all: `update-task` took exactly
 * `<id> <status>`, and `annotateTask` states in its own docstring that the description is
 * not touched. The rationale was sound — rewriting destroys the record of what was
 * originally asked — but it was enforced by REFUSING TO WRITE, which keeps the original by
 * leaving the WRONG text in front of every future reader. A correction could only ever sit
 * UNDERNEATH the claim it disproved, and a reader hits the description first.
 *
 * Measured 2026-09-10, twice in one day: a queue item was dispatched as work from a stale
 * title while the correction sat in its own body, and a task went on asserting a fix
 * direction its own author had already measured dead.
 *
 * ⭐ THE FIX IS NEITHER "ALLOW OVERWRITE" NOR "REFUSE TO WRITE" — IT IS KEEP BOTH. So the
 * two load-bearing arms are the two halves of that sentence: the new text must be live, and
 * the old text must still be retrievable. An implementation that satisfies only the first
 * is the destruction the original design was protecting against, and it would look
 * identical from the caller's side.
 */

function iso(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function writeTask(paths: BusPaths, o: Partial<Task> & { id: string }): Task {
  const now = iso(new Date());
  const task: Task = {
    id: o.id,
    title: o.title ?? 'T',
    description: o.description ?? 'original description',
    type: 'agent',
    needs_approval: false,
    status: o.status ?? 'pending',
    assigned_to: o.assigned_to ?? 'agent1',
    created_by: 'agent1',
    org: 'testorg',
    priority: 'normal',
    project: '',
    kpi_key: null,
    // ⛔ HONOUR THE OVERRIDES. These read `now` unconditionally in the first version of this
    // helper, so the composition arms below — which need a task PAST the 24h stale gate — were
    // silently given a brand-new task and asserted against an empty bucket. The probe that
    // originally proved the composition used a different helper that did honour them, so the
    // finding was real and the port of it was not: A TEST MOVED INTO A NEW FILE INHERITS THAT
    // FILE'S SETUP, NOT THE ONE IT WAS PROVEN UNDER.
    created_at: o.created_at ?? now,
    updated_at: o.updated_at ?? now,
    completed_at: null,
    due_date: null,
    archived: false,
  };
  atomicWriteSync(join(paths.taskDir, `${task.id}.json`), JSON.stringify(task));
  return task;
}

const read = (paths: BusPaths, id: string): Task =>
  JSON.parse(readFileSync(join(paths.taskDir, `${id}.json`), 'utf-8'));

describe('update-task --desc: revise the live text, keep the old one', () => {
  let tmp: string;
  let paths: BusPaths;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'descrev-'));
    const taskDir = join(tmp, 'tasks');
    mkdirSync(taskDir, { recursive: true });
    paths = {
      ctxRoot: tmp, inbox: tmp, inflight: tmp, processed: tmp, logDir: tmp,
      stateDir: tmp, taskDir, approvalDir: tmp, analyticsDir: tmp, deliverablesDir: tmp,
    } as BusPaths;
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  /** ARM 1 of 2. The previous text must survive the replacement, byte for byte. */
  it('KEEPS the previous description, verbatim and retrievable, after replacement', () => {
    writeTask(paths, { id: 'task_d1', description: '(a) is the mechanism and is cheap' });

    updateTask(paths, 'task_d1', 'in_progress', 'MEASURED DEAD: 162 -> 159. Use the transition axis.');

    const t = read(paths, 'task_d1');
    expect(t.description).toBe('MEASURED DEAD: 162 -> 159. Use the transition axis.');
    expect(t.description_history).toHaveLength(1);
    expect(t.description_history![0].description).toBe('(a) is the mechanism and is cheap');
    expect(t.description_history![0].agent).toBe('agent1');
    expect(t.description_history![0].ts).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
    expect(t.status).toBe('in_progress');
  });

  /**
   * ARM 2 of 2. A task that has never been revised must round-trip UNCHANGED — no
   * `description_history` key at all, not an empty array. Every task file on disk predates
   * this field, and a write that adds an empty array to all of them is a migration nobody
   * asked for, showing up as a diff on every task the next time anything touches it.
   */
  it('leaves an unrevised task byte-identical: no history key is introduced', () => {
    writeTask(paths, { id: 'task_d2', description: 'untouched' });
    const before = readFileSync(join(paths.taskDir, 'task_d2.json'), 'utf-8');

    updateTask(paths, 'task_d2', 'in_progress');

    const t = read(paths, 'task_d2');
    expect(t.description).toBe('untouched');
    expect('description_history' in t).toBe(false);
    expect(JSON.parse(before).description).toBe(t.description);
  });

  /** Successive revisions accumulate oldest-first; nothing is dropped or reordered. */
  it('accumulates every superseded text in order across repeated revisions', () => {
    writeTask(paths, { id: 'task_d3', description: 'v1' });
    updateTask(paths, 'task_d3', 'pending', 'v2');
    updateTask(paths, 'task_d3', 'pending', 'v3');

    const t = read(paths, 'task_d3');
    expect(t.description).toBe('v3');
    expect(t.description_history!.map((r) => r.description)).toEqual(['v1', 'v2']);
  });

  /**
   * ⛔ THE HISTORY HOLDS THE PREVIOUS TEXT, NOT THE NEW ONE. Storing the new text would make
   * the array a duplicate of the live field and lose the only copy of the old — the exact
   * destruction it exists to prevent, in a shape that still looks like a record.
   */
  it('never stores the replacement text in the history', () => {
    writeTask(paths, { id: 'task_d4', description: 'old' });
    updateTask(paths, 'task_d4', 'pending', 'new');
    const t = read(paths, 'task_d4');
    expect(t.description_history!.map((r) => r.description)).not.toContain('new');
  });

  /**
   * Identical text is not a revision. Re-running the same command must not put a duplicate
   * in the history and make it look like a second correction.
   */
  it('records nothing when the text is unchanged', () => {
    writeTask(paths, { id: 'task_d5', description: 'same' });
    updateTask(paths, 'task_d5', 'pending', 'same');
    expect('description_history' in read(paths, 'task_d5')).toBe(false);
  });

  /**
   * ⛔ `undefined` AND `''` ARE DIFFERENT ARGUMENTS. `undefined` means "do not touch"; the
   * empty string is a real (if unwise) replacement. Under a truthiness check the second
   * would silently become a no-op while the caller was told it worked — a write that
   * reports success and does nothing, which is this codebase's recurring failure shape.
   */
  it('treats an empty string as a real replacement, not as "no argument"', () => {
    writeTask(paths, { id: 'task_d6', description: 'had text' });
    updateTask(paths, 'task_d6', 'pending', '');
    const t = read(paths, 'task_d6');
    expect(t.description).toBe('');
    expect(t.description_history!.map((r) => r.description)).toEqual(['had text']);
  });

  /**
   * The audit line for a revision must NOT read as lifecycle activity. It carries no
   * `from`/`to`, so `lastTransition` skips it exactly like an annotation — otherwise
   * correcting a description would reset the idle clock that `stale_in_progress` reads, and
   * a task could be kept looking fresh by editing its text.
   */
  it('writes an audit line that is not a transition and does not reset the idle clock', () => {
    writeTask(paths, { id: 'task_d7', description: 'old' });
    updateTask(paths, 'task_d7', 'in_progress', 'new');

    const entries = readTaskAudit(paths, 'task_d7');
    const notes = entries.filter((e) => e.from === undefined && e.to === undefined);
    expect(notes).toHaveLength(1);
    expect(notes[0].note).toContain('description replaced');
    expect(notes[0].note).toContain('description_history');
    expect(notes[0].note).not.toContain('old');

    // The note must be skipped SILENTLY — not counted as any kind of rejection. A note that
    // landed in `transitions_no_op` or `transitions_invalid_endpoint` would show up as audit
    // corruption in every diagnostic that reads those counters.
    const readout = lastTransition(paths, read(paths, 'task_d7'));
    expect(readout.transitions_no_op).toBe(0);
    expect(readout.transitions_invalid_endpoint).toBe(0);
    expect(readout.transitions_unparseable_ts).toBe(0);
    expect(readout.skipped_malformed).toBe(0);
    // Exactly one line in the log IS a transition: the status change, not the revision.
    expect(entries.filter((e) => e.from !== undefined && e.to !== undefined)).toHaveLength(1);
  });

  /** Revision and annotation are independent records; neither consumes the other. */
  it('keeps annotations and description history side by side', () => {
    writeTask(paths, { id: 'task_d8', description: 'old' });
    annotateTask(paths, 'task_d8', 'a note that arrived later', 'agent2');
    updateTask(paths, 'task_d8', 'pending', 'new');

    const t = read(paths, 'task_d8');
    expect(t.annotations).toHaveLength(1);
    expect(t.annotations![0].text).toBe('a note that arrived later');
    expect(t.description_history).toHaveLength(1);
    expect(t.description).toBe('new');
  });
});

/**
 * ⛔ THE COMPOSITION ARM — the later change defending the earlier contract.
 *
 * The `stale_pending_regressed` bucket keys on `transitions_valid`: has this task ever made a
 * REAL status transition, which is what separates a wedge from a backlog item. This file adds
 * an audit line for a description revision. IF THAT LINE COUNTED AS A TRANSITION, EDITING A
 * DESCRIPTION WOULD PROMOTE A BACKLOG TASK INTO THE WEDGE BUCKET — a monitor you can trip by
 * correcting a typo, and the alarm would go noisy again through the one route nobody would
 * think to check.
 *
 * ⭐ NEITHER CHANGE'S OWN SUITE CAN SEE THIS. Each was written without the other, so a clean
 * merge and a green full run stay green whichever way the interaction goes. The composition is
 * only visible to a test that holds both, which is why this arm lives with the LATER change:
 * the contract it could break belongs to the earlier one.
 */
describe('COMPOSITION: a description revision must not read as lifecycle activity', () => {
  let tmp: string;
  let paths: BusPaths;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'descrev-compose-'));
    const taskDir = join(tmp, 'tasks');
    mkdirSync(taskDir, { recursive: true });
    paths = {
      ctxRoot: tmp, inbox: tmp, inflight: tmp, processed: tmp, logDir: tmp,
      stateDir: tmp, taskDir, approvalDir: tmp, analyticsDir: tmp, deliverablesDir: tmp,
    } as BusPaths;
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const hoursAgo = (h: number) => iso(new Date(Date.now() - h * 3600e3));

  it('revising a description does NOT promote a born-pending task into stale_pending_regressed', () => {
    writeTask(paths, {
      id: 'task_cx1', status: 'pending',
      created_at: hoursAgo(72), updated_at: hoursAgo(72),
    });

    updateTask(paths, 'task_cx1', 'pending', 'corrected text');  // no status change; description revised

    const report = checkStaleTasks(paths);
    expect(report.stale_pending.map((t) => t.id)).toContain('task_cx1');
    expect(report.stale_pending_regressed.map((t) => t.id)).not.toContain('task_cx1');
    expect(lastTransition(paths, read(paths, 'task_cx1')).transitions_valid).toBe(0);
  });

  /**
   * THE ARM THAT MAKES THE ONE ABOVE MEAN SOMETHING. Without it, "the revision is invisible to
   * the counter" and "the counter stopped working" are the same observation.
   */
  it('still counts real transitions when a revision rides along with one', () => {
    writeTask(paths, {
      id: 'task_cx2', status: 'pending',
      created_at: hoursAgo(72), updated_at: hoursAgo(72),
    });

    updateTask(paths, 'task_cx2', 'in_progress', 'revised while claiming');
    updateTask(paths, 'task_cx2', 'pending');

    const t = read(paths, 'task_cx2');
    expect(lastTransition(paths, t).transitions_valid).toBe(2);   // two status changes, not three
    expect(t.description_history).toHaveLength(1);
    expect(checkStaleTasks(paths).stale_pending_regressed.map((x) => x.id)).toContain('task_cx2');
  });
});
