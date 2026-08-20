# Managed Onboarding: Native Windows Operations

This is an execution reference for the shared managed-agent onboarding
protocol. It does not replace, reorder, or duplicate any onboarding questions.
Read the role's `ONBOARDING.md` for the conversation and use this reference only
to translate its operational steps when `node -p "process.platform"` returns
`win32`.

## Rules

- Use harness file tools whenever they are available.
- Otherwise use PowerShell, Windows paths, and the cross-platform `cortextos`
  Node CLI. Do not require WSL, Git Bash, Bash, POSIX utilities, symlink
  privileges, or Developer Mode.
- Never ask the user to translate a shell command or edit Cortext state by hand.
- Keep the shared Telegram pacing: ask exactly one onboarding question that
  requires exactly one answer, send it in exactly one outbound message, then
  **END YOUR TURN**. Never combine multiple questions, multi-part questions, or
  independent requested answers. Perform no more tool calls until a new inbound
  reply arrives.

## Paths and files

Build native paths rather than concatenating `/` separators:

```powershell
$stateDir = Join-Path $env:CTX_ROOT (Join-Path 'state' $env:CTX_AGENT_NAME)
$agentDir = $env:CTX_AGENT_DIR
$orgContext = Join-Path $env:CTX_FRAMEWORK_ROOT (Join-Path 'orgs' (Join-Path $env:CTX_ORG 'context.json'))
```

Read and write JSON with harness JSON/file tools when possible. The PowerShell
fallback for a read is `Get-Content -LiteralPath $path -Raw |
ConvertFrom-Json`. Preserve unknown fields when updating an existing file; do
not reconstruct the document from a partial schema.

Create directories and the completion marker natively, only after every
required onboarding outcome is complete:

```powershell
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
New-Item -ItemType File -Path (Join-Path $stateDir '.onboarded') -Force | Out-Null
```

Do not create `.onboarded` early. After interruption, inspect the native files
and resume from the earliest unanswered or incomplete item.

## Cortext CLI and team discovery

Invoke Cortext directly from PowerShell. Do not wrap it in Bash:

```powershell
cortextos bus read-all-heartbeats
cortextos list-agents
cortextos status
```

Use the CLI response for team discovery rather than translating `ls`, `grep`,
or `sed` pipelines. Use harness file tools to inspect the state directory only
when the CLI has no applicable operation.

## Persistent crons

Create recurring managed-agent work through the Cortext bus:

```powershell
cortextos bus add-cron $env:CTX_AGENT_NAME heartbeat 6h "Read HEARTBEAT.md and follow its instructions."
cortextos bus add-cron $env:CTX_AGENT_NAME daily-report "0 9 * * 1-5" "Generate and send the daily report."
```

The daemon-owned source of truth is
`$CTX_ROOT\state\<agent>\crons.json`. Do not hand-edit it, use `/loop`, create a
Windows Scheduled Task for an agent cron, or store cron definitions in
`config.json`.

## Telegram turn boundary

Use one bus call for the one permitted outbound onboarding message:

```powershell
cortextos bus send-telegram $env:CTX_TELEGRAM_CHAT_ID "<one onboarding question requiring one answer>"
```

After that command succeeds, **END YOUR TURN** immediately. On the next inbound
message, record the answer and continue from the earliest unanswered item.
