import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync, unlinkSync, appendFileSync } from 'fs';
import { join } from 'path';
import type { Task, TaskAnnotation, Priority, TaskStatus, BusPaths, StaleTaskReport, ArchiveReport } from '../types/index.js';
import { isTaskStatus } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { randomDigits } from '../utils/random.js';
import { validatePriority, validateTaskId } from '../utils/validate.js';
import { logEvent } from './event.js';

/**
 * Create a new task. Identical JSON format to bash create-task.sh.
 */
export function createTask(
  paths: BusPaths,
  agentName: string,
  org: string,
  title: string,
  options: {
    description?: string;
    assignee?: string;
    priority?: Priority;
    project?: string;
    needsApproval?: boolean;
    dueDate?: string;
    blockedBy?: string[];
    blocks?: string[];
  } = {},
): string {
  const {
    description = '',
    assignee = agentName,
    priority = 'normal',
    project = '',
    needsApproval = false,
    dueDate = '',
    blockedBy = [],
    blocks = [],
  } = options;

  validatePriority(priority);

  const epoch = Date.now();
  // 8 digits: same-millisecond collision probability is ~1e-8 instead of ~1e-3.
  // Two createTask calls in the same ms with a 3-digit suffix collided in CI
  // (run 25618845172), making the new task's id equal to its declared blocker
  // and tripping detectCycleOrThrow with "X ultimately blocks itself via X".
  const rand = randomDigits(8);
  const taskId = `task_${epoch}_${rand}`;
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  // Dependency validation FIRST — a cycle must never be allowed to
  // leave partial state on disk. Earlier iteration wrote the task
  // JSON before detectCycleOrThrow ran, so a failed cycle check left
  // a dangling task with a one-way edge and no symmetric peer update.
  // Order is now: validate → write task → mutate peers → audit. The
  // cycle walker gets a `virtual` description of the not-yet-written
  // task so chains that pass through it are still detectable.
  const virtualTask = { id: taskId, blocked_by: blockedBy };
  if (blockedBy.length) detectCycleOrThrow(paths, taskId, blockedBy, virtualTask);
  if (blocks.length) {
    for (const downId of blocks) detectCycleOrThrow(paths, downId, [taskId], virtualTask);
  }

  const task: Task = {
    id: taskId,
    title,
    description,
    type: 'agent',
    needs_approval: needsApproval,
    status: 'pending',
    assigned_to: assignee,
    created_by: agentName,
    org,
    priority,
    project,
    kpi_key: null,
    created_at: now,
    updated_at: now,
    completed_at: null,
    due_date: dueDate || null,
    archived: false,
    ...(blockedBy.length ? { blocked_by: [...blockedBy] } : {}),
    ...(blocks.length ? { blocks: [...blocks] } : {}),
  };

  ensureDir(paths.taskDir);
  atomicWriteSync(join(paths.taskDir, `${taskId}.json`), JSON.stringify(task));

  // Cycle-safe now: validation already passed, so symmetric-edge
  // maintenance is just mutating peer JSONs.
  for (const depId of blockedBy) addSymmetricEdge(paths, depId, 'blocks', taskId);
  for (const downId of blocks) addSymmetricEdge(paths, downId, 'blocked_by', taskId);

  appendTaskAudit(paths, taskId, { event: 'create', agent: agentName, to: 'pending', note: title });

  return taskId;
}

/**
 * Mutate an existing task to add an edge to its blocks/blocked_by list.
 * No-op if the peer id is already present. Used to maintain symmetric
 * edges when a new task declares its dependencies.
 */
function addSymmetricEdge(
  paths: BusPaths,
  taskId: string,
  field: 'blocks' | 'blocked_by',
  peerId: string,
): void {
  const filePath = findTaskFile(paths, taskId);
  if (!filePath) return; // Peer task missing — surfaced at resolution time.
  try {
    const task = JSON.parse(readFileSync(filePath, 'utf-8')) as Task;
    const list = task[field] ?? [];
    if (!list.includes(peerId)) {
      task[field] = [...list, peerId];
      atomicWriteSync(filePath, JSON.stringify(task));
    }
  } catch { /* best-effort */ }
}

/**
 * Walk the dependency DAG rooted at `newTaskId` depth-first along its
 * proposed `blocked_by` edges and throw if the walk re-enters
 * `newTaskId`. Only checks the `blocked_by` direction — cycles are
 * topologically symmetric, so walking one direction catches them all.
 *
 * `virtual` lets the caller describe a task that does not yet exist
 * on disk (the task being created). Without this, running the check
 * BEFORE the task JSON is written would miss cycles that pass
 * through the new task itself.
 */
function detectCycleOrThrow(
  paths: BusPaths,
  newTaskId: string,
  initialBlockers: string[],
  virtual?: { id: string; blocked_by: string[] },
): void {
  const seen = new Set<string>();
  const stack = [...initialBlockers];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === newTaskId) {
      throw new Error(`Dependency cycle: ${newTaskId} ultimately blocks itself via ${cur}`);
    }
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (virtual && cur === virtual.id) {
      if (virtual.blocked_by.length) stack.push(...virtual.blocked_by);
      continue;
    }
    const filePath = findTaskFile(paths, cur);
    if (!filePath) continue; // Missing peer is not a cycle, just a dangling ref.
    try {
      const task = JSON.parse(readFileSync(filePath, 'utf-8')) as Task;
      if (task.blocked_by?.length) stack.push(...task.blocked_by);
    } catch { /* skip */ }
  }
}

/**
 * Resolve blockers for `taskId`: returns the list of tasks in its
 * `blocked_by` that are NOT yet completed. Empty list = good to go.
 * A missing peer is reported as `{ id, status: 'missing' }` so callers
 * can distinguish "dependency cleared" from "dependency references a
 * task that no longer exists".
 */
export function checkTaskDependencies(
  paths: BusPaths,
  taskId: string,
): Array<{ id: string; status: TaskStatus | 'missing' }> {
  const filePath = findTaskFile(paths, taskId);
  if (!filePath) return [];
  let task: Task;
  try { task = JSON.parse(readFileSync(filePath, 'utf-8')) as Task; }
  catch { return []; }
  const deps = task.blocked_by ?? [];
  const open: Array<{ id: string; status: TaskStatus | 'missing' }> = [];
  for (const depId of deps) {
    const depPath = findTaskFile(paths, depId);
    if (!depPath) { open.push({ id: depId, status: 'missing' }); continue; }
    try {
      const dep = JSON.parse(readFileSync(depPath, 'utf-8')) as Task;
      if (dep.status !== 'completed') open.push({ id: depId, status: dep.status });
    } catch {
      open.push({ id: depId, status: 'missing' });
    }
  }
  return open;
}

/**
 * Find the on-disk path of a task file by ID, supporting cross-org lookup.
 *
 * cortextOS's standard dispatch pattern is an orchestrator in one org
 * filing tasks that get assigned to specialists in other orgs. Before
 * this helper existed, updateTask
 * and completeTask hardcoded `join(paths.taskDir, taskId + '.json')` — which
 * points at the CURRENT agent's org tasks dir — so the specialist could not
 * drive the lifecycle of any task that was filed from a sibling org. Every
 * cross-org assignment required a manual workaround dance where the filer
 * ran update/complete on behalf of the assignee.
 *
 * This helper fixes that by using a two-tier lookup:
 *
 *   1. Fast path: check the caller's OWN org tasks dir first. Most tasks
 *      live there and this check pays zero scan cost when it hits.
 *   2. Fallback: scan every sibling org under `<ctxRoot>/orgs/*` for a
 *      matching task file. Only runs when the fast path missed, so
 *      same-org operations take no perf hit.
 *
 * Task IDs are generated as `task_<epoch_ms>_<3digit_random>` so real
 * collisions are effectively impossible — but if the scan ever finds the
 * same ID in multiple orgs (e.g. due to a bug in ID generation or a manual
 * file copy), we warn loudly naming the task ID, the match count, AND the
 * org names so an operator can investigate without having to grep the IDs
 * themselves. We still return the first match and keep operations flowing;
 * erroring on a theoretical collision would be worse UX than the warn.
 *
 * Exported because the helper is a useful primitive for any future caller
 * that needs cross-org task lookup (e.g. a hypothetical `get-task` command,
 * task-graph visualization, or cross-org list-tasks flag).
 */
export function findTaskFile(paths: BusPaths, taskId: string): string | null {
  // Reject path-traversal task ids before they reach any join() below. This is
  // the chokepoint for updateTask/claimTask/completeTask/checkTaskDependencies.
  validateTaskId(taskId);
  // Fast path: same-org lookup.
  const sameOrg = join(paths.taskDir, `${taskId}.json`);
  if (existsSync(sameOrg)) return sameOrg;

  // Fallback: cross-org scan.
  const orgsRoot = join(paths.ctxRoot, 'orgs');
  const matches: Array<{ path: string; org: string }> = [];
  try {
    for (const entry of readdirSync(orgsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(orgsRoot, entry.name, 'tasks', `${taskId}.json`);
      if (existsSync(candidate)) {
        matches.push({ path: candidate, org: entry.name });
      }
    }
  } catch {
    return null; // orgs/ missing or unreadable
  }

  if (matches.length === 0) return null;
  if (matches.length > 1) {
    const orgList = matches.map((m) => m.org).join(', ');
    console.warn(
      `[task] Ambiguous task id ${taskId}: found in ${matches.length} orgs (${orgList}). ` +
      `Operating on the first match in org '${matches[0].org}'. ` +
      `Review task ID generation if this recurs.`,
    );
  }
  return matches[0].path;
}

/**
 * Update a task's status. Matches bash update-task.sh behavior, with the
 * cross-org fallback from findTaskFile so an assignee in one org can drive
 * the lifecycle of a task filed by an orchestrator in a sibling org.
 */
export function updateTask(
  paths: BusPaths,
  taskId: string,
  status: TaskStatus,
): void {
  const filePath = findTaskFile(paths, taskId);
  if (!filePath) {
    throw new Error(
      `Task ${taskId} not found in any org under ${paths.ctxRoot}/orgs/`,
    );
  }
  let prevStatus: TaskStatus | undefined;
  let assignee: string | undefined;
  try {
    const content = readFileSync(filePath, 'utf-8');
    const task: Task = JSON.parse(content);
    prevStatus = task.status;
    assignee = task.assigned_to;
    task.status = status;
    task.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    atomicWriteSync(filePath, JSON.stringify(task));
  } catch (err) {
    throw new Error(`Task ${taskId} update failed: ${err}`);
  }
  appendTaskAudit(paths, taskId, { event: 'update', agent: assignee || 'unknown', from: prevStatus, to: status });
}

/**
 * One audit entry written to a task's append-only JSONL log. Every
 * status transition, claim, and completion emits one of these so the
 * full lifecycle can be replayed from disk.
 */
/**
 * Append a dated, attributed note to a task WITHOUT touching its description.
 *
 * The gap this fills: no bus route could correct a task after creation, so
 * corrections lived in chat prose and were lost to anyone reading the task later.
 *
 * WHY THIS IS NOT `appendTaskAudit`. That log is documented as best-effort and
 * swallows its own write failures — correct for observability, wrong for a
 * correction. An annotation that silently vanishes is worse than no annotation:
 * the reader sees a task with no note and concludes there was nothing to say.
 * So this writes into the task record itself and THROWS on failure.
 *
 * `description` is never modified. A correction is a new fact about the task, not
 * a replacement for what was originally asked; keeping both is what lets a reader
 * see that the ask changed, and when, and who changed it.
 */
export function annotateTask(
  paths: BusPaths,
  taskId: string,
  text: string,
  agent: string,
): TaskAnnotation {
  validateTaskId(taskId);

  // Reject an empty note loudly rather than recording a blank one. A blank
  // annotation is indistinguishable from "someone looked and had nothing to add",
  // which is a claim this command has no business making on the writer's behalf.
  const body = (text ?? '').trim();
  if (!body) {
    throw new Error('annotate-task: note text is empty. Pass the note, or do not annotate.');
  }
  const who = (agent ?? '').trim();
  if (!who) {
    throw new Error('annotate-task: no agent identity. Set CTX_AGENT_NAME or pass --agent.');
  }

  // A missing task directory IS "not found" — it must not surface as a path-type error
  // from deeper in the stack. The caller asked whether this task exists; answer that
  // question, in the caller's vocabulary.
  let filePath: string | null = null;
  try {
    filePath = findTaskFile(paths, taskId);
  } catch {
    filePath = null;
  }
  if (!filePath) {
    throw new Error(`Task ${taskId} not found`);
  }

  const before = readFileSync(filePath, 'utf-8');
  const task: Task = JSON.parse(before);
  const descriptionBefore = task.description;

  const entry: TaskAnnotation = {
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    agent: who,
    text: body,
  };
  task.annotations = [...(task.annotations ?? []), entry];
  task.updated_at = entry.ts;

  // FUTURE-EDIT TRIPWIRE, not a runtime check — and the distinction is the point.
  //
  // As this function stands today the comparison CANNOT FAIL: nothing between the read above
  // and this line assigns `task.description`, so it compares a value with itself. Read as a
  // runtime guarantee it is decoration, and a check that cannot fail is not a check.
  //
  // It is kept, and kept deliberately, for the edit that has not happened yet: `description`
  // is a string, so `descriptionBefore` holds a COPY of the value, and any future line that
  // reassigns `task.description` between the read and the write fails loudly HERE rather than
  // silently overwriting what was originally asked. That is the invariant this command exists
  // to protect — a correction is a new fact about the task, never a replacement for the ask.
  //
  // Its limit, stated so nobody reads more into it: it catches REASSIGNMENT of the field. It
  // would not catch mutation of a nested object, and `description` is not one today. If that
  // ever changes, this line stops covering what its comment claims.
  if (task.description !== descriptionBefore) {
    throw new Error(`annotate-task: refusing to write — description changed for ${taskId}`);
  }

  atomicWriteSync(filePath, JSON.stringify(task));
  appendTaskAudit(paths, taskId, { event: 'update', agent: who, note: `annotated: ${body}` });
  return entry;
}

export interface TaskAuditEntry {
  ts: string; // ISO 8601
  event: 'create' | 'claim' | 'update' | 'complete';
  agent: string; // who caused the event
  from?: TaskStatus;
  to?: TaskStatus;
  note?: string;
}

/**
 * Append one audit line to `<taskDir>/audit/<taskId>.jsonl`. Uses
 * appendFileSync so concurrent writers each get O_APPEND semantics on
 * POSIX — partial interleaving at the sub-line level is possible on
 * some filesystems for lines over PIPE_BUF, but our entries are
 * ~200 bytes, comfortably under the 4096-byte atomicity bound.
 *
 * Best-effort: a failing audit write never blocks the caller. The
 * audit log is an observability aid, not the source of truth.
 */
export function appendTaskAudit(
  paths: BusPaths,
  taskId: string,
  entry: Omit<TaskAuditEntry, 'ts'>,
): void {
  // Validate before the try so a traversal id is rejected loudly rather than
  // swallowed by the audit-never-blocks catch below.
  validateTaskId(taskId);
  try {
    const auditDir = join(paths.taskDir, 'audit');
    ensureDir(auditDir);
    const line: TaskAuditEntry = {
      ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      ...entry,
    };
    appendFileSync(join(auditDir, `${taskId}.jsonl`), JSON.stringify(line) + '\n', { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // Never block a real operation on audit-log write failure.
  }
}

/**
 * Read all audit entries for a task in write-order. Returns empty
 * array if no audit log exists. Corrupt lines are skipped so a
 * partially-written line (rare: write crashed mid-line) does not
 * block history replay of surrounding entries.
 */
export function readTaskAudit(
  paths: BusPaths,
  taskId: string,
): TaskAuditEntry[] {
  return readTaskAuditDetailed(paths, taskId).entries;
}

/** One audit-log read, with the counts of what the read THREW AWAY. */
export interface TaskAuditRead {
  /** Lines that parsed AND were a usable entry object. */
  entries: TaskAuditEntry[];
  /**
   * Lines that were valid JSON but NOT a usable entry object — the literal
   * `null`, a bare number, a string, an array. THIS IS THE CRASH CLASS.
   */
  skipped_malformed: number;
  /** Lines that were not valid JSON at all (a write that crashed mid-line). */
  skipped_unparseable: number;
}

/**
 * Read a task's audit log, returning the usable entries AND how many lines were
 * discarded, by reason.
 *
 * WHY THE COUNTS EXIST. A filter that cannot say how much it excluded is
 * indistinguishable from one that excluded nothing — and this file already had
 * a filter with exactly that shape (`catch { /* skip corrupt *\/ }`). A silent
 * skip is only safe while nothing ever goes wrong, which is not a property any
 * log on disk has.
 *
 * WHY THE SHAPE CHECK EXISTS, and it is not defensive decoration.
 * `JSON.parse('null')` SUCCEEDS. So does `'[]'`, `'3'`, `'"x"'`. The previous
 * cast `JSON.parse(trimmed) as TaskAuditEntry` made the return type a LIE: one
 * line reading exactly `null` in one task's log put a `null` into a
 * `TaskAuditEntry[]`, and the first consumer to read `.from` or `.event` off it
 * threw. That crashed `checkStaleTasks` ENTIRELY — all five buckets, not just
 * the row with the bad line — and it would equally crash `bus task-history`
 * (`src/cli/bus.ts`, which reads `e.event.padEnd`). Handling syntactically
 * corrupt JSON does not cover valid JSON of the wrong shape; they are different
 * failures and only one of them was handled.
 */
export function readTaskAuditDetailed(
  paths: BusPaths,
  taskId: string,
): TaskAuditRead {
  validateTaskId(taskId);
  const path = join(paths.taskDir, 'audit', `${taskId}.jsonl`);
  if (!existsSync(path)) return { entries: [], skipped_malformed: 0, skipped_unparseable: 0 };
  const entries: TaskAuditEntry[] = [];
  let skippedMalformed = 0;
  let skippedUnparseable = 0;
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      skippedUnparseable++;
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      skippedMalformed++;
      continue;
    }
    entries.push(parsed as TaskAuditEntry);
  }
  return { entries, skipped_malformed: skippedMalformed, skipped_unparseable: skippedUnparseable };
}

/**
 * Atomically claim a task for an agent. Prevents two agents from double-
 * picking the same task — a race that previously could happen because
 * `update-task <id> in_progress` was a read-modify-write with no lock.
 *
 * Mechanism: write a companion claim-lock file via the POSIX O_EXCL
 * path (`writeFileSync` with `flag: 'wx'`). The first writer wins; the
 * second gets EEXIST and claimTask throws "already claimed by X". Only
 * after the lock is taken do we flip the task's status + assigned_to.
 *
 * Re-claiming a task you already own is idempotent (returns the task
 * without mutation). Claiming a non-pending task is rejected with a
 * message that names the current status so operators can diagnose.
 *
 * Claim-lock files live at `<taskDir>/.claims/<taskId>.claim` and carry
 * `<agent>\t<iso8601>` for audit. A later compaction pass can prune
 * claim-locks for completed tasks; for now they are append-only.
 */
export function claimTask(
  paths: BusPaths,
  taskId: string,
  agent: string,
): Task {
  const filePath = findTaskFile(paths, taskId);
  if (!filePath) {
    throw new Error(
      `Task ${taskId} not found in any org under ${paths.ctxRoot}/orgs/`,
    );
  }

  let task: Task;
  try {
    task = JSON.parse(readFileSync(filePath, 'utf-8')) as Task;
  } catch (err) {
    throw new Error(`Task ${taskId} claim failed (unreadable): ${err}`);
  }

  const claimsDir = join(paths.taskDir, '.claims');
  ensureDir(claimsDir);
  const claimPath = join(claimsDir, `${taskId}.claim`);
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  // Idempotency: if this agent already owns the claim, succeed silently.
  if (existsSync(claimPath)) {
    try {
      const owner = readFileSync(claimPath, 'utf-8').split('\t')[0];
      if (owner === agent) {
        return task;
      }
      throw new Error(
        `Task ${taskId} already claimed by ${owner} (current status=${task.status})`,
      );
    } catch (err) {
      if (err instanceof Error && err.message.startsWith(`Task ${taskId} already claimed`)) throw err;
      // Unreadable claim file — fall through and try the exclusive write.
    }
  }

  if (task.status !== 'pending') {
    throw new Error(
      `Task ${taskId} is not pending (status=${task.status}); cannot claim`,
    );
  }

  // Atomic: O_EXCL fails if the file exists, giving us true mutual
  // exclusion even under concurrent claims from two agents.
  try {
    writeFileSync(claimPath, `${agent}\t${now}\n`, { flag: 'wx', encoding: 'utf-8', mode: 0o600 });
  } catch (err) {
    // Someone else won the race — read the winner and surface it.
    let owner = 'unknown';
    try { owner = readFileSync(claimPath, 'utf-8').split('\t')[0]; } catch { /* stays 'unknown' */ }
    if (owner === agent) return task; // Benign race with self — treat as idempotent success.
    throw new Error(`Task ${taskId} already claimed by ${owner}`);
  }

  // Lock held — safe to mutate the task JSON.
  const prevStatus = task.status;
  task.status = 'in_progress';
  task.assigned_to = agent;
  task.updated_at = now;
  try {
    atomicWriteSync(filePath, JSON.stringify(task));
  } catch (err) {
    // Roll back the claim so a retry can succeed; we never want a ghost
    // lock surviving a write failure on the task JSON itself.
    try { unlinkSync(claimPath); } catch { /* best-effort */ }
    throw new Error(`Task ${taskId} claim commit failed: ${err}`);
  }
  appendTaskAudit(paths, taskId, { event: 'claim', agent, from: prevStatus, to: 'in_progress' });
  return task;
}

/**
 * Complete a task. Sets status to done, completed_at, and optional result.
 * Matches bash complete-task.sh behavior, with the cross-org fallback from
 * findTaskFile so an assignee in one org can complete a task filed by an
 * orchestrator in a sibling org.
 *
 * Side-effect: emits a `task/task_completed` event on the activity feed so
 * completions are visible on the dashboard without agents having to follow
 * every complete-task call with a separate log-event. The event is written
 * best-effort — a failing event write never unblocks task completion from
 * persisting to disk.
 */
export function completeTask(
  paths: BusPaths,
  taskId: string,
  result?: string,
): void {
  const filePath = findTaskFile(paths, taskId);
  if (!filePath) {
    throw new Error(
      `Task ${taskId} not found in any org under ${paths.ctxRoot}/orgs/`,
    );
  }
  let prevStatus: TaskStatus | undefined;
  let assignee: string | undefined;
  let taskOrg: string = '';
  try {
    const content = readFileSync(filePath, 'utf-8');
    const task: Task = JSON.parse(content);
    prevStatus = task.status;
    assignee = task.assigned_to;
    taskOrg = task.org || '';
    task.status = 'completed';
    task.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    task.completed_at = task.updated_at;
    if (result) {
      task.result = result;
    }
    atomicWriteSync(filePath, JSON.stringify(task));
  } catch (err) {
    throw new Error(`Task ${taskId} complete failed: ${err}`);
  }
  appendTaskAudit(paths, taskId, { event: 'complete', agent: assignee || 'unknown', from: prevStatus, to: 'completed', note: result });

  // Activity-feed event. Best-effort — the task is already persisted.
  if (assignee) {
    try {
      // Cross-org completion (caller's org ≠ task's org) is allowed via
      // findTaskFile, but the caller's `paths.analyticsDir` is scoped to
      // the caller's org. Rewrite the analytics path to the task's actual
      // org so dashboards/metrics see the completion under the right tree.
      // Only rewrite analyticsDir when the resolved task path is in the
      // nested cross-org layout: <ctxRoot>/orgs/<org>/tasks/<taskId>.json.
      // Flat/single-org test harnesses use <ctxRoot>/tasks + <ctxRoot>/analytics
      // and should keep the caller-provided analyticsDir unchanged.
      const pathOrgMatch = filePath.match(/[\\/]orgs[\\/](?<org>[^\\/]+)[\\/]tasks[\\/]/);
      const fileOrg = pathOrgMatch?.groups?.org || '';
      const eventPaths: BusPaths = fileOrg
        ? { ...paths, analyticsDir: join(paths.ctxRoot, 'orgs', fileOrg, 'analytics') }
        : paths;
      logEvent(eventPaths, assignee, taskOrg, 'task', 'task_completed', 'info', {
        task_id: taskId,
        ...(result ? { result } : {}),
      }, { refreshHeartbeat: true });
    } catch {
      // Never let observability break task completion.
    }
  }
}

/**
 * List tasks with optional filters.
 * Matches bash list-tasks.sh behavior.
 */
export function listTasks(
  paths: BusPaths,
  filters?: {
    agent?: string;
    status?: TaskStatus;
    priority?: Priority;
    project?: string;
    respectDeps?: boolean;
  },
): Task[] {
  const { taskDir } = paths;
  let files: string[];
  try {
    files = readdirSync(taskDir).filter(
      f => f.startsWith('task_') && f.endsWith('.json'),
    );
  } catch {
    return [];
  }

  const tasks: Task[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(taskDir, file), 'utf-8');
      const task: Task = JSON.parse(content);

      // Apply filters
      if (filters?.agent && task.assigned_to !== filters.agent) continue;
      if (filters?.status && task.status !== filters.status) continue;
      if (filters?.priority && task.priority !== filters.priority) continue;
      if (filters?.project && task.project !== filters.project) continue;
      if (task.archived) continue;

      tasks.push(task);
    } catch {
      // Skip corrupt files
    }
  }

  const sorted = tasks.sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  if (!filters?.respectDeps) return sorted;

  // DAG-aware ordering: unblocked tasks first, blocked ones after, with
  // the secondary order preserving created_at DESC within each bucket.
  // "Blocked" = any blocked_by entry resolves to non-completed.
  const byId = new Map<string, Task>();
  for (const t of sorted) byId.set(t.id, t);
  const isBlocked = (t: Task): boolean => {
    for (const depId of t.blocked_by ?? []) {
      const dep = byId.get(depId);
      // Out-of-list deps are checked on-disk via checkTaskDependencies,
      // but the list-view only considers in-list tasks for speed.
      if (!dep) continue;
      if (dep.status !== 'completed') return true;
    }
    return false;
  };
  const unblocked: Task[] = [];
  const blocked: Task[] = [];
  for (const t of sorted) (isBlocked(t) ? blocked : unblocked).push(t);
  return [...unblocked, ...blocked];
}

/**
 * Helper: read all task JSON files from a directory (non-recursive).
 */
function readAllTasks(taskDir: string): Task[] {
  let files: string[];
  try {
    files = readdirSync(taskDir).filter(
      f => f.startsWith('task_') && f.endsWith('.json'),
    );
  } catch {
    return [];
  }

  const tasks: Task[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(taskDir, file), 'utf-8');
      tasks.push(JSON.parse(content));
    } catch {
      // Skip corrupt files
    }
  }
  return tasks;
}

/**
 * Check for stale tasks. Matches bash check-stale-tasks.sh behavior.
 */
/**
 * Epoch seconds of the newest AUDIT TRANSITION for a task — the last moment
 * the task demonstrably CHANGED STATE — falling back to `created_at` when the
 * audit log holds no transition (or no log exists at all).
 *
 * WHY THIS EXISTS, and it is not a second opinion about `updated_at`.
 * `updated_at` moves on ANY write, including a write that does no work.
 * `annotateTask` is exactly that write: it appends a note and refreshes
 * `updated_at`, so a scheduled sweep that annotates every open task RESETS THE
 * CLOCK `checkStaleTasks` READS — including when the annotation's own text says
 * nothing happened. Measured 2026-09-08 across 727 task files: of the 10
 * `in_progress` tasks, the shipped check CLEARED 5, and all 5 were genuinely
 * idle 4.2h-20.9h. The false-clear rate on what it passes was 5 of 5.
 *
 * The failure is not degradation, it is INVERSION: the seats that annotate most
 * diligently look healthiest. `updated_at` is not merely silent about idleness,
 * it ASSERTS a recency that a no-op write manufactured.
 *
 * THE DISCRIMINATOR IS STRUCTURAL, NOT TEXTUAL. An annotation is written as
 * `{ event: 'update' }` with NO `from` and NO `to`; every genuine lifecycle
 * event (`create`, `claim`, status-changing `update`, `complete`) carries both.
 * So a transition can be told from a self-report mechanically, with no judgement
 * about what the note SAYS.
 *
 * A TEXT-CLASSIFYING PREDICATE WAS SPECIFIED FIRST AND MEASURED DEAD, and the
 * reason is worth keeping: "byte-identical annotation AND no resume condition"
 * flagged 0 of the 9 byte-identical groups on the live corpus, because all nine
 * DO state a resume condition ("resume only on a new Chief instruction",
 * "nothing further before 13:00Z brief"). Negative control: the same condition
 * regex fires on 150 of 249 annotations and not on 99, so it detects conditions
 * rather than English and that zero is real. There is no lexical line between a
 * keepalive and a substantive hold note. Do not reintroduce one.
 *
 * @returns epoch SECONDS. Never NaN: an unparseable `created_at` yields 0,
 *          which reads as maximally stale — this check must fail LOUD.
 */
export function lastTransitionEpoch(paths: BusPaths, task: Task): number {
  return lastTransition(paths, task).epoch;
}

/** What one `lastTransition` read found, and what it had to throw away to find it. */
export interface TransitionReadout {
  /** Epoch SECONDS of the newest valid PAST transition, else `created_at`, else 0. */
  epoch: number;
  /** Audit lines discarded as not-an-entry-object. See TaskAuditRead. */
  skipped_malformed: number;
  /** Audit lines discarded as not-valid-JSON. See TaskAuditRead. */
  skipped_unparseable: number;
  /** Transitions whose `ts` did not parse: cannot date the event, ignored and counted. */
  transitions_unparseable_ts: number;
  /** Transitions dated AFTER `nowEpoch`: cannot establish PRESENT activity, ignored and counted. */
  transitions_future: number;
  /** Transitions rejected because `from === to`: both ends written, nothing changed. */
  transitions_no_op: number;
  /** Transitions rejected because an endpoint was not a real `TaskStatus` (e.g. `null`). */
  transitions_invalid_endpoint: number;
}

/**
 * The full readout behind `lastTransitionEpoch`. Separate function so the
 * DIAGNOSTICS reach the report: every rejection below is a line this check
 * chose not to trust, and a check that cannot say what it ignored is
 * indistinguishable from one that ignored nothing.
 *
 * `nowEpoch` is a parameter rather than a `Date.now()` call so the future-dated
 * boundary is testable without moving the system clock.
 */
export function lastTransition(
  paths: BusPaths,
  task: Task,
  nowEpoch: number = Math.floor(Date.now() / 1000),
): TransitionReadout {
  const fallback = epochSecondsOrNull(task.created_at) ?? 0;
  const audit = readTaskAuditDetailed(paths, task.id);

  let newest = 0;
  let unparseableTs = 0;
  let future = 0;
  let noOp = 0;
  let invalidEndpoint = 0;

  for (const entry of audit.entries) {
    // Not a transition at all, and not malformed either: an annotation carries
    // NEITHER end, a `create` carries only `to`. Both are ordinary lines, so they
    // are skipped silently and NOT counted as rejections — a diagnostic that fires
    // on every healthy log tells a reader nothing.
    if (entry.from === undefined || entry.to === undefined) continue;

    // ⛔ FROM HERE THE LINE CLAIMS TO BE A TRANSITION, SO IT MUST BE A WELL-FORMED ONE:
    // both endpoints REAL STATUSES, and different. Presence was never the question.
    //
    // `{ from: null, to: 'in_progress' }` is the case that got through everything else:
    // it is a plain object, so the JSON-shape filter passes it; `null !== undefined`, so
    // the presence check passes it; `null !== 'in_progress'`, so the difference check
    // passes it — and a 9h-idle row was then CLEARED on a state change that never
    // happened. A LINE CAN BE MALFORMED DATA INSIDE A WELL-FORMED OBJECT, and every
    // guard written before this one asked about the container instead of the contents.
    if (!isTaskStatus(entry.from) || !isTaskStatus(entry.to)) {
      invalidEndpoint++;
      continue;
    }

    // ⛔ BOTH ENDS PRESENT IS NECESSARY AND NOT SUFFICIENT. A TRANSITION IS
    // `from !== to`. `updateTask` writes `{ from, to }` UNCONDITIONALLY without
    // checking that the status changed, so `update-task <id> in_progress` on a
    // task that is ALREADY `in_progress` emits both ends having moved nothing —
    // and the first version of this predicate counted that as activity. That
    // replaced "any write resets the clock" with "any STATUS write resets the
    // clock": the exact class this check exists to catch, reproduced inside the
    // fix for it, and worse for wearing a receipt.
    //
    // The repair is here, in the READER, not in `updateTask`. The writer's
    // no-op line is a separate question with its own blast radius (other
    // consumers of the audit log), and this predicate has to be correct
    // whatever the writer does.
    if (entry.from === entry.to) {
      noOp++;
      continue;
    }

    const epoch = epochSecondsOrNull(entry.ts);
    if (epoch === null) {
      unparseableTs++;
      continue;
    }
    // A FUTURE-DATED ENTRY CANNOT ESTABLISH PRESENT ACTIVITY. Ignore it and
    // keep the newest valid PAST transition — a clock problem announcing itself
    // must never read as "recently active".
    if (epoch > nowEpoch) {
      future++;
      continue;
    }
    if (epoch > newest) newest = epoch;
  }

  return {
    epoch: newest > 0 ? newest : fallback,
    skipped_malformed: audit.skipped_malformed,
    skipped_unparseable: audit.skipped_unparseable,
    transitions_unparseable_ts: unparseableTs,
    transitions_future: future,
    transitions_no_op: noOp,
    transitions_invalid_endpoint: invalidEndpoint,
  };
}

/**
 * Epoch SECONDS for an ISO timestamp, or `null` when it does not parse.
 *
 * NaN IS NOT A TIME. `new Date('nonsense').getTime()` is `NaN`, `NaN` survives
 * every arithmetic operation it enters, and then LOSES every comparison —
 * `NaN > 7200` is `false`. So an unparseable timestamp did not fail loudly: it
 * silently CLEARED the alarm and serialised as JSON `null` in the report. This
 * helper exists so the choice about malformed time is made ONCE, explicitly, by
 * every caller, instead of being made implicitly by IEEE-754.
 */
function epochSecondsOrNull(iso: string | undefined | null): number | null {
  if (typeof iso !== 'string') return null;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

export function checkStaleTasks(paths: BusPaths): StaleTaskReport {
  const nowEpoch = Math.floor(Date.now() / 1000);
  const STALE_IN_PROGRESS = 7200;   // 2 hours
  const STALE_PENDING = 86400;      // 24 hours
  const STALE_HUMAN = 86400;        // 24 hours
  // `blocked` is a legitimate state, so a blocked task alarms nothing and
  // nobody looks at it. 4 hours is deliberately tighter than the pending
  // threshold: a task blocked on an approval or another agent is waiting on
  // something that should move within a working session, and the whole point
  // of the bucket is to surface it while it is still actionable.
  const STALE_BLOCKED = 14400;      // 4 hours

  const report: StaleTaskReport = {
    stale_in_progress: [],
    stale_pending: [],
    stale_blocked: [],
    stale_human: [],
    overdue: [],
    idle_ages: [],
  };

  const tasks = readAllTasks(paths.taskDir);

  for (const task of tasks) {
    // Skip completed/done tasks
    if (task.status === 'completed' || task.status === 'cancelled') continue;

    // ⛔ AN UNPARSEABLE TIMESTAMP READS AS MAXIMALLY STALE, NEVER AS FRESH.
    //
    // `new Date('invalid-date').getTime()` is NaN; `nowEpoch - NaN` is NaN; and
    // `NaN > STALE_IN_PROGRESS` is FALSE. So malformed time did not fail loudly
    // here, it CLEARED the row — and `clock_age_seconds` then serialised as JSON
    // `null`, which reads to a consumer like "no age" rather than "bad data".
    // This bucket exists to catch tasks nobody is looking at; a task whose own
    // timestamps are corrupt is the last one that should be waved through.
    //
    // The sentinel is `nowEpoch` itself — the age of a task stamped at the UNIX
    // epoch. It is a real number (so no consumer sees `null`), it is maximally
    // stale (so every threshold in this function fires), and `clock_malformed`
    // on the report row says WHY without a reader having to recognise the value.
    //
    // Applied to BOTH clocks, and this is wider than the `in_progress` bucket on
    // purpose: `age` also drives `stale_blocked` and `createdAge` drives
    // `stale_pending`/`stale_human`, all of which were silently cleared by the
    // same NaN. It can only ever ADD rows.
    const updatedEpoch = epochSecondsOrNull(task.updated_at);
    const createdEpoch = epochSecondsOrNull(task.created_at);
    const clockMalformed = updatedEpoch === null;
    const rawAge = updatedEpoch === null ? nowEpoch : nowEpoch - updatedEpoch;
    // A FUTURE `updated_at` GIVES A NEGATIVE AGE. Clamped at 0 so both clocks obey the
    // same no-negative-age contract the type declares, and FLAGGED, because the clamp
    // points the reassuring way: 0 reads as "just written". For `in_progress` that is
    // covered — the idle clock is the other half of `max()` and still decides. For
    // `blocked`, `pending` and `human` there is no second clock, so a future `updated_at`
    // clears those rows; it already did that at -10800, and the clamp changes the number
    // rather than the outcome. Flagged rather than widened into those buckets here.
    const clockFuture = rawAge < 0;
    const age = clockFuture ? 0 : rawAge;
    const createdAge = createdEpoch === null ? nowEpoch : Math.max(0, nowEpoch - createdEpoch);

    // Stale in_progress: alarm on MAX(clock, true idle).
    //
    // `age` (from updated_at) is the CLOCK. `idleAge` (from the newest audit
    // TRANSITION) is how long the task has not actually moved. They differ
    // exactly when a no-op write refreshed updated_at, which is the defect
    // this bucket was silently losing rows to — see lastTransitionEpoch.
    //
    // MAX, not replace: the clock is still the right answer whenever it is the
    // larger of the two (a task whose audit log is missing or lost a write
    // still alarms on its clock), and taking the max means this change can only
    // ever ADD rows to the bucket, never remove one the shipped check caught.
    // That direction is deliberate and is what makes it safe to ship.
    if (task.status === 'in_progress') {
      const transition = lastTransition(paths, task, nowEpoch);
      const rawIdle = nowEpoch - transition.epoch;
      // A NEGATIVE IDLE AGE IS A CLOCK PROBLEM, NOT RECENT ACTIVITY. Future-dated
      // audit entries are already ignored inside lastTransition; this clamp
      // covers the remaining route — a future-dated `created_at` reached through
      // the fallback. Clamped AND reported: a silent clamp would turn one broken
      // timestamp into a row that merely looks fresh.
      const idleClamped = rawIdle < 0;
      const idleAge = idleClamped ? 0 : rawIdle;
      // Both ages are reported for EVERY in_progress task, not only stale ones:
      // a reader has to be able to see the two clocks disagree while the row is
      // still being cleared, which is precisely the case that was invisible.
      // The diagnostic counts ride along for the same reason — every one of them
      // is a line this check decided not to trust, and a row that alarms because
      // its audit log is unreadable must not look like a row that alarms because
      // the work stopped.
      report.idle_ages.push({
        task_id: task.id,
        clock_age_seconds: age,
        true_idle_seconds: idleAge,
        clock_malformed: clockMalformed,
        clock_future: clockFuture,
        idle_clamped: idleClamped,
        audit_lines_malformed: transition.skipped_malformed,
        audit_lines_unparseable: transition.skipped_unparseable,
        audit_transitions_unparseable_ts: transition.transitions_unparseable_ts,
        audit_transitions_future: transition.transitions_future,
        audit_transitions_no_op: transition.transitions_no_op,
        audit_transitions_invalid_endpoint: transition.transitions_invalid_endpoint,
      });
      if (Math.max(age, idleAge) > STALE_IN_PROGRESS) {
        report.stale_in_progress.push(task);
      }
    }

    // Stale pending: created_at > 24 hours ago
    if (task.status === 'pending' && createdAge > STALE_PENDING) {
      report.stale_pending.push(task);
    }

    // Stale blocked: updated_at > 4 hours ago. Uses updated_at (not created_at)
    // so the clock measures how long it has sat blocked, not how old the task
    // is — a task blocked five minutes ago is not stale just because it was
    // created last week.
    if (task.status === 'blocked' && age > STALE_BLOCKED) {
      report.stale_blocked.push(task);
    }

    // Human tasks: assigned to "human" or "user", or in human-tasks project
    if (
      (['human', 'user'].includes(task.assigned_to ?? '') ||
        task.project === 'human-tasks') &&
      createdAge > STALE_HUMAN
    ) {
      report.stale_human.push(task);
    }

    // Overdue: has due_date and it's in the past
    if (task.due_date) {
      const dueEpoch = Math.floor(new Date(task.due_date).getTime() / 1000);
      if (dueEpoch > 0 && nowEpoch > dueEpoch) {
        report.overdue.push(task);
      }
    }
  }

  return report;
}

/**
 * Archive completed tasks older than 7 days. Matches bash archive-tasks.sh behavior.
 */
export function archiveTasks(paths: BusPaths, dryRun: boolean = false): ArchiveReport {
  const nowEpoch = Math.floor(Date.now() / 1000);
  const ARCHIVE_AGE = 604800; // 7 days

  let archived = 0;
  let skipped = 0;

  const tasks = readAllTasks(paths.taskDir);

  for (const task of tasks) {
    // Only archive completed tasks
    if (task.status !== 'completed') continue;

    if (!task.completed_at) {
      skipped++;
      continue;
    }

    const completedEpoch = Math.floor(new Date(task.completed_at).getTime() / 1000);
    const age = nowEpoch - completedEpoch;

    if (age > ARCHIVE_AGE) {
      // task.id comes from the file's JSON body and is used to build the
      // rename source/dest below; a tampered id must not escape the task tree.
      try { validateTaskId(task.id); } catch { skipped++; continue; }
      if (!dryRun) {
        const archiveDir = join(paths.taskDir, 'archive');
        ensureDir(archiveDir);

        // Mark as archived
        task.archived = true;
        const srcPath = join(paths.taskDir, `${task.id}.json`);
        atomicWriteSync(srcPath, JSON.stringify(task));

        // Move to archive
        renameSync(srcPath, join(archiveDir, `${task.id}.json`));
      }
      archived++;
    }
  }

  return { archived, skipped, dry_run: dryRun };
}

/**
 * Semantic compaction of old completed tasks (beads-inspired). Each
 * eligible task becomes a one-line summary entry in a monthly
 * `archive-YYYY-MM.jsonl` file (bucketed by the task's completed_at
 * month), and the active task JSON is removed to keep the task board
 * small. The audit log (audit/<id>.jsonl) is intentionally preserved
 * so full lifecycle history survives compaction.
 *
 * Guards (a task is SKIPPED if any of the following holds):
 *   - status !== 'completed'
 *   - completed_at missing OR completed_at within the cutoff window
 *   - the task is still listed in some OTHER task's `blocked_by` where
 *     that other task is not yet completed (compaction must not
 *     orphan dependency references for unresolved dependents)
 *
 * No LLM calls. The "summary" is just title + result + key metadata;
 * callers supply clean result strings via `complete-task --result`.
 *
 * Idempotent: running twice over the same data does nothing the
 * second time because eligible tasks have already been removed.
 */
export interface CompactTasksReport {
  archived: Array<{ id: string; archive_file: string }>;
  skipped: Array<{ id: string; reason: string }>;
  dry_run: boolean;
}

export function compactTasks(
  paths: BusPaths,
  options: { olderThanDays?: number; dryRun?: boolean } = {},
): CompactTasksReport {
  const { olderThanDays = 30, dryRun = false } = options;
  const report: CompactTasksReport = { archived: [], skipped: [], dry_run: dryRun };
  const cutoffMs = Date.now() - olderThanDays * 86400_000;

  const { taskDir } = paths;
  let files: string[];
  try {
    files = readdirSync(taskDir).filter(f => f.startsWith('task_') && f.endsWith('.json'));
  } catch {
    return report;
  }

  // First pass: load every task so we can check cross-task dependency
  // references without re-reading files per candidate.
  const tasks: Task[] = [];
  for (const f of files) {
    try { tasks.push(JSON.parse(readFileSync(join(taskDir, f), 'utf-8')) as Task); }
    catch { /* skip corrupt */ }
  }

  // Build a "still-needed" set: the TRANSITIVE blocker closure of
  // every open task. A completed blocker must survive compaction as
  // long as ANY open task has it in its blocked_by chain — not just
  // direct parents. With A <- B <- C and C open, the direct-only
  // guard preserved B but archived A, leaving B with a dangling
  // reference to an archived task. Phase 4 directive was
  // "still in the blocked_by chain of a pending task" — the
  // full-chain reading is the correct one.
  const byId = new Map<string, Task>();
  for (const t of tasks) byId.set(t.id, t);
  const stillNeededAsBlocker = new Set<string>();
  const stack: string[] = [];
  for (const t of tasks) {
    if (t.status === 'completed') continue;
    for (const blockerId of t.blocked_by ?? []) stack.push(blockerId);
  }
  while (stack.length) {
    const cur = stack.pop()!;
    if (stillNeededAsBlocker.has(cur)) continue;
    stillNeededAsBlocker.add(cur);
    const parent = byId.get(cur);
    if (parent?.blocked_by?.length) stack.push(...parent.blocked_by);
  }

  for (const task of tasks) {
    if (task.status !== 'completed') continue;
    if (!task.completed_at) { report.skipped.push({ id: task.id, reason: 'no completed_at timestamp' }); continue; }
    const completedMs = new Date(task.completed_at).getTime();
    if (isNaN(completedMs) || completedMs > cutoffMs) {
      report.skipped.push({ id: task.id, reason: 'completed_at within cutoff' });
      continue;
    }
    if (stillNeededAsBlocker.has(task.id)) {
      report.skipped.push({ id: task.id, reason: 'still referenced by an open task\'s blocked_by chain' });
      continue;
    }

    // task.id (from the file's JSON body) is used to unlink the source file
    // below; a tampered id must not delete a file outside the task tree.
    try { validateTaskId(task.id); } catch { report.skipped.push({ id: String(task.id), reason: 'invalid task id (path-traversal guard)' }); continue; }

    const yyyymm = task.completed_at.substring(0, 7); // YYYY-MM
    // completed_at is from the JSON body and feeds the archive filename below;
    // reject anything that isn't a literal YYYY-MM so a tampered timestamp can't
    // traverse out of the task tree via the archive path.
    if (!/^\d{4}-\d{2}$/.test(yyyymm)) {
      report.skipped.push({ id: String(task.id), reason: 'invalid completed_at (path-traversal guard)' });
      continue;
    }
    const archiveFile = `archive-${yyyymm}.jsonl`;
    const archivePath = join(taskDir, archiveFile);
    const entry = {
      id: task.id,
      title: task.title,
      org: task.org,
      assigned_to: task.assigned_to,
      completed_at: task.completed_at,
      archived_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      result: task.result ?? '',
    };

    if (!dryRun) {
      try {
        appendFileSync(archivePath, JSON.stringify(entry) + '\n', { encoding: 'utf-8', mode: 0o600 });
        unlinkSync(join(taskDir, `${task.id}.json`));
      } catch (err) {
        report.skipped.push({ id: task.id, reason: `archive write failed: ${err}` });
        continue;
      }
    }
    report.archived.push({ id: task.id, archive_file: archiveFile });
  }

  return report;
}

/**
 * Find stale human-assigned tasks. Matches bash check-human-tasks.sh behavior.
 */
export function checkHumanTasks(paths: BusPaths): Task[] {
  const nowEpoch = Math.floor(Date.now() / 1000);
  const STALE_THRESHOLD = 86400; // 24 hours

  const tasks = readAllTasks(paths.taskDir);
  const result: Task[] = [];

  for (const task of tasks) {
    if (task.status === 'completed' || task.status === 'cancelled') continue;
    if (task.assigned_to !== 'human' && task.assigned_to !== 'user') continue;

    const createdEpoch = Math.floor(new Date(task.created_at).getTime() / 1000);
    const age = nowEpoch - createdEpoch;

    if (age > STALE_THRESHOLD) {
      result.push(task);
    }
  }

  return result;
}
