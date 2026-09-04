import { configDefaults, defineConfig } from 'vitest/config';
import { SLOW_TESTS } from './tests/slow-tests.js';
import { ACCEPTANCE_TESTS } from './tests/acceptance-tests.js';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      // Matches the dashboard's tsconfig path alias so tests under
      // dashboard/src/**/__tests__ can import dashboard source via "@/…".
      '@': path.resolve(__dirname, 'dashboard/src'),
      // Dashboard tests need to resolve `next/server` and other Next deps
      // from dashboard/node_modules, because root's package.json does not
      // depend on Next.js.
      'next/server': path.resolve(__dirname, 'dashboard/node_modules/next/server.js'),
    },
  },
  test: {
    globals: true,
    testTimeout: 10000,
    include: [
      'tests/**/*.test.ts',
      'dashboard/src/**/__tests__/**/*.test.ts',
    ],
    // TWO OPT-IN LANES, BOTH EXCLUDED HERE, FOR DIFFERENT REASONS. Neither is a
    // weakening: each runs the SAME assertions under its own command, and each
    // keeps membership in ONE file so a test cannot fall into neither lane.
    //   SLOW_TESTS        -> `npm run test:slow`        (duration)
    //   ACCEPTANCE_TESTS  -> `npm run test:acceptance`  (reads source from sibling
    //                        worktrees named by two mandatory env vars, so a clean
    //                        clone and every CI runner cannot run them at all)
    // ⚠ The union is what the fast lane excludes. If the two lists ever overlap,
    // a file is claimed by both lanes — assert they are disjoint, do not assume it.
    exclude: [...configDefaults.exclude, ...SLOW_TESTS, ...ACCEPTANCE_TESTS],
  },
});
