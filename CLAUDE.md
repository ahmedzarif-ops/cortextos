# Contributing to cortextOS

## Development Setup

```bash
git clone https://github.com/grandamenium/cortextos.git
cd cortextos
npm install
npm run build
npm test
```

## Before Submitting Changes

1. `npm run typecheck:root-and-dashboard` — TypeScript must compile cleanly in **both** those trees
2. `npm run build` — the CLI bundle must build
3. `npm test` — all tests must pass
4. Match existing patterns in `src/` for new features
5. Add unit tests in `tests/` for any new code

**Why step 1 is not `npm run build`.** It used to be, and the line said "TypeScript must
compile cleanly" — which was true of `src/` and false of the repo. `build` is `tsup`, a
bundler: it strips types rather than checking them, so it is green on code that does not
typecheck. And `typecheck` alone is `tsc --noEmit` against the ROOT tsconfig, whose
`include` is `src/**/*` — the dashboard is not in it.

**And the name is `typecheck:root-and-dashboard`, not `typecheck:all`, because it is not
all.** Both tsconfigs exclude `tests/`, so neither command sees a single test file. A parse
error inside a test was measured exiting **0** under `npm run typecheck` while the file
silently did not run. A script called `:all` invites exactly the reading that a green covers
the repo. **Verify test changes by RUNNING them.**

So the documented bar passed on a real type error for as long as the error lived in
`dashboard/`. Measured at 9d4383f: `npm run build` exits 0 and `npm run typecheck` exits 0,
while `dashboard/src/lib/data/agents.ts:17` imports `displayField` from `@/lib/utils`, where
it is not defined. `npm run typecheck:dashboard` exits 2 and names it.

**CI was never blind to this** — the `dashboard-build` job has always run `npx tsc --noEmit`
inside `dashboard/`, and it catches this exact error. The gap was only ever in the LOCAL bar,
which is the one a contributor runs before pushing. A local bar that is weaker than CI does
not prevent the failure, it just moves it to someone else.

## Project Structure

- `src/` — TypeScript source (bus, cli, daemon, hooks, types, utils)
- `bus/` — Shell wrapper scripts (delegate to `dist/cli.js bus`)
- `dashboard/` — Next.js 14 web dashboard
- `templates/` — Agent templates (agent, orchestrator, analyst, agent-codex, agent-opencode)
- `community/` — Community skills and agent catalog
- `tests/` — Unit, integration, and E2E tests

## Code Style

- TypeScript strict mode
- No external runtime dependencies beyond what's in `package.json`
- File operations use atomic writes (see `src/utils/atomic.ts`)
- All bus operations go through `src/bus/` modules
