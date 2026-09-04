import { configDefaults, defineConfig } from 'vitest/config';
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
    // The acceptance lane runs the SAME assertions under `npm run test:acceptance`.
    // Nothing is deleted and nothing is weakened — they are excluded HERE only,
    // because they read source from sibling worktrees named by two mandatory env
    // vars, so a clean clone (and CI) cannot run them at all. Under the default
    // glob that is not a strict suite, it is a suite that fails for everyone who
    // is not the author.
    // Membership lives in tests/acceptance-tests.ts alone, so the two lanes
    // cannot drift into a file belonging to neither.
    exclude: [...configDefaults.exclude, ...ACCEPTANCE_TESTS],
  },
});
