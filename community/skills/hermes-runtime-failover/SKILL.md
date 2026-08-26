---
name: hermes-runtime-failover
description: Plan, preflight, execute, and restore a cortextOS fleet failover to explicitly pinned Hermes profiles when verified Claude weekly remaining reaches 10 percent. Use for model failover, per-seat Hermes routing, Sunday Claude restoration, or auditing whether a proposed switch preserves profiles, crons, MCP tools, restart behavior, and spend evidence.
---

# Hermes Runtime Failover

Use this workflow only for a standing cortextOS fleet. It is dry-run-first and fail-closed.

## Non-negotiable gates

- A 10% trigger requires a fresh numeric weekly-remaining reading. HTTP 401, missing figures, stale figures, or an unreadable denominator means `NO RESULT`; do not infer the threshold.
- Never use Hermes profile `default` or `shared` for a standing seat. Every Hermes seat needs a unique lowercase profile matching `^[a-z0-9][a-z0-9_-]{0,63}$`.
- Pin exact `model`, `hermes_provider`, and `hermes_reasoning`. Reject model IDs beginning with `~`; those are moving aliases.
- Set `hermes_cron_ownership` explicitly. Use `cortextos` for a fleet whose existing daemon-managed `crons.json` schedules must continue. Never run both native and cortextOS scheduling for the same seat.
- Prove required MCP servers with an actual tool result, not an enabled flag.
- A green process or exit code is not enough. Verify process, profile DB, cron injection, MCP tool row, model usage row, and preserved outputs.
- Configuration changes, restarts, cron arming, and restoration are live mutations. Obtain Zarif's explicit approval immediately before the first mutation. Earlier approval does not survive a changed plan or failed preflight.

## 1. Validate the plan without changing state

Copy `references/ygs-routes.example.json` to a new evidence path and replace every `REPLACE` value. Capture separate byte-bound fleet, restore, spend, and trigger receipts. The validator requires the authoritative six-seat YGS roster, a fresh trigger receipt, per-seat and total weekly spend, per-seat MCP transcript and usage receipts, a canonical native-cron scan, and an explicit city-first/chief-last order. It independently invokes the fixed `${CTX_FRAMEWORK_ROOT}/dist/cli.js bus check-usage-api --json --force --no-store` path, requires a fresh complete authenticated Anthropic OAuth result, derives weekly remaining itself, and compares that result to the plan and receipt. The example itself is deliberately not executable until those receipts are supplied.

```bash
node scripts/validate-plan.mjs \
  --plan references/ygs-routes.example.json \
  --restore /absolute/path/to/RESTORE-STATE.json \
  --fleet-snapshot /absolute/path/to/FLEET-SNAPSHOT.json \
  --spend /absolute/path/to/SPEND-ESTIMATE.json \
  --trigger-receipt /absolute/path/to/TRIGGER-RECEIPT.json
```

The validator performs no writes and prints no credentials. Its forced usage read uses `--no-store`, so it does not update the usage cache or account state. HTTP 401, a missing CLI, a nonzero read, cached/unauthenticated/unexpected origin metadata, invalid JSON, missing utilization fields, or a stale timestamp all fail closed; unavailable measurement is never converted to zero. It hashes every referenced fleet/restore/spend/trigger/MCP artifact and rejects a plan or receipt value that differs from the independently measured weekly remaining; any source other than `cortextos-check-usage-api:anthropic-oauth`; any plan trigger whose metric, denominator, value, time, or source differs from the separate receipt bytes; any roster other than the authoritative six YGS seats; a past/non-next Sunday restore; null or moving models (including whitespace-padded aliases); invalid restore runtimes; any Hermes restore pin that differs from byte-verified live config; whitespace-padded model/provider/MCP-server pins or normalized MCP duplicates; missing or inconsistent spend; reused or cross-profile MCP evidence; a tool from the wrong required server; enabled native crons at the canonical profile path; incomplete ordering; or a snapshot-path/hash mismatch. `evidence_max_age_minutes` is mandatory and capped at 24 hours. Any error blocks the switch.

## 2. Re-read live state immediately before preflight

Capture each seat's current `runtime`, explicit fixed `model`, config hash, process PID/status, profile, cron count, and next fire time. The fleet snapshot must identify `ygs-cortex-fleet` and contain exactly `chief`, `city`, `growth`, `guard`, `sentinel`, and `social`; the restore snapshot must contain the same set. Each fleet row must include the canonical `${CTX_FRAMEWORK_ROOT}/orgs/ygs-cortex-fleet/agents/<seat>/config.json` path and its byte hash. Validation rereads those canonical files and rejects decoys or drift. The fleet snapshot must also list `intended_hermes_seats` exactly as `chief`, `city`, `growth`, `sentinel`, and `social`; both cutover orders are derived from that byte-bound set. Both snapshots include schema version, absolute UTC capture/restore timestamps, `captured_from: live-seat-configs`, and a config SHA-256 for every seat. Save them to new timestamped files. Do not overwrite an earlier snapshot.

Create a separate spend receipt with `schema_version: 1`, a fresh `generated_at_utc`, `currency: USD`, a named estimation method, the exact six-seat set, and for each seat the planned runtime/model/provider plus finite non-negative `expected_weekly_usd`. `total_expected_weekly_usd` must equal the per-seat sum. Bind its exact path and SHA-256 into the plan.

For each proposed Hermes seat:

1. Create or reuse only its named isolated profile. When creating, use `hermes profile create <name> --clone --no-alias`; never use `--clone-all`.
2. Invoke a non-live canary with all four pins: `--profile`, `--model`, `--provider`, `--reasoning`.
3. Write `--usage-file` output into the evidence directory.
4. Put a unique nonce into profile A. Query profile A, profile B, and global `~/.hermes/state.db`; require counts `>0`, `0`, `0` respectively.
5. Enable only required MCPs in that profile, run `hermes --profile <name> mcp test <server>`, then require a real model-invoked MCP tool row in that profile DB.
   Preserve dedicated JSON transcript and usage receipts for each seat/server pair. Both receipts must contain the exact seat, profile, required server, unique invocation ID, profile session ID, tested timestamp, and success state; the transcript also binds the server-specific `mcp__<server>__*` tool and result marker, while usage binds model/provider. Evidence paths and hashes cannot be reused across seats or servers.
6. Read the canonical `<HERMES_HOME root>/profiles/<profile>/cron/jobs.json`. The validator derives this path from `HERMES_HOME` and the planned profile; a plan cannot substitute a decoy path. Require zero enabled native jobs before selecting `hermes_cron_ownership: cortextos`; the runtime adapter independently refuses to start the external scheduler when the native file is active, malformed, or unreadable.
7. Run `hermes --profile <name> prompt-size --json`. Reject a model whose usable context cannot comfortably hold fixed bootstrap plus the expected task input and output.

## 3. Prove the cortextOS adapter

From the exact isolated framework ref intended for deployment:

```bash
npm run build
npm test -- --run \
  tests/unit/pty/hermes-pty.test.ts \
  tests/unit/daemon/agent-process-hermes.test.ts \
  tests/unit/daemon/agent-manager.test.ts \
  tests/unit/cli/add-agent-hermes.test.ts
```

Required effects:

- Spawn receives exact profile/model/provider/reasoning argv and matching `HERMES_HOME`.
- Missing, malformed, `default`, and `shared` profiles fail before spawn.
- `.force-fresh` is consumed before any Hermes DB continuation check.
- Native cron ownership skips the daemon scheduler.
- CortextOS ownership creates the scheduler and fires through `injectAgent`.
- New Hermes agents cannot be scaffolded without an explicit model.

## 4. Approval packet

Send chief one consolidated packet containing:

- verified trigger reading and timestamp;
- exact per-seat routes, byte-bound per-seat weekly spend, and byte-bound total weekly spend;
- restore snapshot path and hash;
- build/test denominators;
- two-profile nonce counts;
- MCP server, tool name, and returned canary value;
- prompt/tool-schema bytes per profile;
- proposed mutation order and one-shot restore time in local time plus UTC;
- explicit statement that live seats are still unchanged.

Stop until Zarif approves the exact packet.

## 5. Approved cutover

Apply `city` first as the mechanically declared canary. The validator requires the exact Hermes seat set once, `city` first, and coordinating seat `chief` last for both cutover and restore. Restart only the canary seat. Verify:

1. process runtime and PID;
2. argv/profile env in adapter evidence;
3. the expected profile DB receives the new session while every other profile does not;
4. exact model/provider appear in `session_model_usage` or the invocation usage file;
5. one inbox reply path works;
6. one owned cron fires exactly once;
7. one required MCP tool call succeeds;
8. no unexpected Telegram initiation occurs.

If any check fails, restore that seat immediately from the snapshot and stop. After a successful canary, migrate remaining specialists one at a time. Migrate the coordinating seat last so it can supervise every earlier move.

## 6. Sunday restore

The standing contract is Sunday at 15:00 `America/Chicago`. Convert that occurrence to an absolute ISO timestamp, create a one-shot daemon-managed cron only after approval, and read back its `next_fire_at`. The restore handler must:

1. re-read the snapshot and current live state;
2. refuse if seat membership changed or the snapshot hash differs from the approved packet;
3. restore one canary seat first;
4. verify runtime/model/process/inbox/cron effects;
5. restore remaining seats one at a time, coordinating seat last;
6. remove or allow deletion of the fired one-shot cron only after effect proof;
7. preserve Hermes profiles and usage evidence for audit—do not delete histories during restore.

If Sunday arrives while prerequisites are not satisfied, roll the restore forward with a new approved time. Never mark it restored because the cron fired.

## Stop conditions

Stop and report a concrete blocker for any of: no verified usage figure, unapproved live mutation, moving model alias, duplicate/shared profile, model/provider mismatch, profile cross-contamination, missing cron owner, double fire, MCP flag without tool execution, missing restore seat, changed restore hash, or incomplete effect proof.
