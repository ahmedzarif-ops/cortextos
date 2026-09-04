import { readdirSync, readFileSync, existsSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import type { Heartbeat, BusPaths } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';

/**
 * SessionEnd-hook end-type markers (see src/hooks/hook-crash-alert.ts). A
 * restart writes one of these; the crash-alert hook reads it WITHOUT consuming
 * it, because one restart fires the hook twice and both firings must classify
 * from the same marker. clearEndMarkers is the marker's primary cleanup: an
 * agent updating its heartbeat is genuinely alive in its post-restart session,
 * so a pending end-marker is stale and is removed here — but only once it is
 * past the grace window below. The hook's TTL is the backstop for a start that
 * fails before ever heartbeating.
 */
const END_TYPE_MARKERS = [
  '.restart-planned',
  '.session-refresh',
  '.user-restart',
  '.user-disable',
  '.user-stop',
  '.daemon-crashed',
  '.daemon-stop',
];

/**
 * A marker younger than this is left alone by clearEndMarkers — it may belong
 * to a restart still in flight. The hazard: the post-restart session can reach
 * its first heartbeat before the dying restart's SECOND SessionEnd firing
 * lands (firing#2 is typically 13-22s after firing#1, but not hard-bounded).
 * Without a grace window, that heartbeat would wipe the marker and firing#2
 * would classify `crash` — the exact false positive this whole change exists
 * to kill, reintroduced under a narrower window.
 *
 * The grace makes that race negligible, not mathematically zero: a firing#2
 * delayed past 120s under heavy load could still miss the marker. That is the
 * same bounded residual as the hook's TTL and is accepted. The window is sized
 * generously on the TTL's cost asymmetry — too tight reopens the FP; too loose
 * only delays cleanup harmlessly (the heartbeat clears it on a later pass, and
 * the 300s hook TTL backstops). 120s clears any plausible firing#2 delay while
 * staying well under the TTL.
 */
const MARKER_CLEAR_GRACE_MS = 120_000; // 2 minutes

/**
 * Remove SessionEnd-hook end-type markers from an agent's state dir, skipping
 * any marker younger than MARKER_CLEAR_GRACE_MS (an in-flight restart whose
 * second hook firing may not have landed yet). `nowMs` is injectable for tests.
 */
export function clearEndMarkers(stateDir: string, nowMs: number = Date.now()): void {
  for (const file of END_TYPE_MARKERS) {
    const p = join(stateDir, file);
    if (!existsSync(p)) continue;
    try {
      if (nowMs - statSync(p).mtimeMs < MARKER_CLEAR_GRACE_MS) continue; // in-flight — leave it
      unlinkSync(p);
    } catch { /* ignore — best-effort cleanup */ }
  }
}

/**
 * Update heartbeat for the current agent.
 * Writes to: {ctxRoot}/state/{agent}/heartbeat.json
 * Matches bash update-heartbeat.sh format exactly.
 */
export function updateHeartbeat(
  paths: BusPaths,
  agentName: string,
  status: string,
  options?: { org?: string; timezone?: string; dayModeStart?: string; dayModeEnd?: string; loopInterval?: string; currentTask?: string; displayName?: string },
): void {
  ensureDir(paths.stateDir);

  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  // The caller resolves timezone/window from config (see resolveModeSettings in cli/bus.ts) and
  // passes them here. The 'UTC' below is now only reached when a caller supplies NOTHING at all —
  // a programmatic caller, not the CLI — and it no longer silently overrides an org that has
  // declared its timezone.
  const mode = detectDayNightMode(
    options?.timezone ?? 'UTC',
    options?.dayModeStart,
    options?.dayModeEnd,
  );

  const heartbeat: Heartbeat = {
    agent: agentName,
    org: options?.org ?? '',
    ...(options?.displayName ? { display_name: options.displayName } : {}),
    status,
    current_task: options?.currentTask ?? '',
    mode,
    last_heartbeat: ts,
    loop_interval: options?.loopInterval ?? '',
  };

  atomicWriteSync(
    join(paths.stateDir, 'heartbeat.json'),
    JSON.stringify(heartbeat),
  );

  // The agent is alive in its (post-restart) session — clear stale SessionEnd
  // markers so the crash-alert hook cannot misclassify a later genuine crash
  // as a planned restart. Markers inside the grace window are left in place
  // (an in-flight restart's second hook firing may not have landed); they are
  // cleared on a later heartbeat. This is the primary marker cleanup; the
  // hook's TTL is the failed-start backstop.
  clearEndMarkers(paths.stateDir);
}

/** Declared default day window when config supplies none. Matches the shipped org template
 *  and SYSTEM.md / USER.md ("Day Mode: 08:00 - 00:00"). NOT 8-22 — see detectDayNightMode. */
export const DEFAULT_DAY_START = '08:00';
export const DEFAULT_DAY_END = '00:00';

/**
 * Minutes-since-midnight for an "HH:MM" string, or null if unparseable.
 *
 * Minute granularity rather than hours on purpose: `day_mode_start` is a free-form config string
 * and "08:30" is a legal value. An hours-only parser would silently floor it and be wrong for
 * thirty minutes a day — the kind of small, permanent, invisible error this function already had.
 */
function parseClock(hhmm: string | undefined): number | null {
  if (!hhmm) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 24 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Detect day/night mode for a timezone and a configured day window.
 *
 * ⛔ THIS USED TO DEFAULT TO UTC AND HARDCODE 8-22, AND BOTH WERE WRONG INDEPENDENTLY
 * (sentinel, 2026-09-04, proven by effect on the running binary before the source was read):
 *
 *   1. THE TIMEZONE. `updateHeartbeat` passed a timezone only when the caller supplied one and
 *      otherwise passed the literal 'UTC'. HEARTBEAT.md tells every seat to run
 *      `cortextos bus update-heartbeat "<status>"` with NO flag, so the whole fleet computed its
 *      mode five hours off the org's declared America/Chicago — and the error ran toward DAY
 *      DURING THE NIGHT. Measured at 05:48 Chicago: no flag -> "day"; --timezone America/Chicago
 *      -> "night"; --timezone Asia/Tokyo -> "day" (the control proving the field moves).
 *      ⭐ IT ALSO MADE MODE A PER-CALL ARGUMENT RATHER THAN A FLEET PROPERTY: chief passed the
 *      flag and sentinel did not, so the two seats reported different halves of the day IN THE
 *      SAME MINUTE ON THE SAME MACHINE.
 *
 *   2. THE WINDOW. `hour >= 8 && hour < 22` while SYSTEM.md and USER.md both declare
 *      "Day Mode: 08:00 - 00:00" — so 22:00-00:00 read as night even with the timezone right.
 *      ⚠ AND THE CONFIG ALREADY SAID SO. Both the agent's config.json and the org's context.json
 *      carry `day_mode_start: "08:00"` and `day_mode_end: "00:00"`, and `types/index.ts` has
 *      carried those fields all along. The data was never missing; this function never read it.
 *
 * Fixing only the timezone READS LIKE A FIX and leaves the window, which is why they are one change.
 *
 * The window WRAPS: when start > end the day span crosses midnight. That is what makes
 * 08:00-00:00 work without a special case — end 00:00 parses to 0, 480 > 0, so the span is
 * "at or after 08:00", i.e. 08:00 through 23:59. A 22:00-06:00 night-shift org works the same way.
 */
export function detectDayNightMode(
  timezone: string,
  dayStart?: string,
  dayEnd?: string,
): 'day' | 'night' {
  const startMin = parseClock(dayStart) ?? parseClock(DEFAULT_DAY_START)!;
  const endMin = parseClock(dayEnd) ?? parseClock(DEFAULT_DAY_END)!;

  let nowMin: number;
  try {
    const parts = new Date().toLocaleString('en-US', {
      timeZone: timezone,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    });
    const m = /(\d{1,2}):(\d{2})/.exec(parts);
    if (!m) throw new Error('unparseable locale time');
    // 'en-US' with hour12:false renders midnight as 24:00 in some ICU versions; normalise it.
    nowMin = (parseInt(m[1], 10) % 24) * 60 + parseInt(m[2], 10);
  } catch {
    // An INVALID TIMEZONE falls back to UTC — but the window is still the configured one, so a
    // bad tz string costs the offset and not the org's declared hours.
    const now = new Date();
    nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  }

  // Degenerate window (start === end) means "always day"; treat it as such rather than as a
  // zero-length day, because a config that says 00:00-00:00 more plausibly means "no night mode"
  // than "never day", and silently reporting permanent night would be the louder wrong answer.
  if (startMin === endMin) return 'day';

  const isDay = startMin < endMin
    ? (nowMin >= startMin && nowMin < endMin)
    : (nowMin >= startMin || nowMin < endMin); // wraps midnight

  return isDay ? 'day' : 'night';
}

/**
 * Read all agent heartbeats.
 * Scans state/ directory for agent subdirs containing heartbeat.json.
 * Matches dashboard heartbeat path: state/{agent}/heartbeat.json
 */
export function readAllHeartbeats(paths: BusPaths): Heartbeat[] {
  const heartbeats: Heartbeat[] = [];
  const stateDir = join(paths.ctxRoot, 'state');
  let agentDirs: string[];
  try {
    agentDirs = readdirSync(stateDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return [];
  }

  for (const agent of agentDirs) {
    const hbPath = join(stateDir, agent, 'heartbeat.json');
    try {
      const content = readFileSync(hbPath, 'utf-8');
      heartbeats.push(JSON.parse(content));
    } catch {
      // Skip agents without heartbeat
    }
  }

  return heartbeats;
}
