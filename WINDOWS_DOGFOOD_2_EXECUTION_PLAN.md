# Windows Dogfood 2 execution plan

Run ID: `windows-dogfood-2-20260819`

Branch: `codex/windows-native-install-dogfood-2-20260819`

Base checkpoint: `0958d5d1`

Status: planning only; the VM has not been changed for Dogfood 2.

## Purpose

Dogfood 2 will test Cortext as a normal Windows user experiences it: a clean
clone, native PowerShell installation, root onboarding guidance, fresh agent
scaffolding, headless persistence, first agent boot, and real Telegram
conversation. It will reuse the two existing temporary Telegram bot identities
for Claude and Codex, but it will not reuse Dogfood 1 code, dependencies, agent
state, PM2 state, scheduled tasks, or onboarding progress.

Dogfood 1 is frozen as evidence and a rollback target. Main remains untouched.

## Non-negotiable invariants

- Only one active `getUpdates` consumer may own a Telegram token. Dogfood 1 must
  be stopped and proven inactive before Dogfood 2 starts either poller.
- The existing bot tokens must never appear in commands, process arguments,
  logs, patches, Git, screenshots, or reports.
- Token values may move only inside the VM from an existing protected secret
  file to a new protected secret file, without being emitted to stdout. The new
  files must immediately receive the owner-and-LocalSystem-only Windows ACL.
- Dogfood 1 files and logs are preserved. Its scheduled task is disabled rather
  than deleted until Dogfood 2 is accepted.
- Dogfood 2 gets a new clone directory, CTX root, instance ID, org, PM2 home,
  process names, scheduled task, state directory, logs, ports, and agent dirs.
- No `node_modules`, build output, runtime state, `.env`, Telegram offset, or
  `.onboarded` marker is copied from Dogfood 1.
- Dashboard remains bound to `127.0.0.1`; no Azure NSG or Windows Firewall port
  is opened.
- Every manual repair or command translation a normal user would have needed is
  recorded as a product/usability failure.

## Phase 1 — implementation before the clean install

### 1. Preserve already-completed fixes

Dogfood 2 starts with all checkpoint fixes, including:

- native Windows paths, process trees, PTYs, Codex IPC, and PM2 persistence;
- Windows-safe secret ACLs and loopback-only dashboard generation;
- native Claude executable resolution under Task Scheduler/S4U;
- readiness-confirmed recovery notifications from `3ff763ce`;
- the one-question onboarding gate from `0958d5d1`.

### 2. Make the onboarding turn boundary structural

The high-level one-question rule is necessary but still relies on model
instruction-following. Before Dogfood 2 installation:

1. Review every shipped `ONBOARDING.md` and onboarding skill used by Claude,
   Codex, OpenCode, orchestrator, analyst, and community roles.
2. Combine the introductory text with the first substantive question so a new
   user is not forced through a redundant “can you help?” turn.
3. Put an explicit `END YOUR TURN` immediately after every onboarding prompt or
   topical question group, not only at the top of the document.
4. Require the next turn to resume at the earliest unanswered item and prohibit
   repeating already-answered prompts.
5. Add a deterministic structural regression that fails if a shipped document
   contains two onboarding prompts without an intervening turn boundary.
6. Keep communication-style subparts together as one clearly scoped topical
   question; do not send multiple Telegram messages in that turn.

If a live runtime still batches questions after this instruction hardening,
escalate to a product-level outbound gate tied to inbound-turn correlation. Do
not add that mechanism preemptively without proving the instruction contract is
insufficient.

### 3. Resolve the native-shell behavioral observation

DOG-012 remains open because Claude emitted Bash-like commands on Windows even
though the native-host rule existed. Before the fresh install:

1. Reproduce the exact behavior in a disposable Windows agent directory while
   capturing sanitized command/tool metadata.
2. Determine whether the provider harness translated the commands safely,
   invoked an undocumented compatibility shell, or actually violated the
   Cortext native-shell contract.
3. If Cortext instructions caused it, make runtime-specific Windows guidance
   explicit: PowerShell syntax or cross-platform Node/Cortext CLI only.
4. Add a static portability regression for forbidden user-facing Bash commands
   and a behavioral probe that creates/reads a file using the selected Windows
   shell.
5. Keep it classified as `UNVERIFIED` if provider internals prevent reliable
   attribution; do not call it fixed because a command happened to succeed.

### 4. Pre-install verification gate

Run before any VM cutover:

- focused onboarding, recovery, runtime resolver, secret-permission, ecosystem,
  and startup-helper tests;
- root typecheck and build;
- dashboard typecheck/build where affected;
- `git diff --check` and a secret scan;
- full local test suite;
- review that the unrelated pre-existing
  `tests/unit/lifecycle/legacy-status.test.ts` modification is not staged;
- commit and push only Dogfood 2; never update main or rewrite Dogfood 1.

## Phase 2 — freeze Dogfood 1 and transfer Telegram ownership

Tell the user when the short Telegram maintenance window begins and ask them not
to message either bot until Dogfood 2 is declared ready.

1. Capture Dogfood 1's exact commit, scoped PM2 status, Task Scheduler state,
   agent/poller PIDs, dashboard listener, latest safe Telegram update metadata,
   and sanitized log counters.
2. Gracefully stop both old pollers and agents, then the scoped daemon/dashboard.
3. Save the stopped scoped PM2 state and disable the Dogfood 1 scheduled task so
   it cannot reclaim the tokens after reconnect or reboot.
4. Confirm there are zero old poller/runtime descendants and no old dashboard
   listener. Wait beyond one long-poll interval and confirm no new Dogfood 1
   activity or Telegram `409 Conflict`.
5. Preserve Dogfood 1 directories and ACLs unchanged for rollback.
6. Copy only the two token values inside the VM into a temporary protected
   Dogfood 2 bootstrap secret source. Do not copy chat offsets, chat history,
   agent state, or onboarding markers.

Rollback before Dogfood 2 acceptance is: stop Dogfood 2 completely, prove zero
new pollers, re-enable Dogfood 1's task, start its saved PM2 state, and verify a
single owner per token. Never run both instances concurrently.

## Phase 3 — reproduce a normal clean Windows installation

### Clean source and dependencies

1. Clone the remote Dogfood 2 branch into a brand-new directory.
2. Record the exact commit and prove the clone is clean.
3. Use the supported Node/npm versions and native Windows PowerShell 5.1 path.
   Do not use WSL, Git Bash, Docker, or hidden compatibility tooling.
4. Follow the root onboarding skill exactly as written. Record every command it
   recommends and whether a normal user could run it unchanged.
5. Run a fresh `npm ci`, typecheck, build, native node-pty load/spawn probe, and
   `cortextos doctor`. Do not reuse any dependency directory or global test
   state except explicitly supported machine prerequisites.

### Fresh Cortext instance

1. Create a new isolated instance and org through the documented CLI/setup flow.
2. Exercise `cortextos setup` end to end in native PowerShell, including masked
   credential input, Telegram discovery, private-user authorization, and clean
   terminal exit. Use the existing protected token source without displaying
   or placing token values in argv.
3. Scaffold fresh `claude-test` and `codex-test` agents from the updated runtime
   templates. Verify no `.onboarded` marker or prior conversation state exists.
4. Confirm runtime selection, executable readiness, and authentication readiness
   independently for Claude and Codex.
5. Inspect all new secret ACLs and require protected inheritance plus only the
   current Windows identity and LocalSystem.
6. Generate a uniquely scoped PM2 ecosystem with a loopback dashboard and
   instance-specific names. Verify no secret is embedded in the ecosystem file
   or PM2 process description.
7. Register the new Startup/S4U scheduled task twice and prove idempotence,
   limited privilege, correct action, correct PM2 home, and exactly one task.

### First process boot

1. Start the new scoped daemon/dashboard via Task Scheduler, not an SSH-owned
   PM2 daemon.
2. Reconnect in a new SSH session and prove they survived independently of the
   observer session.
3. Start exactly one poller and one runtime for each configured agent.
4. Require native executable selection, real bootstrap readiness, stable PIDs
   beyond the recovery window, and no historical-error misclassification.
5. Confirm there is no Telegram `409 Conflict`, no duplicate process, no false
   recovery message, and no premature “online” state.

Only after these checks pass is Telegram handed back to the user.

## Phase 4 — user-driven first-boot acceptance

The existing Telegram chats remain the transport, but the agents must behave as
fresh installations. The prior chat transcript is not agent state and must not
cause onboarding to be skipped.

Test Claude first, then Codex:

1. Tell the user the named bot is ready and ask for `/onboarding`.
2. Require exactly one outbound Telegram message containing one topical
   question. No second onboarding message may arrive before the user replies.
3. The user answers only that question. Observe exactly one receive, dispatch,
   runtime turn, and outbound response.
4. Repeat one turn at a time through identity, role, goals, communication,
   autonomy, system context, guardrails, approvals, and completion.
5. Interrupt once mid-onboarding with a normal process restart. The next turn
   must resume from the earliest unanswered item without repeating completed
   questions.
6. Verify every generated file is under the new agent directory and every
   native command is valid PowerShell/Node/Cortext CLI behavior.
7. Verify `.onboarded` appears only after mandatory steps finish and under the
   Dogfood 2 state root only.
8. Send a normal post-onboarding message and require useful conversational
   continuity.

Claude must pass before Codex begins. This makes any behavioral regression easy
to attribute and prevents simultaneous user conversations from obscuring logs.

## Phase 5 — lifecycle and real-user matrix

After both agents complete onboarding, run sequentially:

- a two-turn context-dependent conversation per bot;
- native PowerShell file create/read in each isolated agent directory;
- rapid ordered messages, Unicode/CRLF content, Telegram command plus text,
  long-response chunking, and idle/resume;
- agent restart and a new message after readiness;
- forced runtime exit with one message sent at the recovery boundary;
- confirmation that recovery is announced only after the 30-second stability
  gate, with exactly one replacement and no lost/duplicate reply;
- daemon restart without duplicate pollers or replay;
- one short-lived cron per agent, restart persistence, removal, and two silent
  former-fire windows;
- PM2 cold resurrection;
- a controlled VM reboot after explicit user notice, followed by Telegram
  replies without interactive repair.

Every turn must have one inbound receipt, one intended-agent dispatch, no
cross-agent delivery, readiness before injection, one complete reply, and
correlated sanitized evidence.

## Adaptive defect loop

Every error, unexpected log, behavioral mismatch, confusing status, delay, or
user-reported rough edge receives a new DOG2 ID:

1. Preserve redacted evidence before restarting.
2. Classify it as Cortext product, Windows/VM environment, test orchestration,
   provider/external, security, or unclassified.
3. Reproduce minimally and add a failing deterministic regression when possible.
4. Fix shared Node core first; use the thinnest OS adapter only for genuine
   platform behavior.
5. Run focused tests, adjacent runtimes, typecheck/build, and the exact live
   failure again.
6. Soak across the relevant readiness/backoff/restart window.
7. Close only after the original scenario passes; otherwise retain FAIL,
   UNVERIFIED, or a precise external blocker.

Priority order is: secret exposure, wrong-recipient delivery, message loss,
duplicate/leaked processes, failed recovery, false status, functional behavior,
performance, then documentation/usability.

## Exit criteria

Dogfood 2 is ready for review only when:

- the clean Windows install required no Bash/WSL/manual translation;
- both fresh agents completed one-question-per-turn onboarding;
- the user judges both bots normally usable;
- the full messaging/lifecycle/persistence matrix has timestamped evidence;
- no unresolved critical/high product issue, secret leak, lost/wrong/duplicate
  message, process leak, false-ready state, or post-reboot manual repair remains;
- the full local suite and Windows/macOS/Linux CI pass at the exact branch
  commit;
- PASS, FAIL, UNVERIFIED, and environment/orchestration observations are
  reported separately;
- Dogfood 1 and main remain unchanged.

After acceptance, the user revokes both temporary Telegram tokens. Only then do
we remove both instances' scoped secrets, processes, scheduled tasks, and other
disposable VM state according to the cleanup checklist.

## Human checkpoints

The user is needed only to:

1. observe the announced Telegram maintenance window;
2. send `/onboarding` and answer one question at a time when each bot is handed
   over;
3. judge response quality during ordinary conversation;
4. approve the controlled reboot window if availability matters;
5. revoke both bot tokens after acceptance.

Implementation, safe token handoff inside the VM, fresh installation,
observation, fault injection, regression work, reruns, and scoped cleanup can be
performed autonomously within this plan.
