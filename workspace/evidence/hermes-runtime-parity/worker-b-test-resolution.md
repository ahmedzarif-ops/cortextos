# Worker B — Isolated Test Resolution Diagnosis

invocation:
  profile: `sentinelparityb`
  model: `z-ai/glm-5.3-flash`
  provider: `nous`
  reasoning: `high`
  mode: read-only bounded diagnosis

## Root cause

The worktree has no `node_modules`. Node/Vite resolution walks upward from `/Users/guest1/cortextos-worktrees/hermes-runtime-parity` and never finds `/Users/guest1/cortextos/node_modules` automatically.

1. Vitest cannot normally load `vitest.config.ts` because its Vite bundle resolves `vitest/config` relative to the worktree.
2. `NODE_PATH=/Users/guest1/cortextos/node_modules` starts Vitest, but Vite's ESM resolver still cannot resolve bare specifiers such as `@noble/hashes/sha2.js` from worktree source. `NODE_PATH` helps CommonJS resolution, not Vite/Vite-node resolution.
3. TypeScript similarly cannot find the Node type definitions from the worktree.

The worker ran a broad read-only probe with `NODE_PATH`: 1220/1243 tests passed; 28 files failed on the unresolved-package class. This was diagnostic, not parity proof.

## Ranked remedies from worker

1. Symlink the existing dependency trees into this worktree (`node_modules` and `dashboard/node_modules`). This preserves all source/build output in the isolated worktree and writes nothing to the dirty live tree.
2. Edit `typeRoots` only fixes TypeScript and still misses Vite resolution.
3. `NODE_PATH` is verified partial and insufficient.
4. A fresh per-worktree `npm ci` is cleanest semantically but installs a second dependency tree and may require network/time.

## Risks

- A dependency symlink is an untracked/reversible worktree filesystem entry and shares the exact installed dependency versions of the live checkout. If the branch lockfile differs, this does not reproduce clean CI.
- Live-tree dependency updates become visible immediately through a symlink.
- A fresh install avoids those coupling risks but is slower and potentially network-dependent.

## Coordinator note

Before creating any symlink, try running the worktree test paths with Vitest rooted at `/Users/guest1/cortextos`; if Vite's configured root resolves bare dependencies while relative source imports remain in the isolated worktree, that avoids an extra filesystem entry. Preserve exact RC and output.

worker_statement: No source files were modified; git state was not changed.
