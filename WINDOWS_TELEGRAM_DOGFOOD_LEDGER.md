# Windows Telegram dogfood ledger

Run ID: `windows-dogfood-20260819`
Integration branch: `codex/windows-native-install-dogfood-20260819`
Starting/tested commit: `4bb6847362eda5e4c590656ce9cdb551d4141b9c`
VM: secured Azure Windows host (identifiers intentionally omitted)

Attribution values:

- `product`: inherent Cortext Windows code, documentation, or supported flow;
- `environment`: Azure/Windows image, network, sizing, security policy, or preinstalled state;
- `orchestration`: observer automation, SSH/session handling, concurrency, or fault injection;
- `external`: Telegram/model provider behavior outside Cortext control;
- `unclassified`: insufficient evidence; must not affect readiness until reproduced.

| ID | Severity | Attribution | Status | Observation | Normal-user oracle / evidence |
|---|---|---|---|---|---|
| DOG-001 | critical | product | fix implemented; live gate pending | The root zero-to-running onboarding command and packaged first-boot instructions were Unix-first on a native Windows host | The native-host contracts, PowerShell flows, Windows persistence path, and deterministic portability regressions are now implemented. A fresh clean-install and real first-boot conversation must still pass before closure; tracked as WIN-036. |
| DOG-006 | high | product | fix implemented; live gate pending | The nominally cross-platform `cortextos setup` wizard was not a safe drop-in backend for root onboarding | Token input is now masked and excluded from child argv, Telegram discovery long-polls in-process, `ALLOWED_USER` records the private sender, competing readline/ConPTY ownership is avoided, and Windows PM2 runs through ComSpec. Fresh Windows wizard/PTY validation remains required. |
| DOG-007 | medium | product | reproduced; fix implemented; live gate pending | Successful native Windows install printed Unix-oriented handoff text | The clean PowerShell 5.1 run printed `cat` and a chained `cortextos ecosystem && pm2 ...` command, plus `cortextos start` still recommended the obsolete third-party Windows startup shim. Handoff text now uses editor-neutral credential guidance, separate commands, and the repository Task Scheduler helper. |
| DOG-002 | low | orchestration | resolved | A detached SSH-driven dashboard `npm ci` remained alive while the observer mistakenly launched a retry, producing `ENOTEMPTY` and preventing cleanup | Captured parent/child PIDs proved two observer operations overlapped. After terminating only the captured install tree, removing only disposable `dashboard/node_modules`, and running one attached `npm ci`, the Next entry existed and the lockfile was unchanged. Do not attribute to Cortext unless a single foreground user run reproduces it. |
| DOG-003 | high | product | fix implemented; instance mitigated; live gate pending | Scaffolded agent `.env` files retained broad inherited Windows ACL entries because the product relied on `chmod(0600)`, which does not establish a Windows ACL boundary | All product secret writers now use a shared fail-closed permission adapter: mode `0600` on Unix and an owner/SYSTEM-only ACL on Windows. Local deterministic regressions pass; clean Windows ACL inspection remains required before closure as WIN-037. |
| DOG-004 | info | external/user checkpoint | waiting | Both temporary bot tokens validate and have no webhooks, but Telegram has returned no inbound updates yet | User must send `/start` and a unique greeting to each bot before CHAT_ID/ALLOWED_USER can be derived and live pollers can start. |
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
