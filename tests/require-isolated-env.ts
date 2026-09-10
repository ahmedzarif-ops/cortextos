import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';

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

function ctxRootFailure(): string | null {
  const raw = process.env.CTX_ROOT;
  if (raw === undefined || raw === '') {
    return (
      'CTX_ROOT is NOT SET.\n\n' +
      '  Unset is not "sandboxed". src/bus/crons.ts falls back to process.cwd(), so the\n' +
      '  suite writes .cortextOS/state/agents/ INTO THE REPOSITORY you are standing in.'
    );
  }
  // realpath, so a symlink or a `..` cannot walk into the live tree behind the check.
  let resolved: string;
  try {
    resolved = realpathSync(raw);
  } catch {
    // A path that does not exist yet is fine as a sandbox — resolve its parent instead,
    // and fall back to the literal value when even that is absent.
    try {
      resolved = join(realpathSync(dirname(raw)), basename(raw));
    } catch {
      resolved = raw;
    }
  }
  let live: string;
  try {
    live = realpathSync(join(homedir(), '.cortextos'));
  } catch {
    live = join(homedir(), '.cortextos');
  }
  if (resolved === live || resolved.startsWith(live + sep)) {
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
