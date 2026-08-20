# Windows Dogfood 2 remediation ledger

Run ID: `windows-dogfood-2-20260819`

Branch: `codex/windows-native-install-dogfood-2-20260819`

Ledger baseline commit: `af7515af`

Candidate commit: pending

Dispositions:

- `integrated-and-regressed`
- `implementation-pending`
- `live-validation-pending`
- `environment-orchestration-control`
- `out-of-scope-by-decision`
- `external-unverified`

The historical regression references below establish why an existing fix is in
the candidate. Gate C still requires all applicable tests to be rerun together
at the final exact commit before VM cleanup.

## Prior Windows engineering findings

| ID | Disposition | Candidate implementation / source | Deterministic evidence | Dogfood 2 live gate or residual |
|---|---|---|---|---|
| WIN-001 | integrated-and-regressed | Platform-neutral catalog, KB, dashboard sync, migrations (`fa86b55a`) | catalog, KB, dashboard, migration suites | Fresh install exercises native paths |
| WIN-002 | integrated-and-regressed | BOM/CRLF-safe parsers (`fa86b55a`) | frontmatter and migration parser suites | PowerShell-authored config inspected live |
| WIN-003 | integrated-and-regressed | Windows Codex loopback WebSocket endpoint (`dbd7bc6d`) | Codex unit/E2E lifecycle suites | Extra Codex agent is out of current live scope |
| WIN-004 | integrated-and-regressed | Native process-tree adapter and OpenCode reap (`dbd7bc6d`) | OpenCode reap/process suites | Extra OpenCode agent is out of current live scope |
| WIN-005 | integrated-and-regressed | HOME/USERPROFILE-aware test isolation (`f8cfc289`) | cross-platform home/path suites | None beyond three-OS candidate CI |
| WIN-006 | integrated-and-regressed | Native lifecycle marker/log paths (`dbd7bc6d`) | lifecycle/agent-process suites | Initial Claude boot verifies markers/logs |
| WIN-007 | integrated-and-regressed | Platform-neutral CLI test invocation (`f8cfc289`) | CLI error-boundary suite | Public installer exit observed live |
| WIN-008 | integrated-and-regressed | Injected filesystem-failure harness (`f8cfc289`) | deterministic recovery failure suite | None beyond candidate CI |
| WIN-009 | integrated-and-regressed | Junction/copy skill install fallback (`dbd7bc6d`) | add-agent Codex/skill install suites | Extra Codex agent is out of current live scope |
| WIN-010 | integrated-and-regressed | Isolated native Git diagnostics (`96f126bf` and Git follow-ups) | legacy/status/Git diagnostic suites | `legacy-status.test.ts` user edit excluded from commits |
| WIN-011 | integrated-and-regressed | Shared lifecycle plus prior three-runtime live acceptance | E2E lifecycle suites | Current live scope verifies initial Claude only |
| WIN-012 | live-validation-pending | PM2 resurrection and startup helper (`ab5aed96`, `1f929dee`) | ecosystem/startup helper suites | New default-path Startup/S4U instance must survive new session |
| WIN-013 | live-validation-pending | Telegram routing already deterministic; credentials now authorized | Telegram API/poller/dispatcher suites | Fresh user `hi`, one dispatch, first single question |
| WIN-014 | integrated-and-regressed | Headless Codex process transport (`dbd7bc6d`) | headless-process and Codex lifecycle suites | Codex live agent out of current scope |
| WIN-015 | integrated-and-regressed | Native Codex fixture paths (`f8cfc289`) | Codex continuation/lifecycle suite | None beyond candidate CI |
| WIN-016 | integrated-and-regressed | Closed trusted Git/Node environment (`a39e2323`) | diagnostic/Git trust suites | Installer/doctor run in cleaned account |
| WIN-017 | integrated-and-regressed | Completion-event live oracle (`67fddcea`) | Codex lifecycle completion suite | Codex live agent out of current scope |
| WIN-018 | integrated-and-regressed | Explicit bus-only lifecycle enablement (`1a6e68b8`) | enable-agent validation/lifecycle suites | Bus-only live path out of current scope |
| WIN-019 | integrated-and-regressed | Native repository identity and safe.directory (`f9ba488b`–`32e13e98`) | Git root/diagnostic suites | Default-path installer/doctor validates live |
| WIN-020 | out-of-scope-by-decision | Dashboard remains loopback-only; dependency upgrades separated | Dashboard build/auth/loopback tests only | Public exposure is not approved or claimed |
| WIN-021 | out-of-scope-by-decision | Normal global `cortextos` CLI deliberately mirrors Mac/Linux | Installer global-link tests | Account is snapshotted/cleaned; isolated CLI mode not required |
| WIN-022 | live-validation-pending | PM2 path and authenticated Windows identity (`ab5aed96`) | startup helper resolver/identity tests | Double registration and task action inspected live |
| WIN-023 | integrated-and-regressed | Isolated PTY diagnostics close handles (`f0a03b20`–`58523d56`) | PTY smoke/doctor/install exit suites | Installer and doctor must return cleanly live |
| WIN-024 | live-validation-pending | Explicit dashboard host (`fe101adf`) | ecosystem Windows-native suite | Listener must be `127.0.0.1` only |
| WIN-025 | live-validation-pending | Restricted dashboard `.env.local` materialization (`b7495cfb`) | ecosystem/dashboard credential suites | Dashboard auth/health passes from fresh state |
| WIN-026 | integrated-and-regressed | BOM stripping across agent config lifecycle (`409ea334`) | enable/daemon/config suites | PowerShell-authored config parsed live |
| WIN-027 | live-validation-pending | Headless Claude first-run screen handling (`158451db`) | agent PTY/profile lifecycle suites | Fresh initial Claude must not stall or swallow message |
| WIN-028 | integrated-and-regressed | Full synchronous CSI/OSC stripping (`e858a7da`) | agent PTY output/bootstrap suites | Sanitized live logs confirm readiness parsing |
| WIN-029 | integrated-and-regressed | Exact Claude permission-ready sentinel (`7afa235c`) | agent PTY warning/readiness tests | Live readiness cannot be warning false-positive |
| WIN-030 | live-validation-pending | Auth-confirmed non-secret Claude profile preparation (`305d7d7a`) | Claude profile suite | Cleaned account retains auth and boots without OAuth prompt |
| WIN-031 | live-validation-pending | Claude OAuth variable allowlist (`773d1ba5`) | secret-safe environment propagation test | Native scheduled runtime remains authenticated |
| WIN-032 | live-validation-pending | Startup/S4U trigger (`1f929dee`) | startup helper PowerShell contract tests | Task-owned startup and new-session survival required |
| WIN-033 | live-validation-pending | Current runtime readiness marker tolerance (`2f61cb8f`) | Claude/OpenCode readiness suites | Initial Claude crosses readiness without timeout |
| WIN-034 | integrated-and-regressed | Ignore transient private Git maintenance state (`776b919f`) | immutability stress/three-OS CI | Candidate three-OS CI must remain green |
| WIN-035 | integrated-and-regressed | Preserve queue until replacement readiness (`3c1f256b`) | agent-process recovery suites | Crash-boundary live message is outside initial handoff scope |
| WIN-036 | live-validation-pending | Public installer (`13c8dbe3`, `ca28afaa`), canonical OS routing (`9833f23a`), optional Windows dependency deferral (`a94b514a`), and managed Windows reference (`35a82685`) | installer 18 tests; root routing 5 tests; managed portability plus adjacent templates 111 tests | Public installer → root onboarding → first managed question, no translation |
| WIN-037 | live-validation-pending | Shared Windows ACL adapter (`0d466f37`) | secret-permissions and CLI writer suites | All new secret files pass live `Get-Acl` inspection |

## Prior Telegram dogfood findings

| ID | Disposition | Candidate implementation / source | Deterministic evidence | Dogfood 2 live gate or residual |
|---|---|---|---|---|
| DOG-001 | live-validation-pending | Public installer, root Windows operational reference, and managed reference are integrated at `ca28afaa` | installer/root/managed focused suites pass | Full clean initial Windows path required |
| DOG-002 | environment-orchestration-control | Use one foreground dependency install; never overlap observer retries | Serialized execution runbook | A single clean install failure would reopen as product |
| DOG-003 | live-validation-pending | Shared fail-closed Windows ACL adapter (`0d466f37`) | secret-permissions tests | Inspect installer, org, agent, dashboard secrets live |
| DOG-004 | live-validation-pending | Two bots valid; current run activates Claude bot only | Telegram routing/poller suites | User sends fresh `hi`; exactly one authorized route |
| DOG-005 | integrated-and-regressed | Trust only the repository's required `esbuild`/`node-pty` scripts and Claude's global Windows postinstall | Manifest and global-install argument contracts plus native load/spawn gate | Clean Windows rerun must materialize both native artifacts |
| DOG-006 | out-of-scope-by-decision | Existing setup-wizard changes retained but not exercised | Existing setup tests may run in full suite | `cortextos setup` does not block this run |
| DOG-007 | integrated-and-regressed | Windows-native CLI handoff (`3cdc0ab1`) | CLI/ecosystem handoff assertions | Public installer and root onboarding output checked live |
| DOG-008 | live-validation-pending | Native Claude resolver (`bbdd8f35`) | Claude command/profile/doctor tests | Fresh scheduled Claude stays stable and answers |
| DOG-009 | environment-orchestration-control | Task Scheduler owns PM2; SSH-owned PM2 is not acceptance | startup helper/ecosystem tests | New admin session must not kill daemon/dashboard |
| DOG-010 | live-validation-pending | Generation/bootstrap/stability recovery notice (`3ff763ce`) | recovery-notification suite | No false recovered/crashed burst during initial soak |
| DOG-011 | live-validation-pending | Every shipped managed role/skill now requires one question, one answer, one outbound message, then `END YOUR TURN` (`35a82685`) | deterministic inventory/turn-boundary suite plus adjacent template suites: 111 tests | Exactly one first Telegram question live |
| DOG-012 | live-validation-pending | One operations-only Windows managed reference is selected after `process.platform`; shared conversation remains canonical (`35a82685`) | managed portability/reference contract passes | No Bash/WSL/manual translation in initial managed turn |

## Dogfood 2 findings

| ID | Severity | Classification | Status | Observation | Closure evidence |
|---|---|---|---|---|---|
| DOG2-001 | high | product/install/prerequisite | fixed; live validation pending | The global Windows `claude.ps1` shim points at a missing legacy package path while the authenticated executable lives in the architecture-specific optional dependency | Shared resolver now selects `claude-code-win32-<arch>/claude.exe`; stale-shim regression plus resolver/profile/doctor/PTY run passed 4 files, 34 tests; clean daemon boot must prove the native path |
| DOG2-002 | critical | product/installer portability | fixed; live validation pending | The prior `install.mjs` declared WSL required, pre-blocked on compiler tools, treated jq as core, and could continue after a failed pull | Native argument-array runner, PowerShell 5.1 file bootstrap, selected-remote/branch enforcement, conditional compiler guidance, fail-closed stages, and Windows optional-tool deferral pass 20 focused installer/core-install tests; clean public-command run remains |
| DOG2-003 | high | product/runtime dispatch | fixed; candidate-wide regression pending | `AgentPTY.spawn()` ignored the runtime adapter's `getBinaryName()` and always used the Claude resolver, so an OpenCode agent launched `claude` despite its native adapter | Existing failing OpenCode binary assertion plus AgentPTY/Hermes/Claude/lifecycle focused run: 5 files, 76 tests passed |
| DOG2-004 | critical | product/security/Windows ACL | third fix; candidate-wide regression pending | Hosted Windows showed `Set-Acl` could not load `Microsoft.PowerShell.Security`: the GitHub `pwsh` → Node → `powershell.exe` grandchild inherited PowerShell 7's incompatible `PSModulePath`, a documented cross-edition grandchild bug; secret writes correctly remained fail-closed | The ACL child now removes inherited `PSModulePath` case-insensitively so Windows PowerShell 5.1 rebuilds its native module path, then applies a fresh protected descriptor containing only current-user and LocalSystem; exact hosted Windows CI remains the proof gate |
| DOG2-005 | medium | invalid cross-platform test assumptions | fixed; candidate-wide regression pending | Root-onboarding hashes assumed LF checkout text and the OpenCode auth-seed test asserted POSIX `chmod` rather than the shared secret restriction contract | Contract text is newline-normalized and the auth-seed test asserts `restrictSecretFile`; the focused repair set passes |
| DOG2-006 | medium | test-harness portability | second fix; candidate-wide regression pending | Vitest's Windows transform path attempted to parse the executable installer after CRLF materialization and failed before collecting tests; a direct file-URL import was still intercepted on the hosted runner | The test imports a newline-normalized, shebang-free temporary copy while a separate child-process test continues to execute the real installer; exact Windows CI remains the proof gate |
| DOG2-007 | low | test-clock resolution | fixed; candidate-wide regression pending | A teardown floor measured 2,999 ms against an exact 3,000 ms assertion on Windows | The test uses the monotonic clock with a bounded 5 ms resolution margin while retaining explicit per-runtime ceilings and PTY-write observations |
| DOG2-008 | critical | product/install/npm lifecycle and command resolution | second fix; candidate-wide regression pending | The first clean PowerShell install proved npm 11.17 skipped Claude's global postinstall. After explicit approval materialized two valid authenticated executables, the second run proved the installer still selected an earlier broken `claude.cmd` from a stale PATH prefix | Windows global installs explicitly trust only `@anthropic-ai/claude-code`; the root manifest trusts only `node-pty` and `esbuild`; both installer layers now select the native executable even behind an earlier stale shim; focused lifecycle/resolver tests and a zero-state live rerun remain required |
| DOG2-009 | high | product/install/handoff | fixed; candidate-wide regression pending | The third public install passed completely, but its printed Windows next step still used generic `claude <path>`; installed-state verification proved that generic shim failed while two authenticated native executables worked | The Windows success handoff now prints an invocation-safe, single-quoted native executable and repository path; macOS/Linux retain the existing generic command; focused output and stale-prefix contracts pass, with exact full gates and literal live handoff still required |
| DOG2-010 | high | product/documentation/handoff | fixed; candidate-wide regression pending | The pre-reinstall documentation audit found the Windows README still directed users to generic `claude`, contradicting the native handoff and reproducing DOG2-009 when a stale shim precedes the working package | The Windows quick start now tells users to run the exact native command emitted by the installer, with a static regression forbidding the stale generic instruction; exact full gates and clean live rerun remain required |
| DOG2-011 | medium | test-orchestration/hosted-runner contention | fixed; candidate-wide regression pending | Two identical Ubuntu hosted retries reported 102.51 ms and 120.70 ms maxima for a 10-cycle file-I/O benchmark even though the same runs measured isolated write/read operations at 0.07–0.18 ms, the 10-cycle averages were 37–38 ms, no cron I/O product code changed, and the preceding exact candidates measured 0.69–1.18 ms maxima | CI keeps every `<100ms` assertion unchanged, excludes this wall-clock benchmark from the parallel full-suite worker pool, then runs the complete 17-test file in a separate single-worker process; a local exact standalone run passed and ten isolated P-4 reproductions measured 0.38–0.48 ms maxima; exact three-OS CI remains required |
| DOG2-012 | critical | product/install/handoff/workspace | fixed; candidate-wide regression pending | Literal execution of the printed native command proved Claude's positional argument is a prompt, not a working-directory selector: Claude booted successfully in the Windows profile home and canonical `/onboarding` could not run against the installed repository | Every installer handoff now changes into the repository before launching Claude (`Set-Location -LiteralPath ...; & <native>` on Windows, `cd ... && claude` on POSIX); exact output regressions cover both shells, the macOS README is corrected, and clean live reinstall/literal `/onboarding` remain required |
| DOG2-013 | medium | test-orchestration/Windows process contention | fixed; candidate-wide regression pending | The exact Windows job timed out one real `restrictSecretFile` PowerShell 5.1 child at its unchanged 10-second contract while 2,354 tests passed; the identical test took 3.59–5.69 seconds in the prior three green Windows runs and no ACL product code changed | Windows CI excludes only this file from the parallel worker pool and runs all seven unchanged ACL tests in a separate single-worker process; macOS/Linux retain the normal suite, the timeout is not inflated, and exact three-OS CI remains required |

## Gate A baseline evidence

- Baseline commit: `af7515af` plus only this untracked ledger; typecheck and
  build passed.
- Full Vitest baseline: 150 files passed, 1 file failed, 1 skipped; 2,344 tests
  passed, 1 failed, 5 skipped.
- The single failure reproduced focused: OpenCode expected its `opencode`
  binary but received `claude`. Classification: product/runtime dispatch,
  DOG2-003—not flake, environment, or invalid expectation.
- Narrow shared fix now respects runtime `getBinaryName()` while retaining
  Claude command-prefix/profile preparation only for the base Claude command.
  Adjacent verification passed: 5 files, 76 tests.
- Dashboard baseline checks passed: `npx tsc --noEmit` and `npm run build`.
  Existing Next.js workspace-root, middleware, dynamic-spawn, and viewport
  warnings were classified as unrelated/non-functional for this run.
- `bash tests/leak-guard.test.sh` passed before integration.
- Gate B implementation commits through `ca28afaa` contain no in-scope
  `implementation-pending` disposition. Focused installer/core-install tests
  passed 20/20; canonical root routing passed 5/5 plus the pre-existing root
  route contract; managed onboarding and adjacent template suites passed
  111/111; root typecheck/build passed after each implementation stream.
- Candidate-wide rerun remains Gate C work after all bounded implementation
  streams integrate.
- Exact candidate `e179d862` passed the full local suite (155 files passed,
  1 skipped; 2,375 tests passed, 5 skipped), root typecheck/build, dashboard
  typecheck/build, leak guard, tree leak guard, diff check, and targeted added-line
  secret scan. Its GitHub Actions build/typecheck jobs passed on Ubuntu, macOS,
  and Windows; dashboard and the Ubuntu/macOS unit jobs also passed.
- Windows unit CI at `e179d862` failed in eight files. Triage classified one
  production security/ACL compatibility defect (DOG2-004) and three bounded
  test-contract defects (DOG2-005 through DOG2-007). The integrated local
  repair run passes all eight affected files (96 tests), root typecheck/build,
  and diff check. A new exact three-OS CI candidate is required before Gate C
  can close or the VM can be mutated.

## Candidate acceptance evidence

Pending until Gates C–G.
