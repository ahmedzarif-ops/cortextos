/**
 * tests/unit/cli/ecosystem-timezone.test.ts
 *
 * THE DEFECT THIS GUARDS
 * ----------------------
 * The generated PM2 ecosystem file writes most env vars as `process.env.X || 'default'`, so PM2 picks
 * them up from whoever runs `pm2 start`. Applying that pattern to TZ is not a convenience: cron
 * schedules are matched against process-LOCAL time, so THE DAEMON'S TIMEZONE IS THE FLEET'S SCHEDULE.
 *
 * On 2026-09-04 a daemon was restarted from a terminal with `TZ=UTC` exported. It inherited that, and
 * every `m h * * *` cron fired five hours early for nine days — while every status display stayed
 * green, because each process was internally consistent about its own clock.
 *
 * The subtle half, and the reason these tests exist rather than a comment: the OBVIOUS fix — bake in
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` — reintroduces the same bug one step earlier.
 * That call RESPECTS `process.env.TZ`, so generating from a contaminated shell would produce a literal
 * that LOOKS deliberate and is wrong. A wrong value that looks chosen is worse than one that looks
 * inherited, because nobody re-examines it.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'fs';
import { resolveSystemTimezone } from '../../../src/cli/ecosystem';

const originalTZ = process.env.TZ;
afterEach(() => {
  if (originalTZ === undefined) delete process.env.TZ;
  else process.env.TZ = originalTZ;
});

describe('resolveSystemTimezone', () => {
  it('IGNORES an exported TZ — the whole point of the change', () => {
    // This is the 2026-09-04 condition reproduced exactly.
    const clean = resolveSystemTimezone();
    process.env.TZ = 'UTC';
    const contaminated = resolveSystemTimezone();

    expect(contaminated).toBe(clean);
  });

  it('is not merely returning whatever Intl says, which is the trap', () => {
    // Negative control. If this ever starts passing by accident because the two agree, the test above
    // proves nothing — so pin the DIFFERENCE, on hosts where the system zone is not UTC.
    process.env.TZ = 'UTC';
    const intlSays = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const resolved = resolveSystemTimezone();

    if (existsSync('/etc/localtime') && resolved !== 'UTC') {
      expect(intlSays).toBe('UTC');        // Intl was contaminated...
      expect(resolved).not.toBe(intlSays); // ...and we did not follow it.
    } else {
      // A genuinely-UTC host, or no zoneinfo symlink. Nothing to discriminate; say so rather than
      // asserting something vacuous that would read as a pass.
      expect(resolved).toBe(intlSays);
    }
  });

  it('honours an explicit zone over the system one', () => {
    expect(resolveSystemTimezone('Europe/Berlin')).toBe('Europe/Berlin');
  });

  it('an explicit zone beats even a contaminated environment', () => {
    process.env.TZ = 'UTC';
    expect(resolveSystemTimezone('Asia/Tokyo')).toBe('Asia/Tokyo');
  });

  it('THROWS on an invalid zone rather than silently falling back', () => {
    // A bad zone must fail at generation time, loudly. Falling back to a default here would write a
    // plausible-looking literal nobody asked for — and the failure would then surface as crons firing
    // at the wrong hour, days later, with no trace back to this decision.
    expect(() => resolveSystemTimezone('Not/AZone')).toThrow();
  });

  it('returns a zone that is actually usable by Intl', () => {
    const zone = resolveSystemTimezone();
    expect(() => new Intl.DateTimeFormat('en-US', { timeZone: zone })).not.toThrow();
    expect(zone).toMatch(/^[A-Za-z]+(\/[A-Za-z0-9_+-]+)*$/);
  });
});
