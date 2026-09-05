/**
 * tests/unit/utils/scheduler-clock.test.ts
 *
 * THE DEFECT UNDER TEST
 * ---------------------
 * `nextFireFromCron` matches a cron expression against process-LOCAL time — it
 * compares the cron fields to `d.getHours()`, `d.getDate()` and `d.getDay()`
 * (src/daemon/cron-scheduler.ts).  The daemon runs that function in its own
 * process and fires on ITS clock.  `bus list-crons` runs the SAME function in
 * the CALLER's process to render the "Next Fire" column, so it answers on the
 * CALLER's clock.
 *
 * When the two processes were launched under different TZ values the column
 * shows a time the scheduler will never use.  Observed in production
 * 2026-09-05: the same cron `0 6 * * *` rendered `06:00 UTC` from a TZ=UTC
 * shell and `11:00 UTC` from an America/Chicago shell against one unchanged
 * daemon.
 *
 * The failure is silent, and silence is the whole problem: each process is
 * internally consistent, so neither side can detect the divergence alone, and
 * the column reads as authoritative in both.  Worse, it fails in the
 * REASSURING direction — a verifier whose own shell matches the zone the
 * daemon is *supposed* to have reads the expected value whether or not the
 * daemon was ever fixed.
 *
 * WHAT THESE TESTS PIN
 * --------------------
 * Not the arithmetic (unchanged, and deliberately still caller-local here —
 * recomputing in the daemon's zone is a separate, owner-gated decision).  What
 * is pinned is that the divergence CANNOT BE SILENT:
 *   - agreement is stated, so "no warning" means "checked and agreed" rather
 *     than "never looked";
 *   - disagreement is loud and names both zones;
 *   - each way of FAILING TO COMPARE stays distinguishable from the others and
 *     from a successful comparison, because "could not check" and "checked and
 *     matched" are different facts and collapsing them rebuilds the defect one
 *     layer up.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();
vi.mock('../../../src/daemon/ipc-server.js', () => ({
  IPCClient: class {
    send(req: unknown) { return mockSend(req); }
  },
}));

import { describeSchedulerClock, schedulerClockNotes } from '../../../src/utils/scheduler-clock';

const callerTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Any zone that is definitely not the one this test process is running in. */
const otherTz = () => (callerTz() === 'UTC' ? 'America/Chicago' : 'UTC');

beforeEach(() => {
  mockSend.mockReset();
});

describe('describeSchedulerClock', () => {
  it('reports a match when the daemon resolves the same zone as the caller', async () => {
    mockSend.mockResolvedValue({
      success: true,
      data: { resolvedTimezone: callerTz(), envTimezone: callerTz() },
    });

    const clock = await describeSchedulerClock('default');

    expect(clock.status).toBe('match');
    expect(clock.callerTz).toBe(callerTz());
  });

  it('reports a mismatch, carrying BOTH zones, when the daemon is on another clock', async () => {
    const daemonTz = otherTz();
    mockSend.mockResolvedValue({
      success: true,
      data: { resolvedTimezone: daemonTz, envTimezone: daemonTz },
    });

    const clock = await describeSchedulerClock('default');

    expect(clock.status).toBe('mismatch');
    // Both are required: a warning that names only one zone cannot tell the
    // reader which of the two times in front of them is the real one.
    expect(clock).toMatchObject({ callerTz: callerTz(), daemonTz });
  });

  it('distinguishes an UNSET daemon TZ from an explicitly-set one', async () => {
    // These are different situations with different fixes.  A daemon launched
    // with TZ=UTC was told to be UTC; a daemon with no TZ merely inherited the
    // host default and will change zone the next time the host does.  Reporting
    // only the resolved zone erases that difference permanently, because it
    // cannot be recovered after the fact.
    mockSend.mockResolvedValue({
      success: true,
      data: { resolvedTimezone: otherTz(), envTimezone: null },
    });

    const clock = await describeSchedulerClock('default');

    expect(clock).toMatchObject({ status: 'mismatch', daemonEnvTz: null });
    expect(schedulerClockNotes(clock).join('\n')).toContain('TZ unset');
  });

  it('classifies an OLDER daemon (no daemon-info handler) as its own outcome', async () => {
    // The daemon returns `Unknown command: <type>` for a type it does not know.
    // Such a daemon schedules perfectly well and simply cannot answer — which
    // is not the same as a daemon that is down, and must not be reported as
    // agreement.
    mockSend.mockResolvedValue({ success: false, error: 'Unknown command: daemon-info' });

    const clock = await describeSchedulerClock('default');

    expect(clock.status).toBe('daemon-older');
  });

  it('classifies a daemon that is not running as its own outcome', async () => {
    mockSend.mockResolvedValue({
      success: false,
      error: 'Daemon is not running. Start it with: cortextos start',
    });

    const clock = await describeSchedulerClock('default');

    expect(clock.status).toBe('daemon-down');
  });

  it('survives a REJECTED send rather than letting list-crons die', async () => {
    // IPCClient.send REJECTS on timeout (and on socket errors other than
    // ECONNREFUSED/ENOENT) instead of resolving an error envelope.  Without a
    // catch here, a wedged daemon would take the whole command down — a worse
    // outcome than not knowing the daemon's zone, and one that would arrive
    // exactly when someone is trying to diagnose the daemon.
    mockSend.mockRejectedValue(new Error('IPC request timed out'));

    const clock = await describeSchedulerClock('default');

    expect(clock.status).toBe('unreachable');
    expect(clock).toMatchObject({ detail: expect.stringContaining('timed out') });
  });

  it('treats a successful response with no zone in it as unreachable, not as a match', async () => {
    // A malformed or truncated payload must never fall through to "agreed".
    // The safe default for an unanswerable question is "I could not check".
    mockSend.mockResolvedValue({ success: true, data: { pid: 123 } });

    const clock = await describeSchedulerClock('default');

    expect(clock.status).toBe('unreachable');
  });

  it('asks the daemon for daemon-info and identifies itself', async () => {
    mockSend.mockResolvedValue({
      success: true,
      data: { resolvedTimezone: callerTz(), envTimezone: null },
    });

    await describeSchedulerClock('default');

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'daemon-info', source: expect.stringContaining('list-crons') }),
    );
  });
});

describe('schedulerClockNotes', () => {
  it('makes a mismatch unmissable and says which schedules it affects', async () => {
    const notes = schedulerClockNotes({
      status: 'mismatch',
      callerTz: 'America/Chicago',
      daemonTz: 'UTC',
      daemonEnvTz: 'UTC',
    }).join('\n');

    expect(notes).toContain('CLOCK MISMATCH');
    expect(notes).toContain('America/Chicago');
    expect(notes).toContain('UTC');
    // Interval schedules ("4h") are computed from last_fired_at and are NOT
    // affected. Saying only "the times are wrong" would over-warn and get the
    // whole notice discounted, which is how a true warning stops working.
    expect(notes).toMatch(/Interval schedules.*unaffected/s);
  });

  it('states agreement explicitly, so silence never has to be interpreted', async () => {
    const notes = schedulerClockNotes({
      status: 'match',
      callerTz: 'UTC',
      daemonTz: 'UTC',
    }).join('\n');

    expect(notes).toContain('UTC');
    expect(notes).not.toContain('MISMATCH');
  });

  it('never claims agreement on any outcome where the comparison did not happen', async () => {
    // The load-bearing assertion of this file.  Each non-comparing outcome must
    // announce that it could not check.  If any of them rendered like the match
    // case, the tool would report a silent green for a question it never asked
    // — which is the original defect wearing a new coat.
    const uncompared = [
      schedulerClockNotes({ status: 'daemon-older', callerTz: 'UTC' }),
      schedulerClockNotes({ status: 'daemon-down', callerTz: 'UTC' }),
      schedulerClockNotes({ status: 'unreachable', callerTz: 'UTC', detail: 'boom' }),
    ];

    for (const notes of uncompared) {
      const text = notes.join('\n');
      expect(text).toContain('⚠');
      expect(text).not.toMatch(/schedules on the same zone/);
    }

    // And they must not be mistakable for EACH OTHER either: a daemon that is
    // merely old still fires crons, a daemon that is down fires nothing, and an
    // unreachable one is an open question. Three states, three messages.
    const rendered = uncompared.map(n => n.join('\n'));
    expect(new Set(rendered).size).toBe(3);
  });
});
