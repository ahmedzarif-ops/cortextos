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

export default function setup(): void {
  const set = CONTAMINATING.filter((name) => {
    const v = process.env[name];
    return v !== undefined && v !== '';
  });
  if (set.length === 0) return;

  const shown = set.map((name) => `    ${name}=${process.env[name]}`).join('\n');
  const flags = set.map((name) => `-u ${name}`).join(' ');

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
      `    env ${flags} npm test\n\n` +
      '  To confirm the strip actually took effect, assert INSIDE the same invocation:\n' +
      `    env ${flags} printenv ${set[0]}   # must exit 1\n\n` +
      '  A test that needs one of these set points it at its own fixture in-process,\n' +
      '  which this does not affect.\n',
  );
}
