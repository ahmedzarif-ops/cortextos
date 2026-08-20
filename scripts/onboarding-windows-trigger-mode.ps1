$ErrorActionPreference = 'Stop'

# Explorer is the normal interactive Windows desktop shell. Its absence is a
# conservative signal that logon-triggered persistence would not revive a VPS
# or unattended workstation after reboot.
$CurrentSession = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
$DesktopShell = Get-Process -Name explorer -ErrorAction SilentlyContinue |
    Where-Object { $_.SessionId -eq $CurrentSession } |
    Select-Object -First 1
$Mode = if ($DesktopShell) { 'Logon' } else { 'Startup' }

[pscustomobject]@{
    triggerMode = $Mode
    reason = if ($Mode -eq 'Logon') { 'interactive-desktop-detected' } else { 'no-interactive-desktop-detected' }
} | ConvertTo-Json -Compress
