# Root onboarding: native Windows operations

This is the Windows execution reference for `.claude/commands/onboarding.md`.
It supplies operating-system mechanics only. Keep the questions, explanations,
verbatim text, ordering, and completion gates in the canonical onboarding file.

Use these operations only after `node -p "process.platform"` returns `win32`.
Run shell commands in native PowerShell from the repository root unless a step
says otherwise. These commands are complete; do not ask the user to translate a
macOS/Linux example. Never invoke WSL or Git Bash.

If a Windows command or verification fails, remain on this Windows route while
diagnosing it. Use the harness Read/JSON tools and the native PowerShell commands
in this reference. Never fall back to Bash or POSIX utilities such as `cat`,
`head`, `grep`, `find`, `ls`, or shell redirection to inspect the failure.

Retain the selected instance ID, organization, repository root, and agent names
in onboarding state. Put literal values into every CLI call; do not assume a
PowerShell variable survives a later agent-tool invocation.

## W1. Dependency and authentication checks

Core prerequisites are Node.js 20+, npm, Claude Code, and PM2. `jq`, Unix shell
utilities, Python, and compiler tooling are not core runtime prerequisites.
Python is optional and is checked only if the user enables the knowledge base.

The platform was already detected before this reference was loaded; do not run
`node -p "process.platform"` again. Claude Code may label its terminal surface
`Bash` on Windows, so this block explicitly enters native PowerShell. Submit the
exact line once without rewriting it, joining it with another command, or
substituting `&&` or another shell operator:

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -Command "node --version; npm --version; pm2 --version"
```

Successful execution of this active `/onboarding` session proves that Claude
Code is executable and authenticated for the current Windows account. The
public installer also checks both immediately before printing the native launch
handoff. Do not spawn `claude auth status`, bare `claude`, or `doctor` as a
nested child of this Claude session: Claude's child-tool context can report a
false unauthenticated result even though the same account passes immediately
outside the session. Validate daemon authentication after boot with the
readiness and doctor checks in W8.

If Node, npm, or PM2 is unavailable, identify it without producing a PowerShell
error:

```powershell
Get-Command node,npm,pm2 -ErrorAction SilentlyContinue | Select-Object Name,Source
```

Install missing Node.js with the user's available native package manager:

```powershell
winget install --id OpenJS.NodeJS.LTS --exact
```

Install missing PM2 after Node/npm work:

```powershell
npm install --global pm2
```

If this onboarding session itself cannot execute authenticated work, stop and
have the user authenticate in this same Windows account through the native
handoff emitted by the public installer. Never copy authentication from another
user, and never claim readiness from the existence of an unrelated
`claude.cmd` or `claude.ps1` shim.

## W2. Repository install and instance state

The repository verification is one fail-closed native operation. Do not inspect
artifacts or dependency directories first, do not skip a stage because one is
already present, and do not split or rewrite this command. Submit this exact
line once; the checked-in script installs both locked dependency trees before
the full suite, then tests, builds, and installs core state in order:

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ./scripts/onboarding-windows-install.ps1
```

Select the instance with one fail-closed native operation. Submit this exact
line once without rewriting it or separately listing profile state:

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ./scripts/onboarding-windows-select-instance.ps1
```

Read the `instanceId` field from its small JSON result and retain that literal
value in onboarding state. The checked-in selector reuses `default` only when
`config\enabled-agents.json` exists and is an empty JSON object; otherwise it
returns the first absent `cortextosN` directory. Do not reimplement or verify
this decision with shell commands, `$env:USERPROFILE`, path text parsing, or a
second profile inspection.

Detect the timezone with one fail-closed native operation when canonical Phase
4 reaches its timezone question. Submit this exact line once; do not run the
canonical `node -p` example directly through Claude Code's Bash-labeled command
surface:

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ./scripts/onboarding-windows-timezone.ps1
```

Read the `timezone` field from its small JSON result, show that detected IANA
timezone to the user, and retain the confirmed literal value in onboarding
state. Do not reimplement or verify this probe through another shell command.

All Cortext CLI calls are native Node commands. Claude Code submits these
through its Bash-labeled terminal surface even on Windows, so every
repository-relative executable argument must use forward slashes. Backslashes
are shell escapes there and must not appear in a submitted command. Use these
explicit literal forms without rewriting them:

```powershell
node ./dist/cli.js init '<org-name>' --instance '<instance-id>'
node ./dist/cli.js add-agent '<agent-name>' --template orchestrator --org '<org-name>' --instance '<instance-id>'
node ./dist/cli.js enable '<agent-name>' --org '<org-name>' --instance '<instance-id>'
```

Create and update `context.json`, `goals.json`, `config.json`, `secrets.env`,
and `enabled-agents.json` with the harness file/JSON tools. Use Windows paths
returned by Node/path APIs. Do not compose them by replacing path separators.
Preserve existing ACLs and never print secret values. W3 is the only supported
route for the agent `.env` and Telegram authorization.

## W3. Telegram discovery

Create the non-secret agent scaffold first and require this command to succeed:

```powershell
node ./dist/cli.js add-agent <orchestrator-name> --template orchestrator --org <org-name> --instance <instance-id>
```

Have the normal user open a separate native PowerShell terminal at the
repository root and run the Windows safe onboarding command:

```powershell
node ./dist/cli.js telegram onboard <orchestrator-name> --org <org-name> --instance <instance-id>
```

The command prompts for the token with masked input, tells the user to send
`hi`, starts long polling immediately without flushing the update, requires the
existing agent scaffold, and stores the credential plus discovered chat and
sender authorization internally with the required Windows ACL. It prints only
safe progress and completion: never the token, Telegram API URI, agent
environment path or contents, chat ID, or sender ID.

The onboarding agent must never ask the user to paste the token into the agent
conversation, place it in an argument, or reproduce a Telegram HTTP/polling
block. It must never use Read, Write, or Edit on the agent `.env`. Wait for the
separate terminal to finish and continue only after it reports safe completion.

Dogfood automation may instead run the same command with
`--use-existing-token`, but only after the credential has been securely
pre-provisioned for that exact agent. Never offer this flag to a normal user or
use it to bypass the masked prompt with an untrusted credential source.

## W4. Dashboard install, build, and browser handoff

```powershell
Push-Location -LiteralPath (Join-Path (Get-Location).Path 'dashboard')
npm ci
npm run build
Pop-Location
```

Keep the dashboard supervised by the generated PM2 ecosystem; do not start a
separate development server. Materialize credentials through the supported
ecosystem generator. Keep the dashboard on loopback unless the user explicitly
configures a secure reverse proxy later.

After readiness is proven on a desktop:

```powershell
Start-Process 'http://localhost:3000'
```

On a headless VPS, do not open a public firewall or cloud security-group port.
Keep `127.0.0.1:3000` and use the existing authenticated administration tunnel.

## W5. Optional knowledge base

Python and knowledge-base dependencies are optional and the native Windows core
install deliberately defers them. When the user opts in, verify Python 3, create
the virtual environment, install its locked requirements, and then run the Node
bus contract. Set the Gemini key with the harness Edit tool, never a command
line.

```powershell
python -m venv ./knowledge-base/venv
./knowledge-base/venv/Scripts/python.exe -m pip install --requirement ./knowledge-base/scripts/requirements.txt
```

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ./scripts/onboarding-windows-kb-ingest.ps1 -InstanceId '<instance-id>' -OrgName '<org-name>' -FilePath '<native-file-path>'
```

Run one bounded query through `node ./dist/cli.js bus` as defined by the current
CLI help. If Python or optional dependencies are missing, give the exact native
remediation and let the user defer the knowledge base without failing the core
agent runtime.

## W6. Generate and start the supervised system

Generate and start the ecosystem through the checked-in native helper. Keep the
selected values literal. The helper owns all PowerShell variables internally,
binds the dashboard to loopback, uses the instance-scoped PM2 home, and fails
closed before saving partial PM2 state:

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ./scripts/start-windows-runtime.ps1 -InstanceId '<instance-id>' -OrgName '<org-name>'
```

Never rewrite this as a `powershell.exe -Command` string or reproduce its
PowerShell variables through Claude Code's Bash-labelled command surface.
Do not treat PM2 `online` as agent readiness. Continue through W8.

## W7. Native reboot persistence

Do not use PM2's Unix startup generator on Windows. First detect the correct
native trigger with this checked-in probe:

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ./scripts/onboarding-windows-trigger-mode.ps1
```

Read the `triggerMode` field. Use its literal value in the registration command;
do not reimplement the probe or use a PowerShell variable. Run this exact shape
twice and verify one instance-scoped task is updated rather than duplicated:

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ./scripts/install-windows-pm2-startup.ps1 -InstanceId '<instance-id>' -TriggerMode '<Logon-or-Startup>'
```

The helper must not store a Windows password. It restores only allowlisted,
user-scoped provider authentication into the scheduled process without printing
or embedding credential values in its action, logs, or arguments.

## W8. Readiness, diagnostics, logs, and port health

```powershell
pm2 list
node ./dist/cli.js doctor --instance '<instance-id>'
node ./dist/cli.js status --instance '<instance-id>'
Get-NetTCPConnection -State Listen -LocalPort 3000 -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,OwningProcess
```

Require the daemon, dashboard, Telegram poller, and enabled agent runtime to
cross their actual readiness gates. Confirm the dashboard listener is loopback.
On Windows, doctor and the managed PTY restore missing allowlisted provider
credentials from the current account's persistent user environment because
Claude Code intentionally removes its OAuth token from tool-child processes.
They never print or persist the restored values. An authenticated outer
`/onboarding` session alone is not proof that the daemon-launched runtime is
authenticated; require the live runtime readiness result.
Read bounded diagnostics without revealing `.env` or token-bearing URLs:

```powershell
pm2 logs cortextos-daemon --lines 30 --nostream
Get-Content -LiteralPath '<instance-root>\logs\<agent>\stdout.log' -Tail 50
Get-Content -LiteralPath '<instance-root>\logs\<agent>\fast-checker.log' -Tail 50
```

Use the actual instance-scoped PM2 process name if it differs. Verify runtime
authentication with its native status command, but never reauthenticate or
print credential files during routine diagnosis.

## W9. Windows completion and troubleshooting overlay

At completion, report whether the single scoped scheduled task uses Logon or
Startup. Do not show privileged macOS/Linux persistence instructions.

For Telegram failure, run doctor/status, inspect bounded agent logs, and ensure
only one poller owns the bot through redacted process diagnostics. Never inspect
the agent `.env`; rerun W3 if its safe command reports incomplete setup. For
daemon failure, verify `./dist/daemon.js`, PM2 state, and enabled-agent JSON. For
dashboard failure, verify the loopback listener, generated
`dashboard\.env.local`, and supervised dashboard logs.
