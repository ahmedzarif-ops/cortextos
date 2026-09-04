/**
 * cron-health.ts — Pure health computation helper for the fleet health dashboard.
 *
 * Subtask 4.4.
 *
 * This module is intentionally side-effect-free and has no I/O dependencies so
 * it can be unit-tested exhaustively with injected fixtures.
 *
 * States
 * ------
 *   never-fired  — cron has never produced an execution log entry (lastFire null)
 *                  AND it is not a future-scheduled one-shot in its grace window.
 *   failure      — most recent execution log entry is 'failed' with no later success.
 *   warning      — gap between now and lastFire > 2 × expectedIntervalMs.
 *   healthy      — everything else.
 *
 * One-shot crons (fire_at field set, no schedule interval)
 * ---------------------------------------------------------
 *   A "once" cron that has not yet fired but whose fire_at is still in the future
 *   (+ grace period) is treated as healthy — it is not overdue.
 *   After fire_at + grace period passes without a fire, it becomes warning/never-fired.
 */

import { parseDurationMs, cronExpressionMaxGapMs, nextFireFromCron } from '../bus/cron-state.js';
import type { CronSummaryRow, CronExecutionLogEntry } from '../types/index.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type HealthState = 'healthy' | 'warning' | 'failure' | 'never-fired';

export interface CronHealth {
  /** Agent that owns this cron. */
  agent: string;
  /** Org the agent belongs to. */
  org: string;
  /** Name of the cron. */
  cronName: string;
  /** Computed health state. */
  state: HealthState;
  /** Human-readable explanation, e.g. "last fire 3h ago, expected within 90m". */
  reason: string;
  /** Unix ms of the most recent fire attempt; null if never fired. */
  lastFire: number | null;
  /** Expected interval in ms (derived from schedule); 0 if not parseable (cron expr). */
  expectedIntervalMs: number;
  /** Gap (now - lastFire) in ms; null if never fired. */
  gapMs: number | null;
  /** Fraction of fires in the last 24h that succeeded (0–1). 1.0 if no fires. */
  successRate24h: number;
  /** Raw count of fire attempts in the last 24h. */
  firesLast24h: number;
  /** ISO string of nextFire from the CronSummaryRow. */
  nextFire: string;
}

// Per-agent summary used by the fleet-health IPC response.
export interface AgentHealthSummary {
  agent: string;
  org: string;
  total: number;
  healthy: number;
  warning: number;
  failure: number;
  neverFired: number;
}

export interface FleetHealthResult {
  rows: CronHealth[];
  summary: {
    total: number;
    healthy: number;
    warning: number;
    failure: number;
    neverFired: number;
    agents: Record<string, AgentHealthSummary>;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Multiplier: a cron is "warning" when gap > WARNING_MULTIPLIER × expectedIntervalMs */
export const WARNING_MULTIPLIER = 2;

/** Grace period for one-shot crons (ms): 10 minutes past fire_at before becoming warning */
const ONCE_GRACE_MS = 10 * 60 * 1000;

const MS_24H = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Core helper
// ---------------------------------------------------------------------------

/**
 * Can this schedule string be parsed by anything that actually schedules crons?
 *
 * WHY THIS EXISTS AND WHY IT DOES NOT READ `row.nextFire` (guard's ride-along on PR #5,
 * 2026-09-04): the not-yet-due grace below must only apply to a cron that CAN fire. The first
 * version of that gate asked `row.nextFire !== 'unknown'` — i.e. it trusted a value its CALLER
 * supplied. Exactly one producer fills that field today (`listAllCrons` in ipc-server, correctly,
 * via `computeNextFire`), so the gate was right by luck of there being one caller. A second
 * producer filling `nextFire` from anything else — a hand-built probe, a fixture, a future
 * dashboard path — silently reopens the hole this gate was added to close, and NOTHING FAILS when
 * it does. Guard's own probe did precisely that and made the fix look broken.
 *
 * So parseability is derived HERE, from the schedule itself, using the SAME two parsers the
 * scheduler uses. Deliberately not a re-implementation: a second, independently-written parse test
 * would be free to disagree with the real scheduler, which is the same defect wearing a different
 * hat.
 *
 * ⚠ `cronExpressionMaxGapMs` must NOT be used for this. It returns its 31-day FALLBACK for
 * unrecognised shapes, so it answers "how long might the gap be" and never "is this readable" —
 * an unparseable schedule and a genuinely monthly one are byte-identical in its output. That
 * conflation IS the 31-day false-clear guard found.
 */
export function isScheduleParseable(schedule: string, nowMs = Date.now()): boolean {
  if (typeof schedule !== 'string' || schedule.trim() === '') return false;
  // Interval shorthand ("4h", "30m") — parseDurationMs returns NaN when it cannot read it.
  if (!isNaN(parseDurationMs(schedule))) return true;
  // 5-field cron expression — nextFireFromCron returns NaN when it cannot read it.
  return !isNaN(nextFireFromCron(schedule, nowMs));
}

/**
 * Compute health for a single cron given its summary row and recent executions.
 *
 * @param row               - CronSummaryRow from list-all-crons / listAllCrons().
 * @param executionsLast24h - All execution log entries for this cron in the last 24h.
 *                            Caller is responsible for pre-filtering to the cron + time window.
 * @param nowMs             - Epoch ms for "now" (injectable for deterministic tests).
 */
export function computeHealth(
  row: CronSummaryRow,
  executionsLast24h: CronExecutionLogEntry[],
  nowMs = Date.now(),
): CronHealth {
  const { agent, org, cron, lastFire: lastFireTs, lastStatus, nextFire } = row;

  // ── Derived timing values ──────────────────────────────────────────────────

  const lastFireMs: number | null = lastFireTs ? new Date(lastFireTs).getTime() : null;
  const gapMs: number | null = lastFireMs !== null ? nowMs - lastFireMs : null;

  // Expected interval: derive from schedule.
  //
  // ⛔ THIS USED TO READ `parseDurationMs(cron.schedule) || 0` AND THAT EXEMPTED 66% OF THE FLEET.
  // parseDurationMs only understands the interval shorthand (`4h`, `30m`) and returns NaN for a
  // 5-field cron expression; `NaN || 0` gave 0, and the staleness branch below is gated on `> 0`.
  // Measured 2026-09-04: 18 of 27 live crons could therefore never score `warning` — including
  // every daily and weekly review, sweep and metrics cron. A daily cron dead for five days read
  // `healthy`. The 9 that WERE checked were the hourly interval crons, i.e. exactly the ones whose
  // silence a human would notice anyway. (task_1788511684383_66545168)
  //
  // For expressions we use the MAX GAP, never cronExpressionMinIntervalMs — that returns 24h for a
  // weekly cron and would flag every healthy weekly cron stale after 48h, every week.
  const intervalFromShorthand = parseDurationMs(cron.schedule);
  const expectedIntervalMs = !isNaN(intervalFromShorthand) && intervalFromShorthand > 0
    ? intervalFromShorthand
    : cronExpressionMaxGapMs(cron.schedule);

  // ── 24h metrics ───────────────────────────────────────────────────────────

  const firesLast24h = executionsLast24h.length;
  const successCount = executionsLast24h.filter(e => e.status === 'fired').length;
  const successRate24h = firesLast24h > 0 ? successCount / firesLast24h : 1;

  // ── State machine ─────────────────────────────────────────────────────────

  // Check for one-shot cron that hasn't fired yet but is scheduled in the future
  if (lastFireMs === null && cron.fire_at) {
    const fireAtMs = new Date(cron.fire_at).getTime();
    if (!isNaN(fireAtMs)) {
      if (nowMs < fireAtMs + ONCE_GRACE_MS) {
        // Still within grace window — healthy
        return makeHealth(agent, org, cron.name, nextFire, 'healthy',
          `one-shot scheduled in the future (fire_at: ${cron.fire_at})`,
          lastFireMs, expectedIntervalMs, gapMs, successRate24h, firesLast24h);
      }
      // Past grace window, never fired — fall through to never-fired
    }
  }

  // never-fired — but SPLIT THREE WAYS, because "no fire" has three different causes and the
  // previous single bucket rendered them identically. (task_1788511684383_66545168)
  //
  //   attempted PRESENT + fired ABSENT  -> the scheduler DISPATCHED and the run DIED.
  //   both ABSENT, a fire time has passed -> the scheduler never reached it.
  //   both ABSENT, nothing due yet      -> NOT YET DUE. No information. Not a fault.
  //
  // cron-scheduler.ts persists `last_fire_attempted_at` BEFORE awaiting the dispatch, expressly
  // "to detect crash" — and nothing outside cron-scheduler ever read it. The discriminating field
  // was already on disk, written deliberately, unused.
  //
  // The third branch is not politeness: without it every newly-created cron scores as a fault on
  // the day it is added, and a checker that cries wolf on every new cron is switched off.
  if (lastFireMs === null) {
    const attemptedMs = cron.last_fire_attempted_at
      ? new Date(cron.last_fire_attempted_at).getTime()
      : null;

    if (attemptedMs !== null && !isNaN(attemptedMs)) {
      return makeHealth(agent, org, cron.name, nextFire, 'failure',
        `dispatched ${formatRelativeMs(nowMs - attemptedMs)} ago and never completed — the run died`,
        lastFireMs, expectedIntervalMs, gapMs, successRate24h, firesLast24h);
    }

    // ⛔ THE GRACE IS GATED ON PARSE SUCCESS (guard's review of PR #5, 2026-09-04).
    // computeNextFire returns the literal 'unknown' when neither the interval shorthand nor the
    // 5-field parser can read the schedule. Such a cron WILL NEVER FIRE — the scheduler cannot
    // schedule it — so `never-fired` is the honest verdict and grace is exactly wrong.
    // Without this gate the fallback (31 days, deliberately long) HID a permanently dead cron for
    // a month: guard reproduced '@daily' and '0 9 * * MON' reading HEALTHY on this branch while
    // the base correctly said never-fired. My widening turned a true positive into a false clear,
    // which is the failure direction this whole change exists to remove.
    // DERIVED HERE, NOT READ FROM `row.nextFire` — see isScheduleParseable above. The old form
    // (`nextFire !== 'unknown'`) delegated the safety property of this gate to whoever built the
    // row, and only one caller in the tree happens to build it correctly.
    const parseable = isScheduleParseable(cron.schedule, nowMs);
    const createdMs = cron.created_at ? new Date(cron.created_at).getTime() : null;
    const dueYet = createdMs !== null && !isNaN(createdMs)
      ? nowMs - createdMs > expectedIntervalMs
      : true;
    if (parseable && !dueYet) {
      return makeHealth(agent, org, cron.name, nextFire, 'healthy',
        'created recently and not due yet — no fire expected',
        lastFireMs, expectedIntervalMs, gapMs, successRate24h, firesLast24h);
    }

    return makeHealth(agent, org, cron.name, nextFire, 'never-fired',
      'cron has never fired — no execution history and a fire time has passed',
      lastFireMs, expectedIntervalMs, gapMs, successRate24h, firesLast24h);
  }

  // failure: most recent status is 'failed' AND no later success in log
  if (lastStatus === 'failed') {
    return makeHealth(agent, org, cron.name, nextFire, 'failure',
      `most recent execution failed (${formatRelativeMs(gapMs!)} ago)`,
      lastFireMs, expectedIntervalMs, gapMs, successRate24h, firesLast24h);
  }

  // warning: gap > 2x expected interval (only applies when interval is known)
  if (expectedIntervalMs > 0 && gapMs !== null && gapMs > WARNING_MULTIPLIER * expectedIntervalMs) {
    const expectedLabel = formatMs(expectedIntervalMs);
    const gapLabel = formatMs(gapMs);
    return makeHealth(agent, org, cron.name, nextFire, 'warning',
      `last fire ${gapLabel} ago, expected within ${expectedLabel} (2x threshold exceeded)`,
      lastFireMs, expectedIntervalMs, gapMs, successRate24h, firesLast24h);
  }

  // healthy
  const gapLabel = gapMs !== null ? `${formatRelativeMs(gapMs)} ago` : 'never';
  return makeHealth(agent, org, cron.name, nextFire, 'healthy',
    `last fired ${gapLabel}`,
    lastFireMs, expectedIntervalMs, gapMs, successRate24h, firesLast24h);
}

// ---------------------------------------------------------------------------
// Fleet aggregation
// ---------------------------------------------------------------------------

/**
 * Aggregate an array of CronHealth rows into a FleetHealthResult.
 * Pure — no I/O.
 */
export function aggregateFleetHealth(rows: CronHealth[]): FleetHealthResult {
  const summary = {
    total: rows.length,
    healthy: 0,
    warning: 0,
    failure: 0,
    neverFired: 0,
    agents: {} as Record<string, AgentHealthSummary>,
  };

  for (const row of rows) {
    // Top-level counters
    switch (row.state) {
      case 'healthy':    summary.healthy++;    break;
      case 'warning':    summary.warning++;    break;
      case 'failure':    summary.failure++;    break;
      case 'never-fired': summary.neverFired++; break;
    }

    // Per-agent breakdown
    if (!summary.agents[row.agent]) {
      summary.agents[row.agent] = {
        agent: row.agent,
        org: row.org,
        total: 0,
        healthy: 0,
        warning: 0,
        failure: 0,
        neverFired: 0,
      };
    }
    const agentSummary = summary.agents[row.agent];
    agentSummary.total++;
    switch (row.state) {
      case 'healthy':    agentSummary.healthy++;    break;
      case 'warning':    agentSummary.warning++;    break;
      case 'failure':    agentSummary.failure++;    break;
      case 'never-fired': agentSummary.neverFired++; break;
    }
  }

  return { rows, summary };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function makeHealth(
  agent: string,
  org: string,
  cronName: string,
  nextFire: string,
  state: HealthState,
  reason: string,
  lastFire: number | null,
  expectedIntervalMs: number,
  gapMs: number | null,
  successRate24h: number,
  firesLast24h: number,
): CronHealth {
  return {
    agent,
    org,
    cronName,
    state,
    reason,
    lastFire,
    expectedIntervalMs,
    gapMs,
    successRate24h,
    firesLast24h,
    nextFire,
  };
}

/** Format a duration in ms as a compact human string: "3h", "45m", "2d". */
function formatMs(ms: number): string {
  if (ms >= 86_400_000) return `${Math.round(ms / 86_400_000)}d`;
  if (ms >= 3_600_000)  return `${Math.round(ms / 3_600_000)}h`;
  if (ms >= 60_000)     return `${Math.round(ms / 60_000)}m`;
  return `${ms}ms`;
}

/** Format a positive gap in ms as "3h 12m" style. */
function formatRelativeMs(ms: number): string {
  if (ms >= 86_400_000) {
    const d = Math.floor(ms / 86_400_000);
    const h = Math.floor((ms % 86_400_000) / 3_600_000);
    return h > 0 ? `${d}d ${h}h` : `${d}d`;
  }
  if (ms >= 3_600_000) {
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  if (ms >= 60_000) {
    const m = Math.floor(ms / 60_000);
    return `${m}m`;
  }
  return `${Math.round(ms / 1000)}s`;
}
