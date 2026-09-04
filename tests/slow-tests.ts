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

  // ADDED 2026-09-04 (task_1788503640584_26548296), on this list's own criterion: observed, with
  // the observation recorded. It is the CLEAREST member of the class and it was missed on the first
  // pass because it PASSES in the fast lane — absence of evidence, exactly as the caveat above says.
  //
  // MEASURED, two runs of an identical tree (efd3252, porcelain 0 lines):
  //   unsplit run A -> 17 failing files, this file among them, test "startup time scales sub-linearly"
  //   unsplit run B -> 16 failing files, this file NOT among them
  //   comm A\B = exactly this file; comm B\A = empty; B's set is byte-identical to the fast lane's.
  //   fast lane, 4 consecutive runs -> 0 of 4 failures for this file.
  // So: 1 of 2 at full load, 0 of 4 at reduced load.
  //
  // ⛔ WHY REMOVING ITS NEIGHBOURS IS NOT A FIX FOR IT. The assertion is on WALL-CLOCK STARTUP
  // ("startup time scales sub-linearly"), so it is load-sensitive BY CONSTRUCTION. It currently
  // passes in the fast lane only because dropping the three files above put total contention under
  // whatever threshold it uses. That means THE FAST LANE'S STABILITY RESTS ON AN UNMEASURED LOAD
  // BUDGET, and the next heavy test added anywhere reintroduces the flake — with no warning, and
  // blamed on whatever change happens to be in flight.
  // The only real fixes are to keep it off the gate (this list) or to rewrite it to assert on
  // something that is not elapsed time. It cannot be made deterministic by tidying its neighbours.
  'tests/integration/phase5-performance.test.ts',
];
