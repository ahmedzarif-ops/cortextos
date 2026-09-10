import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, normalize, sep } from 'node:path';
import setup, {
  isLiteralNormal,
  isUnderRoot,
  liveStateRoot,
  resolveNonStrict,
  walkToResolvable,
} from '../../require-isolated-env.js';

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

describe('the literal-normal gate — city round 2, and it was a hole INSIDE the fix for a hole', () => {
  /**
   * ⛔ MEASURED, not relayed. On a DANGLING link, `lstat` FOLLOWS the link when the
   * path ends in a separator, so `link/` throws ENOENT exactly as an absent name does
   * and the walk resolved it away. Pre-fix behaviour, re-measured from this seat form
   * by form rather than taken from the report:
   *
   *   bare      -> REFUSED  (lstat(link) succeeds, .native throws)
   *   '/'       -> ACCEPTED  ⛔ the hole
   *   '//'      -> ACCEPTED  ⛔ the hole
   *   '/.'      -> REFUSED  (dirname drops the '.', the next cursor IS the link)
   *   '/./x'    -> REFUSED  (two dirname steps reach the link)
   *   '/child'  -> REFUSED
   *
   * ⭐ EXACTLY TWO OF THE SIX FORMS BYPASSED, AND THE OTHER FOUR REFUSED — so the
   * suite agreed with the defect. A relayed list of "all these forms are accepted"
   * would have had me write four arms that pass for the wrong reason; city measured
   * `/.` refusing and said so, and re-measuring here confirmed it.
   * ⇒ **A CORRECTION THAT MAKES A REPORT SMALLER IS WORTH MORE THAN ONE THAT MAKES IT
   * BIGGER, because it is the one nobody is rewarded for sending.**
   *
   * The ruled fix rejects all four non-literal forms up front, so `/.` and `/./x` now
   * refuse for a DIFFERENT reason than they did before — a visible behaviour change,
   * named here so a diff review does not read it as a regression.
   */
  // '//x' is city's seventh form, found AFTER round 2 and preserved by them as a
  // regression probe. It is here rather than only in their report: a probe pinned in a
  // reviewer's report protects one round and nothing after it (the case-14 weakness).
  const forms = ['/', '//', '/.', '/./x', '//x'];

  it('refuses every non-literal form of a dangling link, with its own reason', () => {
    for (const suffix of forms) {
      // RAW STRING CONCATENATION. path.join would normalise the suffix away and the
      // arm would test the bare form four times.
      const raw = join(sandbox, 'dangling') + suffix;
      const v = resolveNonStrict(raw);
      // ⛔ SOFT, so every form is reported. A hard expect inside a loop stops at the
      // FIRST failure, so a mutant that breaks four forms names one — and the arm then
      // cannot tell you which forms it actually covers.
      expect.soft(v.kind, `form ${JSON.stringify(suffix)}`).toBe('not-literal');
    }
  });

  it('the bare dangling link still refuses through the WALK, not the gate', () => {
    expect(isLiteralNormal(join(sandbox, 'dangling'))).toBe(true);
    expect(resolveNonStrict(join(sandbox, 'dangling')).kind).toBe('unresolvable');
  });

  it('isLiteralNormal accepts what mktemp -d produces and the ordinary sandbox forms', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'ctxroot-lit-'));
    expect(isLiteralNormal(fresh)).toBe(true);
    expect(isLiteralNormal(realpathSync.native(fresh))).toBe(true);
    expect(isLiteralNormal(join(sandbox, 'not-created-yet', 'deeper'))).toBe(true);
    rmSync(fresh, { recursive: true, force: true });
    // ⚠ `path.normalize` ALONE IS NOT THE PREDICATE: normalize('/a/b/') === '/a/b/',
    // so an equality-with-normalize test would ADMIT the exact form that caused the
    // hole. The trailing-separator condition is separate for that reason.
    expect(normalize('/a/b/')).toBe('/a/b/');
    expect(isLiteralNormal('/a/b/')).toBe(false);
  });

  it('the WALK\'s own disambiguator is fixed too, exercised directly past the gate', () => {
    // The gate makes this unreachable through resolveNonStrict, and a branch that
    // cannot be reached is a branch nobody measures — so the arm calls the walk.
    // ⭐ '//x' is the one that matters here and it is NOT a trailing-separator ARGUMENT:
    // `dirname('/a/dangling//x')` returns `'/a/dangling/'` — WITH a trailing separator —
    // so the walk MANUFACTURES the trapped form for itself from an argument that did not
    // end in one. That is city's "walk reaches slash-suffixed intermediate cursor", and
    // it is why the probe strip is load-bearing INSIDE the walk rather than merely a
    // second guard on the argument.
    // (For a gate-PASSING argument this is unreachable: a literal-normal path has no
    // doubled separator, and dirname only yields a trailing one from a doubled one.)
    for (const suffix of ['/', '//', '//x']) {
      const raw = join(sandbox, 'dangling') + suffix;
      const v = walkToResolvable(raw);
      expect.soft(v.kind, `walk on ${JSON.stringify(suffix)}`).toBe('unresolvable');
      if (v.kind !== 'unresolvable') continue;
      expect.soft(v.at, `walk on ${JSON.stringify(suffix)}`).toBe(join(sandbox, 'dangling'));
      expect.soft(v.isSymlink, `walk on ${JSON.stringify(suffix)}`).toBe(true);
    }
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
