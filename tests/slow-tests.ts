/**
 * THE SLOW LANE MANIFEST — one list, imported by both vitest configs, so the
 * fast lane's exclusion and the slow lane's inclusion CANNOT DRIFT APART.
 *
 * Two homes for one list is how a test ends up in neither lane and is quietly
 * never run. That failure would be invisible: both suites would be green.
 *
 * ⛔ MEMBERSHIP IS EVIDENCE-BASED, AND THE EVIDENCE IS RECORDED PER ENTRY.
 * A file belongs here only if it has been OBSERVED to be slow or unstable, with
 * the observation written down. Do not add a file because it "feels flaky".
 *
 * ⚠ THIS LIST IS NOT CLAIMED TO BE EXHAUSTIVE. It is every file for which
 * direct evidence existed on 2026-09-04. Vitest's default reporter prints
 * durations only for FAILING files, so a passing 90-second file would not have
 * shown up in the runs this list was built from — absence from this list is
 * absence of evidence, not evidence of speed.
 * TO EXTEND IT PROPERLY: `npx vitest run --reporter=verbose` (or the json
 * reporter) to get per-file durations for PASSING files too, then add anything
 * over the ~60s mark with its measurement.
 */
export const SLOW_TESTS = [
  // 388,708 ms measured 2026-09-04. Failed 4/5 in the full suite; passed in
  // isolation on BOTH a feature branch and a clean main worktree.
  'tests/integration/phase2-backtesting.test.ts',

  // 146,561 ms measured 2026-09-04. Failed 1/11 in the full suite; passed in
  // isolation on BOTH arms of the same comparison.
  'tests/integration/multi-agent-crons.test.ts',

  // ~20,000 ms. Included on DIFFERENT grounds from the two above: it is not
  // multi-minute, but it demonstrably flaked — 3 failures, then 2, then 0
  // across three runs of trees that shared the relevant code, and 63/63 in
  // isolation. The failing tests are duration-shaped ("clears timer on stop",
  // "does not fire before bootstrap completes").
  'tests/unit/daemon/fast-checker.test.ts',
];
