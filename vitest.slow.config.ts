import path from 'path';
import { configDefaults, defineConfig } from 'vitest/config';
import { SLOW_TESTS } from './tests/slow-tests.js';

// THE SLOW LANE. The SAME tests, unweakened, run as their own job.
//
// ⛔ THIS FILE DELIBERATELY DOES NOT `mergeConfig` WITH vitest.config.ts.
// The first version of it did, and mergeConfig CONCATENATES arrays: the slow
// lane inherited the base `include` and enumerated 138 files instead of 3 —
// the entire fast suite, wearing the slow lane's name. It was caught only by
// the union control below (fast 138 + slow 138 = 276 against an original 141);
// the obvious check — "are the three files absent from the fast lane?" — passed
// cleanly while the split was broken. A duplicated lane and a correct one look
// identical from the fast side.
//
// WHY THIS FILE EXISTS AT ALL — the pre-push gate had stopped measuring anything.
// On 2026-09-04 two agents ran `npm test` on the SAME commit (origin/main
// efd3252) in clean worktrees and got 52 failed / 22 files and 37 failed /
// 17 files: a 41% disagreement on one tree. On near-identical trees,
// fast-checker failed 3, then 2, then 0 across three runs, while
// multi-agent-crons and phase2-backtesting failed in the full suite and then
// passed 16/16 IN ISOLATION on both arms of a branch-vs-main comparison.
//
// A suite whose failing SET moves between runs of the same tree is not measuring
// the change — it reports a number that looks like a verdict. And because it is
// always red, every push is either aborted or forced with --no-verify, which
// turns a gate into the habit of driving through a red light nobody will notice
// turning green for the wrong reason.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'dashboard/src'),
      'next/server': path.resolve(__dirname, 'dashboard/node_modules/next/server.js'),
    },
  },
  test: {
    globals: true,
    include: SLOW_TESTS,
    exclude: [...configDefaults.exclude],
    // Multi-minute wall-clock simulations (146s and 389s measured 2026-09-04).
    // The base 10s testTimeout is the mechanism behind the flake, not a detail.
    testTimeout: 600000,
    hookTimeout: 600000,
    // Serial. Contending for CPU with 138 other files is why these lose:
    // they simulate elapsed time and cannot win against scheduler noise.
    fileParallelism: false,
  },
});
