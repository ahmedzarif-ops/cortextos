# Windows-native runner bug ledger

Run ID: `win-native-20260819-0301`

Starting commit: `34f788b655a86e572161955eb15ed0ad0f153266`

Baseline CI: [run 32216291826](https://github.com/grandamenium/cortextos/actions/runs/32216291826)

Statuses: `new`, `reproduced`, `test-added`, `fixed`, `verified`, `deferred`, `not-a-bug`.

| ID | Severity | Classification | Status | Symptom / scope | Expected evidence |
|---|---|---|---|---|---|
| WIN-001 | high | product/platform paths | fixed | Catalog, KB, dashboard sync, migrations, and agent state use POSIX-only path assumptions | Product code uses platform-neutral containment/routing; Windows and Unix tests pass |
| WIN-002 | medium | parser/test harness | fixed | CRLF/BOM skill/frontmatter files are rejected on Windows | Shared parser accepts LF/CRLF/BOM; malformed input still rejected |
| WIN-003 | high | product/IPC | fixed | Codex app-server lifecycle assumes Unix socket paths | Windows-native endpoint transports the same JSON-RPC/WebSocket contract; both OS families tested |
| WIN-004 | high | product/process lifecycle | fixed | OpenCode stale-process cleanup assumes POSIX signals and POSIX paths | Central process adapter proves graceful/forced cleanup on Windows and Unix |
| WIN-005 | medium | test harness/home | fixed | Tests redirect `HOME` while Windows `os.homedir()` uses `USERPROFILE` | Test isolation controls both; product home semantics remain native |
| WIN-006 | high | product/process lifecycle | fixed | Agent lifecycle marker/log path and crash-recovery assertions expose separator assumptions | Shared path construction and cross-platform lifecycle tests pass |
| WIN-007 | medium | test harness/CLI | fixed | CLI error-boundary tests invoke Unix executable layout | Platform-neutral Node/CLI invocation verifies clean exit contract |
| WIN-008 | medium | test harness/fault injection | fixed | chmod-based write-failure injection does not fail on Windows | Deterministic injected filesystem failure covers recovery without OS skip |
| WIN-009 | high | product/skills install | fixed | Codex skill links may require Windows Developer Mode | Directory junction/copy fallback installs skills without elevation and remains idempotent |
| WIN-010 | medium | product/diagnostics | fixed | Legacy lifecycle Git inspection tests fail under Windows environment/process semantics | Git subprocess adapter scrubs unsafe env and behaves identically across OSes |
| WIN-011 | high | behavioral/live runtime | new | cortextOS-managed Claude/Codex/OpenCode Windows lifecycle not yet proven | Timestamped live VM matrix through daemon, bus, native command, file, restart, and cron |
| WIN-012 | high | behavioral/persistence | new | PM2 resurrection and controlled Windows reboot not yet proven | Exact tested commit returns after cold resurrection/reboot without duplicate processes |
| WIN-013 | high | behavioral/messaging | new | Live external Telegram round trip lacks confirmed dedicated test credentials | Live authorized test succeeds, otherwise explicit UNVERIFIED plus deterministic transport evidence |
| WIN-014 | high | product/process lifecycle | fixed | Real Codex app-server can hang under Windows ConPTY with `AttachConsole failed` | Windows launches the headless protocol server without ConPTY; regression and live VM probe pass without leaked children |

## Adaptive notes

- Baseline: 18 failed files, 74 failed tests, 2,194 passed, 12 skipped on `windows-latest`; macOS and Ubuntu CI were green.
- Every fix must trigger adjacent probes described in the requirements document.
- Intermittent observations remain open until reproduced or explained with evidence.
- Never include VM IPs, usernames, tokens, chat IDs, device codes, private paths outside the isolated worktree, or raw environments.
