[CmdletBinding()]
param(
  [string]$UserHome = [Environment]::GetFolderPath('UserProfile')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($UserHome)) {
  throw 'Unable to resolve the current Windows user profile.'
}

$StateRoot = Join-Path $UserHome '.cortextos'
$DefaultEnabledAgents = Join-Path (Join-Path (Join-Path $StateRoot 'default') 'config') 'enabled-agents.json'
$UseDefault = $false

if (Test-Path -LiteralPath $DefaultEnabledAgents -PathType Leaf) {
  try {
    $EnabledAgents = Get-Content -LiteralPath $DefaultEnabledAgents -Raw | ConvertFrom-Json
    $UseDefault = $EnabledAgents -is [PSCustomObject] -and @($EnabledAgents.PSObject.Properties).Count -eq 0
  } catch {
    $UseDefault = $false
  }
}

if ($UseDefault) {
  $InstanceId = 'default'
} else {
  $InstanceId = $null
  for ($Index = 1; $Index -le 10000; $Index++) {
    $Candidate = 'cortextos' + $Index
    if (-not (Test-Path -LiteralPath (Join-Path $StateRoot $Candidate))) {
      $InstanceId = $Candidate
      break
    }
  }
  if (-not $InstanceId) {
    throw 'Unable to find an available CortextOS instance ID.'
  }
}

[PSCustomObject]@{ instanceId = $InstanceId } | ConvertTo-Json -Compress
