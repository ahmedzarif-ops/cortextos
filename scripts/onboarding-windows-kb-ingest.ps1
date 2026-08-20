[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstanceId,
    [Parameter(Mandatory = $true)]
    [string]$OrgName,
    [Parameter(Mandatory = $true)]
    [string]$FilePath,
    [string]$FrameworkRoot = (Get-Location).Path
)

$ErrorActionPreference = 'Stop'
if ($InstanceId -notmatch '^[A-Za-z0-9._-]+$') { throw 'Invalid InstanceId.' }
if ($OrgName -notmatch '^[a-z0-9_-]+$') { throw 'Invalid OrgName.' }

$FrameworkRoot = [System.IO.Path]::GetFullPath($FrameworkRoot)
$FilePath = [System.IO.Path]::GetFullPath($FilePath)
if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) { throw 'Knowledge-base input file not found.' }

$env:CTX_INSTANCE_ID = $InstanceId
$env:CTX_FRAMEWORK_ROOT = $FrameworkRoot
& node.exe (Join-Path $FrameworkRoot 'dist\cli.js') bus kb-ingest $FilePath --org $OrgName --scope shared
if ($LASTEXITCODE -ne 0) { throw "Knowledge-base ingest failed with exit code $LASTEXITCODE." }
