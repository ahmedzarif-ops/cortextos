# Hermes runtime parity — consolidated isolated proof

captured_at_utc: 2026-08-26T18:47Z
worktree: `/Users/guest1/cortextos-worktrees/hermes-runtime-parity`
branch: `fix/hermes-runtime-parity`
base: `4fe279b`
scope: isolated build and proof only; no live seat/config/cron mutation

## Result

The four original parity defects are closed in the isolated implementation:

1. every Hermes launch carries explicit profile/model/provider/reasoning pins;
2. standing histories resolve to unique profile databases and shared profiles fail closed;
3. cron ownership is explicit, with cortextOS-owned Hermes crons using the existing scheduler;
4. an isolated Hermes model invoked a real Context7 MCP tool successfully.

The hard-restart ordering defect is also fixed: `.force-fresh` is consumed before Hermes continuation checks.

## Source surface

- `src/types/index.ts` — typed Hermes profile/provider/reasoning/cron ownership fields.
- `src/pty/hermes-pty.ts` — profile validation/root normalization, pinned argv, matching env, profile DB lookup.
- `src/daemon/agent-process.ts` — marker-first restart and configured-profile continuation.
- `src/daemon/agent-manager.ts` — explicit native vs cortextOS cron ownership.
- `src/cli/add-agent.ts` — Hermes template selection, required model, scaffolded pins/profile/cron owner.
- `templates/hermes/config.json` — named profile plus explicit provider/reasoning/cron owner.
- focused unit tests plus reusable `community/skills/hermes-runtime-failover/`.

## Build and tests

- `git diff --check`: RC 0.
- `npm run build`: RC 0, tsup build success.
- Focused parity/skill suite: 5 files, 58 tests, 58 passed, RC 0.
- Broad suite: 142 files; 136 passed, 1 skipped, 5 failed; 2,261 tests passed, 3 skipped, 34 failed.
- Baseline control on the same five failing files at base checkout `4fe279b`: 33 failures reproduce unchanged (inherited live `CTX_AGENT_DIR` sandbox leakage plus Hermes Node wrapper expectations). The branch-only 34th is an unrelated `.claude` symlink test whose source has an existing uncommitted fix in dirty `/Users/guest1/cortextos/src/hooks/index.ts`; that live user change was not copied or touched.
- Conclusion: changed Hermes surface is green; the repository-wide suite is not globally green at the base/environment and is not represented as such.

## Spawn and restart proof

Focused tests assert the actual PTY spawn seam receives:

```text
hermes --profile hermes-agent --model z-ai/glm-5.3-flash --provider nous --reasoning high
HERMES_HOME=~/.hermes/profiles/hermes-agent
HERMES_PROFILE=hermes-agent
```

Continue mode preserves every pin and appends `--continue`. Missing/malformed/`default` profiles fail before spawn. An agent-local wrong `HERMES_HOME` is overwritten by the same daemon-level root used for DB probing. `.force-fresh` returns fresh, consumes the marker, and never calls the profile DB probe.

## Cron proof

- Native/unspecified Hermes ownership preserves the existing daemon-scheduler skip.
- `hermes_cron_ownership: "cortextos"` creates the daemon scheduler.
- Effect test wrote a sandboxed one-minute `hermes-heartbeat` cron, advanced the scheduler, and observed exactly one call through `injectAgent('alice', '[CRON FIRED ...] hermes-heartbeat: Run the isolated heartbeat canary.')`.
- No production cron file or schedule was changed.

## Two-profile isolation proof

profiles:

- `/Users/guest1/.hermes/profiles/sentinelparitya/state.db`
- `/Users/guest1/.hermes/profiles/sentinelparityb/state.db`

Profile A received unique nonce `CORTEXTOS_PROFILE_A_ONLY_20260826T184100Z` through an explicitly pinned `z-ai/glm-5.3-flash` / `nous` / `high` invocation and returned it exactly.

Independent SQLite counts over `messages.content`:

```text
sentinelparitya/state.db | 2
sentinelparityb/state.db | 0
~/.hermes/state.db       | 0
```

This is a positive control in A and negative controls in B and the global DB.

## MCP effect proof

- Isolated profile A enabled only `context7` among the six cloned MCP entries.
- `hermes --profile sentinelparitya mcp test context7`: connected in 816 ms; 2 tools discovered.
- Explicitly pinned model invocation required `resolve-library-id` for `zod`.
- Final output: `MCP_CONTEXT7_OK /colinhacks/zod`.
- Profile DB contains tool row `mcp__context7__resolve_library_id` with returned untrusted-tool-result content.
- Usage report: model `z-ai/glm-5.3-flash`, provider `nous`, 4 API calls, 85,780 total tokens including cache reads, estimated $0.002050816, completed true, failed false.

## Isolated workers and spend

- Worker A runtime audit: 8 API calls, estimated $0.003460244.
- Worker B test-resolution diagnosis: 11 API calls, estimated $0.002212664.
- Profile nonce canary: 1 API call, estimated $0.00120598.
- MCP canary: 4 API calls, estimated $0.002050816.
- Total measured estimated spend: `$0.008929704`.
- Raw reports and usage JSON files are in this evidence directory.

## Prompt/context proof

`hermes --profile sentinelparitya prompt-size` offline result:

- system prompt: 40,756 B;
- tool schemas: 44,808 B across 27 tools;
- skills index: 20,318 B;
- memory: 2,530 B;
- user profile: 1,538 B.

Fixed bootstrap plus schemas is about 85.6 KB before task input. This is acceptable only for large-context routes and remains a hard routing input. The skills index is the largest avoidable fixed block.

## Reusable failover/restore contract

`community/skills/hermes-runtime-failover/` is structurally valid under the skill-creator validator. Its plan validator:

- accepts the current six-seat proposed routing plus the restore snapshot;
- reports 6 seats, 5 isolated Hermes profiles, `live_changes: 0`;
- rejects a trigger other than exactly 10%, moving `~` aliases, duplicate/shared profiles, missing routing pins, wrong cron ownership, changed seat membership, and invalid Sunday restore contract;
- requires owner approval again immediately before cutover and before arming the one-shot Sunday restore.

Current restore source: `/Users/guest1/cortextos/orgs/ygs-cortex-fleet/agents/sentinel/workspace/failover/RESTORE-STATE.json`.

## Live-state negative proof

All six current seat configs were re-read after proof:

```text
chief    | codex-app-server | gpt-5-codex | no Hermes profile
growth   | codex-app-server | gpt-5-codex | no Hermes profile
guard    | codex-app-server | gpt-5-codex | no Hermes profile
city     | codex-app-server | gpt-5-codex | no Hermes profile
social   | codex-app-server | gpt-5-codex | no Hermes profile
sentinel | codex-app-server | gpt-5-codex | no Hermes profile
```

All six agents are still reported running. No standing-seat mutation occurred.

## Remaining gates before any live move

1. Review/land the isolated framework change; live daemon does not yet contain it.
2. Re-read exact current model catalog IDs/prices and owner-approved per-seat route packet.
3. Obtain explicit Zarif approval for that exact packet and mutation order.
4. Apply one low-risk live canary seat and verify process/profile/model/inbox/cron/MCP effects.
5. Only after the live canary passes, migrate other seats one at a time; coordinator last.
6. Arm the Sunday 15:00 America/Chicago one-shot restore only with explicit approval and verified `next_fire_at`.

