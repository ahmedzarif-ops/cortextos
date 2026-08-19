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

**Hard gate: Phase 2 is forbidden until Phase 1 is complete.** Dogfood 2 is not
merely another test of the current branch. It is the clean-install validation of
a newly remediated candidate branch. Every previously observed issue must first
have an explicit disposition, and every Cortext product defect must have its
implementation and automated regression on this branch before the VM is
reinstalled.

Create `WINDOWS_DOGFOOD_2_REMEDIATION_LEDGER.md` before editing code. Give every
`WIN-001`–`WIN-037` and `DOG-001`–`DOG-012` item one of these dispositions:

- `implemented-and-regressed`: the fix is present in the combined candidate and
  its deterministic tests pass;
- `implementation-pending`: code/docs/tests still need to change before install;
- `live-validation-pending`: implementation and regressions pass, but the
  original behavior can only be closed by the new clean Windows run;
- `environment-orchestration-control`: not a Cortext defect, with the exact
  procedure that prevents it from contaminating the normal-user result;
- `external-unverified`: outside Cortext control and still honestly unverified.

No product defect may be labeled deferred merely to reach the reinstall. If a
critical/high product issue cannot be implemented safely, stop and report the
branch as not ready rather than continuing to Phase 2.

### 1. Remediation audit of every existing finding

The implementation pass must cover the complete ledgers, not only the two most
recent screenshots:

| Finding set | Required work before reinstall |
|---|---|
| WIN-001–WIN-012, WIN-014–WIN-019, WIN-022–WIN-037 | Confirm every prior fix is present together on Dogfood 2, map it to its source commit and regression, rerun the focused suite, and repair any integration regression. “Fixed on an older branch” is not enough. |
| WIN-013 | Replace the old Telegram-deferred status with the current two-bot evidence, while retaining any unperformed unauthorized-sender scenario as explicitly live-unverified. |
| WIN-020 | Re-audit the dashboard production dependencies. Remediate compatible direct critical/high advisories and run dashboard regressions. Any advisory without a safe upstream resolution must be itemized as a release risk; the dashboard remains loopback-only and cannot be declared publicly deployable. |
| WIN-021 | Implement a supported isolated-install path that avoids a host-global `npm link` for non-default/test instances, document its update behavior, add install/isolation regressions, and use that path for Dogfood 2. |
| DOG-001 | Audit the root onboarding skill and every packaged first-boot copy for native Windows commands, fix every remaining Bash-only user instruction, and pass deterministic portability tests. Full conversational closure remains a Phase 4 live gate. |
| DOG-002 | Encode serialized foreground dependency installation in the test procedure and add observer guards against overlapping installs; do not change product code unless one clean foreground run reproduces it. |
| DOG-003 | Re-run all secret-writer/ACL tests and verify every writer uses the shared fail-closed adapter. The new instance receives a separate live ACL inspection. |
| DOG-004 | No code fix. Record the already-proven bot separation/private-user flow and retain the fresh Telegram activation check in Phase 4. |
| DOG-005 | Re-test clean native dependency installation and node-pty loading. If npm's warning corresponds to a broken artifact, fix installation; otherwise retain it as a documented toolchain observation. |
| DOG-006 | Audit the complete setup wizard fix—masked entry, no token argv/logging, in-process discovery, sender authorization, terminal ownership, Windows PM2 invocation, and clean exit—and add/repair deterministic tests before its fresh Phase 3 run. |
| DOG-007 | Regress every Windows CLI handoff string so no supported Windows path emits `cat`, Bash chaining, `pm2 startup`, or another untranslated Unix command. |
| DOG-008 | Regress native Claude executable resolution for interactive and scheduled environments, including doctor/profile/runtime consistency and narrow fallback behavior. |
| DOG-009 | Encode the Task Scheduler-owned PM2 launch as the VPS test path and prevent SSH-owned launch from being mistaken for product persistence. No product fix is required unless the supported scheduled path fails. |
| DOG-010 | Keep the readiness-confirmed recovery implementation, add/retain generation and stability-window regressions, and verify it cannot emit “recovered” for a replacement that crashes during the window. |
| DOG-011 | Complete structural one-question turn boundaries in every shipped onboarding role and add a regression that detects missing boundaries, as detailed below. |
| DOG-012 | Reproduce, classify, and implement the native-shell correction before reinstall, as detailed below. It cannot remain merely “observed” when Phase 2 begins. |

For fixes already present in the base, “implement” means audit the actual
combined Dogfood 2 code, retain or improve its regression, and fix any conflict
or coverage gap. It does not mean rewriting working fixes. For behavior that can
only be proven live, the pre-install requirement is completed implementation
plus a deterministic regression; the issue remains `live-validation-pending`
until the exact clean-install scenario passes.

### 2. Preserve and integrate already-completed fixes

Dogfood 2 starts with all checkpoint fixes, including:

- native Windows paths, process trees, PTYs, Codex IPC, and PM2 persistence;
- Windows-safe secret ACLs and loopback-only dashboard generation;
- native Claude executable resolution under Task Scheduler/S4U;
- readiness-confirmed recovery notifications from `3ff763ce`;
- the one-question onboarding gate from `0958d5d1`.

### 3. Make the onboarding turn boundary structural

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

### 4. Resolve the native-shell behavioral observation

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

### 5. Pre-install implementation-complete gate

Phase 1 passes only when all of the following are true:

- the remediation ledger contains all 49 existing IDs and no product item is
  `implementation-pending`;
- every code/documentation fix is committed on Dogfood 2 and mapped to at least
  one focused regression or a documented reason deterministic coverage is
  impossible;
- DOG-011's structural turn-boundary check passes across every shipped role;
- DOG-012 has a completed classification and implemented correction when it is
  attributable to Cortext;
- WIN-021's isolated install path is implemented and selected for Dogfood 2;
- WIN-020 has a fresh audit and compatible critical/high dependency fixes are
  applied; residual upstream-only risk is explicit and remains loopback-bound;
- a review of the complete diff confirms no Windows fork of shared daemon,
  poller, bus, scheduler, or agent logic was introduced.

Then run, before any VM cutover:

- focused onboarding, recovery, runtime resolver, secret-permission, ecosystem,
  and startup-helper tests;
- root typecheck and build;
- dashboard typecheck/build where affected;
- `git diff --check` and a secret scan;
- full local test suite;
- review that the unrelated pre-existing
  `tests/unit/lifecycle/legacy-status.test.ts` modification is not staged;
- commit and push only Dogfood 2; never update main or rewrite Dogfood 1.

Record the exact implementation-complete commit. Phase 3 must clone that commit
from the remote branch; working-tree-only fixes or manual VM patches invalidate
the normal-user simulation.

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
