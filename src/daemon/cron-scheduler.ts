/**
 * cron-scheduler.ts — Daemon Cron Scheduling Engine (Subtask 1.3).
 *
 * The CronScheduler class is instantiated once by the daemon and ticks every
 * 30 seconds.  On each tick it checks which external crons are due and calls
 * the caller-supplied `onFire` callback for each one.
 *
 * CATCH-UP POLICY
 * ---------------
 * If the daemon was stopped and a cron's computed nextFireAt is in the past
 * on start(), we fire ONCE for the most recent missed window, then advance
 * nextFireAt to the next future slot.  We deliberately do not flood-fire all
 * missed windows — one catch-up is enough to inform the agent that time has
 * passed, and the agent can decide whether further action is needed.
 *
 * RETRY POLICY
 * ------------
 * 3 attempts with exponential backoff (1s → 4s → 16s).  If all 3 fail the
 * error is logged and the scheduler moves on — it does NOT crash.
 *
 * RELOAD SEMANTICS
 * ----------------
 * reload() re-reads crons.json.  For crons whose name + schedule + fire_at are
 * unchanged the in-memory nextFireAt is preserved so we don't reset timers.
 * New or modified crons get a freshly computed nextFireAt.
 */

import { homedir } from 'os';
import { join } from 'path';
import { parseDurationMs, readCronState, nextFireFromCron, computeNextFireMs } from '../bus/cron-state.js';
import { readCronsWithStatus, updateCron, cronsFileMtimeMs } from '../bus/crons.js';
import type { CronDefinition } from '../types/index.js';
import { appendExecutionLog } from './cron-execution-log.js';

// ---------------------------------------------------------------------------
// Cron expression parser — MOVED to src/bus/cron-state.ts (2026-09-04).
//
// WHY IT MOVED (guard's ride-along on PR #5): cron-health.ts needs to answer
// "can this schedule be parsed at all?" for itself instead of trusting a
// nextFire string handed to it by its caller. cron-health is a pure module and
// must not import the daemon, so the parser now lives beside parseDurationMs in
// cron-state.ts and BOTH the scheduler and the health checker use that one copy.
//
// Re-exported here so every existing importer of
// `nextFireFromCron` from './cron-scheduler.js' keeps working unchanged.
// ---------------------------------------------------------------------------

export { nextFireFromCron };

// ---------------------------------------------------------------------------
// Internal scheduler state for a single cron
// ---------------------------------------------------------------------------

interface ScheduledCron {
  definition: CronDefinition;
  /** Epoch ms when this cron should next fire. */
  nextFireAt: number;
  /** Normalised key for detecting definition changes: name|schedule|fire_at */
  changeKey: string;
  /**
   * The scheduled slot the next fire will SERVE. Identical to `nextFireAt` except
   * after a catch-up, where `nextFireAt` is pulled forward to `now` so the missed
   * window fires promptly while this still names the slot that was missed.
   */
  dueSlotAt?: number;
  /** True while onFire (+ retries) is executing — prevents re-entry on the next tick. */
  firing?: boolean;
}

/**
 * Schedule identity for reload().  A cron whose key is unchanged keeps its
 * in-memory nextFireAt so a prompt-only edit does not reset a running timer.
 *
 * ⛔ `fire_at` IS PART OF THE IDENTITY. It was omitted, and the omission was
 * invisible because `schedule` is present and looks like the whole answer:
 * editing ONLY fire_at left the key identical, so reload() classified the cron
 * as unchanged and KEPT THE OLD DUE EPOCH. The new definition object was swapped
 * in — so the callback would receive the new prompt — at the OLD time. Adding
 * the field also covers the recurring↔one-shot transitions, since fire_at
 * appearing or disappearing changes the key in both directions.
 */
function changeKeyFor(c: CronDefinition): string {
  return `${c.name}|${c.schedule}|${c.fire_at ?? ''}`;
}

/**
 * Compute the next fire time for a cron definition.
 *
 * For interval shorthands ("6h", "30m") we count forward from the
 * reference time.  For cron expressions we call nextFireFromCron().
 *
 * @param cron        - The cron definition.
 * @param referenceMs - Epoch ms to count forward from (usually now or lastFiredAt).
 */
function computeNextFireAt(
  cron: CronDefinition,
  referenceMs: number,
  opts?: {
    /** "Now", for deciding which slots are already past. Defaults to `referenceMs`. */
    nowMs?: number;
    /** Skip slots already past and land on the first future one. Defaults to false. */
    skipMissed?: boolean;
  },
): number {
  // ONE-SHOT: a cron carrying `fire_at` fires exactly once, at or after that
  // absolute instant, and never again. `referenceMs` is deliberately ignored —
  // for a recurring cron the next slot is relative to the last fire, but a
  // one-shot's time is an absolute point, not an offset from anything.
  //
  // NEVER-RE-FIRE IS A PERSISTENCE PROPERTY, NOT AN IN-MEMORY ONE. The fired
  // state is read back from the same fields the scheduler writes to crons.json
  // (`fire_count` / `last_fired_at`), so it survives a daemon restart. A
  // one-shot that fired only in memory would re-fire on the next boot, and the
  // past-due-at-boot case is exactly where that would happen unnoticed.
  //
  // `last_fire_attempted_at` COUNTS AS FIRED for a one-shot, deliberately. It is
  // written before the dispatch is awaited, so its presence without
  // `last_fired_at` means the daemon died mid-fire and the dispatch may well have
  // landed. The asymmetry decides it: re-running a one-shot action is worse than
  // missing an ambiguous one, and this is the same stance the recurring path
  // already takes when it uses that field to avoid double-firing after a crash.
  if (cron.fire_at) {
    const at = Date.parse(cron.fire_at);
    if (isNaN(at)) return NaN; // caller warns and skips, same as an unparseable schedule
    const alreadyFired =
      (cron.fire_count ?? 0) > 0 ||
      Boolean(cron.last_fired_at) ||
      Boolean(cron.last_fire_attempted_at);
    return alreadyFired ? Number.POSITIVE_INFINITY : at;
  }

  // ONE COMPUTATION, shared with the CLI and the daemon's ipc surface. See
  // `computeNextFireMs` in cron-state.ts for why there is only one now.
  return computeNextFireMs({
    schedule: cron.schedule,
    referenceMs,
    // Defaults chosen so every EXISTING caller behaves exactly as before: with
    // `nowMs === referenceMs` and `skipMissed` off, this returns the very next
    // slot after the reference even if it is already past — which the load
    // path's catch-up policy depends on.
    nowMs: opts?.nowMs ?? referenceMs,
    skipMissed: opts?.skipMissed ?? false,
  });
}

/**
 * The latest slot that has been ACCOUNTED FOR — served, or deliberately skipped.
 *
 * ⭐ THIS IS THE FIELD'S WHOLE CONTRACT, and getting it wrong is what guard's R2
 * caught: `computeNextFireAt(def, last_slot_at)` must reproduce EXACTLY the
 * `nextFireAt` the running scheduler holds. Persisting "the slot this fire served"
 * did not satisfy that. After a multi-slot catch-up the in-memory advance jumps
 * every missed interval (`skipMissed`) while the persisted slot named the OLDEST
 * one, so a restart — and the IPC and CLI displays — advanced a single interval
 * from a slot the live scheduler had already skipped past. Sleep 12:00 -> 18:30
 * gave scheduler 19:00, display 14:00, and a restart re-dispatching at 18:31.
 *
 * ⇒ Derive it BACKWARDS FROM THE NEXT FIRE, so the persisted state and the
 * in-memory policy cannot describe different worlds. For a cron expression there
 * is no interval to subtract and no phase to drift, so the served slot is exact.
 */
function accountedSlotIso(
  cron: CronDefinition,
  nextFireMs: number,
  dueAtMs: number,
): string | undefined {
  const durationMs = parseDurationMs(cron.schedule);
  if (!isNaN(durationMs) && Number.isFinite(nextFireMs)) {
    return new Date(nextFireMs - durationMs).toISOString();
  }
  return Number.isFinite(dueAtMs) ? new Date(dueAtMs).toISOString() : undefined;
}

// ---------------------------------------------------------------------------
// Retry helper
// ---------------------------------------------------------------------------

const RETRY_DELAYS_MS = [1_000, 4_000, 16_000];

async function fireWithRetry(
  cron: CronDefinition,
  agentName: string,
  onFire: (c: CronDefinition) => Promise<void> | void,
  logger: (msg: string) => void,
  /**
   * The instant this fire was DUE, threaded down purely so the execution log can
   * record it beside `ts`. Undefined only if the caller could not name a finite
   * due instant; the field is then omitted rather than guessed.
   */
  dueAtIso?: string,
): Promise<boolean> {
  const maxAttempts = RETRY_DELAYS_MS.length + 1; // 4 attempts total
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const start = Date.now();
    try {
      await Promise.resolve(onFire(cron));
      appendExecutionLog(agentName, {
        ts: new Date().toISOString(),
        due_at: dueAtIso,
        cron: cron.name,
        status: 'fired',
        attempt: attempt + 1,
        duration_ms: Date.now() - start,
        error: null,
      });
      return true;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const duration_ms = Date.now() - start;
      if (attempt < RETRY_DELAYS_MS.length) {
        const delay = RETRY_DELAYS_MS[attempt];
        logger(
          `[cron-scheduler] onFire failed for "${cron.name}" ` +
          `(attempt ${attempt + 1}/4, retrying in ${delay}ms): ${errMsg}`
        );
        appendExecutionLog(agentName, {
          ts: new Date().toISOString(),
          due_at: dueAtIso,
          cron: cron.name,
          status: 'retried',
          attempt: attempt + 1,
          duration_ms,
          error: errMsg,
        });
        await sleep(delay);
      } else {
        logger(
          `[cron-scheduler] onFire failed for "${cron.name}" ` +
          `after all 4 attempts — giving up. Last error: ${errMsg}`
        );
        appendExecutionLog(agentName, {
          ts: new Date().toISOString(),
          due_at: dueAtIso,
          cron: cron.name,
          status: 'failed',
          attempt: attempt + 1,
          duration_ms,
          error: errMsg,
        });
      }
    }
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// CronScheduler
// ---------------------------------------------------------------------------

export interface CronSchedulerOptions {
  agentName: string;
  onFire: (cron: CronDefinition) => Promise<void> | void;
  logger?: (msg: string) => void;
}

export class CronScheduler {
  private readonly agentName: string;
  private readonly onFire: (cron: CronDefinition) => Promise<void> | void;
  private readonly logger: (msg: string) => void;

  /** In-memory schedule, keyed by cron name. */
  private scheduled: Map<string, ScheduledCron> = new Map();

  /**
   * Snapshot of the last successfully loaded non-empty schedule.
   *
   * Updated every time `loadCrons()` produces a non-empty result.  When a
   * subsequent reload produces an empty result (e.g. transient corruption),
   * the scheduler keeps firing the last-good schedule and logs a warning
   * instead of silently dropping all cron definitions.
   *
   * This snapshot is only held in memory — it does NOT persist across process
   * restarts (see PHASE5-FAILURE-MODES-REPORT.md for design rationale).
   */
  private lastGoodSchedule: Map<string, ScheduledCron> = new Map();

  /**
   * mtime (ms) of crons.json at the moment loadCrons() last read it.  The tick
   * loop compares the live file mtime against this to detect durable edits that
   * arrived without an explicit IPC reload signal, and reloads within one tick.
   */
  private lastLoadedCronsMtimeMs: number | null = null;

  /** The master 30-second interval handle. */
  private tickHandle: ReturnType<typeof setInterval> | null = null;

  /** Epoch ms of the tick interval, exposed so tests can override. */
  static readonly TICK_INTERVAL_MS = 30_000;

  constructor(opts: CronSchedulerOptions) {
    this.agentName = opts.agentName;
    this.onFire    = opts.onFire;
    this.logger    = opts.logger ?? ((msg: string) => process.stdout.write(msg + '\n'));
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Start the scheduler.  Reads crons.json, builds in-memory schedule, and
   * begins the master tick loop.
   */
  start(): void {
    if (this.tickHandle !== null) {
      this.logger('[cron-scheduler] start() called while already running — ignored');
      return;
    }
    this.loadCrons(/* isReload */ false);
    this.tickHandle = setInterval(() => void this.tick(), CronScheduler.TICK_INTERVAL_MS);
    this.logger(`[cron-scheduler] started for agent "${this.agentName}" with ${this.scheduled.size} cron(s)`);
  }

  /**
   * Stop the scheduler and clear all timers.
   */
  stop(): void {
    if (this.tickHandle !== null) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    this.scheduled.clear();
    this.logger(`[cron-scheduler] stopped for agent "${this.agentName}"`);
  }

  /**
   * Re-read crons.json and update the in-memory schedule.
   *
   * Crons whose name + schedule + fire_at are unchanged retain their current nextFireAt
   * so we don't accidentally reset pending timers.  New or modified crons get
   * a freshly computed nextFireAt.
   */
  reload(): void {
    this.loadCrons(/* isReload */ true);
    this.logger(`[cron-scheduler] reloaded for agent "${this.agentName}" — ${this.scheduled.size} cron(s) active`);
  }

  /**
   * Return the next fire time for every scheduled cron (for CLI/debugging).
   */
  getNextFireTimes(): Array<{ name: string; nextFireAt: number }> {
    return [...this.scheduled.values()].map(sc => ({
      name: sc.definition.name,
      nextFireAt: sc.nextFireAt,
    }));
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private loadCrons(isReload: boolean): void {
    const now = Date.now();
    // Capture the file mtime BEFORE reading its contents.  If a write lands
    // between this stat and the read below, we store the OLDER mtime and read
    // the NEWER content, so the next tick harmlessly re-reloads rather than
    // missing the edit — we deliberately err toward an extra reload, never a
    // missed edit.  This single assignment keeps the tracked mtime in sync for
    // every caller: start(), reload() (IPC path), and the tick mtime-guard.
    this.lastLoadedCronsMtimeMs = cronsFileMtimeMs(this.agentName);
    const { crons: defs, corrupt } = readCronsWithStatus(this.agentName);
    const nextScheduled = new Map<string, ScheduledCron>();

    // Read cron-state.json so catch-up sees fires recorded by `bus update-cron-fire`
    // (e.g. agent heartbeat skills). Without this, a cron that pre-dates the
    // external-cron migration shows last_fire only in cron-state.json — the
    // scheduler would otherwise compute referenceMs=now and skip catch-up,
    // silently dropping the overdue fire.
    //
    // Resolve stateDir from CTX_ROOT so test sandboxes (which override CTX_ROOT
    // but not homedir) don't accidentally read production state.
    const ctxRoot = process.env.CTX_ROOT ||
      join(homedir(), '.cortextos', process.env.CTX_INSTANCE_ID || 'default');
    const stateDir = join(ctxRoot, 'state', this.agentName);
    let stateLastFireByName = new Map<string, string>();
    try {
      const stateFile = readCronState(stateDir);
      for (const rec of stateFile.crons) stateLastFireByName.set(rec.name, rec.last_fire);
    } catch {
      // Malformed file / missing dir — fall back to crons.json only
    }

    for (const def of defs) {
      if (!def.enabled) {
        // Disabled — silently skip
        continue;
      }

      const key = changeKeyFor(def);
      const existing = this.scheduled.get(def.name);

      // RELOAD-WHILE-FIRING GUARD: if the cron is mid-fire, preserve the
      // existing entry AS-IS (same object reference) until the fire completes.
      // A fresh ScheduledCron built from stale crons.json (last_fired_at not yet
      // persisted) would catch-up-fire on the next tick and double-fire the same
      // logical event.  The next reload (manual or after fire completes) will
      // pick up the new schedule cleanly.
      //
      // This MUST be checked BEFORE the changeKey-unchanged branch below.  That
      // branch stores a SHALLOW COPY (`{ ...existing }`) to swap in the new
      // definition object; for a firing cron the copy would orphan the object
      // tick() holds — the copy freezes firing=true and the stale nextFireAt,
      // while the in-flight fire's post-success advances the now-detached
      // original.  Result: nextFireAt is never updated in the live map and the
      // cron is stuck firing=true forever.  Ordering the firing guard first
      // keeps the SAME reference so the completing fire advances the live entry.
      // (Only exposed once the tick loop can reload mid-fire on an mtime change;
      // pre-existing latent hazard on the reload-while-unchanged path.)
      if (isReload && existing !== undefined && existing.firing === true) {
        this.logger(
          `[cron-scheduler] reload deferred for "${def.name}" — fire in progress; ` +
          `new schedule will apply on next reload after fire completes`
        );
        nextScheduled.set(def.name, existing);
        continue;
      }

      if (isReload && existing !== undefined && existing.changeKey === key) {
        // Definition unchanged (and not firing) — preserve nextFireAt while
        // swapping in the new definition object so prompt-only edits apply.
        nextScheduled.set(def.name, { ...existing, definition: def });
        continue;
      }

      // New or modified cron — compute fresh nextFireAt.
      // Base: take the most recent of crons.json.last_fired_at,
      // crons.json.last_fire_attempted_at (set pre-onFire to detect crash
      // mid-fire — iter 11), and cron-state.json.last_fire (either may be
      // more current depending on which write path recorded the fire).
      // Fall back to now.
      const stateFire = stateLastFireByName.get(def.name);
      const candidates: number[] = [];
      if (def.last_fired_at) candidates.push(new Date(def.last_fired_at).getTime());
      if (def.last_fire_attempted_at) candidates.push(new Date(def.last_fire_attempted_at).getTime());
      if (stateFire) candidates.push(new Date(stateFire).getTime());

      // ⛔ THE PHASE ANCHOR IS THE PERSISTED SLOT, NOT THE ACTUAL FIRE.
      // The candidates above are ACTUAL fire instants, `Math.max`ed so a crash
      // mid-fire cannot re-fire a slot already served. That remains their job — but
      // as a PHASE anchor they are wrong: a 15m30s-late fire persisted as
      // `last_fired_at` moved the next slot forward by 15m30s at the next restart,
      // so the in-memory phase fix died at every stop/start.
      // (guard, PR41: "restart preserves the restored phase".)
      //
      // `last_slot_at` is the slot that fire SERVED, so `slot + interval` is on
      // phase by construction. The crash guard is not weakened — the next slot is
      // strictly after the one just served, so an attempted-but-unconfirmed fire
      // for that slot is still never repeated.
      //
      // Absent on legacy crons.json: those fall back to the old behaviour exactly.
      const slotMs = def.last_slot_at ? new Date(def.last_slot_at).getTime() : NaN;
      const referenceMs = !isNaN(slotMs)
        ? slotMs
        : candidates.length > 0 ? Math.max(...candidates) : now;

      let nextFireAt = computeNextFireAt(def, referenceMs);

      if (isNaN(nextFireAt)) {
        this.logger(
          `[cron-scheduler] WARNING: cannot parse schedule "${def.schedule}" for cron "${def.name}" — skipping`
        );
        continue;
      }

      // CATCH-UP POLICY: if nextFireAt is in the past (daemon was stopped),
      // fire once immediately for the missed window, then recompute from now.
      // We do NOT flood-fire all missed windows — one catch-up is sufficient.
      // ⛔ KEEP THE ORIGINAL SLOT WHEN CATCHING UP. `nextFireAt` still becomes `now`
      // so the fire happens on the next tick — unchanged — but the SCHEDULED instant
      // is what `due_at` must record and what the post-fire advance must count from.
      // Overwriting the only copy made startup catch-up log its own start time as the
      // due instant: a fire an hour late reported 30 seconds of lateness.
      // (guard, PR41: "startup catch-up log names the original due slot".)
      let dueSlotAt = nextFireAt;
      if (nextFireAt <= now) {
        this.logger(
          `[cron-scheduler] catch-up: cron "${def.name}" missed fire at ${new Date(nextFireAt).toISOString()} — scheduling immediate fire`
        );
        nextFireAt = now; // when to fire; dueSlotAt keeps WHICH SLOT is being served
      }

      nextScheduled.set(def.name, { definition: def, nextFireAt, dueSlotAt, changeKey: key });
    }

    // LAST-GOOD-SCHEDULE FALLBACK (corruption-only)
    // If this is a reload AND readCronsWithStatus reported `corrupt: true`
    // (primary file unparseable AND .bak fallback failed/missing), retain
    // the previous in-memory schedule instead of silently dropping all cron
    // definitions.  This prevents transient corruption from halting cron
    // execution on a running scheduler.
    //
    // CRITICAL: we ONLY apply this fallback when `corrupt === true`.  An empty
    // result with `corrupt === false` is a legitimate empty file — produced
    // by `bus remove-cron` on the last cron, or a freshly initialized agent —
    // and the schedule MUST be cleared.  Earlier versions of this method
    // gated only on `nextScheduled.size === 0`, which restored the just-removed
    // cron from `lastGoodSchedule` and kept firing it after removal until the
    // daemon restarted (iter 9 regression).
    //
    // We do NOT apply this fallback on initial start() — an empty/missing file
    // on startup is normal and should produce an empty schedule.
    if (isReload && corrupt && nextScheduled.size === 0 && this.lastGoodSchedule.size > 0) {
      this.logger(
        `[cron-scheduler] WARNING: reload produced empty schedule for agent "${this.agentName}" — ` +
        `retaining last-good schedule (${this.lastGoodSchedule.size} cron(s)) until file is repaired`
      );
      this.scheduled = new Map(this.lastGoodSchedule);
      return;
    }

    this.scheduled = nextScheduled;

    // Update the last-good snapshot whenever we get a non-empty result.
    if (nextScheduled.size > 0) {
      this.lastGoodSchedule = new Map(nextScheduled);
    }
  }

  private async tick(): Promise<void> {
    const now = Date.now();

    // MTIME RELOAD GUARD.
    // The guard reloads whenever crons.json's mtime differs from the last
    // LOADED mtime.  This INCLUDES the tick after any fire, because tick's own
    // updateCron bookkeeping writes (last_fire_attempted_at, last_fired_at)
    // advance the file mtime.  That post-fire reload is intentional and
    // load-bearing: it is how an external edit that landed while a fire was
    // awaiting gets picked up.  We deliberately do NOT refresh the tracked
    // mtime after our own writes — by mtime alone we cannot distinguish our
    // bookkeeping write from one that merged a concurrent external edit (we are
    // the last writer either way), so storing the post-write mtime would
    // permanently mask such an edit.  The reload is correctness-neutral
    // (nextFireAt is preserved for unchanged changeKey), and is logged like any
    // other reload for transparency.
    //
    // The `!== null` condition means a transient stat failure or unexpected
    // deletion (null) is treated as "no change" so we never drop the live
    // schedule on a transient error.  reload() inherits the reload-while-firing
    // guard, so a cron mid-fire is preserved and an mtime reload cannot
    // double-fire.
    const currentMtime = cronsFileMtimeMs(this.agentName);
    if (currentMtime !== null && currentMtime !== this.lastLoadedCronsMtimeMs) {
      this.reload();
    }

    for (const [name, sc] of this.scheduled) {
      if (sc.nextFireAt > now) {
        continue; // not yet due
      }

      // Guard against re-entry: if a previous tick's async fire+retry is still
      // in flight (can happen with fake timers or very slow onFire), skip.
      if (sc.firing) {
        continue;
      }

      sc.firing = true;
      const cron = sc.definition;
      // Read the due instant ONCE, here, before anything can advance it. The
      // post-fire advance below overwrites `sc.nextFireAt`, so a later read
      // would report the NEXT slot as the one this fire was due at.
      // The SLOT this fire serves. Equals `nextFireAt` on the normal path; differs
      // only after a catch-up, where `nextFireAt` was moved to `now` to fire promptly
      // while `dueSlotAt` still names the slot that was missed.
      const dueAtMs = sc.dueSlotAt ?? sc.nextFireAt;
      // Declared here, beside the slot it renders, because the attempt marker below
      // now writes it pre-dispatch. `Number.isFinite` guards the terminal one-shot
      // case, where `nextFireAt` is POSITIVE_INFINITY and is not a date.
      const dueAtIso = Number.isFinite(dueAtMs) ? new Date(dueAtMs).toISOString() : undefined;
      this.logger(`[cron-scheduler] firing cron "${name}" (was due ${new Date(dueAtMs).toISOString()})`);

      // Persist last_fire_attempted_at to disk BEFORE awaiting the dispatch.
      // If the daemon crashes between this point and the post-success
      // updateCron below, loadCrons() on restart will see this attempt
      // timestamp in the referenceMs candidates and avoid re-firing the
      // same slot via the catch-up gate. (See iter 10/11 audit.)
      //
      // ⛔ FOR A ONE-SHOT: NO MARKER, NO FIRE. If this write does not land, the
      // scheduler has no durable record that it claimed the slot, so a restart
      // reads an untouched definition and fires again — two dispatches of an
      // action promised to happen exactly once. The recurring path's inherited
      // behaviour (warn, dispatch anyway) is right for a recurring cron, where a
      // lost marker costs one duplicate slot rather than a broken guarantee, and
      // it is deliberately left alone here.
      //
      // ⭐ THE MARKER CAN FAIL WITHOUT THROWING. updateCron returns `false` when
      // no cron of that name exists in crons.json — deleted between load and
      // fire, or renamed. A try/catch alone reads that as success. The RETURN
      // VALUE and the throw are two different failure channels and both have to
      // be closed.
      const attemptIso = new Date(now).toISOString();
      const isOneShot = Boolean(cron.fire_at);
      let markerPersisted = false;
      let markerError = '';
      try {
        // ⛔ THE SLOT GOES DOWN WITH THE MARKER, NOT AFTER THE DISPATCH.
        // guard's R1, a REGRESSION my own previous head introduced: the attempt
        // marker was written here (pre-dispatch) but `last_slot_at` only on success,
        // so a fire interrupted between the two left an OLDER slot on disk. On the
        // next load that older slot won over the newer attempt marker and THE SAME
        // SLOT WAS DISPATCHED TWICE. A duplicate fire is the exact thing this marker
        // exists to prevent, so introducing one while adding a phase field made the
        // guard worse than it was at base.
        // ⭐ Writing both together removes the window rather than ordering it: there
        // is no instant at which the slot on disk is older than the attempt on disk,
        // so no precedence rule between them is needed — and a rule that is not
        // needed cannot be got wrong later.
        markerPersisted = updateCron(this.agentName, name, {
          last_fire_attempted_at: attemptIso,
          ...(dueAtIso ? { last_slot_at: dueAtIso } : {}),
        });
        if (markerPersisted) {
          sc.definition = {
            ...cron,
            last_fire_attempted_at: attemptIso,
            ...(dueAtIso ? { last_slot_at: dueAtIso } : {}),
          };
        } else {
          markerError = 'no cron of that name in crons.json (deleted or renamed since load)';
        }
      } catch (err) {
        markerPersisted = false;
        markerError = err instanceof Error ? err.message : String(err);
      }

      if (!markerPersisted) {
        if (isOneShot) {
          // FAIL CLOSED. Leave nextFireAt where it is so the cron stays due and a
          // later tick retries once the write can succeed; do NOT dispatch.
          this.logger(
            `[cron-scheduler] WARNING: one-shot "${name}" NOT dispatched — could not persist ` +
            `last_fire_attempted_at (${markerError}). Fail-closed: without a durable claim a restart ` +
            `would fire it again. Still due; will retry when the write succeeds.`
          );
          sc.firing = false;
          continue;
        }
        this.logger(
          `[cron-scheduler] WARNING: failed to persist last_fire_attempted_at for "${name}" — ` +
          `${markerError}. ` +
          `Continuing dispatch; crash mid-fire could double-fire on restart.`
        );
      }

      const success = await fireWithRetry(cron, this.agentName, this.onFire, this.logger, dueAtIso);

      if (success) {
        // Persist last_fired_at + fire_count to disk.
        // updateCron writes through atomicWriteSync and can throw ENOSPC or
        // EACCES (disk full / read-only filesystem).  These errors must not
        // crash the tick loop — we log and keep the in-memory schedule intact.
        const nowIso = new Date(now).toISOString();
        const newFireCount = (cron.fire_count ?? 0) + 1;

        // ⛔ THE ADVANCE IS COMPUTED BEFORE THE WRITE, DELIBERATELY, so the slot that
        // goes to disk is derived from the very value the scheduler is about to hold.
        // Persisting first and advancing afterwards is what let the two drift: the
        // file said one thing, memory said another, and nothing compared them.
        const firedDefForNext: CronDefinition = {
          ...cron,
          last_fired_at: nowIso,
          fire_count: newFireCount,
        };
        const nextAfterFire = computeNextFireAt(firedDefForNext, dueAtMs, { nowMs: now, skipMissed: true });
        const accountedIso = accountedSlotIso(firedDefForNext, nextAfterFire, dueAtMs);

        try {
          updateCron(this.agentName, name, {
            last_fired_at: nowIso,
            // THE PHASE, persisted — and it is the slot the LIVE SCHEDULER is anchored
            // on after skipping missed slots, not the oldest slot this fire served.
            ...(accountedIso ? { last_slot_at: accountedIso } : {}),
            fire_count: newFireCount,
          });
        } catch (err) {
          this.logger(
            `[cron-scheduler] WARNING: failed to persist fire state for "${name}" — ` +
            `${err instanceof Error ? err.message : String(err)}. ` +
            `In-memory schedule retained; state will be lost if daemon restarts.`
          );
        }

        // Advance in-memory nextFireAt.
        // ⛔ COMPUTE FROM THE POST-FIRE DEFINITION, NOT THE PRE-FIRE ONE. For a
        // recurring cron the two give the same answer, so this read as a harmless
        // simplification. For a ONE-SHOT it is the difference between "never
        // again" and a busy-loop: computeNextFireAt decides by reading
        // fire_count/last_fired_at, and the pre-fire object still has neither, so
        // it would hand back the same past instant on every tick, forever.
        const firedDef: CronDefinition = {
          ...cron,
          last_fired_at: nowIso,
          fire_count: newFireCount,
        };
        // ⛔ ANCHOR ON THE SCHEDULED SLOT, NOT ON THE ACTUAL FIRE.
        // This used to pass `now`, so for an interval schedule the next slot became
        // `actual_fire + interval` and every millisecond of lateness was added to the
        // PHASE and kept forever. A clock that only ever slips forward has no restoring
        // force: host sleep, tick rounding and slow dispatch all accumulate.
        //
        // MEASURED 2026-09-09: a 15:25:02Z host sleep left the daemon suspended, running
        // only inside ~2s macOS DarkWake windows ~16 min apart. `lane-watch` (1h) fired
        // 12m32s late and its minute-of-hour moved :24 -> :36 AND STAYED THERE. Nothing
        // ever moved it back, because nothing could.
        //
        // CATCH-UP POLICY, stated rather than implied: `skipMissed` advances by WHOLE
        // INTERVALS from the original slot to the first instant strictly in the future.
        // Missed slots are SKIPPED, never burst — an agent that was unreachable for six
        // hours gets one fire, not six — and the phase is preserved exactly.
        // ⭐ THE SAME VALUE THAT WAS PERSISTED, not a second computation of it.
        // Two computations of "the same" thing is precisely how the persisted state
        // and the in-memory policy came to describe different worlds.
        const next = nextAfterFire;
        if (!isNaN(next)) {
          sc.nextFireAt = next;
          // The catch-up divergence is spent: from here the slot and the fire time
          // are the same thing again until the next catch-up.
          sc.dueSlotAt = next;
          sc.definition = firedDef;
        } else {
          // Unrecognised schedule after fire — remove from schedule to avoid infinite loops
          this.scheduled.delete(name);
          this.logger(`[cron-scheduler] WARNING: removed "${name}" from schedule after fire — schedule unparseable`);
          continue; // sc is gone, skip clearing firing flag
        }
      } else {
        // Dispatch failed (all retries exhausted). Advance nextFireAt anyway so
        // we don't re-fire the same scheduled slot on every subsequent tick —
        // that produced a busy-loop when an agent was unreachable. Treat the
        // failed window as a missed slot and schedule the next normal fire.
        // For a ONE-SHOT this resolves to "never again": last_fire_attempted_at
        // was persisted before the dispatch, so computeNextFireAt returns
        // Infinity. That is intended — the retries are already exhausted, and
        // re-attempting a one-shot later is the duplicate-action risk this
        // feature exists to avoid. The failure is recorded in the execution log.
        const attemptedDef: CronDefinition = {
          ...cron,
          last_fire_attempted_at:
            cron.last_fire_attempted_at ?? sc.definition.last_fire_attempted_at,
        };
        // Same anchoring as the success path: a failed window is a MISSED SLOT, and a
        // missed slot must not re-phase the cron any more than a late one does.
        const next = computeNextFireAt(attemptedDef, dueAtMs, { nowMs: now, skipMissed: true });
        if (!isNaN(next)) {
          sc.nextFireAt = next;
          sc.dueSlotAt = next;
          // ⛔ A TERMINAL ONE-SHOT HAS NO NEXT SLOT, AND Infinity IS NOT A DATE.
          // computeNextFireAt returns POSITIVE_INFINITY once the attempt marker
          // exists, which is correct — but `new Date(Infinity).toISOString()`
          // throws RangeError: Invalid time value. That rejected the whole tick
          // and skipped `sc.firing = false` below, wedging the cron mid-fire
          // forever. Render the terminal state as words instead of converting a
          // non-finite number to a date. The success path already stores the
          // same Infinity without rendering it, so both post-fire paths now
          // agree: the entry stays, permanently not-due.
          this.logger(
            Number.isFinite(next)
              ? `[cron-scheduler] WARNING: "${name}" dispatch failed — advancing to next slot ${new Date(next).toISOString()} ` +
                `to avoid busy-loop (no last_fired_at update; failure recorded in execution log)`
              : `[cron-scheduler] WARNING: one-shot "${name}" dispatch failed after all retries — terminal, ` +
                `it will not fire again (no last_fired_at update; failure recorded in execution log)`
          );
        } else {
          this.scheduled.delete(name);
          this.logger(`[cron-scheduler] WARNING: removed "${name}" from schedule after failure — schedule unparseable`);
          continue;
        }
      }
      sc.firing = false;
    }
  }
}
