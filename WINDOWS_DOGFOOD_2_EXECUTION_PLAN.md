# Windows Dogfood 2 — agreed implementation and clean-install plan

Run ID: `windows-dogfood-2-20260819`

Branch: `codex/windows-native-install-dogfood-2-20260819`

Planning base: `4a4c17e1`

Status: requirements agreed; implementation has not started and the VM has not
been changed for Dogfood 2.

## 1. Outcome and handoff

Dogfood 2 is a fix-first test of the complete initial Windows user experience:

1. Implement and regress every in-scope fix on the Dogfood 2 branch.
2. Snapshot the Azure VM and export sanitized evidence from Dogfood 1.
3. Remove the existing Cortext installations and runtime state from the current
   Windows account, leaving only documented prerequisites and provider auth.
4. Simulate the human running the public Windows installation command.
5. Simulate the human opening Claude Code in the installed repository and
   invoking the canonical `/onboarding` command.
6. Drive that onboarding through creation, configuration, persistence, and boot
   of the initial Claude Orchestrator.
7. Pause the user only when canonical onboarding asks them to send the bot a
   fresh Telegram message for private chat discovery.
8. Hand the system back only after the Orchestrator is truly ready, remains
   stable beyond the recovery window, and sends exactly one Telegram onboarding
   question.

The user owns the Telegram conversation after that handoff, including completing
Orchestrator onboarding and creating/onboarding the Analyst or specialists.

Main and Dogfood 1 branches remain unchanged. All new code lands only on the
Dogfood 2 branch unless the user later explicitly approves another action.

## 2. Product decisions from the requirements interview

### Shared onboarding architecture

- The canonical initial Claude Code onboarding remains the single shared
  conversation and source of truth.
- It detects the host once with Node's `process.platform`.
- Existing macOS/Linux operational instructions remain effectively unchanged.
- Windows routes operational steps into a new Windows reference containing
  PowerShell syntax, Windows paths, Task Scheduler persistence, diagnostics,
  browser behavior, and other native differences.
- Do not copy the entire conversational flow into a Windows fork. Shared
  questions, sequencing, generated artifacts, and completion rules remain
  centralized.
- Native Windows instructions may use PowerShell, the Cortext Node CLI, and
  harness file tools. They may not silently depend on WSL, Git Bash, Bash,
  POSIX utilities, symlink privileges, or Windows Developer Mode.

### Conversational behavior

- The initial Claude Code `/onboarding` pacing remains unchanged because it
  already works well for existing users.
- The one-question/one-message rule applies only to managed-agent onboarding
  over Telegram.
- It applies to managed agents on Windows, macOS, and Linux because it is a
  transport/behavior rule rather than an OS workaround.
- After one topical question, the managed agent must stop all tool use and end
  its turn. It resumes from the earliest unanswered item only after a new inbound
  message and never repeats completed questions.

### Installation and updates

- The simulated human starts with Node/npm, Git, Claude Code, and Codex already
  installed and authenticated, but with no Cortext repository or runtime state.
- The public Windows installation command owns cloning, dependency installation,
  build, global CLI exposure, `cortextos install`, and the Claude Code handoff.
- A manual clone is not a valid Dogfood 2 test.
- Normal Windows users receive the same global `cortextos` command as existing
  macOS/Linux users. An isolated CLI mode is not required for this run.
- Re-running the public installer remains the simple supported update mechanism,
  mirroring macOS/Linux.
- If an update pull fails, the installer must stop clearly and preserve the
  checkout. It must not build stale code and print a false success message.
- Pre-merge testing may substitute only the Dogfood 2 raw installer URL and
  branch selector. Otherwise the PowerShell command and resulting flow must be
  the eventual public Windows experience.

### Windows requirements and persistence

- Derive prerequisites from the working native code instead of historical docs.
- The intended required baseline is Node.js 20+ with npm, Git, and at least one
  authenticated agent runtime. PM2 is installed by Cortext.
- Python/knowledge-base dependencies, compiler tools, `jq`, and other utilities
  are optional or conditional unless the clean run proves core Cortext actually
  needs them.
- WSL is not a Cortext prerequisite.
- Visual C++ Build Tools are requested only if dependency installation genuinely
  needs native compilation and no compatible prebuild is usable.
- Windows boot persistence is a default Cortext feature, just as PM2 startup is
  part of macOS/Linux installation.
- Use the native Task Scheduler helper. The onboarding agent selects the normal
  Windows trigger from machine/session context and reports the choice. The Azure
  VPS must select Startup/S4U so Cortext returns before interactive login.

### Secrets, Telegram, and dashboard

- Keep the current chat-based Telegram bot-token handoff for now; masked terminal
  entry is not part of Dogfood 2.
- Never print a token or put it in argv, logs, Git, screenshots, reports, or test
  names. Secret files must retain the Windows owner-and-LocalSystem-only ACL.
- The existing Claude bot identity is reused for the initial Orchestrator. The
  unused Codex bot secret remains protected but is not activated during this run.
- The user sends one fresh Telegram “hi” when requested so canonical private
  chat/user discovery is exercised normally.
- The dashboard remains part of canonical onboarding and must install, build,
  authenticate, start, and pass a health check.
- On the VPS it remains bound to `127.0.0.1`; no Windows Firewall or Azure NSG
  port is opened.
- Dashboard dependency-advisory upgrades are a separate security workstream and
  do not block this Windows runner test.

### Explicitly out of scope

- `cortextos setup`; do not test or expand the alternate setup wizard.
- Creating or onboarding the Analyst.
- Creating or onboarding a Codex/OpenCode specialist.
- Live macOS/Linux onboarding; those platforms receive regression protection
  now and broader live testing after Windows is stable.
- Dashboard dependency-version remediation.
- Merging or pushing anything to main.

## 3. Hard pre-install remediation gate

No VM snapshot, cleanup, or fresh install begins until this gate passes.

Create `WINDOWS_DOGFOOD_2_REMEDIATION_LEDGER.md` and give every prior
`WIN-001`–`WIN-037` and `DOG-001`–`DOG-012` finding an explicit disposition:

- `integrated-and-regressed` — the fix is in the combined Dogfood 2 candidate
  and deterministic coverage passes;
- `implementation-pending` — code/docs/tests still need work and block cleanup;
- `live-validation-pending` — implementation passes locally but the clean
  Windows run is required to close the original symptom;
- `environment-orchestration-control` — not a product defect, with the exact
  control used to prevent it from contaminating the user simulation;
- `out-of-scope-by-decision` — explicitly excluded above, with the user's scope
  decision recorded;
- `external-unverified` — outside Cortext control and honestly unverified.

No in-scope product defect may be deferred merely to reach installation.

### 3.1 Audit and integrate all existing fixes

Confirm the combined branch contains and regressions cover the previously
implemented Windows work:

- path containment/routing, separators, CRLF/BOM parsing, home/state paths;
- Windows process-tree termination, stale recovery, and PTY lifecycle;
- Codex loopback IPC and headless process behavior;
- Claude first-run screens, ANSI parsing, auth/profile environment, native
  executable resolution, and readiness detection;
- queue preservation across crash replacement;
- PM2 ecosystem generation, loopback dashboard binding, credentials, process
  naming, and scoped startup persistence;
- Git for Windows trust/environment behavior and diagnostic handle closure;
- Windows secret ACLs across every installer/config writer;
- truthful doctor executable/auth reporting;
- recovery notifications that require the same crash generation to be
  bootstrapped and stable before announcing recovery.

An older fix commit is not sufficient by itself. It must be present and passing
inside the final Dogfood 2 integration candidate.

### 3.2 Fix the public Windows installer

The current `install.mjs` contains Windows behavior that contradicts the native
runner and must be rectified before the clean test:

- remove the WSL requirement and every claim that agents require Bash;
- derive actual core prerequisites and stop requiring `jq`, Python, or compiler
  tooling when the native Node path does not need them;
- remove obsolete Windows build-tool installation advice and provide a current,
  evidence-based remediation only after a real native build failure;
- prove the documented PowerShell bootstrap works in Windows PowerShell 5.1 and
  modern PowerShell without command corruption or truncation;
- preserve the selected branch on install and update; never silently pull
  `main` when testing another allowed branch;
- fail closed when clone/pull/install/build/link/core-install fails and never
  print success for stale or partial output;
- safely handle paths containing spaces and native Windows executable shims;
- keep the normal global CLI behavior consistent with macOS/Linux;
- produce accurate Windows handoff commands for opening Claude Code and invoking
  `/onboarding`;
- add fresh-install, failure, branch-update, repeat-run, and path-safety
  regressions without altering successful macOS/Linux behavior.

### 3.3 Refactor canonical onboarding by OS reference

- Preserve the existing initial conversation wording and pacing.
- Move Windows-specific execution details out of the shared flow into a new
  Windows reference and route to it after host detection.
- Preserve existing macOS/Linux instructions in the existing POSIX path.
- Ensure every root-onboarding operation has a native Windows implementation:
  dependency checks, CLI calls, state/JSON writes, Telegram discovery, dashboard
  install/build, PM2 ecosystem/start/save, Task Scheduler registration, doctor,
  status, logs, port health, and browser/VPS handoff.
- Remove contradictory WSL/Bash/manual-translation guidance from all Windows
  user-facing sources.
- Audit README, installer comments/output, canonical onboarding,
  troubleshooting, CLI handoff text, and startup docs against the actual code.
- Add a portability contract test that fails if a Windows route contains a
  forbidden POSIX-only user command or a macOS/Linux block changes unexpectedly.

### 3.4 Fix managed-agent first-boot behavior

- Keep one shared managed onboarding protocol.
- Add a Windows operational reference rather than cloning the full protocol.
- Put explicit turn boundaries after each managed onboarding question or topical
  question group in every shipped managed-agent role.
- Keep exactly one outbound Telegram message in that turn.
- Resume from the earliest unanswered item after interruption.
- Add deterministic structural tests for every shipped role/skill copy.
- Regress Windows-native state markers, file writes, crons, and Cortext CLI use.

Dogfood 2 live scope ends at the first managed question, but the implementation
must be correct across the complete managed onboarding documents before install.

### 3.5 Pre-install verification

Before the VM is touched, require:

- every in-scope remediation-ledger item has no `implementation-pending` status;
- focused installer, onboarding, recovery, resolver, process, secret-permission,
  ecosystem, dashboard, and startup-helper suites pass;
- root typecheck and build pass;
- dashboard typecheck/build pass;
- full local test suite passes;
- Windows/macOS/Linux CI passes at the exact candidate commit;
- `git diff --check` and secret scanning pass;
- the unrelated pre-existing `tests/unit/lifecycle/legacy-status.test.ts` change
  remains outside every Dogfood 2 commit;
- the candidate is committed and pushed only to the Dogfood 2 branch.

Record the exact implementation-complete commit. The VM may install only that
remote commit; working-tree patches on the VM invalidate the simulation.

## 4. Snapshot and clean the existing Windows account

This is destructive and begins only after the pre-install gate passes.

1. Resolve and report the exact VM, OS disk/data disks, Cortext paths, scheduled
   tasks, PM2 homes/processes, listeners, and repositories before mutation.
2. Create a restorable Azure VM/disk snapshot and record its identifiers without
   including credentials.
3. Export the sanitized ledgers, logs, commits, process evidence, and observed
   error signatures needed to compare Dogfood 2 against Dogfood 1.
4. Move the reusable bot secrets into a temporary ACL-protected location outside
   Cortext state without displaying them.
5. Stop all existing pollers, agents, daemon, dashboard, and captured descendants.
6. Disable/remove the associated scheduled tasks and scoped PM2 state.
7. Remove every relevant Cortext repository, install directory, state root,
   agent directory, generated ecosystem, dashboard runtime secret, and global
   Cortext CLI link from the Windows account.
8. Preserve Git, Node/npm, PM2, Claude Code, Codex, provider authentication,
   Windows tooling, and the temporary protected bot-secret source.
9. Verify there is no Cortext process, port listener, Telegram poller, repository,
   state directory, scheduled task, PM2 entry, or CLI link left.

Never use broad recursive targets. Every deletion target must be an explicit,
read-only-resolved path from the cleanup inventory. The Azure snapshot replaces
Dogfood 1 as the rollback mechanism.

## 5. Full Windows human simulation

### 5.1 Public installer

1. From native PowerShell in the cleaned account, run the eventual public
   Windows bootstrap with only the Dogfood 2 URL/branch substitution.
2. Capture sanitized stdout/stderr, exit status, timings, selected paths, and
   process descendants.
3. Require a default-path clone, correct remote/branch, dependency install,
   native node-pty load/spawn, build, global CLI, core install, and accurate
   Claude Code handoff.
4. Do not manually clone, precreate Cortext state, patch the installed checkout,
   translate a command, or repair a hidden prerequisite.
5. Any required expert repair is a product failure and re-enters the adaptive
   loop.

The repeated-installer/update behavior is covered deterministically before this
run and may also be exercised after the clean first-install evidence is secured,
provided it cannot obscure the primary user path.

### 5.2 Canonical Claude Code onboarding

1. Launch Claude Code using the exact installer handoff command.
2. Invoke `/onboarding` as the simulated human.
3. Use a documented disposable test persona for organization/name/goals/model,
   dashboard credentials, and optional-feature decisions.
4. Let the onboarding agent perform every safe operation itself. Do not manually
   execute its commands on its behalf.
5. Provide the existing Claude bot token in the onboarding chat when requested,
   while preventing it from entering shell argv, captured logs, Git, or reports.
6. When the agent asks for a Telegram message, pause and ask the user to send a
   fresh “hi.” This is the only required human checkpoint before handoff.
7. Require native private chat/user discovery, restricted `.env` ACL, correct
   config, one enabled Claude Orchestrator, dashboard installation, loopback
   health, PM2 start/save, automatic Startup/S4U persistence, doctor, and status.
8. Any Windows command translation, WSL/Bash dependency, false success, manual
   repair, secret exposure, or premature-ready state fails the run.

### 5.3 Initial Orchestrator boot and handoff gate

Before telling the user to take over, verify:

- exactly one daemon, dashboard, poller, and Claude runtime exists;
- Task Scheduler, not the SSH session, owns persistence;
- daemon/dashboard survive a new administration session;
- the dashboard listens only on `127.0.0.1` and returns its expected health page;
- Claude uses the intended native executable and authenticated profile;
- the runtime reaches the real bootstrap/readiness gate;
- it remains stable beyond the 30-second recovery-notification window;
- no new crash loop, duplicate process, `409 Conflict`, false recovery notice,
  or historical-log false positive appears;
- one user Telegram update maps to one intended dispatch;
- the Orchestrator sends exactly one message containing one onboarding question
  and sends no next question before a new user reply;
- `.onboarded` remains absent because managed onboarding is not complete.

At that point, report the exact tested commit and passing evidence, then hand the
Telegram conversation to the user.

## 6. Adaptive fix-and-rerun loop

Every installation error, unexpected log, behavioral mismatch, confusing
instruction, excessive delay, or user-visible rough edge receives a DOG2 ID:

1. Preserve sanitized evidence before restarting.
2. Classify it as product, Windows/VM environment, test orchestration,
   provider/external, security, or unclassified.
3. Reproduce minimally and add a failing deterministic regression where
   possible.
4. Fix the shared Node core or onboarding source of truth; use the thinnest
   Windows adapter/reference only for genuine platform differences.
5. Protect the existing macOS/Linux path with focused regressions.
6. Run focused tests, typecheck/build, full tests, and relevant CI.
7. Commit and push the fix to Dogfood 2—never patch the installed VM checkout as
   the final solution.
8. Clean the affected Windows state and rerun from the public installer command
   whenever the failure could influence a normal fresh installation.
9. Close the issue only when the original scenario passes and remains stable
   across its readiness/backoff window.

Priority is secret exposure, wrong-recipient delivery, message loss, duplicate
or leaked processes, failed recovery, false status, install failure, behavioral
failure, performance, then documentation/usability.

## 7. Final report and later work

The Dogfood 2 report separates `PASS`, `FAIL`, `LIVE-VALIDATION-PENDING`,
`OUT-OF-SCOPE`, `ENVIRONMENT/ORCHESTRATION`, and `EXTERNAL-UNVERIFIED`.

It must include the exact branch commit, installer command shape with secrets
omitted, OS/runtime versions, sanitized evidence locations, every new DOG2 item,
and whether the user handoff gate passed.

After Windows handoff, later work may cover full Orchestrator/Analyst/specialist
onboarding, Codex/OpenCode user flows, live macOS/Linux installation, the
alternative setup wizard, dashboard dependency upgrades, longer messaging
soaks, crons, controlled crashes, and reboot acceptance. Those are not allowed
to blur or delay the initial Windows installation result defined here.
