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
 * every `m h * * *` cron fired five hours early for the ~45 hours until the next restart
 * (2026-09-04T22:58Z to 2026-09-06T20:17Z) — while every status display stayed green, because each
 * process was internally consistent about its own clock. The window is the observed interval
 * between the two restarts; no claim is made about crons outside it.
 *
 * The subtle half, and the reason these tests exist rather than a comment: the OBVIOUS fix — bake in
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` — reintroduces the same bug one step earlier.
 * That call RESPECTS `process.env.TZ`, so generating from a contaminated shell would produce a literal
 * that LOOKS deliberate and is wrong. A wrong value that looks chosen is worse than one that looks
 * inherited, because nobody re-examines it.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveSystemTimezone, proveProcessTimezone, ecosystemCommand } from '../../../src/cli/ecosystem';

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

  it('THROWS on an EMPTY explicit zone instead of silently discovering one', () => {
    // Review finding on this PR: `if (explicit)` is a TRUTHINESS test, so `--timezone ""` is read as
    // "not supplied" and falls through to /etc/localtime discovery. The operator asked for a zone,
    // passed a malformed one, and got a plausible literal they never chose — which is precisely the
    // "wrong value that looks deliberate" failure this whole file exists to prevent, arriving through
    // the argument that was supposed to be the escape hatch from it.
    process.env.TZ = 'UTC';

    // Discrimination guard. Prove discovery WOULD have succeeded on this host, so the throw below is
    // attributable to the empty string. Without this, a host with no zoneinfo symlink makes the
    // pre-fix code throw too, and this test passes for a reason that has nothing to do with the bug.
    const discovered = resolveSystemTimezone();
    expect(discovered).toBeTruthy();

    expect(() => resolveSystemTimezone('')).toThrow();
  });

  it('returns a zone that is actually usable by Intl', () => {
    const zone = resolveSystemTimezone();
    expect(() => new Intl.DateTimeFormat('en-US', { timeZone: zone })).not.toThrow();
    expect(zone).toMatch(/^[A-Za-z]+(\/[A-Za-z0-9_+-]+)*$/);
  });
});

/**
 * THE SECOND DEFECT, FOUND IN REVIEW: validating against the WRONG CONTRACT.
 *
 * `new Intl.DateTimeFormat('en-US', { timeZone: z })` accepting `z` does NOT mean node will RUN in
 * `z`. Both cases below were measured on node v22 before these tests were written; both were accepted
 * by the previous validator and both produce a daemon whose clock is not the one that was asked for.
 *
 * These assert BEHAVIOUR, not the shape of the check, so a future rewrite of the validator is free to
 * satisfy them any way it likes.
 */
/**
 * ⚠ THE REJECTION PATH FOR AN OFFSET STRING IS HOST-DEPENDENT, and three arms here once asserted
 * the wrong half of that. `+01:00` is REJECTED on both hosts, by DIFFERENT mechanisms:
 *
 *   macOS ICU   ACCEPTS it at Intl, and a fresh process then does not honour it
 *               → this module's own "NOT honoured as a process TZ" error.
 *   ubuntu ICU  REJECTS it at Intl outright
 *               → RangeError "Invalid time zone specified: +01:00", raised before this module speaks.
 *
 * The arms asserted the macOS MESSAGE — the mechanism, not the outcome — so they passed on every
 * machine in the fleet and failed on CI. A test that pins which PATH a rejection took is testing the
 * host as much as the code.
 *
 * ⇒ Assert the OUTCOME (rejected), and PRINT the path rather than skipping quietly, so a host
 * difference stays visible instead of being smoothed into "it threw somehow".
 */
function rejectionPathFor(zone: string): 'intl' | 'process-contract' {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return 'process-contract';
  } catch {
    return 'intl';
  }
}

describe('proveProcessTimezone — the process TZ contract, not Intl acceptance', () => {
  it('REJECTS a UTC-offset string, whichever layer catches it', () => {
    const path = rejectionPathFor('+01:00');
    // Loud, never silent: the reader must be able to see which contract did the rejecting here.
    console.log(`    [host] "+01:00" is rejected via: ${path}`);

    expect(() => proveProcessTimezone('+01:00', 'test')).toThrow();

    if (path === 'process-contract') {
      // Only where Intl accepts it does this module get to speak. Where it does, hold it to its words.
      expect(() => proveProcessTimezone('+01:00', 'test')).toThrow(/NOT honoured as a process TZ/);
    }
  });

  it('REJECTS a lower-cased IANA name — the case Intl silently canonicalises and node does not', () => {
    // This is why the fix is not written as "reject offsets". Intl canonicalises "america/chicago" to
    // "America/Chicago" and looks entirely happy; a fresh process with that TZ reports NO zone at all.
    expect(() => proveProcessTimezone('america/chicago', 'test')).toThrow(/NOT honoured as a process TZ/);
  });

  it('names both the requested and the actually-observed zone, so the error is diagnosable', () => {
    // An error that only says "invalid" sends the reader to the spelling. The failure here is not a
    // spelling error, so the message has to carry the discrepancy that makes it one.
    //
    // ⚠ Asserted against the LOWER-CASED IANA name, not against "+01:00". Both hosts accept
    // "america/chicago" at Intl and neither honours it as a process TZ, so this module always
    // produces the message — whereas an offset is intercepted by Intl on some hosts and this
    // module never speaks at all. Choosing the input that exercises the path on EVERY host keeps
    // the coverage instead of skipping it on one, which a `path === 'intl'` guard would have done.
    expect(rejectionPathFor('america/chicago')).toBe('process-contract');
    expect(() => proveProcessTimezone('america/chicago', 'test')).toThrow(/Intl canonicalises it to/);
    expect(() => proveProcessTimezone('america/chicago', 'test')).toThrow(/actually runs in/);
  });

  it('ACCEPTS a plain IANA zone', () => {
    expect(proveProcessTimezone('Europe/Berlin', 'test')).toBe('Europe/Berlin');
  });

  it('ACCEPTS UTC and Etc/GMT+1, which an Intl.supportedValuesOf allowlist would have rejected', () => {
    // The negative control on the rejected design: a membership check against
    // Intl.supportedValuesOf('timeZone') omits both of these, and a fresh process honours both. A
    // validator that rejects UTC is a false block, and a false block gets switched off.
    expect(proveProcessTimezone('UTC', 'test')).toBe('UTC');
    expect(proveProcessTimezone('Etc/GMT+1', 'test')).toBe('Etc/GMT+1');
  });

  it('ACCEPTS a link name whose canonical form differs from the input', () => {
    // US/Central canonicalises to America/Chicago and a fresh process honours it. The check must
    // compare the child against the CANONICAL form, not against the raw input, or this fails wrongly.
    expect(proveProcessTimezone('US/Central', 'test')).toBe('US/Central');
  });

  it('is not fooled by an exported TZ that happens to match the wrong answer', () => {
    // The child must not inherit the parent's TZ. With TZ=Europe/Berlin exported, a bad zone must
    // still be rejected rather than reading back the ambient value and calling it agreement.
    // Uses the lower-cased IANA name for the same reason as the arm above: it reaches this module's
    // own check on every host, so the assertion is about TZ inheritance and not about which ICU the
    // runner shipped with.
    process.env.TZ = 'Europe/Berlin';
    expect(() => proveProcessTimezone('america/chicago', 'test')).toThrow(/NOT honoured as a process TZ/);
    // And the offset must still be rejected under the same contaminated environment, by some layer.
    expect(() => proveProcessTimezone('+01:00', 'test')).toThrow();
  });
});

describe('failed discovery is a LOUD STOP, never an ambient guess', () => {
  it('never returns the ambient Intl zone when no explicit zone is given', () => {
    // THE REGRESSION THIS EXISTS FOR. The previous revision fell back to
    // Intl.DateTimeFormat().resolvedOptions().timeZone — which reads process.env.TZ — and then the
    // caller printed the result as "(system zone)". Exporting a bogus-but-real zone must not be able
    // to reach the output. On a host WITH /etc/localtime the system zone wins; on one without, it
    // must throw. Either way "Asia/Tokyo" must not come back just because it was exported.
    process.env.TZ = 'Asia/Tokyo';
    let result: string | null = null;
    try {
      result = resolveSystemTimezone();
    } catch {
      // Throwing is the correct outcome on a host with no readable /etc/localtime.
      return;
    }
    expect(result).not.toBe('Asia/Tokyo');
  });

  it('directs the reader to --timezone when discovery cannot answer', () => {
    // Only meaningful where discovery genuinely fails; where it succeeds there is nothing to assert.
    if (existsSync('/etc/localtime')) return;
    expect(() => resolveSystemTimezone()).toThrow(/--timezone/);
  });
});

/**
 * THE END OF THE CHAIN.
 *
 * Everything above tests the RESOLVER. None of it proves the resolved value reaches the file the
 * daemon is actually started from — and that wiring is the only reason the resolver exists. Both ends
 * can be correct and fully tested while nothing checks the seam between them.
 */
describe('the emitted daemon env block', () => {
  it('carries TZ as a literal, not as a process.env lookup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cortextos-eco-'));
    const out = join(dir, 'ecosystem.config.js');

    // ⛔ THE GENERATOR RETURNS WITHOUT WRITING A FILE WHEN IT FINDS ZERO AGENTS
    // (`if (agents.length === 0) { console.log('No agents found...'); return; }`), so this arm needs
    // an agent to exist before it can assert anything about the emitted file.
    //
    // ⚠ IT USED TO GET ONE BY ACCIDENT. Project-root resolution falls back to `~/cortextos` when that
    // directory has an `orgs/`, so on any machine with a live cortextOS install the generator
    // silently scanned the DEVELOPER'S REAL FLEET and wrote a file. On a machine without one — every
    // CI runner — it found nothing, returned early, and `existsSync(out)` was false. The arm was
    // therefore green for everyone who ran it and red where nobody looked, and the failure message
    // ("expected false to be true") says nothing about the cause.
    //
    // ⇒ Provide a fixture agent and pin CTX_FRAMEWORK_ROOT to it, so the test depends on nothing
    // outside its own tmpdir. Reproduced before fixing: exporting CTX_FRAMEWORK_ROOT to an empty
    // directory reproduces the CI failure exactly on a machine where the arm otherwise passes.
    mkdirSync(join(dir, 'orgs', 'test-org', 'agents', 'test-agent'), { recursive: true });

    const prevRoot = process.env.CTX_FRAMEWORK_ROOT;
    const prev = process.cwd();
    try {
      process.env.CTX_FRAMEWORK_ROOT = dir;
      process.chdir(dir);
      await ecosystemCommand.parseAsync(['node', 'ecosystem', '--output', out, '--timezone', 'Europe/Berlin']);
    } finally {
      process.chdir(prev);
      if (prevRoot === undefined) delete process.env.CTX_FRAMEWORK_ROOT;
      else process.env.CTX_FRAMEWORK_ROOT = prevRoot;
    }

    expect(existsSync(out)).toBe(true);
    const content = readFileSync(out, 'utf-8');

    // The literal is present with the requested value.
    expect(content).toMatch(/TZ:\s*"Europe\/Berlin"/);

    // And it is NOT the `process.env.X || default` shape every other var uses. This is the assertion
    // that would catch a well-meaning future edit "making TZ consistent with the other env vars".
    expect(content).not.toMatch(/TZ:\s*process\.env\.TZ/);
  });
});
