# Windows Telegram dogfood ledger

Run ID: `windows-dogfood-20260819`
Integration branch: `codex/windows-native-install-dogfood-20260819`
Starting commit: `4bb6847362eda5e4c590656ce9cdb551d4141b9c`
Current live VM commit: `bbdd8f35` (paused before the recovery-notification and one-question onboarding fixes)
Current branch base: `3ff763ce` plus the locally verified DOG-011 change
VM: secured Azure Windows host (identifiers intentionally omitted)

Attribution values:

- `product`: inherent Cortext Windows code, documentation, or supported flow;
- `environment`: Azure/Windows image, network, sizing, security policy, or preinstalled state;
- `orchestration`: observer automation, SSH/session handling, concurrency, or fault injection;
- `external`: Telegram/model provider behavior outside Cortext control;
- `unclassified`: insufficient evidence; must not affect readiness until reproduced.

| ID | Severity | Attribution | Status | Observation | Normal-user oracle / evidence |
|---|---|---|---|---|---|
| DOG-001 | critical | product | clean install passed; first-boot completion pending | The root zero-to-running onboarding command and packaged first-boot instructions were Unix-first on a native Windows host | The native-host contracts, PowerShell flows, Windows persistence path, and deterministic portability regressions are implemented. A fresh Windows clone/install/scaffold passed without WSL or Bash. Live first-boot reached Telegram on Claude and Codex, but the full conversation is not complete; tracked as WIN-036. |
| DOG-006 | high | product | fix implemented; live gate pending | The nominally cross-platform `cortextos setup` wizard was not a safe drop-in backend for root onboarding | Token input is now masked and excluded from child argv, Telegram discovery long-polls in-process, `ALLOWED_USER` records the private sender, competing readline/ConPTY ownership is avoided, and Windows PM2 runs through ComSpec. Fresh Windows wizard/PTY validation remains required. |
| DOG-007 | medium | product | live verified | Successful native Windows install printed Unix-oriented handoff text | The clean PowerShell 5.1 run printed `cat` and a chained `cortextos ecosystem && pm2 ...` command, plus `cortextos start` still recommended the obsolete third-party Windows startup shim. Handoff text now uses editor-neutral credential guidance, separate commands, and the repository Task Scheduler helper; the corrected flow was used by the dogfood install. |
| DOG-008 | high | product | live verified | Claude crashes after headless Task Scheduler resurrection and doctor falsely reports it missing | The scheduled environment exposed the npm shim directory, and the adapter launched `claude.cmd`; its already quoted native path gained an additional cmd/ConPTY quoting layer and became an invalid filename. The shared native-executable resolver was deployed; Claude stayed running beyond the prior crash window and exchanged Telegram messages. |
| DOG-009 | low | environment/orchestration | explained; adapter live verified | PM2 children launched directly under Windows OpenSSH died when the SSH job closed | The headless VPS path must launch resurrection through Task Scheduler. The scoped helper registered twice as one limited-privilege task, launched successfully with result 0, and daemon/dashboard survived a new SSH connection. Desktop installs are not attributed this OpenSSH job behavior. |
| DOG-010 | medium | product | reproduced; fix implemented; live gate pending | Crash-loop notifications claimed Claude had recovered immediately before each next crash | `running` meant only that a child spawned, not that its runtime reached readiness. Recovery notifications now wait 30 seconds and require a running, bootstrapped process in the same crash generation, suppressing false recovery spam. |
| DOG-011 | high | product/behavior | reproduced; fix locally verified; not deployed | Claude dumped the first-boot questionnaire as several consecutive Telegram messages without waiting for answers | The generic agent protocol delayed its first explicit turn boundary until after multiple numbered prompts. Every shipped onboarding skill and primary role document now defines one question/one outbound message per turn, an immediate stop, and continuation only after a new inbound reply. Focused tests/typecheck/build pass; live rerun remains the closure gate. |
| DOG-012 | medium | product/behavior | observed; open | Claude used Bash-like command syntax while running on native Windows despite the new native-host rule | The harness executed the commands without asking the user to translate them, so this did not block the conversation. Resume testing must inspect whether the commands actually used a supported native path and add stronger shell-selection instructions or regression coverage if the behavior is reproducible. |
| DOG-002 | low | orchestration | resolved | A detached SSH-driven dashboard `npm ci` remained alive while the observer mistakenly launched a retry, producing `ENOTEMPTY` and preventing cleanup | Captured parent/child PIDs proved two observer operations overlapped. After terminating only the captured install tree, removing only disposable `dashboard/node_modules`, and running one attached `npm ci`, the Next entry existed and the lockfile was unchanged. Do not attribute to Cortext unless a single foreground user run reproduces it. |
| DOG-003 | high | product | live verified | Scaffolded agent `.env` files retained broad inherited Windows ACL entries because the product relied on `chmod(0600)`, which does not establish a Windows ACL boundary | All product secret writers use a shared fail-closed permission adapter: mode `0600` on Unix and an owner/SYSTEM-only ACL on Windows. Live inspection confirmed protected inheritance and access limited to the current Windows identity and LocalSystem on all dogfood secret files. |
| DOG-004 | info | external/user checkpoint | passed | Telegram credentials and private sender authorization were required before live polling could begin | Both tokens validated, webhooks were absent, inbound updates derived the private authorization, and both distinct bots exchanged messages with the intended agents. |
| DOG-005 | low | environment | observed | npm 11 warns that `esbuild` and `node-pty` lifecycle scripts are not covered by its allow-scripts policy | Clean root install still loaded `node-pty`, passed the native PTY smoke test, typechecked, and built. Treat as informational unless a supported clean machine cannot produce usable artifacts. |

## Passed setup evidence

- Fresh clone from current `upstream/main` plus all Windows branch commits; no reused checkout or dependency directory.
- Clone was clean at the recorded commit before initialization.
- Root `npm ci`, typecheck, build, native `node-pty` load, and cortextOS PTY smoke test passed.
- A new instance, org, Claude agent, and Codex agent were created through supported CLI commands.
- Claude and Codex bot identities are distinct, valid, webhook-free, and mapped one-to-one to their agent configuration.
- Tokens are absent from Git tracking/status and are not recorded in this ledger.

## Pending gates

- Derive and configure private chat/user authorization from live Telegram updates.
- Generate/start the isolated loopback PM2 ecosystem and scoped startup task.
- Complete real first-boot onboarding for Claude and Codex through Telegram.
- Fix and regress WIN-036 without relying on Bash/WSL/manual user translation.
- Run ordinary conversation, native PowerShell/file, ordering, chunking, lifecycle, cron, restart, cold resurrection, and reboot scenarios.
- Revoke both tokens and complete scoped cleanup.
