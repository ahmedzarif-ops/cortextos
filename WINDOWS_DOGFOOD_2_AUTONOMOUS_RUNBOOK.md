# Windows Dogfood 2 autonomous implementation runbook

Branch: `codex/windows-native-install-dogfood-2-20260819`

Requirements commit: `6db205b6`

Primary requirements:
`WINDOWS_DOGFOOD_2_EXECUTION_PLAN.md`

Status: ready to start an autonomous goal after the user submits the prompt at
the end of this document.

## 1. Readiness and human actions

### Verified now

- The Dogfood 2 branch is pushed and remotely reachable.
- Azure authentication is active.
- The Windows VM is running and reachable through the existing restricted SSH
  path.
- The signed-in Azure identity has a snapshot-capable role at the VM scope.
- The VM has sufficient current disk headroom for the planned install.
- Windows PowerShell 5.1, Node, Git, PM2, Claude Code, and Codex are present.
- Codex authentication is valid.
- Claude's native executable authentication is valid.
- The global Claude PowerShell shim is stale and points at a missing package
  path. This is an autonomous prerequisite/installer repair and regression, not
  a current human-auth blocker.
- Both temporary Telegram bot identities still authenticate. Values remain
  secret and must never be emitted.

### User actions before starting

1. Keep the Azure VM powered on.
2. Keep the Mac running Codex awake, plugged in, network-connected, and leave the
   Codex application/session available for local workspace and Azure access.
3. Do not revoke or rotate either temporary Telegram token yet.
4. Do not message the Windows Claude bot during implementation, cleanup, or the
   installer phase unless explicitly asked.
5. Submit the `/goal` prompt at the end of this document when ready.

No provider re-authentication is currently required.

### Planned human checkpoint during the goal

The only required checkpoint before handoff is a request to send a fresh
Telegram `hi` to the Windows Claude bot while canonical root onboarding is
actively waiting for chat discovery. If the user is asleep or unavailable, the
goal preserves state and waits; it must not bypass the checkpoint using old chat
state or mark the run failed.

An unexpected provider login prompt, snapshot authorization failure, or secret
rotation may create an additional genuine human checkpoint. Everything else is
expected to be handled autonomously.

## 2. Goal state machine

The run is divided into hard gates. Later phases cannot compensate for an
earlier failure.

### Gate A — baseline and remediation ledger

1. Read the execution plan and all referenced WIN/DOG ledgers completely.
2. Record the exact branch base and protect the unrelated pre-existing
   `tests/unit/lifecycle/legacy-status.test.ts` modification from every commit.
3. Create `WINDOWS_DOGFOOD_2_REMEDIATION_LEDGER.md` with every WIN-001–WIN-037
   and DOG-001–DOG-012 ID, scope disposition, source fix, regression, live gate,
   and residual risk.
4. Run a clean local baseline: focused Windows suites, typecheck, build,
   dashboard checks, full tests, and secret/diff checks.
5. Classify baseline failures before editing: product regression, invalid test
   assumption, local environment, external, or unrelated pre-existing change.

Gate A passes when the full prior issue inventory is mapped to the agreed scope
and there is an evidence-backed implementation queue.

### Gate B — implementation loop

Implement in risk order:

1. Public Windows installer correctness and update failure semantics.
2. Canonical root onboarding OS routing and Windows execution reference.
3. Managed-agent Windows reference and explicit one-question boundaries.
4. Claude native launcher/auth/readiness integration, including the stale-shim
   condition found in the readiness audit.
5. Recovery-notification readiness and generation safety.
6. Secret ACL, dashboard loopback, ecosystem, and Task Scheduler integration.
7. Documentation and troubleshooting consistency.
8. Any other in-scope integration gap surfaced by the remediation audit.

For every issue:

1. Preserve the smallest sanitized failure evidence.
2. Add or strengthen a failing deterministic regression.
3. Implement the narrowest shared-core fix or Windows-only operational
   reference/adapter when the OS behavior genuinely differs.
4. Run the new regression and adjacent focused suites.
5. Run typecheck/build and relevant dashboard checks.
6. Inspect the diff for secret leakage, scope creep, and macOS/Linux changes.
7. Update the remediation ledger with evidence and remaining live gate.
8. Commit a coherent change to Dogfood 2 and push it.

Parallel subagents may be used for bounded, non-overlapping work such as
installer analysis, onboarding-reference review, or regression coverage. The
primary agent owns the requirements documents, destructive VM actions, final
integration review, and acceptance verdict. Subagents must not interpret or
replace the primary requirements source.

Gate B passes only when no in-scope product item remains
`implementation-pending`.

### Gate C — pre-install regression and candidate freeze

At the exact proposed candidate commit, require:

- installer unit/integration tests;
- Windows path/parser/secret/process/PTY/IPC/lifecycle suites;
- root onboarding OS-routing and POSIX-preservation tests;
- managed onboarding structural turn-boundary tests for every shipped role;
- Claude native resolver/auth/readiness and recovery notification tests;
- PM2 ecosystem/dashboard credential/loopback tests;
- Task Scheduler helper parse, idempotence, identity, trigger, and PM2-home tests;
- root typecheck and build;
- dashboard typecheck and build;
- full local test suite;
- `git diff --check` and a targeted secret scan;
- Windows, macOS, and Linux CI at the exact commit.

Do not weaken an assertion, add an unconditional Windows skip, or raise a
timeout without diagnosing the underlying timing. Intermittent failures require
bounded reproduction and classification.

Gate C passes when the candidate is committed/pushed, the branch worktree is
clean except for the known unrelated user modification, CI is green, and the
remediation ledger contains no unresolved critical/high in-scope product defect.

### Gate D — Azure snapshot and destructive cleanup

Before deletion:

1. Inventory exact VM disks, Cortext repositories/state roots, PM2 homes and
   processes, scheduled tasks, listeners, agent/poller descendants, global CLI
   link, and secret files.
2. Export sanitized Dogfood 1 evidence and verify the branch/docs are remote.
3. Create a restorable Azure snapshot and verify it reaches a successful state.
4. Copy reusable Telegram secrets only inside the VM into an ACL-protected
   temporary file outside every deletion target. Never output their values.

Only after snapshot verification, stop Cortext processes and delete the exact
inventoried Cortext targets. Preserve Node/npm, Git, PM2, Claude Code, Codex,
provider auth, SSH/admin access, and ordinary Windows prerequisites.

After cleanup, prove absence of Cortext repositories, state, PM2 entries,
scheduled tasks, listeners, pollers, processes, and the global Cortext CLI link.

If snapshot creation or target resolution fails, do not delete anything. Record
the blocker and continue only with non-destructive implementation/testing work.

### Gate E — public Windows installer simulation

1. Run the documented PowerShell bootstrap from the cleaned account, changing
   only the raw URL/branch selector required to install the Dogfood 2 candidate.
2. Do not manually clone, precreate state, reuse dependencies, patch the VM
   checkout, or translate a command.
3. Capture sanitized output, exit code, timings, selected paths, and process
   descendants.
4. Require the default install path, intended branch/remote, dependency install,
   node-pty load/spawn, build, global CLI link, core install, and exact Claude
   Code handoff.
5. Verify the installer does not require WSL, Bash, Git Bash, `jq`, Python, or
   compiler tools unless a selected/observed path genuinely requires them.
6. Verify failures stop without a false success message.

Any expert-only repair is a product failure. Fix it on the branch, regress it,
re-establish a clean Windows state, and rerun from the public command.

### Gate F — canonical Claude Code onboarding

1. Execute the installer-provided Claude Code handoff command.
2. Invoke `/onboarding`.
3. Drive the existing initial conversation using a documented disposable test
   persona; do not change its pacing.
4. Require the agent to detect Windows and use the Windows operational
   reference without user translation.
5. Let the onboarding agent perform every safe operation itself.
6. Supply the existing Claude bot token in the canonical chat-based step without
   exposing it in shell argv, logs, Git, reports, or screenshots.
7. When it asks for a Telegram message, request the user's fresh `hi` and wait.
8. After the message arrives, require private user/chat discovery, restricted
   secret ACLs, correct org/Orchestrator config, dashboard install/build,
   loopback health, PM2 ecosystem/start/save, automatic Startup/S4U persistence,
   doctor, and status.

Any Bash/WSL/manual translation, incorrect path, false success, secret exposure,
or operator repair re-enters Gate B and then requires a clean rerun.

### Gate G — initial Orchestrator readiness and handoff

Require all of the following:

- exactly one daemon, dashboard, Telegram poller, and Claude runtime;
- Task Scheduler owns persistence rather than the SSH job;
- daemon/dashboard survive a new administrative session;
- dashboard listens only on loopback and passes health/auth checks;
- Claude uses the intended native executable and authenticated profile;
- the runtime crosses the real bootstrap/readiness gate;
- no crash loop, duplicate process, Telegram `409`, false recovery message,
  historical-log false positive, or premature online status;
- stability beyond the 30-second recovery window;
- one fresh Telegram update maps to one intended dispatch;
- exactly one outbound message containing one managed onboarding question;
- no second question before another user reply;
- `.onboarded` remains absent at handoff because managed onboarding is not done.

When Gate G passes, report the exact candidate commit and evidence, tell the user
they may take over the Telegram conversation, and mark the goal complete.

## 3. Testing surfaces and methods

| Surface | Method | Passing oracle |
|---|---|---|
| Installer parsing | Unit/subprocess tests plus real PowerShell 5.1 invocation | Exact command runs without quoting/truncation and exits truthfully |
| Fresh install | Cleaned VM default path | No hidden state, manual clone, or repair |
| Update behavior | Deterministic Git fixtures and bounded repeat run | Selected branch preserved; pull failure stops safely; state not overwritten |
| OS routing | Structural/content tests | Windows reads only Windows operations; POSIX reference stays unchanged |
| Managed pacing | Structural role tests plus live Telegram | One topical question and one outbound message per inbound turn |
| Files/paths | Windows separator, drive, UNC, BOM, CRLF, space-path tests | Native containment and parsing without traversal or corruption |
| Secrets | Unit tests and live `Get-Acl` inspection | No output/argv/Git leakage; only current identity and LocalSystem |
| Claude launch | Unit resolver/profile/env tests plus scheduled live boot | Native executable, valid auth, real readiness, no shim quoting failure |
| Recovery | Generation/stability fake-clock tests plus live soak | No “recovered” until same replacement is ready and stable |
| PM2/persistence | Config tests, double registration, new SSH session | One scoped task/process set; survives observer disconnect |
| Dashboard | Type/build tests plus loopback HTTP/auth probe | Healthy and inaccessible from public bind |
| Telegram | One real user discovery/update and redacted correlation | One poller, one dispatch, one first question, no conflict/duplicate |
| Cross-platform regression | POSIX snapshot/contract tests and three-OS CI | Existing macOS/Linux onboarding operations and suite remain green |
| Documentation | Static audit against executable behavior | No WSL/Bash/obsolete Windows requirement or incorrect handoff |

## 4. Observability contract

For every scenario, the ledger records:

- scenario/issue ID;
- exact Git commit;
- expected and actual behavior;
- timestamp and bounded duration;
- sanitized command shape;
- safe log/evidence location;
- process/task/listener state;
- classification and confidence;
- fix commit and regression;
- live rerun result;
- residual risk.

Never record raw tokens, OAuth material, VM IP, usernames, private keys, chat IDs,
full environments, or unrelated personal paths/content.

Send concise progress commentary at phase boundaries and at least once per hour
during long autonomous work. Do not spam the user with individual passing tests.
Immediately report any security issue, destructive-scope ambiguity, unexpected
cost/infrastructure expansion, or required human checkpoint.

## 5. Things to avoid

- Do not modify, merge, force-push, or open a merge to main.
- Do not rewrite or advance Dogfood 1 branches.
- Do not stage or alter the unrelated `legacy-status.test.ts` user change.
- Do not expose or rotate credentials.
- Do not run two Telegram pollers for one bot.
- Do not patch the VM checkout as the final fix; branch code is the source.
- Do not use WSL, Bash, Git Bash, Docker, or manual POSIX translation on Windows.
- Do not change the working macOS/Linux onboarding flow beyond narrowly tested
  shared correctness fixes.
- Do not test or expand `cortextos setup`.
- Do not create the Analyst or another specialist.
- Do not upgrade dashboard dependencies in this workstream.
- Do not open firewall/NSG/dashboard ports.
- Do not use broad recursive deletion, unresolved variables, home/root targets,
  or destructive globs.
- Do not delete before a verified snapshot.
- Do not restart blindly, retry until green, silence warnings, loosen assertions,
  skip Windows tests, or inflate timeouts without diagnosis.
- Do not claim a live pass from mocks, a PM2 `online` row, process spawn alone,
  or an expert workaround.
- Do not mark the goal complete before the first stable single-question Telegram
  handoff.

## 6. Stop and ask conditions

Pause for user input only when:

- the user must send the fresh Telegram `hi`;
- Claude/Codex authentication genuinely requires interactive login after safe
  repair attempts;
- snapshot creation is unauthorized or cannot be verified;
- an exact destructive target remains ambiguous;
- a new public port, new VM, paid service, or material infrastructure expansion
  would be required;
- requirements conflict in a way that changes user-visible product behavior;
- a secret may have been exposed and rotation is necessary;
- main/merge authorization would be needed.

Test failures, code complexity, slow builds, intermittent external APIs, or a
new ordinary product bug are not reasons to stop. They enter the adaptive loop.

## 7. Paste-ready slash goal

~~~text
/goal

Autonomously implement and validate the complete Windows Dogfood 2 initial-user
experience on branch codex/windows-native-install-dogfood-2-20260819. Read and
follow WINDOWS_DOGFOOD_2_EXECUTION_PLAN.md and
WINDOWS_DOGFOOD_2_AUTONOMOUS_RUNBOOK.md completely as the controlling
requirements. Do not modify main or the frozen Dogfood 1 branches.

First create the complete WIN-001–WIN-037 and DOG-001–DOG-012 remediation
ledger. Implement every in-scope product fix before reinstalling: public native
Windows installer correctness and truthful update/failure behavior; canonical
root onboarding OS detection with a Windows operational reference while
preserving the existing macOS/Linux path; managed-agent Windows instructions
and explicit one-question/one-message Telegram boundaries; Claude native
launcher/auth/readiness; stable generation-confirmed recovery notifications;
secret ACLs; loopback dashboard; PM2 ecosystem; and automatic Task Scheduler
Startup/S4U persistence. Audit all Windows-facing docs against actual code.

Use an adaptive evidence-driven loop for every discovered bug: preserve
sanitized evidence, classify, minimize, add a failing regression, fix narrowly
in shared Node core or the thinnest genuine Windows adapter/reference, run
focused tests plus adjacent surfaces, update the ledger, and rerun the exact
scenario. You may delegate bounded non-overlapping installer, onboarding, or
test-review tasks to subagents, but the primary agent owns requirements,
integration, destructive actions, and the final verdict.

Before touching the VM, require focused suites, full tests, typecheck/build,
dashboard checks, secret/diff checks, and Windows/macOS/Linux CI at the exact
pushed candidate commit. Preserve the unrelated existing
tests/unit/lifecycle/legacy-status.test.ts modification and keep it out of every
commit.

After the implementation gate passes, inventory the Azure Windows VM, export
sanitized Dogfood 1 evidence, create and verify a restorable snapshot, retain
the two bot tokens only in an ACL-protected file without displaying them, stop
all Cortext processes, and delete only the explicitly resolved Cortext repos,
state, PM2 homes/entries, scheduled tasks, listeners, and global CLI link. Keep
Node/npm, Git, PM2, Claude Code, Codex, provider auth, SSH access, and normal
Windows prerequisites. Never delete anything if snapshot verification or exact
target resolution fails.

From the cleaned Windows account, simulate the human by running the documented
public PowerShell installer with only the Dogfood 2 URL/branch substitution.
Do not manually clone, precreate state, reuse dependencies, patch the VM clone,
or translate commands. Then launch Claude Code using the installer handoff,
invoke canonical /onboarding, and drive it with a disposable test persona. Let
the onboarding agent perform all safe work itself. Use the existing Claude bot
token in the canonical chat step without exposing it. When Telegram discovery
requires a fresh user message, ask me to send “hi” and preserve/wait in place.

After my message, finish root onboarding and verify one daemon, loopback
dashboard, one poller, one native authenticated Claude runtime, automatic
Startup/S4U persistence, truthful doctor/status, survival across a new admin
session, no crash loop/duplicate/409/false recovery, and stability beyond the
30-second recovery window. The final acceptance event is exactly one Telegram
message containing the Orchestrator's first onboarding question, with no second
question before another user reply and no .onboarded marker yet. Then report
PASS/FAIL/UNVERIFIED, exact commit, sanitized evidence, residual risks, and tell
me I can take over Telegram. Do not create or onboard an Analyst/specialist, do
not test cortextos setup, do not upgrade dashboard dependencies, and do not
open network ports. Mark the goal complete only after this handoff passes.
~~~
