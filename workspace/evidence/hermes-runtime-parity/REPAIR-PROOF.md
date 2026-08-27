# Hermes runtime parity repair proof

prepared_at_utc: 2026-08-27T02:14:58Z
worktree: `/Users/guest1/cortextos-worktrees/hermes-runtime-parity`
branch: `fix/hermes-runtime-parity`
original_base: `4fe279b753408d407189222809aa3ddf74cc565c`
blocked_parent_commit: `e88377c2230d6ebcb9d1e2757256df11ec9a2694`
blocked_parent_tree: `da412e9e47ef4c3252b41b6199aba4adb75a4dd7`
blocked_parent_packet: `/Users/guest1/cortextos/orgs/ygs-cortex-fleet/agents/sentinel/workspace/hermes/review-packet-e88377c.md`
blocked_parent_packet_sha256: `597993a6300ae4e5fe3fa153c9ec449566334d78a59dfd1d37bdfbd1bfcc068d`
live_changes: `0`

The successor commit and its external changed-file manifest are frozen after this proof is committed. Their exact commit, tree, merge base, binary-diff hash, manifest path/hash, row count, and clean-worktree receipt belong in the external successor packet because a commit cannot contain its own identity.

## Superseded trust claim

The `e88377c` packet claimed that `${CTX_FRAMEWORK_ROOT}/dist/cli.js` was an independent authenticated-usage source. Guard correctly blocked that claim: the validator caller controls `CTX_FRAMEWORK_ROOT`, while `dist/` is ignored and absent from the 30-file manifest. A substituted CLI could therefore forge the authenticated measurement together with a caller-forged plan, receipt, and receipt hash.

This successor does not repair that path or move it relative to the validator. It removes the subprocess boundary. `validate-plan.mjs` imports the tracked same-package `scripts/read-authenticated-usage.mjs` module. That reviewed module:

- requires an absolute `CTX_ROOT`;
- resolves the active token from `state/oauth/accounts.json` or the process OAuth token, matching the canonical bus fallback;
- calls the fixed Anthropic OAuth usage endpoint directly with the fixed OAuth beta header;
- accepts only finite complete utilization values normalized to `0..1`;
- constructs authenticated, fresh, non-cached provenance inside reviewed code;
- performs no writes and never includes a token or response body in an error.

The validator no longer imports `node:child_process`, never reads `${CTX_FRAMEWORK_ROOT}/dist/cli.js` for usage, and never executes a caller-selected usage executable. `CTX_FRAMEWORK_ROOT` remains in the validator only for the separate canonical live-config byte checks already disclosed by the plan contract.

## TDD boundary proof

On untouched `e88377c`, the exact caller-selected-CLI plus jointly forged canonical-source plan/receipt/hash test returned Vitest RC `1` at the assertion `expected 1, received 0`: the old validator accepted the forged chain. After the production change, the exact test returns RC `0`, the hostile CLI execution marker remains absent, and the forged 0% value rejects against the independent 9% fixture.

The test fetch substitution is test-only: Vitest creates a temporary Node `--import` bootstrap and supplies it only to the spawned validator test process. Production code contains no fixture environment variable, response path, endpoint override, command path, fetch-fixture flag, or injectable fetch parameter. The validator calls the imported reader with only the active `CTX_ROOT`.

## Removed subprocess-metadata cases

Three old tests supplied stale, cached, or unauthenticated metadata from a fake CLI subprocess. They disappeared because that caller-supplied payload boundary no longer exists: the reviewed reader constructs `cached: false`, `authentication: oauth-bearer`, the fixed provider/endpoint, and `fetched_at` immediately after the response. One exact substituted-CLI regression test replaces them. Ordinary acceptance plus HTTP 401, missing token, missing utilization, out-of-range normalization, exact executable substitution, plan/receipt mismatch, and freshness checks remain covered. This is a net reduction of two tests, not two lost production states.

## Fresh focused verification

Exact focused command:

```text
npm test -- --run tests/unit/pty/hermes-pty.test.ts tests/unit/daemon/agent-process-hermes.test.ts tests/unit/daemon/agent-manager.test.ts tests/unit/cli/add-agent-hermes.test.ts tests/unit/community/hermes-runtime-failover-skill.test.ts tests/unit/bus/oauth.test.ts
```

Measured successor result: RC `0`; files `6 passed (6)`; tests `141 passed (141)`. Validator-only measured result: RC `0`; files `1 passed (1)`; tests `34 passed (34)`.

Syntax checks:

```text
node --check community/skills/hermes-runtime-failover/scripts/read-authenticated-usage.mjs
node --check community/skills/hermes-runtime-failover/scripts/validate-plan.mjs
```

Measured result: RC `0` for both; no output.

Build command: `npm run build`

Measured result: RC `0`; `tsup` build success.

Whitespace command: `git diff --check 4fe279b753408d407189222809aa3ddf74cc565c`

Measured result: RC `0`; no output.

## Broad/base control

Broad target command: `npm test -- --run`

Measured successor result: RC `1`; files `5 failed | 137 passed | 1 skipped (143)`; tests `34 failed | 2329 passed | 3 skipped (2366)`.

Exact inherited-five command:

```text
npm test -- --run tests/unit/hooks/hooks.test.ts tests/unit/bus/hooks.test.ts tests/unit/hooks/hook-crash-alert.test.ts tests/integration/upgrade-cron-teaching-cli.test.ts tests/unit/cli/bus-crons.test.ts
```

Fresh dirty-successor control: RC `1`; files `5 failed (5)`; tests `34 failed | 83 passed (117)`.

Fresh isolated archived base `4fe279b753408d407189222809aa3ddf74cc565c`: archive RC `0`; extract RC `0`; dependency-link RC `0`; build RC `0`; identical five-file command RC `1`; files `5 failed (5)`; tests `34 failed | 83 passed (117)`.

Both distributions are exactly:

- `tests/unit/hooks/hooks.test.ts` — 1
- `tests/unit/bus/hooks.test.ts` — 7
- `tests/unit/hooks/hook-crash-alert.test.ts` — 4
- `tests/integration/upgrade-cron-teaching-cli.test.ts` — 6
- `tests/unit/cli/bus-crons.test.ts` — 16

The isolated base archive was built first and uses the same root dependency link as the target control. A whole-base run with incomplete dashboard-local dependency links is not a denominator and is not used. The identical measured five-file failure surface is the inheritance proof.

## Live boundary

This repair changes implementation, tests, skill documentation, and this proof only. It does not authorize a merge or live canary. No live config, merge, push, restart, model/provider call, spend, cron mutation, restore arming, credential change, or seat mutation is part of this revision. Any target-byte change after freeze requires a new commit, manifest, proof, and review.
