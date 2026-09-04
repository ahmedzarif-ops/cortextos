import { defineConfig } from 'vitest/config';
import { ACCEPTANCE_TESTS } from './tests/acceptance-tests.js';

/**
 * OPT-IN acceptance lane: `npm run test:acceptance`.
 *
 * Not part of `npm test` and deliberately NOT in CI. These suites read source
 * from sibling worktrees named by two mandatory env vars, so a clean clone —
 * and every CI runner — cannot run them however well documented. Excluding them
 * from the default glob is the honest position, not a weakening: the assertions
 * are unchanged and the reviewer who has the worktrees runs them here.
 *
 * ⚠ NOTE THE CONFIG IS WRITTEN OUT RATHER THAN MERGED. `mergeConfig`
 * CONCATENATES arrays, so inheriting the base config would have made this lane
 * inherit the base `include` and run the whole fast suite under the acceptance
 * lane's name. That exact mistake is recorded in PR #3's slow lane.
 */
export default defineConfig({
  test: {
    globals: true,
    testTimeout: 10000,
    include: ACCEPTANCE_TESTS,
    globalSetup: ['./tests/acceptance/require-env.ts'],
    // Left at the default (false) ON PURPOSE: a lane that matches no files must
    // FAIL. An empty lane exiting 0 is the "clean run" half of the RUNBOOK's own
    // rule — it would report success for a suite that never ran.
    passWithNoTests: false,
  },
});
