/**
 * dormancy.ts — Pure silent-dormancy predicate for the agent status surface.
 *
 * Silent dormancy = an ENABLED agent whose activity signal (heartbeat) is stale
 * RELATIVE TO its own liveness baseline, while nothing surfaces it.
 *
 * This module is intentionally side-effect-free and has no I/O dependencies so
 * it can be unit-tested exhaustively with an injected `nowMs`. It mirrors the
 * shape of cron-health.ts.
 *
 * One defect, two faces — the ONLY difference is which liveness baseline applies:
 *
 *   Face A — mapped agent (present in getAllStatuses)
 *     baseline = the agent's own process uptime. Staleness is clamped to uptime
 *     so a fleet bounce cannot flag the whole fleet.
 *
 *   Face B — enabled agent ABSENT from the mapped set (roster-diff)
 *     no agent uptime exists, so baseline = time since DAEMON start. Catches the
 *     never-spawned / dropped-from-map case. Daemon-start grace is the bounce
 *     guard for this face.
 *
 * `mapped` is NEVER part of the predicate — it only selects which baseline
 * applies and is echoed into the reason string.
 */

// ---------------------------------------------------------------------------
// Constants — all review-tunable proposals, NOT final.
// ---------------------------------------------------------------------------

/** Below this uptime (Face A) / daemon uptime (Face B) an agent is never flagged. */
export const BOOT_GRACE_MS = 15 * 60 * 1000; // 15 min

/** Heartbeat is stale when its age exceeds MULTIPLIER × expected interval. */
export const STALENESS_MULTIPLIER = 3;

/** Fallback expected heartbeat interval when the caller supplies none. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000; // 30 min

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DormancyInput {
  /** Agent name (for the result/reason only). */
  agent: string;
  /** Org the agent belongs to (optional; echoed through). */
  org?: string;
  /** Whether the agent is enabled. A disabled agent is never dormant. */
  enabled: boolean;
  /** True = mapped (Face A, uptime baseline); false = enabled-but-absent (Face B). */
  mapped: boolean;
  /** Epoch ms for "now" (injectable for deterministic tests). */
  nowMs: number;
  /** Epoch ms of the last heartbeat; null if never seen. */
  lastSeenMs: number | null;
  /** Agent process uptime in ms (Face A baseline); null when unmapped. */
  uptimeMs: number | null;
  /** Time since daemon start in ms (Face B baseline). */
  daemonUptimeMs: number;
  /** Expected heartbeat interval in ms; falls back to DEFAULT when null/undefined. */
  expectedIntervalMs?: number | null;
}

export interface DormancyResult {
  agent: string;
  org?: string;
  dormant: boolean;
  mapped: boolean;
  /** Human string containing the mapped/unmapped word + the age/threshold numbers. */
  reason: string;
  /** Staleness threshold used (ms). */
  thresholdMs: number;
  /** The staleness age measured against the baseline (ms). */
  ageMs: number;
  /** The liveness baseline used: uptime (Face A) or daemon uptime (Face B) (ms). */
  baselineMs: number;
}

// ---------------------------------------------------------------------------
// Core helper
// ---------------------------------------------------------------------------

/**
 * Compute silent-dormancy for a single agent. Pure — no I/O.
 *
 * Both faces derive their threshold identically; they differ only in the
 * baseline and staleness measure. The `mapped` flag selects the face.
 */
export function computeDormancy(input: DormancyInput): DormancyResult {
  const interval = input.expectedIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const thresholdMs = Math.max(BOOT_GRACE_MS, STALENESS_MULTIPLIER * interval);

  if (input.mapped) {
    // Face A — baseline is the agent's own uptime. Staleness is clamped to
    // uptime (the min(., uptimeMs) below) so a fleet bounce, where every
    // agent's uptime is small, cannot report the whole fleet as stale.
    const uptimeMs = input.uptimeMs;
    const baselineMs = uptimeMs ?? 0;
    const sinceLastBeat = input.lastSeenMs == null
      ? baselineMs
      : Math.min(input.nowMs - input.lastSeenMs, baselineMs);
    const dormant =
      input.enabled && uptimeMs != null && uptimeMs > BOOT_GRACE_MS && sinceLastBeat > thresholdMs;
    const reason = `mapped agent, heartbeat ${formatMs(sinceLastBeat)} stale vs ${formatMs(thresholdMs)} threshold (uptime ${formatMs(baselineMs)})`;
    return { agent: input.agent, org: input.org, dormant, mapped: true, reason, thresholdMs, ageMs: sinceLastBeat, baselineMs };
  }

  // Face B — baseline is time since daemon start. A never-heartbeating absent
  // agent is treated as stale for the whole daemon uptime. The daemon-start
  // grace is the bounce guard: an agent briefly absent-from-map mid-bounce
  // (daemon uptime still under grace) must NOT flag.
  const daemonUptimeMs = input.daemonUptimeMs;
  const heartbeatAgeMs = input.lastSeenMs == null ? daemonUptimeMs : input.nowMs - input.lastSeenMs;
  const dormant = input.enabled && daemonUptimeMs > BOOT_GRACE_MS && heartbeatAgeMs > thresholdMs;
  const reason = `unmapped agent (enabled but absent from map), heartbeat ${formatMs(heartbeatAgeMs)} stale vs ${formatMs(thresholdMs)} threshold (daemon up ${formatMs(daemonUptimeMs)})`;
  return { agent: input.agent, org: input.org, dormant, mapped: false, reason, thresholdMs, ageMs: heartbeatAgeMs, baselineMs: daemonUptimeMs };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Format a duration in ms as a compact human string: "3h", "45m", "2d". */
function formatMs(ms: number): string {
  if (ms >= 86_400_000) return `${Math.round(ms / 86_400_000)}d`;
  if (ms >= 3_600_000)  return `${Math.round(ms / 3_600_000)}h`;
  if (ms >= 60_000)     return `${Math.round(ms / 60_000)}m`;
  return `${ms}ms`;
}
