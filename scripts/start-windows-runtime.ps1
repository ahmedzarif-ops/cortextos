# Native Windows supervised-runtime bootstrap.
#
# This script is intentionally invoked with literal arguments from the Windows
# onboarding reference. It keeps PowerShell variables inside a real .ps1 file,
# where Claude Code's Bash-labelled tool surface cannot expand or corrupt them.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstanceId,
    [Parameter(Mandatory = $true)]
    [string]$OrgName,
    [string]$FrameworkRoot = (Get-Location).Path
)

$ErrorActionPreference = 'Stop'

if ($InstanceId -notmatch '^[A-Za-z0-9._-]+$') {
    throw 'InstanceId may contain only letters, numbers, dots, underscores, and hyphens.'
}
if ($OrgName -notmatch '^[a-z0-9_-]+$') {
    throw 'OrgName may contain only lowercase letters, numbers, underscores, and hyphens.'
}

$FrameworkRoot = [System.IO.Path]::GetFullPath($FrameworkRoot)
$UserProfile = [Environment]::GetFolderPath('UserProfile')
$CtxRoot = Join-Path (Join-Path $UserProfile '.cortextos') $InstanceId
$Pm2Home = if ($InstanceId -eq 'default') {
    Join-Path $UserProfile '.pm2'
} else {
    Join-Path $UserProfile ('.pm2-' + $InstanceId)
}
$EcosystemPath = Join-Path $FrameworkRoot ('ecosystem.' + $InstanceId + '.config.js')
$CliPath = Join-Path $FrameworkRoot 'dist\cli.js'

if (-not (Test-Path -LiteralPath $CliPath -PathType Leaf)) {
    throw "Built Cortext CLI not found. Run the Windows install stage first."
}

$node = Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1
$pm2 = Get-Command pm2.cmd -CommandType Application -ErrorAction Stop | Select-Object -First 1

$env:CTX_INSTANCE_ID = $InstanceId
$env:CTX_ROOT = $CtxRoot
$env:CTX_FRAMEWORK_ROOT = $FrameworkRoot
$env:CTX_PROJECT_ROOT = $FrameworkRoot
$env:CTX_ORG = $OrgName
$env:PM2_HOME = $Pm2Home

& $node.Source $CliPath ecosystem --instance $InstanceId --org $OrgName --output $EcosystemPath --dashboard-host 127.0.0.1
if ($LASTEXITCODE -ne 0) { throw "Cortext ecosystem generation failed with exit code $LASTEXITCODE." }

& $pm2.Source start $EcosystemPath
if ($LASTEXITCODE -ne 0) { throw "PM2 start failed with exit code $LASTEXITCODE." }

& $pm2.Source save
if ($LASTEXITCODE -ne 0) { throw "PM2 save failed with exit code $LASTEXITCODE." }

[pscustomobject]@{
    instanceId = $InstanceId
    processNames = @(
        if ($InstanceId -eq 'default') { 'cortextos-daemon'; 'cortextos-dashboard' }
        else { "cortextos-daemon-$InstanceId"; "cortextos-dashboard-$InstanceId" }
    )
    loopbackDashboard = $true
    pm2Saved = $true
} | ConvertTo-Json -Compress
