# Windows native dogfood checkpoint — 2026-08-19

## Stop state

Work is intentionally paused before another VM deployment or process restart.
The user can currently communicate with both disposable Telegram agents. Claude
previously crash-looped, then remained stable after the native executable fix;
Codex did not exhibit that crash loop. Claude's current onboarding conversation
incorrectly batched several questions, which is recorded as DOG-011.

- Main is untouched. All work remains on `codex/windows-native-runner` and the
  dogfood integration branch.
- Live VM code is at `bbdd8f35`.
- The branch base is `3ff763ce`, which contains the delayed, readiness-confirmed
  recovery notification fix but has not yet been deployed to the VM.
- The one-question onboarding change and this checkpoint are locally verified
  but were not deployed at the time of this stop.
- The scoped Task Scheduler/PM2 services and the two Telegram agents are left in
  their current running state. No VM cleanup, reboot, or token revocation has
  occurred.
- Temporary secrets are stored only in the ignored, ACL-restricted VM files.
  They are intentionally absent from this document, Git, and test output.

## Complete issue inventory

The authoritative engineering issue details are in
`WINDOWS_NATIVE_RUNNER_BUG_LEDGER.md` (WIN-001 through WIN-037). The live
normal-user dogfood details are in `WINDOWS_TELEGRAM_DOGFOOD_LEDGER.md`
(DOG-001 through DOG-012). Together they cover every issue observed so far.

### Cross-platform engineering findings

- **Paths and parsing:** WIN-001, WIN-002, WIN-005, WIN-006, WIN-015, WIN-019,
  WIN-026. These cover separator-safe containment/routing, CRLF/BOM input,
  Windows home semantics, marker/log paths, fixture paths, native repository
  identity, and BOM-prefixed runtime config.
- **Process, PTY, and IPC lifecycle:** WIN-003, WIN-004, WIN-007, WIN-008,
  WIN-014, WIN-017, WIN-018, WIN-023, WIN-027, WIN-028, WIN-029, WIN-033,
  WIN-035. These cover Codex loopback app-server transport, Windows process-tree
  cleanup, platform-neutral CLI invocation/fault injection, headless Codex,
  completion races, bus-only enablement, diagnostic handle leaks, Claude
  first-run/TUI detection, current provider readiness markers, and messages
  accepted during crash recovery.
- **Native installation and persistence:** WIN-009, WIN-012, WIN-021, WIN-022,
  WIN-032, WIN-036. These cover skill installation without Developer Mode,
  PM2 resurrection, remaining global `npm link` isolation, version-manager PM2
  discovery, headless Startup/S4U persistence, and Windows-native onboarding.
- **Authentication and child environments:** WIN-010, WIN-016, WIN-030,
  WIN-031. These cover isolated Git execution, Windows executable trust,
  authenticated Claude profile preparation, and preservation of Claude's
  dedicated OAuth environment key without logging its value.
- **Dashboard and secret security:** WIN-020, WIN-024, WIN-025, WIN-037. These
  cover unresolved dashboard dependency advisories, loopback binding, PM2
  dashboard credentials, and Windows ACL protection for secrets.
- **Test reliability and live proof:** WIN-011, WIN-013, WIN-034. Native
  lifecycle/persistence have prior signed-bus proof; external Telegram was
  previously deferred and is now being exercised by this dogfood run; transient
  Git maintenance state is excluded from product-tree immutability checks.

### Issues found in the current real-user Telegram run

1. **DOG-001 / WIN-036 — Unix-first onboarding:** critical product defect. The
   root and packaged onboarding instructions contained Bash-only assumptions.
   Native PowerShell/Node flows are implemented and a fresh Windows install
   passed; complete first-boot conversations are still pending.
2. **DOG-002 — overlapping dashboard installs:** low-severity observer error.
   A detached SSH install and an accidental retry collided. A single attached
   normal-user install passed, so this is orchestration rather than Cortext.
3. **DOG-003 / WIN-037 — ineffective Windows secret chmod:** high-severity
   product/security defect. The shared ACL adapter is implemented and live ACL
   inspection passed for dashboard, org, and both agent secret files.
4. **DOG-004 — Telegram activation checkpoint:** not a defect. After the user
   messaged both bots, private sender authorization was derived and both routes
   became live.
5. **DOG-005 — npm allow-scripts warnings:** environment/tooling observation.
   The clean install still produced a loadable, working node-pty and successful
   build; keep watching on other clean Windows images.
6. **DOG-006 — setup wizard safety/usability:** high-severity product defect.
   Token masking, in-process Telegram discovery, private sender persistence,
   single terminal ownership, and Windows PM2 invocation are implemented.
   A clean end-to-end wizard rerun is still required.
7. **DOG-007 — Unix handoff text:** medium product/usability defect. `cat`,
   command chaining, and obsolete Windows startup advice were replaced by
   PowerShell-safe handoff instructions and the repository Task Scheduler flow;
   the corrected dogfood install path passed.
8. **DOG-008 — Claude scheduled-task crash loop:** high product defect. The npm
   `.cmd` shim and quoting layers produced an invalid executable path under
   S4U/ConPTY. The shared native Claude executable resolver was deployed;
   Claude remained running and replied through Telegram afterward.
9. **DOG-009 — SSH-owned PM2 death:** low environment/orchestration behavior.
   Windows OpenSSH closes its job tree with the session. The supported scoped
   Task Scheduler launch registered idempotently, returned success, and kept
   daemon/dashboard alive across new SSH sessions.
10. **DOG-010 — false recovery notifications:** medium product defect. Cortext
    announced recovery as soon as a replacement child spawned, even when it
    immediately crashed. The branch now waits through the stability window and
    requires the same crash generation to be bootstrapped. It is tested but not
    yet deployed/live-rerun.
11. **DOG-011 — onboarding question dump:** high product/behavior defect. Claude
    sent the interview in a burst because early steps lacked turn boundaries.
    All shipped onboarding roles/skills now require exactly one question and
    one outbound message per turn, with continuation only after new input. The
    deterministic regression passes; it is not yet deployed/live-rerun.
12. **DOG-012 — Bash-like commands from Claude on Windows:** medium behavioral
    observation. The harness executed them and did not ask the user to perform
    translation, but we have not yet proven that every command used the intended
    native shell contract. Keep open until reproduced and classified from logs.

## Evidence already passed

- Fresh clone from upstream main plus only the isolated integration branch.
- Clean root `npm ci`, typecheck, build, node-pty load, and PTY spawn.
- Supported instance/org/Claude/Codex scaffolding on native Windows.
- Dashboard dependency install completed in a single foreground run.
- Dashboard bound to loopback; no new public port or firewall rule was added.
- Scoped startup task registered twice without duplication, used limited
  privilege/S4U, returned result 0, and survived later SSH sessions.
- Windows ACL inspection passed for every dogfood secret file.
- `doctor` truthfully recognized executable and authentication readiness after
  the Claude resolver fix.
- Claude and Codex each exchanged real Telegram messages with the user.
- The pending one-question change passed focused integration/unit tests,
  typecheck, build, and `git diff --check` locally.

Passing infrastructure does not close behavioral gates. In particular, neither
agent has completed first-boot onboarding and the complete Telegram/lifecycle
matrix has not run.

## Open gates and risks

- Deploy and live-rerun DOG-010 and DOG-011.
- Complete one-question-at-a-time onboarding for both Claude and Codex; confirm
  resume-from-earliest-unanswered and correct `.onboarded` placement.
- Reproduce/classify DOG-012 from sanitized logs.
- Run a clean `cortextos setup` wizard end to end on Windows.
- Exercise normal conversation continuity, rapid ordering, chunking, Unicode,
  idle/resume, and exactly-once routing on both bots.
- Exercise agent restart, forced crash, queued message during recovery, daemon
  restart, PM2 cold resurrection, and a controlled VM reboot.
- Add/test short-lived cron scheduling and removal.
- Run final full tests and Windows/macOS/Linux CI at the exact candidate commit.
- WIN-020 remains a separate security readiness blocker for any publicly
  exposed dashboard; dogfood remains safe only because it is loopback-bound.
- WIN-021 means non-default installs are not yet fully host-isolated because of
  global `npm link`; this does not invalidate the disposable instance but must
  be disclosed.
- Revoke both Telegram tokens and remove scoped secrets/services at cleanup.

## Resume plan

1. **Reconfirm the stop state.** Record current branch/VM commits, PM2 ownership,
   process counts, loopback listener, agent states, and sanitized error counters
   before changing anything.
2. **Package the pending fixes.** Review the DOG-011 instruction diff, retain the
   unrelated pre-existing `tests/unit/lifecycle/legacy-status.test.ts` change
   outside every commit, run focused tests/typecheck/build/diff check, then
   commit and push only to the two isolated branches.
3. **Deploy narrowly.** Fast-forward the disposable VM clone, rebuild, copy the
   updated runtime-specific onboarding files into the already-scaffolded test
   agents, and restart only the scoped daemon through its task-owned PM2 home.
4. **Verify recovery semantics first.** Observe at least the 30-second stability
   window. Confirm no false “recovered” notification and exactly one process per
   enabled agent/poller before asking the user to continue.
5. **Rerun onboarding behavior.** Ask the user to send `/onboarding` to one bot
   at a time. Require one topical question in one message, wait for a reply,
   preserve answered state, and repeat through completion. Any batching becomes
   a new evidence capture, not a blind retry.
6. **Complete functional Telegram acceptance.** Run the ordinary conversation,
   ordering, chunking, file/PowerShell, isolation, idle/resume, and exactly-once
   scenarios from the acceptance plan.
7. **Run lifecycle scenarios sequentially.** Agent restart, forced exit with a
   message at the readiness boundary, daemon restart, cron persistence/removal,
   PM2 cold resurrection, then user-approved VM reboot. Capture redacted evidence
   and user-visible behavior for each scenario.
8. **Adaptive loop for every new observation.** Preserve evidence, classify
   product/environment/orchestration/external, minimize, add a regression where
   possible, fix in shared Node core or the thinnest native adapter, rerun the
   exact failed case, check adjacent runtimes/OSes, and soak across the affected
   timing window. Never close an issue based only on a restart or workaround.
9. **Release gate.** Run the full local suite and three-OS CI at the exact final
   commit. Report PASS/FAIL/UNVERIFIED separately; do not claim readiness with an
   unresolved critical/high product defect.
10. **Cleanup.** After the user accepts the run, remove disposable crons,
    processes, scheduled task, and secrets; revoke both bot tokens; verify the
    pollers can no longer authenticate. Main remains untouched until a separate
    explicit merge decision.

## First human action after resume

Do not send another onboarding answer until the pending behavior fix is deployed
and the observer explicitly confirms the scoped agents are ready. The first live
test should be `/onboarding` to Claude only, followed by a single answer to the
single question received. Codex follows after Claude proves the turn gate.
