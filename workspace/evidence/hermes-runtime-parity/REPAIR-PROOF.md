# Hermes runtime parity repair proof

prepared_at_utc: 2026-08-26T19:24Z
worktree: `/Users/guest1/cortextos-worktrees/hermes-runtime-parity`
branch: `fix/hermes-runtime-parity`
original_base: `4fe279b753408d407189222809aa3ddf74cc565c`
reviewed_blocked_baseline_commit: `e26a972e545d8424c48d10078e32643ab7c62c19`
reviewed_blocked_baseline_manifest_sha256: `1d57884e5f296019ba9201e57a29d54c5b2e72934913f31ae2703a8b1496b1ed`
live_changes: `0`

The immutable repair commit and external changed-file manifest are frozen after this proof file is committed. Their hashes are supplied in the chief-routed review packet; no writer may modify that target during review.

## Guard defect dispositions

1. **Mandatory launch pins — closed.** `resolveHermesLaunchPins()` resolves an isolated profile and rejects a missing/invalid fixed model, provider, or reasoning level. `HermesPTY` calls it for argv, environment, preflight, and the real spawn seam. All successful launches emit `--profile`, `--model`, `--provider`, and `--reasoning`; absent pins fail before `node-pty.spawn()`.
2. **Strict plan/restore validation — closed.** The validator now rejects invalid/null/whitespace runtimes and models, moving aliases, stale trigger/snapshot evidence, invalid provenance or snapshot bytes, missing restore metadata, invalid Hermes restore pins, seat-set drift, past/non-next-Sunday restore occurrences, and incomplete/duplicated cutover or restore order.
3. **Mutable artifact — closed by freeze.** The repair is committed after tests, then identified by exact commit/tree plus a SHA-256 changed-file manifest stored outside the target. The worktree must remain clean and read-only for Guard.
4. **MCP readiness — closed.** Every required MCP needs a fresh per-profile receipt, a successful connected/tool count, a real `mcp__*` tool name and result marker, a byte-bound transcript containing both, and a byte-bound usage receipt matching the planned model/provider and success state.
5. **Native/cortextOS cron collision — closed.** A cortextOS-owned Hermes scheduler refuses initial creation when native jobs are active or unreadable, stops on reload if native jobs appear later, and rechecks before every fire so no external injection occurs after a collision.
6. **Mechanical canary ordering — closed.** The validator requires the exact Hermes seat set once in both orders, `city` first, and coordinator `chief` last. The same rule applies to cutover and restore.

## Final focused proof

Exact command:

```text
npm test -- --run tests/unit/pty/hermes-pty.test.ts tests/unit/daemon/agent-process-hermes.test.ts tests/unit/daemon/agent-manager.test.ts tests/unit/cli/add-agent-hermes.test.ts tests/unit/community/hermes-runtime-failover-skill.test.ts
```

Raw result: RC `0`; test files `5 passed (5)`; tests `81 passed (81)`.

Build command: `npm run build`

Raw result: RC `0`; `tsup` build success.

Whitespace command: `git diff --check`

Raw result: RC `0`; no output.

## Broad/base control

Repair target command: `npm test -- --run`

Raw repair result: RC `1`; test files `5 failed | 137 passed | 1 skipped (143)`; tests `34 failed | 2290 passed | 3 skipped (2327)`.

The 34 failures are confined to these five pre-existing files:

- `tests/unit/hooks/hooks.test.ts` — 1
- `tests/unit/bus/hooks.test.ts` — 7
- `tests/unit/hooks/hook-crash-alert.test.ts` — 4
- `tests/integration/upgrade-cron-teaching-cli.test.ts` — 6
- `tests/unit/cli/bus-crons.test.ts` — 16

Archived base `4fe279b753408d407189222809aa3ddf74cc565c` was built first (RC `0`) and then run with those exact five files. Raw base control: RC `1`; test files `5 failed (5)`; tests `34 failed | 83 passed (117)`. The same five-file failure distribution reproduced, so the repair adds no failure in the measured broad suite.

An attempted whole-suite run in the archive was not used as a denominator because the archive's root-only `node_modules` link could not resolve dashboard-local `next`/`better-sqlite3` packages. The exact five-file base control above has the same dependency surface and reproduces every repair-target failure.

## Live-state control

Immediately before freeze, all six live configs still read `runtime=codex-app-server`, `model=gpt-5-codex`, and no Hermes profile/provider/reasoning/cron-owner fields: `chief`, `growth`, `guard`, `city`, `social`, `sentinel`. `cortextos bus list-agents` reported all six running. No live config, merge, restart, model call, spend, cron mutation, restore arming, or seat mutation was performed by this repair revision.

## Review boundary

This proof closes implementation/preflight gates only. It does not authorize a merge or live canary. Guard must independently review the chief-routed immutable target. Any byte change requires a new commit, manifest, focused run, broad/base comparison, and fresh review.
