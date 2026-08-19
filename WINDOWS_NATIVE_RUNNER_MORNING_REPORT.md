# Windows-native runner morning report

Run ID: `win-native-20260819-0301`  
Branch: `codex/windows-native-runner`  
Starting commit: `34f788b655a86e572161955eb15ed0ad0f153266`  
Ending tested code commit: `3c1f256b32af039f247543878cc52a1622e867e0`

## 1. Outcome

**PARTIALLY READY.** The native Node.js runner, all three target harnesses, the bus, cron scheduler, PM2 recovery, and headless Windows reboot recovery passed production-like Azure Windows acceptance. Existing macOS and Linux behavior remains covered by the three-OS CI matrix.

This report does not claim unrestricted production readiness because a dedicated live Telegram bot was not provided, the dashboard dependency audit still has high/critical advisories, and non-default `install` still performs a host-global `npm link`. Those are explicit residuals rather than inferred passes.

## 2. Branch and commits

Only `codex/windows-native-runner` was changed and pushed. `main` was not modified, merged, or pushed, and no pull request was opened.

Tested implementation commits after the starting SHA (report-only commits are intentionally omitted):

```text
fa86b55a fix: make filesystem behavior cross-platform
dbd7bc6d fix: add native Windows runtime adapters
96f126bf feat: harden native Windows install diagnostics
f8cfc289 test: close remaining Windows lifecycle gaps
67fddcea test: await complete Codex live turn
a39e2323 fix: use native Git trust checks on Windows
1a6e68b8 fix: support bus-only Windows agent lifecycle
f9ba488b fix: compare Windows repository identity natively
1433ba9f fix: isolate Git for Windows helper paths
0c8455bd fix: scope Windows Git ownership trust
32e13e98 fix: bind Git roots across Windows junctions
ab5aed96 fix: resolve Windows PM2 persistence identity
f0a03b20 fix: close Windows PTY diagnostic handles
bdf258fe fix: close Windows PTY smoke workers
770fa3d7 fix: close live ConPTY smoke shell cleanly
58523d56 fix: isolate native PTY diagnostics
fe101adf fix: support loopback-only dashboard binding
b7495cfb fix: prepare dashboard credentials for PM2
409ea334 fix: accept BOM-prefixed agent configs
158451db fix: advance Claude first-run screens headlessly
e858a7da fix: parse cursor-controlled Claude prompts
7afa235c fix: distinguish Claude ready status from warnings
305d7d7a fix: prepare authenticated Claude profiles headlessly
773d1ba5 fix: preserve Claude OAuth in agent PTYs
1f929dee fix: support headless Windows startup persistence
2f61cb8f fix: tolerate current runtime readiness markers
776b919f test: ignore transient Git maintenance state
3c1f256b fix: preserve messages during runtime recovery
```

Net change before this report: 58 files, 2,550 insertions, and 492 deletions. The architecture remains one shared Node.js core with narrow seams for process trees, headless children, PTY diagnostics, filesystem links, executable discovery, IPC endpoints, and Windows persistence.

## 3. CI and deterministic tests

| Surface | Result | Evidence |
|---|---|---|
| Windows build/typecheck/full tests/Codex parity | **PASS** | Latest tested-code CI run below |
| macOS build/typecheck/full tests/Codex parity | **PASS** | Latest tested-code CI run below |
| Ubuntu build/typecheck/full tests/Codex parity | **PASS** | Latest tested-code CI run below |
| Dashboard build/typecheck | **PASS** | Latest tested-code CI run below |
| Local full Vitest suite | **PASS** | 146 files passed, 1 intentionally skipped; 2,325 tests passed, 5 skipped |
| Local root build/typecheck | **PASS** | Clean `tsup` build and `tsc --noEmit` |
| Local dashboard build/typecheck | **PASS** | Next production build and TypeScript completed |
| Git immutability flake stress | **PASS** | Targeted macOS-sensitive oracle passed 20 consecutive runs |

Latest tested-code CI: **PASS** — every Windows, macOS, Ubuntu, dashboard, full-suite, and Codex-parity job completed successfully in [run 32238843842](https://github.com/grandamenium/cortextos/actions/runs/32238843842).

The prior exact readiness commit passed the full matrix in [run 32238123802](https://github.com/grandamenium/cortextos/actions/runs/32238123802). An earlier run failed only because its test oracle raced Git's transient `.git/objects/maintenance.lock`; Windows and Ubuntu were green in that run. The corrected oracle then passed the complete matrix in [run 32238475947](https://github.com/grandamenium/cortextos/actions/runs/32238475947).

## 4. Live Azure Windows matrix

All tests used a disposable run-specific instance and repository checkout. The three agents ran concurrently under the CortextOS daemon, not as direct harness-only probes.

| Runtime | Boot | Message | Native PowerShell | File R/W | Signed correlated reply | Cron | Restart/disable | Forced-exit recovery |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Claude Code | **PASS** | **PASS** | **PASS** | **PASS** | **PASS** | **PASS** | **PASS** | **PASS** |
| Codex app-server | **PASS** | **PASS** | **PASS** | **PASS** | **PASS** | **PASS** | **PASS** | **PASS** |
| OpenCode | **PASS** | **PASS** | **PASS** | **PASS** | **PASS** | **PASS** | **PASS** | **PASS** |

Additional live results:

- **PASS:** all three `.onboarded` markers were created only after behavioral onboarding completion.
- **PASS:** Claude executed the harmless native PowerShell/file proof and returned the exact unique token.
- **PASS:** Codex and OpenCode executed equivalent native file proofs and returned signed replies.
- **PASS:** two back-to-back Claude messages preserved order and `reply_to` correlation.
- **PASS:** Codex restart changed the child PID and returned a post-restart signed reply.
- **PASS:** OpenCode disable/re-enable killed the old process, created a new one, and returned a post-enable signed reply.
- **PASS:** controlled process-tree exits recovered Claude, Codex, and OpenCode; each returned a signed post-recovery result.
- **PASS:** runtime readiness-marker changes were detected without the former false 30-second timeout.
- **PASS:** a message queued during OpenCode crash replacement remained durable until the new TUI was ready, then produced the exact signed correlated reply.
- **PASS:** one disposable cron per runtime fired through the live agent, produced a signed reply, survived daemon/PM2 restart, and was removed afterward.
- **PASS:** cold `pm2 kill`/`resurrect` restored exactly one daemon and one dashboard plus all enabled agents.
- **PASS:** a controlled Windows reboot ran the S4U boot task after OS startup, restored exactly one daemon/dashboard, restored all three agents, kept the dashboard on `127.0.0.1`, and returned a signed post-reboot agent reply without manual resurrection.
- **PASS:** the supported install and doctor commands returned exit code 0 without the prior lingering ConPTY worker.
- **PASS:** dashboard HTTP reached the expected authentication redirect instead of the prior credential-related HTTP 500.
- **PASS:** the final simultaneous three-runtime soak returned all three exact signed correlated replies in 6.5 seconds with no new anomaly.

## 5. Bugs fixed

The complete 35-item evidence ledger is in `WINDOWS_NATIVE_RUNNER_BUG_LEDGER.md`. The main root-cause groups were:

| Area | Root cause | Durable correction |
|---|---|---|
| Paths and parsing | POSIX separators, LF-only fixtures, BOM-prefixed JSON, and junction aliases | Native containment/path APIs, BOM/CRLF-tolerant parsing, and drive/UNC/traversal tests |
| Windows process lifecycle | POSIX signals/PIDs and npm shims did not model ConPTY descendant trees | Central process-tree adapter, native executable resolution, death confirmation, and bounded headless child processes |
| Codex IPC | Unix sockets and ConPTY were assumed | Unix socket remains on Unix; Windows uses loopback WebSocket with a strict loopback endpoint parser and headless app-server child |
| OpenCode lifecycle | Stale process trees and isolated auth state were incomplete | Native executable selection, `taskkill /T` recovery, credential seeding without overwrite/logging, and multi-version TUI markers |
| Claude lifecycle | First-run screens, ANSI cursor text, profile readiness, and OAuth env filtering disagreed with current Windows Claude | Prompt-specific headless gates, complete CSI/OSC stripping, safe profile merge after positive auth status, and OAuth allowlisting |
| Diagnostics/install | PTY smoke workers retained the CLI; doctor conflated executable and auth readiness | Isolated diagnostic child, separate bounded probes, truthful remediation, and no auth metadata output |
| Dashboard | Host binding and generated credentials were not carried into PM2 | Explicit host option, loopback VPS bind, permission-restricted `.env.local`, and direct Node Next entry |
| Persistence | PM2 discovery/identity assumptions and interactive AtLogOn did not survive a headless VPS reboot | Idempotent scoped Task Scheduler helper plus explicit limited S4U/AtStartup mode; desktop Logon behavior remains default |
| Readiness/recovery | Changed TUI sentinels caused false timeouts; replacement PTYs could drain messages before ready | Version-tolerant explicit markers, Claude-only guarded fallback, and queue/inbox preservation across replacement bootstrap |
| CI oracle | Test recursively inspected Git's asynchronously changing maintenance locks | Product-tree immutability remains strict while private `.git` implementation state is excluded |

No product defect was hidden with an unjustified Windows skip.

## 6. Unverified and deferred

| Item | Result | Exact next action |
|---|---|---|
| Dedicated external Telegram round trip | **UNVERIFIED** | Supply one isolated test bot token/chat identity per concurrently polled bot, then run exact-once receive/reply, unauthorized-sender, restart, and 409-conflict probes. No personal/production bot was repurposed. |
| Dashboard dependency audit | **FAIL** for unrestricted production claim | Triage and upgrade `next-auth`, `next`, and `marked` in a dedicated security branch; current audit reports 19 production advisories, including 2 critical and 11 high. Keep dashboard loopback-only until resolved. |
| Fully isolated non-default install | **UNVERIFIED** | Add an explicit install mode that does not use host-global `npm link` and relocates optional user-global assets. |

## 7. Security and cleanup

- **PASS:** no secrets, auth stores, device codes, private keys, bot tokens, chat IDs, or full environments were committed or included in this report.
- **PASS:** no Azure resources were created/resized and no firewall/NSG rules were opened or weakened.
- **PASS:** effective inbound owner rules for SSH and RDP are source-restricted; there is no broad Internet allow rule for either port.
- **PASS:** the dashboard listens only on `127.0.0.1`; its port is not exposed through Azure NSG.
- **PASS:** S4U startup persistence stores no Windows password and runs at limited privilege.
- **PASS:** disposable acceptance crons were removed and PM2 state was saved afterward.
- **PASS:** all fault injection targeted only run-scoped agent process trees and disposable files.
- **PASS:** final cleanup uninstalled the run-scoped startup task, deleted the two scoped PM2 apps, saved the empty scoped PM2 state, stopped its PM2 daemon, confirmed all three captured agent processes were gone without forced cleanup, and confirmed zero dashboard listeners.

The disposable repository/state remains on disk as diagnostic evidence, but nothing in the run-scoped instance is running or registered to resurrect.

## 8. Compatibility

- Existing command names, default instance/process names, macOS configuration files, and normal user workflow were preserved.
- Default Windows desktop persistence remains AtLogon; headless VPS users opt into `-TriggerMode Startup`.
- Unix Codex retains its Unix-domain socket behavior; only Windows selects native loopback WebSocket IPC.
- Unix process shutdown remains `SIGTERM` then `SIGKILL`; Windows selects `taskkill` tree semantics behind the same adapter.
- The full macOS and Ubuntu suites, builds, CLI contracts, and Codex parity tests pass in hosted CI.

## 9. Recommended next steps

1. Run the dedicated Telegram acceptance matrix when isolated bot credentials are available.
2. Fix the dashboard dependency audit before exposing the dashboard beyond loopback.
3. Add a no-global-link isolated install option, then validate a second clean Windows account.
4. Review the branch and open a PR only when requested; do not merge it blindly because the change set intentionally contains broad Windows portability coverage.
5. Add a Linux VPS live smoke environment later; hosted Ubuntu CI already proves deterministic parity, but a real Linux service-reboot probe would mirror the new Windows evidence.
