import { existsSync } from 'node:fs';
import { REQUIRED_ENV } from '../acceptance-tests.js';

/**
 * Lane precondition check. Runs ONCE, before any test file is collected.
 *
 * ⛔ THE THREE STATES THIS EXISTS TO KEEP APART. The RUNBOOK's own principle is
 * "a missing env var and a clean run must never look alike"; the case it missed
 * is that A MISSING ENV VAR AND A BROKEN SUITE LOOK ALIKE TOO. Both candidate
 * files throw at MODULE SCOPE, so an unset variable printed
 * `FAIL tests/acceptance/…` — the shape of a suite that is broken, not of a
 * lane that was never configured. A reviewer reads that as "the tests are
 * failing" and starts debugging the wrong thing.
 *
 *   1. var unset          -> named, actionable failure BEFORE collection
 *   2. var set, file gone -> named, actionable failure BEFORE collection
 *   3. everything present -> the suite runs and its own results mean something
 *
 * It deliberately does NOT default, guess, or search for a candidate. A lane
 * that quietly picks a path is a lane that reports on a file nobody chose.
 */
export default function setup(): void {
  const problems: string[] = [];
  for (const v of REQUIRED_ENV) {
    const value = process.env[v.name];
    if (!value) {
      problems.push(`  ${v.name} is UNSET.\n    what it must be: ${v.what}\n    used by: ${v.usedBy}`);
      continue;
    }
    if (!existsSync(value)) {
      problems.push(`  ${v.name} is set to a path that does not exist:\n    ${value}\n    used by: ${v.usedBy}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      '\n\n⛔ ACCEPTANCE LANE NOT CONFIGURED — this is a SETUP failure, not a test failure.\n' +
        'No test ran. Nothing here says anything about the code under review.\n\n' +
        problems.join('\n\n') +
        '\n\nBoth variables name sources UNDER REVIEW, which is why they are paths and not flags.\n' +
        'See tests/acceptance/RUNBOOK.md § Running it.\n',
    );
  }
}
