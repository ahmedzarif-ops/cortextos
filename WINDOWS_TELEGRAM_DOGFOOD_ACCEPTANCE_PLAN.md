# Windows Telegram dogfood acceptance plan

**Status:** Ready for credentialed execution  
**Target branch:** `codex/windows-native-runner`  
**Environment:** Existing secured Azure Windows VM  
**Purpose:** Validate cortextOS as a real Windows user experiences it, using live Telegram conversations and all three supported agent runtimes.

## 1. Outcome

Run a private, disposable cortextOS installation on the Windows VM with three independently addressable agents:

| Dogfood agent | Runtime | Telegram identity |
|---|---|---|
| `claude-test` | `claude-code` | Dedicated temporary bot 1 |
| `codex-test` | `codex-app-server` | Dedicated temporary bot 2 |
| `opencode-test` | `opencode` | Dedicated temporary bot 3 |

The user must be able to message each bot normally from Telegram and receive useful, correctly correlated replies from the intended live runtime. The run must also exercise the Windows-specific lifecycle paths changed on this branch without touching the maintainer's normal cortextOS data or the previous acceptance instance.

Success means the three agents remain usable during ordinary conversation, survive expected lifecycle events, recover safely from faults, and leave enough redacted evidence to diagnose every observed failure. It does not mean that no future bug can exist.

## 2. Isolation and safety rules

- Use a new run ID, CTX root, PM2 home, PM2 process names, Task Scheduler task, org, agent directories, ports, logs, and test files.
- Never reuse the stopped overnight acceptance instance as the mutable dogfood environment.
- Use one bot token per agent. Sharing a token between pollers is prohibited because Telegram permits only one active `getUpdates` consumer.
- Authorize only the user's Telegram numeric user ID. Messages from any other identity must be rejected without reaching an agent.
- Bind the dashboard to `127.0.0.1`; access it only through the existing secure administration path. Do not add public firewall or Azure NSG rules.
- Keep model-provider credentials in the authenticated Windows user profile. Do not copy or print them.
- Bot tokens must never appear in Git, patches, reports, screenshots, PM2 process descriptions, test names, command-line arguments, or captured command output.
- Store temporary Telegram secrets only in the dogfood instance's ignored environment file, restrict its Windows ACL to the current user and SYSTEM, and verify Git cannot see it.
- Do not inspect unrelated personal files. Native filesystem tests stay inside the disposable dogfood root.
- Do not run destructive shell prompts. Fault injection may terminate only captured dogfood PIDs/process trees and scoped PM2 processes.
- Revoke all three bot tokens after acceptance, remove local secret files, and confirm the pollers can no longer authenticate.

The safest credential handoff is entry directly in a PowerShell session on the VM using a no-echo prompt. If temporary tokens are supplied through chat instead, treat the entire chat transcript as containing secrets and revoke the tokens immediately after the run.

## 3. Execution gates

### Gate A — preflight

Before starting any live poller:

- Record the exact Git commit under test and confirm the worktree is on the isolated branch.
- Confirm the new instance paths and names do not collide with an existing instance.
- Confirm Node.js, npm, Git, PM2, PowerShell, Claude Code, Codex, and OpenCode versions.
- Run `npm ci`, typecheck, build, focused lifecycle tests, and secret-scanning checks.
- Run `cortextos doctor`; executable readiness and authentication readiness must be reported separately and truthfully for all three runtimes.
- Confirm the VM's inbound rules remain source-restricted and the dashboard is loopback-only.
- Validate each bot token locally without displaying it, record only the bot ID/username, and verify all three bot IDs are distinct.
- Discover and record the authorized Telegram numeric user ID without logging message bodies or tokens.

Failure of isolation, secret handling, runtime authentication, or network exposure blocks the live run. A functional bug enters the adaptive loop in section 8.

### Gate B — clean dogfood install

- Install and initialize a new instance through the supported Windows PowerShell flow.
- Create one org and the three agents listed above using normal CLI/onboarding behavior.
- Confirm each agent has the intended runtime and only its own bot configuration.
- Start daemon, pollers, agents, and loopback dashboard through the generated ecosystem configuration.
- Install the scoped Windows startup task twice; the second run must be idempotent and must not create a duplicate task.
- Confirm `doctor`, `list-agents`, `status`, PM2 status, and dashboard status agree.
- An agent may be shown as online only after its runtime is actually ready to accept a message.

### Gate C — ordinary real-user acceptance

The user sends the messages; automation observes timestamps, redacted logs, bus artifacts, and process state. For each bot, perform:

1. A simple greeting and identity question.
2. A two-turn conversation whose second turn depends on the first.
3. A harmless native Windows task: create a uniquely named text file under that agent's disposable test directory with PowerShell, read it back, and report its contents.
4. A question sent while another runtime is busy, proving agent isolation and concurrency.
5. Two messages sent quickly in a known order.
6. A Telegram command supported by the product and a normal text message immediately afterward.
7. A response long enough to exercise Telegram chunking, with each chunk delivered once and in order.
8. A fresh message after at least one idle interval.

For every turn, require:

- exactly one inbound receipt;
- exactly one dispatch to the intended agent;
- no cross-agent or cross-chat delivery;
- no injection before runtime readiness;
- a complete, useful reply delivered exactly once;
- preserved per-agent conversational continuity;
- a correlation ID linking redacted receive, inject, complete, and send events;
- truthful lifecycle state and bounded latency, with timing recorded rather than silently ignored.

The user makes the qualitative judgment on response usefulness and whether interaction feels normal. The observer records that judgment separately from the programmatic transport result.

## 4. Lifecycle and fault matrix

Run each scenario sequentially so failures have an unambiguous cause. Tell the user before a bot will be intentionally unavailable.

| Scenario | Required behavior | Applies to |
|---|---|---|
| Agent stop/start | Stops the captured process tree, reports stopped, starts one replacement, then answers a new Telegram message | All three |
| Agent restart | No duplicate runtime or poller; next message preserves supported session behavior | All three |
| Disable/re-enable | Disabled agent does not resurrect or consume messages; re-enabled agent becomes genuinely ready and resumes service | All three |
| Forced runtime exit | Daemon detects death, observes backoff, starts exactly one replacement, and answers a message queued at the readiness boundary | All three |
| Daemon restart | Pollers and agents reconnect without duplicate delivery, lost accepted messages, or cross-agent state | All three |
| Back-to-back traffic during recovery | Accepted messages remain queued and return in order once the replacement runtime is ready | All three |
| Stale marker/process simulation | Stale state is repaired only after the old Windows process tree is confirmed dead | OpenCode and applicable shared paths |
| Codex transport restart | Loopback app-server endpoint is rediscovered; only `127.0.0.1` is accepted; no leaked `codex.exe` remains | Codex |
| Claude fresh-profile gate | First-run/theme/trust screens cannot cause a false ready state or swallow a message | Claude, using only a disposable profile if repeated |
| PM2 cold resurrection | Scoped saved process list restores daemon/dashboard and then all enabled agents/pollers | Whole instance |
| Controlled VM reboot | S4U startup task restores the scoped PM2 home without login; Telegram becomes usable without manual repair | Whole instance |

For stop, disable, crash, and reboot cases, test a message both after recovery and—where Telegram semantics make it safe—during the transition. Record whether it was accepted, queued, retried, or rejected. Never call a silently lost message a pass.

## 5. Poller and Telegram-specific criteria

- Exactly one poller owns each token at steady state.
- No sustained Telegram `409 Conflict` loop occurs before or after restarts.
- Telegram offsets survive daemon/PM2/VM restarts without replaying already handled updates.
- Duplicate update delivery, retry, and outbound-send failure paths are idempotent where the Telegram API permits it.
- Temporary network/API failures use bounded backoff and recover without a process storm.
- An unauthorized sender test is performed from a separate test identity if one is available; no message content reaches the runtime and no useful private status is disclosed.
- Bot commands and ordinary messages route to the same intended agent but retain their documented semantics.
- Markdown/escaping, Unicode, CRLF-containing content, and a reply requiring chunking render without corruption.
- Logs show bot identity, safe chat/user identifiers if permitted, update ID, correlation ID, retry category, and result—never the token.

If a second Telegram identity is unavailable, unauthorized-sender behavior remains covered deterministically and is marked **LIVE UNVERIFIED**, not passed.

## 6. Scheduler, persistence, and native-host criteria

For each runtime:

- Add a uniquely named short-interval cron through the supported bus command.
- Confirm it appears in only that agent's `crons.json`, loads without restarting the agent, fires once as expected, reaches the live runtime, and produces a Telegram-visible or otherwise correlated result.
- Restart the agent and daemon; confirm the cron remains scheduled.
- Disable/remove it and wait through at least two former fire windows; it must not fire again.

For the instance:

- Verify native PowerShell execution occurs under the expected Windows user, not WSL or Docker.
- Verify each agent can create/read its own disposable file and cannot accidentally use another agent's configured working directory.
- Verify PM2 save/resurrect, the scoped Task Scheduler action/principal/PM2 home, a cold process resurrection, and one controlled VM reboot.
- After reboot, require daemon, loopback dashboard, three enabled runtimes, three pollers, and retained cron configuration to recover without an interactive login or manual command.

## 7. Observability checks

At every phase, the operator must be able to answer from redacted evidence:

- Which executable and adapter were selected?
- Which PID/process tree belongs to each runtime and poller?
- Is the runtime starting, ready, thinking, idle, recovering, disabled, stopped, or terminally failed—and why?
- Which Telegram update became which bus message and outbound reply?
- Was a retry safe, and what backoff was applied?
- Did a cron load, fire, finish, retry, or fail?
- Did restart recovery create exactly one replacement?

Create a timestamped test ledger with scenario ID, runtime, commit, expected result, actual result, evidence locations, sanitized error signature, classification, fix commit, rerun result, and residual risk. Raw secrets and full environment dumps are forbidden.

## 8. Adaptive bug loop

Every programmatic error, unexpected log, behavioral mismatch, confusing status, excessive delay, or user-reported rough edge enters this loop:

1. **Preserve evidence:** assign a bug ID; capture sanitized logs, timestamps, correlation IDs, process state, and exact user-visible behavior before restarting anything.
2. **Classify:** product defect, invalid test assumption, environment/configuration issue, provider/API issue, security issue, or usability/documentation issue. Track confidence and severity.
3. **Minimize:** reproduce with the smallest deterministic test possible. Add a failing automated regression test when the behavior is representable without live credentials.
4. **Fix narrowly:** prefer the shared Node.js core; use a thin Windows adapter only for genuinely different OS behavior. Do not create a second Windows implementation of the daemon, poller, scheduler, or routing logic.
5. **Verify locally:** run the new regression, adjacent focused suites, typecheck, build, and secret scan.
6. **Verify live:** repeat the exact failed Telegram/Windows scenario on the disposable instance.
7. **Check blast radius:** rerun the equivalent Claude/Codex/OpenCode scenarios, then the Windows/macOS/Linux CI matrix when code changed.
8. **Soak:** after the fix, continue ordinary traffic and lifecycle testing long enough to cross the affected retry/readiness/restart windows.
9. **Close honestly:** mark fixed only when the original evidence is contradicted by a passing rerun. Otherwise leave it open, deferred with reason, or blocked with the precise external dependency.

After each fix, begin the next observation cycle from the last known-good checkpoint. Newly discovered bugs are prioritized by: secret/security exposure; message loss or wrong-recipient delivery; process duplication/leak; inability to recover; false status; functional breakage; performance; usability/documentation.

Do not weaken assertions, add unconditional Windows skips, increase timeouts without diagnosing the delay, or restart blindly until a flaky test passes.

## 9. Soak and exit criteria

After all deterministic scenarios pass, run a real-user soak with all three bots enabled:

- at least 10 meaningful user turns per runtime;
- at least 3 rapid-message pairs per runtime;
- at least 1 idle/resume turn per runtime;
- at least 1 cron fire per runtime;
- at least 1 agent restart per runtime;
- at least 1 daemon restart, PM2 cold resurrection, and VM reboot for the instance;
- no unresolved critical/high defect, message loss, wrong-recipient delivery, duplicate reply, sustained poller conflict, leaked child process, false-ready state, secret leak, or manual repair after reboot.

The run passes only when:

- the user confirms all three bots feel normally usable;
- every mandatory matrix row has timestamped passing evidence;
- all discovered critical/high issues are fixed and rerun, or the overall verdict is explicitly **NOT READY**;
- deterministic Windows, macOS, and Linux CI is green at the final tested commit;
- the final report separates `PASS`, `FAIL`, `UNVERIFIED`, and qualitative observations;
- the exact tested commit is recorded and contains no secrets.

## 10. Cleanup and handoff

1. Export only sanitized logs, the test ledger, bug ledger updates, and final report.
2. Disable/remove disposable crons and prove they stop firing.
3. Stop and remove the scoped PM2 processes; save the now-clean scoped PM2 state.
4. Remove the scoped Windows startup task and confirm it is gone.
5. Confirm captured agent, poller, and descendant PIDs are dead; confirm no dashboard listener remains.
6. Delete the dogfood secret file and any temporary token material.
7. Revoke all three bot tokens through BotFather and verify authentication now fails.
8. Leave the disposable code/state directory only if it is useful as sanitized evidence; otherwise remove it after explicit review.
9. Do not merge or push to `main`. Present the isolated branch, commits, CI links, remaining risks, and rollback instructions for review.

## 11. Human checkpoints

Human input is required only for:

- creating the three temporary bots and securely entering their tokens;
- sending the designated Telegram test conversations and judging response quality;
- optionally providing a second Telegram identity for the live unauthorized-sender test;
- confirming the controlled VM reboot window if availability matters;
- revoking the bot tokens at cleanup;
- approving any eventual merge to `main`.

All other setup, observation, fault injection, regression work, reruns, evidence collection, and scoped cleanup can be executed autonomously within this plan.
