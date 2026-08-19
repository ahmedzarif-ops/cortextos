# Windows-native runner: autonomous overnight requirements

**Status:** Ready to execute  
**Target branch:** `codex/windows-native-runner`  
**Worktree:** the isolated Windows-native worktree, never the maintainer's main worktree  
**Run deadline:** 8:00 AM America/New_York on August 19, 2026  
**Primary live environment:** the existing secured Azure Windows VM  

## 1. Mission

Make cortextOS behave on Windows like it already behaves on macOS/Linux while moving the codebase toward one centrally maintained Node.js runner with small, explicit operating-system adapters.

The Windows VM must run real host-native processes. Claude Code, Codex app-server, and OpenCode must be able to use the Windows user's normal filesystem, PowerShell/terminal, installed programs, network, and credentials with the same authority they would have if launched directly by that user. Docker is not the primary runtime boundary because a container would make host-native filesystem, process, credential, and desktop-session access harder and less representative.

The work must preserve current macOS behavior. Linux and macOS parity are continuously checked in CI. The existing Azure Windows VM is the production-like Windows acceptance environment for this run.

## 2. Product decisions

### 2.1 One core, thin adapters

There should be one implementation of agent lifecycle, message routing, scheduling, configuration, observability, and recovery in TypeScript/Node.js.

Operating-system-specific code is allowed only behind narrow interfaces for capabilities that genuinely differ:

- process-tree termination and liveness checks;
- IPC endpoint selection (Unix domain socket versus Windows named pipe or loopback transport);
- path and home-directory resolution;
- service/login persistence (launchd/systemd versus Windows Task Scheduler/PM2 resurrection);
- shell command selection and quoting;
- filesystem links/permissions where Windows semantics differ.

Do not fork the daemon, scheduler, poller, or runtime implementations into separate Windows and Unix versions. Prefer Node APIs and capability detection over shelling out or branching on the OS name.

### 2.2 Native host process, not Docker

The supported default runner is a normal Node.js process installed on the host. Packaging may later use npm, a standalone Node executable, or an installer, but it must launch the harnesses natively as the logged-in user.

Docker can remain useful for deterministic CI or mocked integration testing. It is not the solution for full host access and is not required in this overnight scope.

### 2.3 Runtime parity

The following runtimes are first-class targets:

| Runtime | cortextOS runtime value | Live Windows prerequisite |
|---|---|---|
| Claude Code | `claude-code` | Authenticated and live smoke-tested |
| Codex app-server | `codex-app-server` | Authenticated and live smoke-tested |
| OpenCode | `opencode` | Authenticated and live smoke-tested |

The core daemon, bus, Telegram poller, cron scheduler, status reporting, restart behavior, and onboarding contract must be runtime-independent. Runtime adapters may translate protocol details but must expose the same lifecycle contract.

## 3. Known starting state

Treat these facts as the baseline; verify them before changing code:

- The isolated branch is based on `upstream/main` and already contains a three-OS GitHub Actions matrix.
- Build, typecheck, CLI help, and lifecycle-status verification pass on GitHub-hosted Windows, macOS, and Ubuntu runners.
- The full test suite and Codex parity tests pass on the GitHub macOS and Ubuntu runners.
- The Windows unit-test job currently reports **74 failed, 2,194 passed, and 12 skipped across 141 test files**. Failures include path assumptions, CRLF parsing, home-directory behavior, Unix-socket assumptions, POSIX signal expectations, and genuine cross-platform product paths.
- Existing Windows hardening work must be inspected before reimplementation, especially open PRs #46 and #561 and the historical Windows install report. Reuse sound fixes by reapplying/rebasing them surgically; do not merge stale branches wholesale.
- Claude Code, Codex, and OpenCode are already authenticated on the Windows VM and each has completed a direct live CLI turn.
- Authentication secrets must never be printed, copied into the repository, included in test artifacts, or sent to another agent.

## 4. User-visible behavior to preserve

The root onboarding skill is the behavioral source of truth. A new agent is not functional until all applicable onboarding outcomes exist:

- runtime is detected from `config.json`;
- `IDENTITY.md`, `SOUL.md`, `GOALS.md`, `USER.md`, and `GUARDRAILS.md` are established;
- Telegram configuration is connected and tested when test credentials are available;
- persistent crons are stored through the cortextOS bus and survive restart;
- the correct runtime-specific skills are available;
- `${CTX_ROOT}/state/<agent>/.onboarded` is written only after onboarding completes;
- interrupted onboarding resumes at the first incomplete step;
- the user is not falsely told an agent is online before it is actually ready.

Existing macOS users should not need to change their commands, config files, agent directories, environment variables, or daily workflow. Configuration/schema migrations must be backward-compatible and idempotent.

## 5. Required workstreams

### A. Establish reproducible cross-platform CI

1. Keep the GitHub Actions matrix on `windows-latest`, `macos-latest`, and `ubuntu-latest`.
2. Make build, typecheck, CLI verification, the full Vitest suite, and runtime-parity tests pass on all three operating systems.
3. Classify every current Windows failure before fixing it:
   - real product defect;
   - invalid test assumption;
   - unsupported Unix-only capability requiring a Windows implementation;
   - environmental flake.
4. Fix product code when the product behavior is wrong. Do not normalize only the assertion if runtime behavior remains broken.
5. A Windows skip is acceptable only when the behavior is truly meaningless on Windows and an equivalent Windows-native test covers the intended contract. Record the reason next to the skip.
6. Keep fixtures and assertions platform-neutral using `node:path`, `os.tmpdir()`, explicit newline handling, and injected/mockable process operations.
7. Separate deterministic mocked lifecycle tests from paid live-agent tests so normal CI never requires model credentials.

### B. Create explicit platform seams

Identify scattered checks for `process.platform`, literal `/tmp`, hardcoded `/` path matching, `HOME`-only behavior, POSIX signals, `bash`, `which`, Unix sockets, and `chmod`. Consolidate only where doing so reduces duplication and clarifies behavior.

At minimum, the implementation must provide testable answers for:

- canonical CTX root and user-home resolution;
- safe child-path containment on both separator styles;
- runtime executable discovery (`.exe`, `.cmd`, PowerShell shims, PATH);
- agent process-tree shutdown, stale-process cleanup, and death confirmation;
- IPC transport/endpoints for Codex app-server on Windows and Unix;
- durable startup/recovery on Windows without changing Unix startup behavior;
- CRLF/LF-tolerant parsing for repository-managed Markdown/frontmatter;
- directory linking/copying for runtime skills without requiring Windows Developer Mode.

Avoid a speculative large rewrite. Add or extract the smallest adapters needed to make proven behavior cross-platform.

### C. Make a clean, isolated Windows install work

Use a new run-specific directory and instance ID on the VM. Do not overwrite any existing user or production-like cortextOS instance.

From the branch under test:

1. Verify Node, npm, Git, PM2, PowerShell, `node-pty`, Claude, Codex, and OpenCode discovery.
2. Run `npm ci`, typecheck, build, and relevant tests natively in PowerShell.
3. Run `cortextos install`, initialize a disposable org, and add one agent for each target runtime.
4. Generate the ecosystem configuration and start the daemon through the supported Windows path.
5. Confirm `cortextos doctor`, `list-agents`, and `status` are truthful and useful.
6. Capture sanitized commands, exit codes, timestamps, runtime versions, and log paths in the final report.

Authentication itself is already proven and is not part of clean-install automation. The run may verify auth status but must not reauthenticate, rotate credentials, or expose device codes/tokens.

### D. Prove real Windows lifecycle behavior

For each of Claude Code, Codex app-server, and OpenCode, prove with a real live agent—not only a direct harness CLI command—that:

1. the daemon discovers and starts the agent;
2. a PTY/app-server session becomes genuinely ready before message injection;
3. a unique test message reaches the live agent;
4. the agent executes a harmless native PowerShell command;
5. the agent reads and writes a uniquely named file inside its disposable Windows test root;
6. the response returns through the cortextOS bus/channel and is correlated to the request;
7. logs and status reflect running, thinking, idle, stopped, and failed states accurately;
8. stop, start, restart, disable, and re-enable do not double-spawn or resurrect disabled agents;
9. an unexpected agent-process exit is detected and recovered within the documented retry policy;
10. queued and back-to-back messages preserve order and do not disappear;
11. runtime state survives a daemon restart without cross-contaminating another agent's session.

The harmless native command test must demonstrate host-native execution while staying inside the disposable test root. Do not probe private user files merely to prove full-disk authority.

### E. Prove poller and messaging behavior

When dedicated test Telegram credentials are already available, run a real end-to-end Telegram round trip for each runtime and verify:

- exactly one poller owns each bot token;
- inbound messages are received once;
- replies are returned once;
- restart does not leave zombie pollers or cause a sustained 409 conflict loop;
- unauthorized senders remain rejected;
- Telegram commands and normal text turns both work.

Never reuse one bot token concurrently across agents. Never repurpose a personal/production bot without explicit permission.

If dedicated live Telegram credentials are unavailable, do not stop the rest of the run. Exercise the complete poller/dispatcher contract against the closest deterministic local transport, mark live Telegram as **UNVERIFIED**, and state exactly what one human step remains. Do not report full production readiness without a live external-channel round trip.

### F. Prove persistent crons

For each runtime:

1. add a short-interval disposable cron through `cortextos bus add-cron`;
2. prove it is stored in the correct per-agent `crons.json`;
3. prove the daemon reloads it without an agent restart;
4. prove it fires and reaches the live agent;
5. prove the result is logged;
6. restart the agent and daemon and prove the cron remains scheduled;
7. disable or remove the test cron and prove it no longer fires.

Do not wait hours for tests; use a safe short interval and bounded timeouts.

### G. Prove restart and Windows persistence

1. Validate PM2 save/resurrect behavior without relying on Unix `pm2 startup`.
2. Validate the repository's Windows Task Scheduler/startup helper is idempotent and targets only the test instance.
3. Perform at least one daemon cold restart and one PM2 cold resurrection.
4. If and only if SSH reconnection and the VM target are confirmed, perform one controlled VM reboot late in the run. Wait for reconnection and verify daemon, dashboard, pollers, crons, and enabled agents return without manual repair.
5. If a full reboot cannot be performed safely, mark it unverified; never fake this acceptance result.

### H. Observability and diagnosis

The operator must be able to understand failures without attaching a debugger. Ensure logs expose, with secrets redacted:

- runtime executable and adapter chosen;
- agent lifecycle transitions and reasons;
- PTY/app-server readiness and bounded startup timeout;
- process PID/identity where safe;
- message receive/inject/complete correlation IDs;
- poller start/stop/conflict/retry state;
- cron load/fire/retry/failure state;
- restart attempts, backoff, and terminal failure reason;
- platform-specific command failure with exit code and actionable remediation.

Do not dump full environments, auth stores, prompts containing secrets, or raw tokens. Add a reusable redaction helper if current logging cannot safely meet this requirement.

### I. Documentation and maintainability

Update user and maintainer documentation to cover:

- one supported install/start flow for Windows;
- Windows prerequisites and one-time harness gates;
- Windows persistence behavior and its login/boot semantics;
- how to run the three-OS test matrix;
- how to run opt-in live Windows smoke tests;
- the platform-adapter boundaries and how to add a new OS-specific implementation;
- troubleshooting for PATH/shims, node-pty, IPC, poller conflicts, stale processes, CRLF, and PM2 resurrection.

Commands must be provided in native PowerShell where Windows users are expected to run them.

## 6. Acceptance matrix

| Capability | Windows GitHub runner | Windows Azure VM | macOS | Ubuntu |
|---|---:|---:|---:|---:|
| Install dependencies/build/typecheck | Required | Required | Required in CI | Required in CI |
| Full deterministic test suite | Required | Targeted confirmation | Required in CI | Required in CI |
| CLI install/init/add-agent/status/doctor | Mocked/integration | Required live | Regression tests | Regression tests |
| Claude agent lifecycle | Mocked | Required live | Must not regress | Must not regress |
| Codex app-server lifecycle | Mocked | Required live | Must not regress | Must not regress |
| OpenCode lifecycle | Mocked | Required live | Must not regress | Must not regress |
| Bus message round trip | Required | Required live | Required | Required |
| Telegram round trip | Mocked | Required for production-ready claim | Existing contract | Existing contract |
| Persistent cron across daemon restart | Required | Required live | Required | Required |
| PM2/host restart recovery | Not applicable | Required live | Must not regress | Must not regress |
| Native shell/filesystem access | Not credentialed | Required live in disposable root | Existing behavior | Contract test |

## 7. Definition of done

The overnight task is complete only when all of the following are true:

- [ ] Windows, macOS, and Ubuntu CI jobs are green for build, typecheck, full tests, and runtime-parity tests.
- [ ] No Windows failure was hidden with an unjustified skip or assertion-only path normalization.
- [ ] Claude, Codex app-server, and OpenCode each complete a live cortextOS-managed Windows round trip.
- [ ] Each runtime proves native PowerShell execution and filesystem access inside the disposable test root.
- [ ] Poller, cron scheduler, daemon restart, agent restart, and message ordering are proven with timestamped evidence.
- [ ] Windows PM2 resurrection is proven; controlled VM reboot is proven or explicitly marked unverified.
- [ ] Onboarding completion/resume behavior matches the root onboarding skill.
- [ ] macOS behavior and existing configuration compatibility are preserved.
- [ ] User-facing Windows setup and troubleshooting docs are accurate.
- [ ] Changes are committed only to `codex/windows-native-runner` and pushed only to that branch for CI.
- [ ] A concise morning report lists changes, evidence, remaining risks, skipped/unverified items, CI links, and exact next actions.

Passing unit tests alone is not sufficient. Passing direct `claude`, `codex`, or `opencode` commands alone is not sufficient. The live processes must be launched and managed through cortextOS.

## 8. Autonomous execution protocol

### 8.1 Adaptive defect-discovery loop

The run is not a fixed checklist that stops when its initially known failures pass. It is an adaptive observe-reproduce-fix-expand loop optimized to drive both programmatic and behavioral errors toward zero.

Use this loop continuously:

1. **Observe:** watch daemon, PTY/app-server, poller, cron, PM2, status, and user-visible response streams during every test.
2. **Capture:** assign every anomaly a run-unique bug ID and record timestamp, platform, runtime, lifecycle state, trigger, expected behavior, actual behavior, and sanitized evidence in the working bug ledger.
3. **Classify:** label it as product logic, platform adapter, runtime protocol, test harness, environment, security, observability, or behavioral-contract failure. Assign severity and reproducibility confidence.
4. **Minimize:** reduce it to the smallest deterministic reproduction without losing the user-visible symptom.
5. **Encode:** add or strengthen a regression test/oracle before the fix when practical. Behavioral failures need behavioral assertions, not merely “process exited zero.”
6. **Fix:** make the smallest root-cause correction in shared core code or the appropriate narrow adapter.
7. **Verify:** prove the new test fails before/passes after when practical, then rerun the affected subsystem on Windows and at least one Unix platform.
8. **Expand:** probe the adjacent failure surface—other runtimes, restart states, path forms, timing windows, duplicate inputs, and recovery paths—because one discovered bug often represents a class.
9. **Regress:** rerun the growing automated suite and the relevant live scenario. Do not close the ledger item from a single lucky execution.
10. **Soak:** when the immediate queue is clear, run repeated mixed-runtime lifecycle/message/cron cycles while watching for new anomalies, then feed every finding back into step 2.

The working bug ledger is the source of truth during the run. Each item must have one of: `new`, `reproduced`, `test-added`, `fixed`, `verified`, `deferred`, or `not-a-bug`. A `deferred` item requires an explicit reason, severity, evidence, and next action. Never silently discard an anomaly because it was intermittent.

Programmatic error detection includes uncaught exceptions, non-zero exits, crashes, leaked processes, invalid paths, corrupt state, incorrect exit codes, failed cleanup, race conditions, timeouts, unhandled protocol messages, and resource leaks.

Behavioral error detection includes missing/duplicate/out-of-order replies, false “online” or “healthy” states, premature message injection, failure to resume onboarding, incorrect runtime/skill selection, misleading diagnostics, lost cron fires, unexpected agent resurrection, cross-agent state contamination, and any difference from the documented macOS/Linux user experience.

Every acceptance scenario needs explicit oracles for:

- expected state transition sequence;
- maximum bounded completion time;
- exact-once or intentionally-at-least-once delivery semantics;
- expected persistent files/state and forbidden side effects;
- expected user-visible reply and error message;
- absence of uncaught errors, crash-looping, secret leakage, stale child processes, and unrelated file mutation.

When a new defect is found, automatically add a targeted adjacent-probe set proportional to its risk. Examples include:

- a path defect triggers checks for spaces, Unicode, long paths, both separators, drive roots, relative segments, and containment boundaries;
- a process defect triggers clean exit, crash, forced kill, double stop/start, stale PID, and daemon-shutdown checks across all runtimes;
- a timing defect triggers delayed readiness, rapid messages, restart-during-turn, and bounded retry checks;
- a parsing defect triggers LF, CRLF, BOM, empty, malformed, partial-write, and recovery checks;
- a poller defect triggers duplicate consumer, transient network failure, 401/409 handling, restart, and exact-once response checks;
- a cron defect triggers add/update/disable/remove, reload, catch-up, duplicate-fire, restart persistence, malformed state, and clock-boundary checks.

Use deterministic fault injection and property/table-driven tests where they provide more coverage than isolated examples. In the disposable VM instance, run bounded chaos scenarios such as killing an agent mid-turn, restarting the daemon with queued messages, temporarily breaking a test transport, and presenting recoverable malformed state. Never inject faults into the VM host, authentication stores, firewall, or non-test instances.

The loop is complete only when all initial and newly discovered high-impact defects are verified fixed, the bug ledger has no unexplained anomalies, repeated mixed-runtime soak cycles produce no new failures, and the full cross-platform regression matrix remains green. Absolute absence of bugs cannot be proven; the morning report must therefore distinguish verified coverage from residual risk instead of claiming perfection without evidence.

### 8.2 Work order

1. Reconfirm branch/worktree isolation and record the starting commit.
2. Reproduce and classify the Windows CI failures.
3. Delegate bounded, non-overlapping investigations where useful (for example: path/CRLF tests, Windows process lifecycle, Codex IPC, OpenCode PTY, and live VM harness). The lead agent owns integration and must review every change.
4. Land small coherent commits with regression tests.
5. Run targeted tests locally, then the full macOS suite, then push the branch to obtain all three hosted CI results.
6. Iterate until cross-platform CI is green or the deadline approaches.
7. Deploy the exact tested commit to the isolated VM test instance.
8. Run the live lifecycle, messaging, cron, recovery, and persistence matrix.
9. Fix, retest, and repeat; never declare success from a one-off lucky run.
10. Stop mutation before the deadline, leave the VM in a safe state, and write the report.

### 8.3 Evidence discipline

For every material bug:

1. capture a minimal reproduction and expected behavior;
2. identify whether the defect is product or test-harness code;
3. add a regression test that fails before the fix when practical;
4. implement the smallest durable fix;
5. run the focused test on Windows and at least one Unix platform;
6. record the result in the morning report.

Use unique run IDs in messages, filenames, crons, agents, and logs so stale output cannot be mistaken for a passing test.

### 8.4 Decision rules

- Prefer forward progress without asking the user about routine implementation choices.
- Do not weaken security, approval gates, path containment, sender allowlists, or credential isolation to make a test pass.
- Do not replace native Windows behavior with WSL as the product solution. WSL may be a diagnostic comparison only.
- Do not introduce a container requirement.
- Do not redesign unrelated architecture, dashboard UI, or agent personalities.
- Do not silently change default models, billing behavior, or provider selection.
- If an upstream harness changed its protocol, verify against the installed version and isolate the compatibility logic in its adapter.
- When a stale PR contains a useful fix, port only the understood change and preserve current-main behavior/tests.

## 9. Safety and change-control boundaries

The overnight agent is authorized to edit, test, commit, and push only the `codex/windows-native-runner` branch and to mutate only the disposable Windows test instance/root.

It must not:

- merge, push, force-push, reset, or commit to `main`/`master`;
- alter the maintainer's main worktree or unrelated dirty worktrees;
- open or merge a pull request unless separately requested;
- delete or overwrite existing orgs, agents, user files, auth stores, or VM data;
- print, commit, upload, or message credentials, device codes, bot tokens, chat IDs, private keys, or full environment dumps;
- disable Windows Firewall, broadly open Azure NSG ports, expose the dashboard publicly, or weaken SSH/RDP restrictions;
- create new paid cloud resources, resize the VM, or enable paid services;
- send messages to real people or external channels except dedicated test endpoints already authorized for this run;
- install unreviewed remote scripts with administrative privileges;
- continue mutating after 7:40 AM America/New_York; reserve the final 20 minutes for cleanup, final verification, and reporting.

Safe cleanup means stopping disposable test crons/agents, removing only run-ID-scoped temporary artifacts, keeping evidence needed for diagnosis, confirming no test port is publicly exposed, and leaving the branch/worktree recoverable.

## 10. Morning report format

Write a sanitized report to `WINDOWS_NATIVE_RUNNER_MORNING_REPORT.md` and summarize it to the user with:

1. **Outcome:** production-ready, partially ready, or not ready.
2. **Branch and commits:** exact branch, starting SHA, ending SHA, and commit list.
3. **CI:** per-OS job results and links.
4. **Live matrix:** one row per runtime with boot, message, native command, file access, reply, cron, restart, and recovery results.
5. **Bugs fixed:** symptom, root cause, fix, and regression test.
6. **Unverified/failed:** candid list with logs and reproduction commands.
7. **Security:** ports/firewall posture, secret-redaction confirmation, and cleanup performed.
8. **Compatibility:** evidence macOS/Linux were not regressed.
9. **Recommended next steps:** ordered, concrete, and minimal.

Use **PASS**, **FAIL**, **UNVERIFIED**, and **NOT APPLICABLE**. Never convert an unverified item into a pass by inference.

## 11. Copy-ready `/goal` prompt

```text
/goal Make cortextOS genuinely Windows-native while preserving existing macOS/Linux behavior. Work autonomously until 8:00 AM America/New_York on August 19, 2026, following WINDOWS_NATIVE_RUNNER_OVERNIGHT_REQUIREMENTS.md as the binding specification.

Operate only in the isolated codex/windows-native-runner worktree/branch. You may edit, test, create bounded sub-agent tasks, commit coherent changes, and push that branch for CI. Never touch or push main, never merge, never open a PR, never modify unrelated worktrees, never expose secrets, never weaken security, and never create paid infrastructure.

Start by verifying the branch and reproducing the current Windows CI baseline. Classify every failure before fixing it. Build one shared Node.js core with only narrow, testable platform adapters. Do not use Docker or WSL as the product runtime. Do not hide real defects with Windows skips or assertion-only normalization.

Get build, typecheck, the full test suite, and runtime-parity tests green on GitHub-hosted Windows, macOS, and Ubuntu. Then deploy the exact tested commit into a disposable instance on the existing Azure Windows VM. The VM already has authenticated Claude Code, Codex, and OpenCode CLIs; verify auth status but do not reauthenticate or expose credentials.

For claude-code, codex-app-server, and opencode, launch a real agent through the cortextOS daemon and prove PTY/app-server readiness, an inbound uniquely identified message, harmless native PowerShell execution, read/write access inside the disposable test root, a correlated response through the cortextOS bus/channel, truthful lifecycle status, ordered back-to-back messages, stop/start/restart/disable behavior, crash recovery, persistent cron execution, and state survival across daemon restart. Exercise real Telegram only with already-authorized dedicated test credentials; otherwise test the deterministic transport contract and mark live Telegram UNVERIFIED. Prove PM2 cold resurrection and perform one controlled VM reboot only if SSH reconnection and the exact VM target are confirmed.

Inspect and selectively reuse relevant prior Windows work, especially open PRs #46 and #561 and the historical Windows install report, but do not merge stale branches wholesale. Preserve onboarding behavior exactly as defined by community/skills/onboarding/SKILL.md.

Maintain an adaptive bug ledger and continuously run the observe-capture-classify-minimize-encode-fix-verify-expand-regress-soak loop in the specification. Every newly observed programmatic or behavioral anomaly becomes a tracked item, a minimized reproduction, a regression oracle when practical, and a risk-proportional set of adjacent probes. Do not stop at the initially known failures or a one-off green run. Continue iterating while safe and useful work remains, including repeated mixed-runtime soak cycles after the known queue is clear.

Use reproducible evidence, unique run IDs, redacted logs, small commits, and repeated tests. Stop mutations at 7:40 AM, clean up only run-scoped artifacts, and spend the final 20 minutes producing the sanitized morning report required by the specification. Report PASS, FAIL, UNVERIFIED, or NOT APPLICABLE honestly for every acceptance item, including newly discovered defects and residual risk.
```
