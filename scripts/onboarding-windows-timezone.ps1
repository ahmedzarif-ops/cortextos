Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Output = (& node.exe -p 'Intl.DateTimeFormat().resolvedOptions().timeZone' 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) {
  throw "Windows timezone detection failed with exit code $LASTEXITCODE"
}
if ([string]::IsNullOrWhiteSpace($Output) -or
    $Output -notmatch '^(?:UTC|[A-Za-z0-9_+\-]+(?:/[A-Za-z0-9_+\-]+)+)$') {
  throw 'Windows timezone detection returned an invalid IANA timezone.'
}

[PSCustomObject]@{ timezone = $Output } | ConvertTo-Json -Compress
