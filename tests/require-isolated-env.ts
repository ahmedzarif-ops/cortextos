import { lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, sep } from 'node:path';

/**
 * Suite precondition: CTX_FRAMEWORK_ROOT must not be set in the environment the
 * suite is launched with.
 *
 * ⛔ WHY THESE THREE AND NOT ELEVEN. Measured 2026-09-10 by bisecting the 54
 * non-baseline variables of a live agent shell against each affected file, both
 * controls pre-registered and both firing (none -> rc 0, all -> rc 1):
 *
 *   tests/unit/bus/hooks.test.ts                    CTX_FRAMEWORK_ROOT
 *   tests/unit/cli/bus-crons.test.ts                CTX_AGENT_DIR, CTX_FRAMEWORK_ROOT, CTX_PROJECT_ROOT
 *   tests/integration/upgrade-cron-teaching-cli.ts  CTX_AGENT_DIR, CTX_FRAMEWORK_ROOT, CTX_PROJECT_ROOT
 *
 * Each named variable is INDIVIDUALLY SUFFICIENT to fail its file, and with all
 * three removed every one of the other 51 restored together passes. That last run
 * is what makes this THE cause set rather than A cause: a bisect terminates on the
 * first witness it finds, so the first pass returned CTX_AGENT_DIR alone and
 * "all-others-restored" still FAILED — two more were hiding behind it. The set was
 * closed by peeling: bisect, remove, re-bisect, until the remaining pool passes.
 *
 * ⛔ `CTX_ROOT` IS NOT AMONG THE CAUSES, which is why this is a named list and not
 * a `CTX_*` prefix. A prefix guard would be four times wider than the measurement
 * and would still be a guess; a named list can be checked against the file that
 * recorded how it was derived.
 *
 * ⛔ PRESENCE IS THE TRIGGER, NOT THE TARGET — AND THE FIRST VERSION OF THIS FILE
 * GOT THAT WRONG. It exempted a non-existent path and a path under the OS temp dir,
 * on the assumption that only a REAL framework tree could contaminate a run. Both
 * exemptions were then measured and both still fail: a fixture-internal value under
 * `tmpdir()` gave 7 failed / 12 passed, and so did `/definitely/not/here`. The
 * mechanism is that these files read the variable and branch on it AT ALL, so any
 * inherited value is a value the test did not choose. The exemption would have
 * shipped a documented hole in the exact gate it was written to close.
 * (Caught because an arm pre-registered to PASS came back FAIL.)
 *
 * A test that needs a fixture root sets `process.env.CTX_FRAMEWORK_ROOT` itself,
 * in-process, after this setup has already run — that is unaffected, and it is how
 * tests/unit/bus/agents.test.ts and approval.test.ts already do it.
 *
 * ⛔ IT REFUSES; IT DOES NOT UNSET. A suite that neutralises its own environment
 * goes green and leaves the misconfiguration in place for the next thing that reads
 * that variable — the operator is never told. The refusal is the whole feature: a
 * loud failure BEFORE collection, naming the exact command to re-run with.
 *
 * ⭐ THE STATES THIS KEEPS APART, and the reason it is a setup failure rather than
 * an assertion. With a value inherited, the affected files fail with texts like
 * `expected 'action' to be 'hook_fire'`: ordinary-looking unit regressions in
 * unrelated code. They are LOUD AND MISATTRIBUTED, which is worse than silent —
 * someone debugs the product instead of the environment.
 */
/**
 * Measured, not guessed. Adding a name here without a bisect that records WHY makes
 * this list exactly the prefix guard it exists instead of.
 */
const CONTAMINATING = ['CTX_AGENT_DIR', 'CTX_FRAMEWORK_ROOT', 'CTX_PROJECT_ROOT'] as const;

/**
 * ⛔⛔ CTX_ROOT IS A POSITIVE REQUIREMENT, NOT A BLOCKLIST ENTRY — AND THE COMMENT
 * THAT USED TO SIT ABOVE THE LIST SAID THE OPPOSITE IN TERMS.
 *
 * It read: "CTX_ROOT IS NOT AMONG THE CAUSES, which is why this is a named list and
 * not a prefix sweep." That sentence is TRUE ABOUT TEST FAILURES and FALSE ABOUT THE
 * HAZARD. The list above came from bisecting for which variables make the suite go
 * RED. CTX_ROOT makes nothing red. It makes the suite PASS while writing into a tree
 * somebody is using.
 * ⭐ A CAUSE SET DERIVED FROM WHAT MAKES A TEST FAIL CANNOT CONTAIN A VARIABLE WHOSE
 * EFFECT IS GREEN. A blocklist built from a red-bisect is blind to it by construction,
 * so no amount of adding names fixes the shape — only a requirement does.
 *
 * MEASURED 2026-09-10, both directions:
 *   CTX_ROOT=<tmp>  -> cron-scheduler.test.ts passes 35/35 AND creates
 *                      <tmp>/.cortextOS/state/agents/test-agent
 *   CTX_ROOT=<live> -> the same writes land in ~/.cortextos/default. alice/ and bob/,
 *                      DELETED UNDER OWNER APPROVAL, were recreated by ordinary runs.
 *
 * ⛔ AND ABSENT IS NOT SAFE EITHER, which is why this demands a value rather than
 * merely rejecting a bad one. src/bus/crons.ts:43 and :376 both read
 *     process.env.CTX_ROOT ?? process.cwd()
 * DIRECTLY — they never call resolveEnv, so env.ts's homedir default is irrelevant to
 * that write path. Unset therefore does not mean "sandboxed"; it means "write into the
 * repository". Measured: a run with every CTX_* stripped created
 * <repo>/.cortextOS/state/agents/test-agent, and the cortextos checkout already carried
 * alice, bob and test-agent from an earlier hook-driven push.
 *
 * ⇒ THE ORDINARY PATHS PASS BY CONSTRUCTION, NOT BY LUCK: package.json's test scripts
 * and the pre-push hook both set CTX_ROOT to a fresh mktemp before vitest. This refusal
 * therefore fires only on a HAND-RUN with a live or absent root — which is exactly the
 * path that had no protection.
 * ⚠ Deliberately NOT a default applied here in setup. A quiet default is the shape that
 * caused this: it would make every caller look isolated while telling nobody which
 * callers were not.
 */
// The echoed command is shared by BOTH refusals. One text, two callers — name the
// invocation at runtime rather than letting each branch reconstruct it (a shared
// sentence whose caller differs is how the slow lane once told operators to re-run the
// fast one).
function originalInvocation(): string {
  const shellQuote = (a: string): string =>
    /^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
  const invoked = process.argv.slice(1).filter((a) => a !== '--');
  return invoked.length > 0 ? `node ${invoked.map(shellQuote).join(' ')}` : 'npm test';
}

const CTX_ROOT_HELP =
  'Set it to a throwaway directory for the run, e.g.  CTX_ROOT=$(mktemp -d)';

/**
 * ⛔⛔ CONTAINMENT IS A PHYSICAL QUESTION, AND EVERY CONVENIENT INSTRUMENT ANSWERS
 * IT LEXICALLY. THE FIRST VERSION OF THIS CHECK USED TWO OF THEM AND HAD THREE HOLES.
 *
 * It resolved with `realpathSync(raw)`, fell back to `join(realpathSync(dirname(raw)),
 * basename(raw))`, and then FELL BACK TO THE RAW STRING when even the parent was
 * absent. Measured by city at round 1 (`tests/require-isolated-env.ts:129`): a missing
 * tail under a symlink into `~/.cortextos`, a RELATIVE path, and a `..` path all
 * PASSED the real setup function.
 * ⭐ The raw fallback is the shape to remember: when resolution FAILS, the check
 * compared the unresolved argument — so the harder the path was to resolve, the more
 * likely it was to be admitted. A guard whose weakest input takes its weakest path.
 *
 * ⛔ AND `..` THROUGH A SYMLINK IS AN ESCAPE VECTOR IN ITS OWN RIGHT, independent of
 * that. Measured on node v22.23.2 (social, chief reproduced) with `sandbox/escape`
 * a symlink to `outside`, on the RAW string `…/sandbox/escape/../outside`:
 *
 *   fs.existsSync            true                  PHYSICAL — the kernel resolves it
 *   fs.statSync              true                  PHYSICAL
 *   path.resolve             …/sandbox/outside     LEXICAL — declares it INSIDE (wrong)
 *   fs.realpathSync   (JS)   THREW ENOENT          LEXICAL first, then lstat
 *   fs.realpathSync.native   …/outside             PHYSICAL — correct
 *
 * ⇒ `path.resolve` + `startsWith` calls that argument INSIDE the sandbox while its real
 * target is OUTSIDE. And `existsSync` and `realpathSync` DISAGREE ON THE SAME STRING,
 * so a deepest-existing-ancestor walk that probes with one and resolves with the other
 * throws on a path it was just told exists.
 * ⇒ ***`path.resolve` AND JS `fs.realpathSync` ARE NOT CONTAINMENT INSTRUMENTS.***
 *
 * ⛔ THE `lstat` ARM IS A DISAMBIGUATOR, NOT A PROBE — and the version that used it as
 * a probe FAILED OPEN. A DANGLING symlink (link present, target absent) satisfies
 * `lstat` and throws on `.native`, `stat` and `existsSync`. Used as an existence probe
 * it stops the walk on a link the resolver cannot resolve; treated as a missing NAME it
 * is resolved away and the parent is re-joined — so a link pointing INTO the live tree
 * is reported as safe, and a later-created target means writes land there.
 * ⇒ THE DISAGREEMENT IS THE SIGNAL:
 *     .native throws AND lstat SUCCEEDS  => a name that exists and cannot be resolved
 *                                           => REFUSE, naming the link
 *     .native throws AND lstat ALSO throws => a genuinely absent NAME
 *                                           => treat as tail and keep walking
 *
 * ⚠ DELIBERATE TRADE, recorded so a future refusal is read as the trade and not as a
 * regression (chief, 02:5xZ): this REFUSES a dangling symlink outright. A caller that
 * creates the link before its target is refused; the remedy is to create the target
 * first. ⛔ NEVER RELAX IT — the relaxation is indistinguishable from the hole.
 */
export type ContainmentVerdict =
  | { kind: 'resolved'; path: string }
  | { kind: 'not-absolute' }
  | { kind: 'dotdot-component' }
  | { kind: 'not-literal'; normalized: string }
  | { kind: 'unresolvable'; at: string; isSymlink: boolean };

/**
 * ⛔⛔ THE THIRD HOLE, AND IT WAS INSIDE THE FIX FOR THE SECOND — one character wide.
 * MEASURED by city at head `8cd41091`, chief reproduced: `lstat` on a path ending in
 * `/`, `//` or `/.` FOLLOWS a symlink (POSIX directory semantics), so on a DANGLING
 * link every one of those forms throws `ENOENT` exactly as an absent name does:
 *
 *     lstat(link)      -> OK              lstat(link + '/')   -> THREW ENOENT
 *     lstat(link + '/.')-> THREW ENOENT   lstat(link + '//')  -> THREW ENOENT
 *
 * ⇒ the disambiguator that exists to tell "unresolvable link" from "absent name"
 * COULD NOT, `dirname` then stripped the separator, the link was re-joined unresolved,
 * and `CTX_ROOT=<sandbox>/dangling/` was **ACCEPTED** while `<sandbox>/dangling` was
 * refused. **Fail-open, and every other arm on that same link refused — so the suite
 * agreed with the defect.**
 *
 * ⭐ RULED FIX (chief): REJECT, DO NOT NORMALISE — the same stance the sibling ops #4
 * change is built on, arriving here for a third reason. Require the argument to be
 * LITERAL-NORMAL before the walk ever runs, so no resolver is ever handed a form whose
 * meaning depends on which call resolves it.
 * ⚠ AND `path.normalize` ALONE IS NOT THE PREDICATE — measured, not assumed:
 * `normalize('/a/b/') === '/a/b/'`, so equality with `normalize` PRESERVES a trailing
 * separator and would have admitted the exact input that produced the hole. The three
 * conditions are separate on purpose and each names a different form.
 * `mktemp -d` output satisfies all three.
 */
export function isLiteralNormal(raw: string): boolean {
  if (raw !== normalize(raw)) return false;                 // '//', '/./', collapses
  if (raw.length > 1 && raw.endsWith(sep)) return false;    // trailing separator
  return !raw
    .split(sep)
    .slice(1)
    .some((c) => c === '' || c === '.' || c === '..');      // empty / '.' / '..'
}

export function resolveNonStrict(raw: string): ContainmentVerdict {
  // (1) Reject the forms that no resolver can be trusted with, BEFORE resolving.
  //     These are properties of the STRING, and once any resolver has touched it the
  //     information is already gone.
  if (!isAbsolute(raw)) return { kind: 'not-absolute' };
  if (raw.split(sep).includes('..')) return { kind: 'dotdot-component' };
  if (!isLiteralNormal(raw)) return { kind: 'not-literal', normalized: normalize(raw) };
  return walkToResolvable(raw);
}

/**
 * The deepest-existing-ancestor walk, exported SEPARATELY so its own disambiguator can
 * be exercised directly. After `resolveNonStrict`'s literal-normal gate this function
 * can never receive a trailing-separator form through the ordinary path — and a branch
 * that cannot be reached is a branch nobody measures (rule 210), so the arms call it
 * here instead of assuming the gate makes it moot.
 */
export function walkToResolvable(raw: string): ContainmentVerdict {
  // Walk up to the deepest ancestor `.native` actually RESOLVES, collecting the
  // unresolved tail. `.native` calls realpath(3), so it follows symlinks the way the
  // kernel does — which is the only definition of "where a write lands".
  const tail: string[] = [];
  let cursor = raw;
  for (;;) {
    try {
      const base = realpathSync.native(cursor);
      return { kind: 'resolved', path: tail.length === 0 ? base : join(base, ...tail) };
    } catch {
      // ⛔⛔ PROBE THE NAME ITSELF, WITH TRAILING SEPARATORS STRIPPED. `lstat` on a
      // path ending in `/` follows the link (POSIX directory semantics), so a
      // DANGLING link probed as `link/` throws exactly as an absent name does —
      // and the disambiguator that exists to tell those two apart CANNOT.
      // MEASURED (city, PR #47 round 2, at head 8cd41091): on the same dangling link,
      //     lstat(link)   -> OK          lstat(link + '/')  -> THREW ENOENT
      //     lstat(link + '//') -> THREW ENOENT
      // so `CTX_ROOT=<sandbox>/dangling` was REFUSED while `CTX_ROOT=<sandbox>/dangling/`
      // was ACCEPTED: the walk read it as a missing NAME, dropped to the parent,
      // re-joined the tail and reported a safe path.
      // ⭐ THE HOLE WAS IN THE FIX FOR THE HOLE, one character wide, and every OTHER
      // arm on that link (bare, `/child`, `/.`) refused — so the suite agreed with the
      // defect. Stripping is safe where collapsing `..` is not: a trailing separator
      // cannot move between directories, it only asserts directory-ness.
      const probe = cursor.replace(/\/+$/, '') || sep;
      let exists: boolean;
      let isSymlink = false;
      try {
        isSymlink = lstatSync(probe).isSymbolicLink();
        exists = true;
      } catch {
        exists = false;
      }
      if (exists) return { kind: 'unresolvable', at: probe, isSymlink };
      const parent = dirname(cursor);
      // `dirname('/') === '/'`: the filesystem root is the termination condition, and
      // it is unreachable in practice because `/` always resolves. Without it a root
      // that somehow failed to resolve would spin forever.
      if (parent === cursor) return { kind: 'unresolvable', at: cursor, isSymlink: false };
      tail.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

/**
 * BOTH SIDES ARE RESOLVED BY THE SAME METHOD. A root under `~/.cortextos` can itself
 * sit behind a symlink, and comparing a resolved candidate against an unresolved root
 * is the same class of mismatch as comparing an epoch against a string: two values
 * that look comparable and are not.
 * If the live root does not exist there is no live tree to protect, so the literal
 * value is a safe floor.
 */
export function liveStateRoot(): string {
  const literal = join(homedir(), '.cortextos');
  try {
    return realpathSync.native(literal);
  } catch {
    return literal;
  }
}

/**
 * Prefix containment on ALREADY-RESOLVED values only. Exported so the arms can pin a
 * fixture root instead of the operator's real one — a containment check that can only
 * be exercised against `homedir()` is a check whose escape cases cannot be written down.
 * ⛔ `root + sep` is load-bearing: a bare `startsWith(root)` also matches a sibling whose
 * name merely begins with the root's name (`~/.cortextos-backup`).
 */
export function isUnderRoot(resolved: string, root: string): boolean {
  return resolved === root || resolved.startsWith(root + sep);
}

function ctxRootFailure(): string | null {
  const raw = process.env.CTX_ROOT;
  if (raw === undefined || raw === '') {
    return (
      'CTX_ROOT is NOT SET.\n\n' +
      '  Unset is not "sandboxed". src/bus/crons.ts falls back to process.cwd(), so the\n' +
      '  suite writes .cortextOS/state/agents/ INTO THE REPOSITORY you are standing in.'
    );
  }

  const verdict = resolveNonStrict(raw);

  if (verdict.kind === 'not-absolute') {
    return (
      `CTX_ROOT is RELATIVE:\n    CTX_ROOT=${raw}\n\n` +
      '  A relative root is resolved against whatever directory each writer happens to\n' +
      '  be standing in, so it names a different tree depending on the caller. It is\n' +
      '  refused rather than resolved here: resolving it would make this check answer a\n' +
      '  question about THIS process that the writers do not have to agree with.'
    );
  }

  if (verdict.kind === 'dotdot-component') {
    return (
      `CTX_ROOT contains a '..' component:\n    CTX_ROOT=${raw}\n\n` +
      "  node's own resolvers collapse '..' LEXICALLY, before following symlinks, so a\n" +
      "  '..' that traverses a symlink resolves to one place on disk and a DIFFERENT\n" +
      '  place under path.resolve() — measured: path.resolve reports INSIDE a sandbox\n' +
      '  while realpath(3) reports OUTSIDE it. Any containment answer computed after\n' +
      '  that collapse is an answer about a path that was never the argument.'
    );
  }

  if (verdict.kind === 'not-literal') {
    return (
      `CTX_ROOT is not a LITERAL path:\n    CTX_ROOT=${raw}\n` +
      `    would normalise to  ${verdict.normalized}\n\n` +
      '  A trailing separator, a doubled separator, or a "." component changes which\n' +
      '  syscall answers a question about it — lstat(2) FOLLOWS a symlink when the path\n' +
      '  ends in "/", so a dangling link written as "link/" is indistinguishable from a\n' +
      '  name that does not exist, and the containment walk resolves it away.\n' +
      '  Refused rather than normalised: normalising it here would make this check answer\n' +
      '  about a path that is not the one the writers will be handed.\n' +
      `  Pass the literal form instead:  ${verdict.normalized.replace(/\/+$/, '') || sep}`
    );
  }

  if (verdict.kind === 'unresolvable') {
    return (
      `CTX_ROOT cannot be resolved:\n    CTX_ROOT=${raw}\n` +
      `    stops at    ${verdict.at}${verdict.isSymlink ? '  (a symlink whose target does not resolve)' : ''}\n\n` +
      '  This name EXISTS but realpath(3) cannot follow it, so where a write through it\n' +
      '  would land is not knowable now — it depends on what the target becomes later.\n' +
      '  Refused deliberately: treating it as a merely-absent name resolves it away and\n' +
      '  admits a link that points into the live tree. If you meant a path that does not\n' +
      "  exist yet, create the TARGET first — the link's own directory is not enough."
    );
  }

  const resolved = verdict.path;
  const live = liveStateRoot();
  if (isUnderRoot(resolved, live)) {
    return (
      `CTX_ROOT points INSIDE the live state tree:\n    CTX_ROOT=${raw}\n` +
      `    resolves to  ${resolved}\n    which is under ${live}\n\n` +
      '  Tests write agent state to whatever CTX_ROOT names. Pointed here, they add and\n' +
      '  overwrite directories under a tree the running fleet reads.'
    );
  }
  return null;
}

export default function setup(): void {
  const rootProblem = ctxRootFailure();
  if (rootProblem !== null) {
    throw new Error(
      '\n\n⛔ SUITE NOT ISOLATED — this is a SETUP failure, not a test failure.\n' +
        'No test ran. Nothing below says anything about the code under review.\n\n' +
        `  ${rootProblem}\n\n` +
        `  ${CTX_ROOT_HELP}\n\n` +
        '  Prefix your ORIGINAL command — this is the invocation this process actually received,\n' +
        '  so your file filter, -t and reporter flags are preserved:\n' +
        `    CTX_ROOT=$(mktemp -d) ${originalInvocation()}\n\n` +
        '  The ordinary lanes already do this for you:\n' +
        '    npm test            # fast lane\n' +
        '    npm run test:slow   # slow lane\n' +
        '  so seeing this message means the suite was launched by hand.\n',
    );
  }

  const set = CONTAMINATING.filter((name) => {
    const v = process.env[name];
    return v !== undefined && v !== '';
  });
  if (set.length === 0) return;

  const shown = set.map((name) => `    ${name}=${process.env[name]}`).join('\n');
  const flags = set.map((name) => `-u ${name}`).join(' ');

  // ⛔ PREFIX THE ORIGINAL INVOCATION; DO NOT NAME A LANE. (guard, two rounds on this file.)
  // Round 1: the refusal hardcoded `npm test`, so the SLOW lane told the operator to re-run the
  // FAST one. Round 2 killed my fix too: naming the lane still DROPS THE ARGUMENTS — an operator
  // who ran `npm run test:slow -- some.test.ts -t 'name' --reporter=json` was handed a command
  // that reruns the whole lane and loses the filter, the -t and the reporter.
  // ⭐ The general defect both rounds share: I was RECONSTRUCTING the command from a guess about
  // how it was invoked, when the invocation is right there in argv. A reconstruction can only ever
  // be as good as the cases its author thought of, and it fails silently — the printed command is
  // always plausible. Echo what was actually run instead.
  // ⛔ AND QUOTE WHAT NEEDS QUOTING. `-t 'my test name'` arrives in argv as ONE element with a
  // space in it; echoed bare it becomes two arguments and the printed command silently does
  // something different from the one that refused — a copy-paste remedy that is wrong in exactly
  // the case the operator was narrowing a run.
  const original = originalInvocation();

  throw new Error(
    '\n\n⛔ SUITE NOT ISOLATED — this is a SETUP failure, not a test failure.\n' +
      'No test ran. Nothing below says anything about the code under review.\n\n' +
      `  Set in the launching environment:\n${shown}\n\n` +
      '  Tests branch on this variable, so an inherited value is a value the test did\n' +
      '  not choose. The failures that follow look like ordinary unit regressions in\n' +
      '  unrelated files, which is why this refuses instead of warning.\n\n' +
      '  Re-run with the variable removed. ⛔ THE FLAG MUST BE LITERAL: an unquoted\n' +
      '  shell variable holding flags arrives as ONE argument and applies none of them,\n' +
      '  so a strip list built in a variable silently does nothing.\n' +
      '  Prefix your ORIGINAL command — this is the invocation this process actually received,\n' +
      '  so your file filter, -t and reporter flags are preserved:\n' +
      `    env ${flags} ${original}\n\n` +
      '  Or, for a whole lane:\n' +
      `    env ${flags} npm test          # fast lane\n` +
      `    env ${flags} npm run test:slow # slow lane\n\n` +
      '  To confirm the strip actually took effect, assert INSIDE the same invocation:\n' +
      `    env ${flags} printenv ${set[0]}   # must exit 1\n\n` +
      '  A test that needs one of these set points it at its own fixture in-process,\n' +
      '  which this does not affect.\n',
  );
}
