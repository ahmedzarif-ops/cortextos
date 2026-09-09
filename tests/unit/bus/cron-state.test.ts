import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { updateCronFire, readCronState, parseDurationMs,
  computeNextFireMs, nextFireFromCron, prevFireFromCron,
} from '../../../src/bus/cron-state';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cron-state-test-'));
});

function cleanup() {
  try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
}

describe('parseDurationMs', () => {
  it('parses minutes', () => {
    expect(parseDurationMs('30m')).toBe(30 * 60_000);
  });

  it('parses hours', () => {
    expect(parseDurationMs('6h')).toBe(6 * 3_600_000);
    expect(parseDurationMs('24h')).toBe(24 * 3_600_000);
  });

  it('parses days', () => {
    expect(parseDurationMs('1d')).toBe(86_400_000);
  });

  it('parses weeks', () => {
    expect(parseDurationMs('2w')).toBe(2 * 604_800_000);
  });

  it('returns NaN for cron expressions', () => {
    expect(parseDurationMs('0 8 * * *')).toBeNaN();
    expect(parseDurationMs('*/5 * * * *')).toBeNaN();
  });

  it('returns NaN for empty string', () => {
    expect(parseDurationMs('')).toBeNaN();
  });

  it('returns NaN for unknown unit', () => {
    expect(parseDurationMs('5y')).toBeNaN();
    expect(parseDurationMs('10s')).toBeNaN();
  });
});

describe('readCronState', () => {
  it('returns empty state when file does not exist', () => {
    const state = readCronState(tmpDir);
    expect(state.crons).toEqual([]);
    cleanup();
  });
});

describe('updateCronFire', () => {
  it('creates a record when none exists', () => {
    updateCronFire(tmpDir, 'heartbeat', '6h');
    const state = readCronState(tmpDir);
    expect(state.crons).toHaveLength(1);
    expect(state.crons[0].name).toBe('heartbeat');
    expect(state.crons[0].interval).toBe('6h');
    expect(Date.parse(state.crons[0].last_fire)).not.toBeNaN();
    cleanup();
  });

  it('updates existing record for the same cron name', () => {
    updateCronFire(tmpDir, 'heartbeat', '6h');
    const first = readCronState(tmpDir).crons[0].last_fire;

    // Ensure time advances
    const before = Date.now();
    updateCronFire(tmpDir, 'heartbeat', '6h');
    const second = readCronState(tmpDir).crons[0].last_fire;

    expect(Date.parse(second)).toBeGreaterThanOrEqual(before);
    expect(readCronState(tmpDir).crons).toHaveLength(1); // no duplicate
    cleanup();
  });

  it('accumulates records for different cron names', () => {
    updateCronFire(tmpDir, 'heartbeat', '6h');
    updateCronFire(tmpDir, 'autoresearch', '24h');
    const state = readCronState(tmpDir);
    expect(state.crons).toHaveLength(2);
    const names = state.crons.map(r => r.name);
    expect(names).toContain('heartbeat');
    expect(names).toContain('autoresearch');
    cleanup();
  });

  it('works without interval argument', () => {
    updateCronFire(tmpDir, 'heartbeat');
    const state = readCronState(tmpDir);
    expect(state.crons[0].name).toBe('heartbeat');
    expect(state.crons[0].interval).toBeUndefined();
    cleanup();
  });

  it('survives a read-write-read cycle with correct values', () => {
    updateCronFire(tmpDir, 'inbox-triage', '2h');
    updateCronFire(tmpDir, 'heartbeat', '4h');
    const state = readCronState(tmpDir);
    const inbox = state.crons.find(r => r.name === 'inbox-triage');
    const hb = state.crons.find(r => r.name === 'heartbeat');
    expect(inbox?.interval).toBe('2h');
    expect(hb?.interval).toBe('4h');
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// computeNextFireMs — the one next-fire computation (2026-09-09)
// ---------------------------------------------------------------------------

describe('computeNextFireMs', () => {
  const T0 = Date.parse('2026-09-09T12:00:00.000Z');
  const HOUR = 3_600_000;

  it('counts forward from the reference, not from now', () => {
    // The plain case, and the one the whole change rests on: given a slot, the
    // next slot is one interval later — whatever "now" happens to be.
    expect(computeNextFireMs({ schedule: '1h', referenceMs: T0, nowMs: T0 })).toBe(T0 + HOUR);
    expect(computeNextFireMs({ schedule: '1h', referenceMs: T0, nowMs: T0 + 55 * 60_000 })).toBe(T0 + HOUR);
  });

  it('returns a PAST instant when the slot has already gone by (no clamp)', () => {
    // ⛔ THIS IS THE BEHAVIOUR THE ipc COPY USED TO SUPPRESS. It clamped a past
    // result up to `now + interval`, so the dashboard could never render an
    // overdue cron. An overdue cron must look overdue.
    const late = T0 + 10 * HOUR;
    expect(computeNextFireMs({ schedule: '1h', referenceMs: T0, nowMs: late })).toBe(T0 + HOUR);
    expect(computeNextFireMs({ schedule: '1h', referenceMs: T0, nowMs: late })).toBeLessThan(late);
  });

  describe('skipMissed — the catch-up policy, stated', () => {
    it('PRESERVES THE PHASE across a late fire', () => {
      // The measured incident: a 1h cron due at T0+1h fired 15m late. The next
      // slot must be T0+2h — on the original phase — and NOT fire+1h.
      const due = T0 + HOUR;
      const firedLate = due + 15 * 60_000;
      const next = computeNextFireMs({ schedule: '1h', referenceMs: due, nowMs: firedLate, skipMissed: true });
      expect(next).toBe(T0 + 2 * HOUR);
      expect(next).not.toBe(firedLate + HOUR); // the old behaviour, named so a revert is unambiguous
    });

    it('SKIPS missed slots without bursting — one jump, whole intervals', () => {
      // Six hours asleep on a 1h cron: the next slot is the first future one,
      // still on the original phase. Not six queued fires, and not a re-anchor.
      const due = T0 + HOUR;
      const wokeAt = due + 6 * HOUR + 30 * 60_000;
      const next = computeNextFireMs({ schedule: '1h', referenceMs: due, nowMs: wokeAt, skipMissed: true });
      expect(next).toBe(T0 + 8 * HOUR);
      expect(next).toBeGreaterThan(wokeAt);
      expect((next - due) % HOUR).toBe(0); // still on phase
    });

    it('is strictly in the future even when a slot lands exactly on now', () => {
      // The boundary that a bare Math.ceil gets wrong: `next === now` is not in
      // the future, and returning it makes the cron due immediately again.
      const due = T0;
      const now = T0 + 3 * HOUR;
      const next = computeNextFireMs({ schedule: '1h', referenceMs: due, nowMs: now, skipMissed: true });
      expect(next).toBeGreaterThan(now);
      expect(next).toBe(T0 + 4 * HOUR);
    });

    it('does nothing when the next slot is already in the future', () => {
      const due = T0;
      expect(computeNextFireMs({ schedule: '1h', referenceMs: due, nowMs: T0, skipMissed: true })).toBe(T0 + HOUR);
    });
  });

  it('handles cron expressions, whose phase cannot drift', () => {
    // A cron expression names absolute instants, so there is no phase to keep —
    // only past slots to skip. Asserted as "in the future and matching the
    // expression", never as a hardcoded instant, because these are local-time.
    const expr = '0 * * * *'; // top of every hour
    const plain = computeNextFireMs({ schedule: expr, referenceMs: T0, nowMs: T0 });
    expect(plain).toBeGreaterThan(T0);
    const stale = computeNextFireMs({ schedule: expr, referenceMs: T0, nowMs: T0 + 10 * HOUR, skipMissed: true });
    expect(stale).toBeGreaterThan(T0 + 10 * HOUR);
  });

  it('returns NaN for a schedule that is neither an interval nor a cron expression', () => {
    expect(Number.isNaN(computeNextFireMs({ schedule: 'not-a-schedule', referenceMs: T0, nowMs: T0 }))).toBe(true);
  });
});

describe('prevFireFromCron', () => {
  const HOUR = 3_600_000;
  const T = (iso: string) => Date.parse(iso);

  // ⭐ THE CONTRACT, and it is the only property that makes this usable as a phase
  // anchor: walking back one occurrence and then forward one occurrence is the
  // identity. Everything the scheduler persists for a cron-expression schedule
  // rests on this and on nothing else about the value.
  it('round-trips with nextFireFromCron for every occurrence it names', () => {
    process.env.TZ = 'UTC';
    for (const expr of ['0 * * * *', '*/15 * * * *', '30 4 * * *', '0 7 * * 1', '41 11 1 * *']) {
      const t = nextFireFromCron(expr, T('2026-09-09T12:00:00Z'));
      expect(Number.isNaN(t)).toBe(false);
      const prev = prevFireFromCron(expr, t);
      expect(Number.isNaN(prev)).toBe(false);
      expect(prev).toBeLessThan(t);
      expect(nextFireFromCron(expr, prev)).toBe(t);
    }
  });

  it('steps back from an instant that sits exactly on an occurrence', () => {
    process.env.TZ = 'UTC';
    // An anchor IS an occurrence, so `<=` here would return the instant itself and
    // the round-trip above would then hand back the same slot forever.
    expect(prevFireFromCron('0 * * * *', T('2026-09-09T18:00:00Z'))).toBe(T('2026-09-09T17:00:00Z'));
  });

  it('returns the latest occurrence strictly before a mid-minute instant', () => {
    process.env.TZ = 'UTC';
    expect(prevFireFromCron('0 * * * *', T('2026-09-09T18:00:30Z'))).toBe(T('2026-09-09T18:00:00Z'));
  });

  it('crosses a weekly gap rather than stopping at the nearest day', () => {
    process.env.TZ = 'UTC';
    // 2026-09-14 is a Monday; the previous `0 7 * * 1` is seven days earlier.
    expect(prevFireFromCron('0 7 * * 1', T('2026-09-14T07:00:00Z')))
      .toBe(T('2026-09-07T07:00:00Z'));
  });

  it('returns NaN for a schedule that is not a cron expression', () => {
    expect(Number.isNaN(prevFireFromCron('4h', Date.now()))).toBe(true);
    expect(Number.isNaN(prevFireFromCron('0 * * *', Date.now()))).toBe(true);
  });

  it('does not spin forever on an unsatisfiable expression', () => {
    // 30 February never occurs. The walk is capped, so this must terminate in NaN
    // rather than hang the suite — the same cap nextFireFromCron carries.
    expect(Number.isNaN(prevFireFromCron('0 0 30 2 *', Date.parse('2026-09-09T12:00:00Z')))).toBe(true);
  });
});
