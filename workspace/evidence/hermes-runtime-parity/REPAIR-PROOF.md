# Hermes runtime parity repair proof

prepared_at_utc: 2026-08-26T20:08:34Z
worktree: `/Users/guest1/cortextos-worktrees/hermes-runtime-parity`
branch: `fix/hermes-runtime-parity`
original_base: `4fe279b753408d407189222809aa3ddf74cc565c`
reviewed_blocked_baseline_commit: `de6d6007349ddf5276eb558a36250b2a06ca2a5b`
reviewed_blocked_baseline_tree: `754f11ec21c92e80d4d4c6c81b4bae372820e054`
reviewed_blocked_baseline_manifest_sha256: `a20b2a4d477221d01e0e600f81536fa09d0f2a7141250cf33f652ac5b4683f08`
guard_final_report: `/Users/guest1/cortextos/orgs/ygs-cortex-fleet/agents/guard/reports/2026-08-26-hermes-runtime-parity-review-538371c.md`
guard_final_report_sha256: `3a25b2e217a62dc8642c9a9e8bca90e40dbdf436d417beb1c9d8f6efce27e0f6`
latest_guard_block_routed_by_chief_msg: `1787774637905-chief-wps8b`
live_changes: `0`

The immutable repair commit and external changed-file manifest are frozen after this proof file is committed. Their hashes are supplied in the chief-routed review packet; no writer may modify that target during review.

## Guard defect dispositions

1. **Mandatory launch pins — closed.** `resolveHermesLaunchPins()` resolves an isolated profile and rejects missing/invalid pins plus moving selectors including `auto`, `latest`, `deepseek/latest`, `gpt-5-auto`, and `~...`. `HermesPTY` calls it before the real spawn seam, and add-agent calls the same resolver before creating files. All successful launches emit `--profile`, `--model`, `--provider`, and `--reasoning`.
2. **Strict plan/restore validation — closed.** The validator requires a byte-hashed fleet snapshot and rereads each canonical `${CTX_FRAMEWORK_ROOT}/orgs/ygs-cortex-fleet/agents/<seat>/config.json`. Model/provider values must already equal their trimmed canonical form, and moving-alias detection trims exactly as runtime resolution does, so a padded `auto` or `nous` cannot validate with equally padded evidence. It rejects decoy paths, byte drift, any roster other than the authoritative six, restore rows that differ from those verified live bytes, invalid provenance, missing per-seat/total spend, invalid/null/whitespace pins, moving aliases, stale evidence, and a past/non-next-Sunday restore. When the verified live route is Hermes, restore profile/provider/reasoning/cron ownership must all match it exactly in addition to runtime/model/config hash.
3. **Mutable artifact — closed by freeze.** The repair is committed after tests, then identified by exact commit/tree plus a SHA-256 changed-file manifest stored outside the target. The worktree must remain clean and read-only for Guard.
4. **MCP readiness — closed.** Every required MCP needs a fresh per-profile/per-server receipt, a server-specific `mcp__<server>__*` tool and result marker, globally unique invocation/session identities, and separate transcript/usage JSON bytes bound to seat, profile, server, invocation, session, timestamp, model, provider, and success. Paths or identical bytes cannot be reused across proofs.
5. **Native/cortextOS cron collision — closed.** Plan validation derives `<HERMES_HOME>/profiles/<validated-profile>/cron/jobs.json` and ignores decoys; runtime independently refuses initial scheduler creation when native jobs are active/unreadable, stops on reload if jobs appear, and rechecks before every fire.
6. **Mechanical canary ordering — closed.** The byte-bound fleet snapshot names the exact intended Hermes set (`chief`, `city`, `growth`, `sentinel`, `social`), checked against fixed YGS policy. Both cutover orders must contain that set exactly once, with `city` first and coordinator `chief` last; omitting a seat everywhere still fails.

The focused suite contains direct negative reproductions of Guard's six original RC0 adversarial plans: missing spend, omitted guard, omitted Hermes sentinel plus evidence/orders, cross-profile MCP reuse, a fake non-context7 tool, and a decoy cron file while the canonical profile file is active. It also rejects a fabricated fleet snapshot, duplicate MCP invocation/session identities, a padded moving alias with matching raw evidence, a padded provider with matching raw evidence, and independent restore mismatches for Hermes profile, provider, reasoning, and cron ownership.

## Final focused proof

Exact command:

```text
npm test -- --run tests/unit/pty/hermes-pty.test.ts tests/unit/daemon/agent-process-hermes.test.ts tests/unit/daemon/agent-manager.test.ts tests/unit/cli/add-agent-hermes.test.ts tests/unit/community/hermes-runtime-failover-skill.test.ts
```

Raw result: RC `0`; test files `5 passed (5)`; tests `103 passed (103)`.

Build command: `npm run build`

Raw result: RC `0`; `tsup` build success.

Whitespace command: `git diff --check 4fe279b753408d407189222809aa3ddf74cc565c`

Raw result: RC `0`; no output.

## Broad/base control

Repair target command: `npm test -- --run`

Raw repair result: RC `1`; test files `5 failed | 137 passed | 1 skipped (143)`; tests `34 failed | 2312 passed | 3 skipped (2349)`.

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
