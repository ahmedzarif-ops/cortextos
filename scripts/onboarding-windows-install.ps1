$ErrorActionPreference = 'Stop'

function Invoke-NativeStage {
  param(
    [Parameter(Mandatory = $true)][string]$Stage,
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$ArgumentList
  )

  & $FilePath @ArgumentList
  if ($LASTEXITCODE -ne 0) {
    throw "$Stage failed with exit code $LASTEXITCODE"
  }
}

$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Push-Location -LiteralPath $repositoryRoot
try {
  $artifactPresent = Test-Path -LiteralPath '.\dist\cli.js'
  Write-Output "Build artifact present before verification: $artifactPresent"

  Invoke-NativeStage 'Root dependency installation' 'npm.cmd' @('ci')

  Push-Location -LiteralPath (Join-Path $repositoryRoot 'dashboard')
  try {
    Invoke-NativeStage 'Dashboard dependency installation' 'npm.cmd' @('ci')
  } finally {
    Pop-Location
  }

  Invoke-NativeStage 'Full test suite' 'npm.cmd' @('test')
  Invoke-NativeStage 'CLI build' 'npm.cmd' @('run', 'build')
  Invoke-NativeStage 'Core state installation' 'node.exe' @('.\dist\cli.js', 'install')
} finally {
  Pop-Location
}
