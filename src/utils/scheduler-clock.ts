import { IPCClient } from '../daemon/ipc-server.js';

/**
 * Which clock did a displayed next-fire time get computed on?
 *
 * `nextFireFromCron` matches cron fields against process-LOCAL time
 * (d.getHours()/getDate()/getDay()).  The daemon runs that function in its own
 * process and fires on ITS clock; a CLI that recomputes a next-fire for display
 * runs the same function in the CALLER's process and answers on the caller's
 * clock.  When the two were launched under different TZ values the displayed
 * time is not the time the scheduler will use — and nothing in the output says
 * so, because each side is internally consistent.
 *
 * This asks the daemon which clock it is on so the caller can say whether the
 * two agree.  It NEVER throws and it never changes the computed times: the
 * numbers are the caller's either way.  Its only job is to stop a divergence
 * from being silent.
 */
export type SchedulerClock =
  | { status: 'match'; callerTz: string; daemonTz: string }
  | { status: 'mismatch'; callerTz: string; daemonTz: string; daemonEnvTz: string | null }
  | { status: 'daemon-down'; callerTz: string }
  | { status: 'daemon-older'; callerTz: string }
  | { status: 'unreachable'; callerTz: string; detail: string };

export async function describeSchedulerClock(instanceId: string): Promise<SchedulerClock> {
  const callerTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let res: { success: boolean; data?: unknown; error?: string };
  try {
    res = await new IPCClient(instanceId).send({
      type: 'daemon-info',
      source: 'cortextos bus list-crons',
    });
  } catch (err) {
    // The IPC client REJECTS on timeout (and on socket errors other than
    // ECONNREFUSED/ENOENT) rather than resolving an error envelope, so this
    // catch is load-bearing: without it list-crons would die on a wedged
    // daemon, which is a worse outcome than not knowing the daemon's zone.
    return { status: 'unreachable', callerTz, detail: String(err) };
  }

  if (!res.success) {
    // Two failures that mean very different things and must not be collapsed:
    // an older daemon (no such handler) still schedules fine and simply cannot
    // answer; a daemon that is not running schedules nothing at all.
    const msg = res.error ?? '';
    if (/Unknown command/i.test(msg)) return { status: 'daemon-older', callerTz };
    if (/not running/i.test(msg)) return { status: 'daemon-down', callerTz };
    return { status: 'unreachable', callerTz, detail: msg };
  }

  const info = (res.data ?? {}) as { resolvedTimezone?: unknown; envTimezone?: unknown };
  const daemonTz = typeof info.resolvedTimezone === 'string' ? info.resolvedTimezone : '';
  if (!daemonTz) {
    return { status: 'unreachable', callerTz, detail: 'daemon-info returned no resolvedTimezone' };
  }
  const daemonEnvTz = typeof info.envTimezone === 'string' ? info.envTimezone : null;

  return daemonTz === callerTz
    ? { status: 'match', callerTz, daemonTz }
    : { status: 'mismatch', callerTz, daemonTz, daemonEnvTz };
}

/** Lines printed under the cron table describing which clock next-fire used. */
export function schedulerClockNotes(clock: SchedulerClock): string[] {
  switch (clock.status) {
    case 'match':
      return [`  Next Fire computed on ${clock.callerTz}; the daemon schedules on the same zone.`];
    case 'mismatch':
      return [
        `  ⚠ CLOCK MISMATCH — the Next Fire column is NOT when these crons will fire.`,
        `    Computed on this shell's zone: ${clock.callerTz}`,
        `    The daemon schedules on:       ${clock.daemonTz}` +
          (clock.daemonEnvTz === null ? ' (TZ unset; host default)' : ` (TZ=${clock.daemonEnvTz})`),
        `    Clock-style schedules (e.g. "0 6 * * *") will fire on the DAEMON's zone.`,
        `    Interval schedules (e.g. "4h") are unaffected.`,
      ];
    case 'daemon-older':
      return [
        `  Next Fire computed on ${clock.callerTz} (this shell's zone).`,
        `  ⚠ Could not compare with the daemon: it is older than this CLI and has no daemon-info.`,
        `    If its zone differs from this shell's, the times above are wrong and cannot be checked here.`,
      ];
    case 'daemon-down':
      return [
        `  Next Fire computed on ${clock.callerTz} (this shell's zone).`,
        `  ⚠ The daemon is not running, so nothing is scheduled and its zone is unknown.`,
      ];
    case 'unreachable':
      return [
        `  Next Fire computed on ${clock.callerTz} (this shell's zone).`,
        `  ⚠ Could not reach the daemon to compare clocks: ${clock.detail}`,
      ];
  }
}
