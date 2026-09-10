import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import setup, { isUnderRoot, liveStateRoot, resolveNonStrict } from '../../require-isolated-env.js';

/**
 * PERMANENT ARMS for the CTX_ROOT containment check (city, PR #47 round 1: "add
 * permanent arms"). Round 1 shipped the check with three holes and no test could have
 * caught them, because the only exercise it had was six one-off shell arms.
 *
 * ⛔⛔ EVERY HAZARDOUS ARGUMENT BELOW IS BUILT AS A RAW STRING WITH `+ '/..'`, NEVER
 * WITH `path.join`. `join` COLLAPSES `..` IN THE SETUP, so the code under test never
 * receives the thing under test and BOTH ARMS AGREE — a green that means nothing.
 * That is not hypothetical: it is exactly how the first measurement of this defect was
 * nearly reported as "no disagreement" (social, 2026-09-10).
 * ⭐ A TEST WHOSE SETUP NORMALISES THE THING UNDER TEST PROVES NOTHING, and it fails in
 * the reassuring direction.
 *
 * NOTHING HERE WRITES INTO THE LIVE STATE TREE. The live-tree arms build a SYMLINK in a
 * temp dir that POINTS at the live root and never follow it for a write — resolution is
 * a read.
 */

let SP: string;          // temp sandbox, itself realpath'd (/var -> /private/var)
let sandbox: string;     // <SP>/sandbox
let outside: string;     // <SP>/outside  — the escape target
let fakeLive: string;    // <SP>/fake-live — stands in for ~/.cortextos in the pure arms

beforeAll(() => {
  SP = realpathSync(mkdtempSync(join(tmpdir(), 'ctxroot-arms-')));
  sandbox = join(SP, 'sandbox');
  outside = join(SP, 'outside');
  fakeLive = join(SP, 'fake-live');
  mkdirSync(sandbox);
  mkdirSync(outside);
  mkdirSync(fakeLive);
  mkdirSync(join(fakeLive, 'default'), { recursive: true });
  writeFileSync(join(outside, 'marker'), 'physical target\n');
  symlinkSync(outside, join(sandbox, 'escape'));                         // resolvable, escapes
  symlinkSync(join(SP, 'no-such-target'), join(sandbox, 'dangling'));    // DANGLING
  symlinkSync(join(fakeLive, 'default'), join(sandbox, 'into-live'));    // points at the "live" root
});

afterAll(() => {
  rmSync(SP, { recursive: true, force: true });
});

describe('resolveNonStrict — the seven cases', () => {
  it('1. an ordinary missing descendant resolves against its deepest real ancestor', () => {
    const v = resolveNonStrict(join(sandbox, 'not-created-yet', 'deeper'));
    expect(v).toEqual({ kind: 'resolved', path: join(sandbox, 'not-created-yet', 'deeper') });
  });

  it('2. a DANGLING symlink is REFUSED, not resolved away', () => {
    const v = resolveNonStrict(join(sandbox, 'dangling'));
    expect(v.kind).toBe('unresolvable');
    if (v.kind !== 'unresolvable') throw new Error('unreachable');
    expect(v.at).toBe(join(sandbox, 'dangling'));
    expect(v.isSymlink).toBe(true);
  });

  it('3. a missing name UNDER a dangling symlink names the LINK, not the leaf', () => {
    const v = resolveNonStrict(join(sandbox, 'dangling', 'child'));
    expect(v.kind).toBe('unresolvable');
    if (v.kind !== 'unresolvable') throw new Error('unreachable');
    // ⛔ The leaf is the absent name; the LINK is the thing that cannot be resolved.
    // Reporting the leaf would send an operator to create a directory that changes
    // nothing.
    expect(v.at).toBe(join(sandbox, 'dangling'));
  });

  it("4. a '..' through a symlink is rejected on the STRING, before any resolver sees it", () => {
    // RAW STRING. `join(sandbox, 'escape', '..', 'outside')` would collapse to
    // `<SP>/sandbox/outside` here in the setup and the arm would test nothing.
    const raw = sandbox + sep + 'escape' + sep + '..' + sep + 'outside';
    expect(raw).toContain(`${sep}..${sep}`);
    expect(resolveNonStrict(raw)).toEqual({ kind: 'dotdot-component' });
  });

  it('5. an escape through a symlink WITHOUT `..` resolves to its PHYSICAL target', () => {
    const v = resolveNonStrict(join(sandbox, 'escape', 'leaf'));
    expect(v).toEqual({ kind: 'resolved', path: join(outside, 'leaf') });
    // and that physical answer is what makes containment able to catch it
    expect(isUnderRoot((v as { path: string }).path, sandbox)).toBe(false);
  });

  it('6. a plain existing directory resolves to itself', () => {
    expect(resolveNonStrict(sandbox)).toEqual({ kind: 'resolved', path: sandbox });
  });

  it('7. a relative path is refused rather than resolved against the cwd', () => {
    expect(resolveNonStrict('relative/sandbox')).toEqual({ kind: 'not-absolute' });
    expect(resolveNonStrict('.')).toEqual({ kind: 'not-absolute' });
  });
});

describe('containment', () => {
  it('CATCHES a symlink into the live root carrying a MISSING TAIL — the round-1 bypass', () => {
    // Round 1 fell back to the RAW string when both the target and its immediate
    // parent were absent, so this exact shape was admitted.
    const raw = join(sandbox, 'into-live', 'a', 'b');
    const v = resolveNonStrict(raw);
    expect(v.kind).toBe('resolved');
    if (v.kind !== 'resolved') throw new Error('unreachable');
    expect(v.path).toBe(join(fakeLive, 'default', 'a', 'b'));
    expect(isUnderRoot(v.path, fakeLive)).toBe(true);
  });

  it('does NOT match a sibling whose name merely begins with the root name', () => {
    expect(isUnderRoot(`${fakeLive}-backup/x`, fakeLive)).toBe(false);
    expect(isUnderRoot(fakeLive, fakeLive)).toBe(true);
    expect(isUnderRoot(join(fakeLive, 'x'), fakeLive)).toBe(true);
  });

  it('liveStateRoot resolves the real root with the SAME method the candidate uses', () => {
    // ⛔ Both sides must be `.native`. Comparing a resolved candidate against an
    // UNRESOLVED root is the same class of error as comparing an epoch to a string:
    // two values that look comparable and are not.
    const literal = join(homedir(), '.cortextos');
    const live = liveStateRoot();
    let expected: string;
    try {
      expected = realpathSync.native(literal);
    } catch {
      expected = literal; // no live tree on this machine — the literal is the safe floor
    }
    expect(live).toBe(expected);
  });
});

/**
 * END-TO-END ARMS against the REAL exported `setup()` and the REAL live root.
 * These are the arms that would have failed at round 1.
 */
describe('setup() — end to end, against the operator\'s real live root', () => {
  const saved = process.env.CTX_ROOT;
  const restore = () => {
    if (saved === undefined) delete process.env.CTX_ROOT;
    else process.env.CTX_ROOT = saved;
  };
  afterAll(restore);

  const withRoot = (value: string | undefined, fn: () => void) => {
    if (value === undefined) delete process.env.CTX_ROOT;
    else process.env.CTX_ROOT = value;
    try {
      fn();
    } finally {
      restore();
    }
  };

  it('REFUSES a missing tail under a symlink that points into ~/.cortextos', () => {
    const link = join(SP, 'live-link');
    symlinkSync(liveStateRoot(), link);
    withRoot(join(link, 'never-created', 'deeper'), () => {
      expect(() => setup()).toThrow(/points INSIDE the live state tree/);
    });
  });

  it('REFUSES an unset root', () => {
    withRoot(undefined, () => expect(() => setup()).toThrow(/CTX_ROOT is NOT SET/));
  });

  it('REFUSES a relative root', () => {
    withRoot('some/relative/dir', () => expect(() => setup()).toThrow(/CTX_ROOT is RELATIVE/));
  });

  it("REFUSES a '..' component", () => {
    withRoot(sandbox + sep + 'escape' + sep + '..' + sep + 'outside', () =>
      expect(() => setup()).toThrow(/contains a '\.\.' component/),
    );
  });

  it('REFUSES a dangling symlink', () => {
    withRoot(join(sandbox, 'dangling'), () => expect(() => setup()).toThrow(/cannot be resolved/));
  });

  it('MISFIRE CHECK — an ordinary mktemp-style sandbox PASSES', () => {
    // /var -> /private/var on macOS: a root behind a system symlink must NOT be
    // refused. A check that rejects everything reads exactly like a check that works.
    const fresh = mkdtempSync(join(tmpdir(), 'ctxroot-ok-'));
    withRoot(fresh, () => expect(() => setup()).not.toThrow());
    withRoot(join(fresh, 'not-created-yet'), () => expect(() => setup()).not.toThrow());

    // ⛔ AND A ROOT REACHED THROUGH A SYMLINK MUST PASS TOO. On macOS `tmpdir()` is
    // already behind `/var -> /private/var`, but on Linux it is not — so the divergence
    // is CONSTRUCTED here rather than assumed, and the arm means the same thing on both.
    // This is the arm that fails if containment is ever rewritten as `pwd` vs `pwd -P`:
    // that form refuses every root behind a symlink, and refusing everything reads
    // exactly like working.
    const linked = join(SP, 'linked-sandbox');
    symlinkSync(fresh, linked);
    expect(linked).not.toBe(realpathSync.native(linked)); // the divergence is really there
    withRoot(linked, () => expect(() => setup()).not.toThrow());
    withRoot(join(linked, 'not-created-yet'), () => expect(() => setup()).not.toThrow());

    rmSync(fresh, { recursive: true, force: true });
  });
});
