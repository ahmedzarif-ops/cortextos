/**
 * SINGLE SOURCE OF TRUTH for which files live in the opt-in acceptance lane.
 *
 * The fast lane (`vitest.config.ts`) EXCLUDES this list; the acceptance lane
 * (`vitest.acceptance.config.ts`) INCLUDES exactly it. Two homes for one list is
 * how a file ends up in neither lane and is quietly never run, so both configs
 * import this and nothing enumerates the files a second time.
 *
 * WHY THESE FILES ARE OPT-IN AND NOT SIMPLY PART OF `npm test`:
 * they are adversarial acceptance suites that read source OUTSIDE this
 * repository — two mandatory env vars name candidate files in sibling worktrees
 * on one machine. A clean clone cannot run them, so under the default glob they
 * are not a strict suite, they are a suite that fails for everyone who is not
 * the person who wrote them.
 *
 * ⛔ AND ONE OF THEM ONLY PASSES WITH SOURCE THAT IS NOT IN THIS PR.
 * `restart-notification-controls.hostile.test.ts` asserts the ONE VOICE
 * lifecycle behaviour shipped by `fix/one-voice-lifecycle-enforcement`. Under
 * the default glob, merging THIS branch first leaves `main` red — 19 failures,
 * every one of them in that file. The suite is doing exactly what its RUNBOOK
 * asks (the base arm is the positive control and the flip is the evidence);
 * committing that base arm under the default glob is what makes it everyone's
 * failing suite. The instrument is correct; its LOCATION was the defect.
 *
 * ⛔ MEMBERSHIP IS A LOCATION, NOT A LIST — SO PUTTING A TEST IN THIS DIRECTORY
 * GATES IT, AND THAT GATE IS NOT FREE.
 * `templates-one-voice-guard.test.ts` lived here and needed NOTHING from outside
 * this repo: it reads `templates/` in-tree and imports only node builtins. But
 * `require-env.ts` is a `globalSetup` — it runs ONCE FOR THE WHOLE LANE, BEFORE
 * COLLECTION, and throws if either CAPACITY_* var is unset. So the one test whose
 * subject is the ONE VOICE countermand ran for one person on one machine and for
 * nobody in CI, while every signal stayed green. It now lives in `tests/` and is
 * back in `npm test`.
 * ⇒ BEFORE ADDING A FILE HERE, ASK WHAT IT READS. If the answer is "only this
 * repo", it belongs in the fast lane; the directory is the opt-in, and a test
 * placed here inherits a requirement it may not have.
 */
export const ACCEPTANCE_TESTS = ['tests/acceptance/**/*.test.ts'];

/**
 * Env vars the lane cannot run without. Each names a source file UNDER REVIEW,
 * which is why they are paths and not flags: the suites are re-pointed at
 * whatever candidate is being reviewed rather than at a fixed import.
 */
export const REQUIRED_ENV: ReadonlyArray<{ name: string; what: string; usedBy: string }> = [
  {
    name: 'CAPACITY_SIGNAL_CANDIDATE',
    what: 'absolute path to the capacity-signal source under review (must export evaluateSigned and accept an `authenticated` option)',
    usedBy: 'tests/acceptance/capacity-signal-trust.hostile.test.ts',
  },
  {
    name: 'CAPACITY_CONTROLLER_CANDIDATE',
    what: 'absolute path to the capacity-controller source under review (must export decideCapacityAction)',
    usedBy: 'tests/acceptance/capacity-controller.hostile.test.ts',
  },
];
