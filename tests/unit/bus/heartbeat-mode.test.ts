/**
 * detectDayNightMode — the timezone default and the configured day window.
 *
 * ⛔ WHAT WAS HERE BEFORE, AND WHY IT CAUGHT NOTHING (sentinel, 2026-09-04):
 * tests/sprint7-environment.test.ts asserts
 *
 *     expect(['day', 'night']).toContain(detectDayNightMode('UTC'))
 *
 * with the comment "we can't control the actual time, but we can test the function signature".
 * That assertion CANNOT FAIL — it checks the function returns one of the only two values its type
 * permits. It passed every day while the function reported DAY at 05:48 in the org's own timezone.
 * A suite that cannot tell the fixed code from the broken code is not coverage of it.
 *
 * The fix is not a better assertion, it is a CONTROLLED CLOCK: vi.setSystemTime pins the instant, so
 * every case below has one correct answer and fails loudly when it is wrong.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { detectDayNightMode, DEFAULT_DAY_START, DEFAULT_DAY_END } from '../../../src/bus/heartbeat';

// 2026-09-04 is CDT (UTC-5) in America/Chicago and JST (UTC+9) in Asia/Tokyo.
// 10:48Z -> Chicago 05:48 (NIGHT) and Tokyo 19:48 (DAY). One instant, two answers: that is what
// makes the override case discriminating rather than decorative.
const T_0548_CHICAGO = new Date('2026-09-04T10:48:00Z');
// 2026-09-05T04:00Z -> Chicago 23:00. Under the OLD hardcoded 8-22 this was night; the org declares
// day until 00:00, so it must be DAY.
const T_2300_CHICAGO = new Date('2026-09-05T04:00:00Z');

const CHI = 'America/Chicago';

describe('detectDayNightMode', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('THE CASE THAT WAS WRONG: 05:48 America/Chicago is NIGHT', () => {
    vi.setSystemTime(T_0548_CHICAGO);
    expect(detectDayNightMode(CHI, '08:00', '00:00')).toBe('night');
  });

  it('CONTROL for the above: the same instant in UTC is DAY — the bug was the default, not the clock', () => {
    // 10:48Z is inside 08:00-00:00 UTC. This is exactly what the fleet was reporting, and it shows
    // the old behaviour was a plausible answer to the wrong question rather than a broken clock.
    vi.setSystemTime(T_0548_CHICAGO);
    expect(detectDayNightMode('UTC', '08:00', '00:00')).toBe('day');
  });

  it('THE WINDOW CASE: 23:00 America/Chicago is DAY (the old hardcoded 8-22 said night)', () => {
    vi.setSystemTime(T_2300_CHICAGO);
    expect(detectDayNightMode(CHI, '08:00', '00:00')).toBe('day');
  });

  it('a --timezone override MOVES the field: same instant, Tokyo is DAY while Chicago is NIGHT', () => {
    vi.setSystemTime(T_0548_CHICAGO);
    expect(detectDayNightMode(CHI, '08:00', '00:00')).toBe('night');
    expect(detectDayNightMode('Asia/Tokyo', '08:00', '00:00')).toBe('day');
  });

  it('MISSING config falls back to the DECLARED 08:00-00:00, not to the old 8-22', () => {
    // The whole point of the second defect: a caller that supplies no window must get the org's
    // declared hours. 23:00 is the hour that separates the two — 8-22 says night, 08:00-00:00 says day.
    vi.setSystemTime(T_2300_CHICAGO);
    expect(detectDayNightMode(CHI)).toBe('day');
    expect(detectDayNightMode(CHI, undefined, undefined)).toBe('day');
    expect(DEFAULT_DAY_START).toBe('08:00');
    expect(DEFAULT_DAY_END).toBe('00:00');
  });

  it('an UNPARSEABLE window falls back to the declared default rather than to always-night', () => {
    vi.setSystemTime(T_2300_CHICAGO);
    expect(detectDayNightMode(CHI, 'garbage', '')).toBe('day');
    expect(detectDayNightMode(CHI, '25:99', 'nope')).toBe('day');
  });

  it('an INVALID timezone falls back to UTC but KEEPS the configured window', () => {
    // The old code fell back to UTC *and* to 8-22. Losing the offset is unavoidable; losing the
    // org's declared hours as well is not, and it made one fault look like two.
    vi.setSystemTime(T_2300_CHICAGO); // 04:00Z
    expect(detectDayNightMode('Invalid/Zone', '08:00', '00:00')).toBe('night'); // 04:00 UTC
    expect(detectDayNightMode('Invalid/Zone', '00:00', '08:00')).toBe('day');   // window respected
  });

  it('honours MINUTES, not just hours — 08:30 start means 08:15 is still night', () => {
    // day_mode_start is a free-form config string and "08:30" is legal. An hours-only parser would
    // floor it and be silently wrong for thirty minutes every day.
    vi.setSystemTime(new Date('2026-09-04T13:15:00Z')); // Chicago 08:15
    expect(detectDayNightMode(CHI, '08:00', '00:00')).toBe('day');
    expect(detectDayNightMode(CHI, '08:30', '00:00')).toBe('night');
  });

  it('a window that WRAPS midnight works in both halves (a 22:00-06:00 night-shift org)', () => {
    vi.setSystemTime(T_2300_CHICAGO);                    // Chicago 23:00
    expect(detectDayNightMode(CHI, '22:00', '06:00')).toBe('day');
    vi.setSystemTime(T_0548_CHICAGO);                    // Chicago 05:48
    expect(detectDayNightMode(CHI, '22:00', '06:00')).toBe('day');
    vi.setSystemTime(new Date('2026-09-04T17:00:00Z')); // Chicago 12:00 — outside that window
    expect(detectDayNightMode(CHI, '22:00', '06:00')).toBe('night');
  });

  it('a degenerate window (start === end) is always DAY, and says so rather than always-night', () => {
    vi.setSystemTime(T_0548_CHICAGO);
    expect(detectDayNightMode(CHI, '00:00', '00:00')).toBe('day');
  });

  it('the function can return BOTH values for one timezone — the old suite never proved this', () => {
    // The negative control the previous test was missing entirely. Without it, every assertion
    // above is satisfiable by a function that returns a constant.
    vi.setSystemTime(T_0548_CHICAGO);
    const a = detectDayNightMode(CHI, '08:00', '00:00');
    vi.setSystemTime(new Date('2026-09-04T17:00:00Z'));
    const b = detectDayNightMode(CHI, '08:00', '00:00');
    expect(a).toBe('night');
    expect(b).toBe('day');
    expect(a).not.toBe(b);
  });
});
