/**
 * Daemon-side cron fire timestamp registry (cron-state.json).
 *
 * Solves the dead zone problem (issue #67): context compression silently drops
 * in-session CronCreate schedules. This module records when each named cron
 * last fired in a file that survives all restarts. AgentProcess polls the file
 * and injects a gap-nudge when a cron has been silent for >2x its interval.
 *
 * Lifecycle:
 *   1. Agent calls `cortextos bus update-cron-fire <name> --interval <interval>`
 *      at the end of each cron prompt execution.
 *   2. Daemon gap-detection loop reads cron-state.json every 10 minutes.
 *   3. If last_fire is >2x interval ago, daemon injects a nudge into the agent PTY.
 *
 * Storage: state/<agent>/cron-state.json (same dir as pending-reminders.json).
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ensureDir } from '../utils/atomic.js';

export interface CronFireRecord {
  name: string;
  last_fire: string;   // ISO 8601 UTC
  interval?: string;   // e.g. "6h", "24h", "30m" — copied from update call
}

interface CronStateFile {
  updated_at: string;
  crons: CronFireRecord[];
}

function cronStatePath(stateDir: string): string {
  return join(stateDir, 'cron-state.json');
}

export function readCronState(stateDir: string): CronStateFile {
  const filePath = cronStatePath(stateDir);
  if (!existsSync(filePath)) {
    return { updated_at: new Date().toISOString(), crons: [] };
  }
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && Array.isArray(parsed.crons)
      ? parsed
      : { updated_at: new Date().toISOString(), crons: [] };
  } catch {
    return { updated_at: new Date().toISOString(), crons: [] };
  }
}

/**
 * Record that a cron just fired. Creates or updates the entry for `cronName`.
 * Called by agents via `cortextos bus update-cron-fire <name> --interval <interval>`.
 */
export function updateCronFire(
  stateDir: string,
  cronName: string,
  interval?: string,
): void {
  ensureDir(stateDir);
  const state = readCronState(stateDir);
  const now = new Date().toISOString();

  const idx = state.crons.findIndex(r => r.name === cronName);
  const record: CronFireRecord = { name: cronName, last_fire: now, ...(interval ? { interval } : {}) };

  if (idx === -1) {
    state.crons.push(record);
  } else {
    state.crons[idx] = record;
  }

  state.updated_at = now;
  writeFileSync(cronStatePath(stateDir), JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

/**
 * Parse an interval string like "6h", "30m", "1d", "2w" into milliseconds.
 * Returns NaN for unrecognised formats (e.g. cron expressions like "0 8 * * *").
 */
export function parseDurationMs(interval: string): number {
  const match = /^(\d+)(m|h|d|w)$/.exec(interval.trim());
  if (!match) return NaN;
  const n = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers: Record<string, number> = {
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  return n * multipliers[unit];
}

/**
 * Estimate the minimum expected firing interval for a 5-field cron expression.
 * Handles common patterns (every-N-minutes, every-N-hours, daily) without an
 * external library. Returns a conservative 48h fallback for anything else.
 */
export function cronExpressionMinIntervalMs(expr: string): number {
  const FALLBACK_MS = 48 * 3_600_000;
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return FALLBACK_MS;
  const [minute, hour] = parts;

  // Every N minutes: */N * * * *
  const everyMin = /^\*\/(\d+)$/.exec(minute);
  if (everyMin && hour === '*') return parseInt(everyMin[1], 10) * 60_000;

  // Every N hours: <fixed-minute> */N * * *
  const everyHour = /^\*\/(\d+)$/.exec(hour);
  if (everyHour) return parseInt(everyHour[1], 10) * 3_600_000;

  // Fixed hour — fires daily (or on restricted days; 24h is the minimum gap)
  if (/^\d+$/.test(hour)) return 24 * 3_600_000;

  return FALLBACK_MS;
}

/**
 * MAXIMUM legitimate gap between fires for a 5-field cron expression — i.e.
 * "how long may this cron stay quiet before silence is a fault".
 *
 * ⛔ THIS IS NOT cronExpressionMinIntervalMs AND THE TWO ARE NOT INTERCHANGEABLE.
 * That one answers "how often could this fire at most" and returns 24h for `0 7 * * 1`,
 * because it only looks at the hour field. A weekly cron is silent for SEVEN days by
 * design, so using the min-interval for a staleness threshold flags every healthy weekly
 * cron as stale every single week — trading a permanent false negative for a recurring
 * false positive, and a checker that cries wolf weekly is switched off by week three.
 * Staleness needs the MAX gap. (sentinel, 2026-09-04, task_1788511684383_66545168.)
 *
 * Bias: when the expression is not understood, return a LARGE value. A false negative
 * leaves the current behaviour; a false positive destroys the checker.
 */
export function cronExpressionMaxGapMs(expr: string): number {
  const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
  // Unrecognised shapes fall back long on purpose — see the bias note above.
  const FALLBACK_MS = 31 * DAY;

  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return FALLBACK_MS;
  const [minute, hour, dom, , dow] = parts;

  const everyMin = /^\*\/(\d+)$/.exec(minute);
  if (everyMin && hour === '*') return parseInt(everyMin[1], 10) * MIN;

  const everyHour = /^\*\/(\d+)$/.exec(hour);
  if (everyHour && dom === '*' && dow === '*') return parseInt(everyHour[1], 10) * HOUR;

  // From here the time-of-day is fixed; the gap is decided by WHICH DAYS it runs.
  if (!/^\d+$/.test(hour)) return FALLBACK_MS;

  // Day-of-month restricted (e.g. `0 3 1 * *`): monthly-ish.
  if (dom !== '*') return FALLBACK_MS;

  // Every day.
  if (dow === '*') return DAY;

  // Day-of-week list, e.g. `0` (Sundays) or `0,3` (Sun+Wed). The answer is the LARGEST
  // gap in the weekly cycle, which is NOT 7/n — `0,3` gives gaps of 3 and 4 days, not 3.5.
  const days = dow.split(',').map(d => parseInt(d, 10)).filter(d => !isNaN(d) && d >= 0 && d <= 7);
  if (days.length === 0) return FALLBACK_MS;
  const norm = Array.from(new Set(days.map(d => d % 7))).sort((a, b) => a - b);
  if (norm.length === 1) return 7 * DAY;
  let maxGapDays = 0;
  for (let i = 0; i < norm.length; i++) {
    const next = i + 1 < norm.length ? norm[i + 1] : norm[0] + 7;
    maxGapDays = Math.max(maxGapDays, next - norm[i]);
  }
  return maxGapDays * DAY;
}

// ---------------------------------------------------------------------------
// Cron expression parser — no external deps.
// Supports: *, */N, comma-lists, and ranges for each of the 5 standard fields.
// Fields: minute hour dom month dow (day-of-week: 0=Sunday … 6=Saturday).
// ---------------------------------------------------------------------------

/**
 * Expand a single cron field string into the set of matching integers.
 *
 * @param field - Raw field token (e.g. "*", "*\/5", "0,15,30,45", "1-5").
 * @param min   - Minimum valid value for this field (0 or 1).
 * @param max   - Maximum valid value (e.g. 59, 23, 31, 12, 6).
 */
function expandField(field: string, min: number, max: number): number[] {
  const result = new Set<number>();

  for (const part of field.split(',')) {
    if (part === '*') {
      for (let i = min; i <= max; i++) result.add(i);
    } else if (part.startsWith('*/')) {
      const step = parseInt(part.slice(2), 10);
      if (isNaN(step) || step <= 0) throw new Error(`Invalid cron step: ${part}`);
      for (let i = min; i <= max; i += step) result.add(i);
    } else if (part.includes('-')) {
      const [lo, hi] = part.split('-').map(s => parseInt(s, 10));
      if (isNaN(lo) || isNaN(hi) || lo > hi) throw new Error(`Invalid cron range: ${part}`);
      for (let i = lo; i <= hi; i++) result.add(i);
    } else {
      const n = parseInt(part, 10);
      if (isNaN(n)) throw new Error(`Invalid cron value: ${part}`);
      result.add(n);
    }
  }

  return [...result].sort((a, b) => a - b);
}

/**
 * Compute the next fire timestamp (ms since epoch) for a 5-field cron
 * expression, starting from `fromMs` (exclusive — the next fire must be
 * strictly after fromMs, rounded forward to the next whole minute).
 *
 * @param expr   - 5-field cron expression ("min hour dom month dow").
 * @param fromMs - Starting epoch time in milliseconds.
 * @returns      Epoch ms of the next matching minute, or NaN if unparseable.
 */
export function nextFireFromCron(expr: string, fromMs: number): number {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return NaN;

  let [minuteStr, hourStr, domStr, monthStr, dowStr] = parts;

  let minutes: number[], hours: number[], doms: number[], months: number[], dows: number[];
  try {
    minutes = expandField(minuteStr, 0, 59);
    hours   = expandField(hourStr,   0, 23);
    doms    = expandField(domStr,    1, 31);
    months  = expandField(monthStr,  1, 12);
    dows    = expandField(dowStr,    0, 6);
  } catch {
    return NaN;
  }

  // Start from the next whole minute after fromMs
  const startMs = Math.floor(fromMs / 60_000) * 60_000 + 60_000;

  // Walk forward minute-by-minute (capped at 1 year to avoid infinite loops).
  const MAX_MINUTES = 366 * 24 * 60;
  let candidate = startMs;

  for (let i = 0; i < MAX_MINUTES; i++) {
    const d = new Date(candidate);
    const m  = d.getMinutes();
    const h  = d.getHours();
    const dy = d.getDate();
    const mo = d.getMonth() + 1; // 1-12
    const dw = d.getDay();       // 0-6

    if (
      months.includes(mo) &&
      doms.includes(dy) &&
      dows.includes(dw) &&
      hours.includes(h) &&
      minutes.includes(m)
    ) {
      return candidate;
    }

    candidate += 60_000;
  }

  return NaN; // should never reach here for valid expressions
}
