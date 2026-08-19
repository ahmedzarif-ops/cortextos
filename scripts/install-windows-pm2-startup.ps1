# install-windows-pm2-startup.ps1
#
# Native Windows replacement for `pm2 startup` — which is broken on Windows
# (no Unix init system) and the third-party shims (pm2-windows-startup,
# pm2-windows-service) require Visual Studio Build Tools or are abandoned.
#
# Registers an instance-scoped Scheduled Task that runs at user logon
# and executes `node <pm2-bin> resurrect`, which restarts every PM2 process
# captured by `pm2 save`. This is the same mechanism `pm2 startup` produces
# on macOS/Linux, just expressed via Windows Task Scheduler.
#
# Run once after `pm2 save`. Re-run is idempotent — Task Scheduler updates
# the exact task in place.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\install-windows-pm2-startup.ps1
#   # or, to remove:
#   powershell -ExecutionPolicy Bypass -File scripts\install-windows-pm2-startup.ps1 -Uninstall

[CmdletBinding()]
param(
    [switch]$Uninstall,
    [string]$TaskName,
    [string]$InstanceId,
    [string]$Pm2Home
)

$ErrorActionPreference = 'Stop'

if (-not $InstanceId) {
    $InstanceId = if ($env:CTX_INSTANCE_ID) { $env:CTX_INSTANCE_ID } else { 'default' }
}
if ($InstanceId -notmatch '^[A-Za-z0-9._-]+$') {
    throw 'InstanceId may contain only letters, numbers, dots, underscores, and hyphens.'
}
if (-not $TaskName) {
    # Preserve the original public task name for existing/default installs.
    $TaskName = if ($InstanceId -eq 'default') { 'PM2 Resurrect' } else { "cortextOS PM2 Resurrect ($InstanceId)" }
}
if (-not $Pm2Home) {
    $Pm2Home = if ($env:PM2_HOME) { $env:PM2_HOME } else { Join-Path $env:USERPROFILE '.pm2' }
}
$Pm2Home = [System.IO.Path]::GetFullPath($Pm2Home)

if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "[ok] Removed scheduled task: $TaskName"
    } else {
        Write-Host "[skip] No scheduled task named '$TaskName' is registered."
    }
    return
}

# Resolve node.exe — required to launch pm2's bin entry point.
$nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$node = if ($nodeCommand) { $nodeCommand.Source } else { $null }
if (-not $node) {
    Write-Error "node.exe not found on PATH. Install Node.js 20+ before running this script."
    exit 1
}

# Resolve pm2's bin entry point. PM2 installed via `npm install -g pm2`
# lives under %APPDATA%\npm\node_modules\pm2\bin\pm2 (no extension — it's
# a Node script). Prefer that over the .cmd shim so Task Scheduler runs
# node.exe directly (no extra cmd.exe in the process tree).
$pm2BinCandidates = @()
if ($env:APPDATA) {
    $pm2BinCandidates += Join-Path $env:APPDATA 'npm\node_modules\pm2\bin\pm2'
}
$pm2BinCandidates += Join-Path (Split-Path $node -Parent) 'node_modules\pm2\bin\pm2'
try {
    $npmRoot = (& npm.cmd root --global 2>$null | Select-Object -First 1).Trim()
    if ($npmRoot) {
        $pm2BinCandidates += Join-Path $npmRoot 'pm2\bin\pm2'
    }
} catch {
    # npm may be absent beside an embeddable/custom Node installation.
}
$pm2Bin = $pm2BinCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $pm2Bin) {
    Write-Error "Could not locate pm2 bin script. Install with: npm install -g pm2"
    exit 1
}

# Verify the user has run `pm2 save` at least once. Without a dump file,
# `pm2 resurrect` does nothing useful at logon.
$dumpFile = Join-Path $Pm2Home 'dump.pm2'
if (-not (Test-Path $dumpFile)) {
    Write-Warning "PM2 dump file not found at $dumpFile."
    Write-Warning "Run 'pm2 save' AFTER starting your processes, otherwise resurrect has nothing to restore."
}

# Restore the same PM2_HOME used at registration. EncodedCommand makes spaces
# and apostrophes in user paths unambiguous without a mutable launcher file.
function ConvertTo-SingleQuotedLiteral([string]$Value) {
    return "'" + $Value.Replace("'", "''") + "'"
}
$nodeLiteral = ConvertTo-SingleQuotedLiteral $node
$pm2BinLiteral = ConvertTo-SingleQuotedLiteral $pm2Bin
$pm2HomeLiteral = ConvertTo-SingleQuotedLiteral $Pm2Home
$actionSource = @"
`$ErrorActionPreference = 'Stop'
`$env:PM2_HOME = $pm2HomeLiteral
& $nodeLiteral $pm2BinLiteral resurrect
exit `$LASTEXITCODE
"@
$encodedAction = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($actionSource))
$powerShellExe = (Get-Command powershell.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$action = New-ScheduledTaskAction `
    -Execute $powerShellExe `
    -Argument "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand $encodedAction"

# Trigger at the current user's logon. AtLogon (not AtStartup) avoids needing
# admin rights / SYSTEM-level service config; Task Scheduler runs under your
# user, which is what PM2 expects (it stores state in %USERPROFILE%\.pm2).
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Hours 72) `
    -MultipleInstances IgnoreNew `
    -Hidden  # Hide the task and prevent its action from inheriting a console.
             # Without this, PM2 children (e.g. the dashboard "next dev") spawn
             # with a visible "next-server (vX)" terminal at logon. PM2's own
             # `windowsHide: true` is unreliable, so we hide the launcher.

# -Force replaces the exact instance-scoped task and makes re-runs idempotent
# without an unregister/register gap.
Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description "cortextOS ($InstanceId): revive PM2-managed daemon + dashboard at user logon. PM2_HOME=$Pm2Home" `
    -Force | Out-Null

Write-Host ""
Write-Host "[ok] Registered scheduled task: $TaskName"
Write-Host "      Trigger:   At logon ($env:USERDOMAIN\$env:USERNAME)"
Write-Host "      Instance:  $InstanceId"
Write-Host "      PM2_HOME:  $Pm2Home"
Write-Host "      Action:    powershell.exe (encoded): node pm2 resurrect"
Write-Host ""
Write-Host "Verify with:  Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
Write-Host "Test now:     Start-ScheduledTask -TaskName '$TaskName'"
Write-Host ""
Write-Host "TIP: set your Windows power plan to 'Never sleep' for true 24/7 operation."
