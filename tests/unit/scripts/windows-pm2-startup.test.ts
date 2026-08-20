import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('native Windows PM2 startup helper contract', () => {
  const script = readFileSync(join(process.cwd(), 'scripts', 'install-windows-pm2-startup.ps1'), 'utf8');

  it('is idempotent and scopes tasks and PM2 state by instance', () => {
    expect(script).toContain("$InstanceId -eq 'default') { 'PM2 Resurrect'");
    expect(script).toContain('cortextOS PM2 Resurrect ($InstanceId)');
    expect(script).toContain("$env:PM2_HOME = $pm2HomeLiteral");
    expect(script).toContain('-Force | Out-Null');
    expect(script).toContain("Join-Path $Pm2Home 'dump.pm2'");
  });

  it('uses native limited-privilege Task Scheduler without external services', () => {
    expect(script).toContain('-LogonType Interactive -RunLevel Limited');
    expect(script).toContain('-LogonType S4U -RunLevel Limited');
    expect(script).toContain('New-ScheduledTaskTrigger -AtLogOn');
    expect(script).toContain('New-ScheduledTaskTrigger -AtStartup');
    expect(script).toContain("[ValidateSet('Logon', 'Startup')]");
    expect(script).toContain('[System.Security.Principal.WindowsIdentity]::GetCurrent().Name');
    expect(script).not.toContain('$env:USERDOMAIN\\$env:USERNAME');
    expect(script).toContain('-EncodedCommand $encodedAction');
    expect(script).not.toMatch(/Developer Mode/i);
    expect(script).not.toMatch(/pm2-windows-(startup|service).*\binstall\b/i);
  });

  it('keeps desktop logon compatibility while offering explicit headless VPS startup', () => {
    expect(script).toContain("[string]$TriggerMode = 'Logon'");
    expect(script).toContain("if ($TriggerMode -eq 'Startup')");
    expect(script).toContain("$triggerLabel = 'At Windows startup (headless S4U)'");
  });

  it('resolves version-manager PM2 shims without persisting the cmd wrapper', () => {
    expect(script).toContain('Get-Command pm2.cmd -CommandType Application');
    expect(script).toContain("Join-Path (Split-Path $pm2Command.Source -Parent) 'node_modules\\pm2\\bin\\pm2'");
    expect(script).toContain('& $nodeLiteral $pm2BinLiteral resurrect');
  });

  it('restores allowlisted user-scoped provider auth without embedding values', () => {
    expect(script).toContain("@('CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_API_KEY')");
    expect(script).toContain("[Environment]::GetEnvironmentVariable(`$name, 'User')");
    expect(script).toContain("[Environment]::SetEnvironmentVariable(`$name, `$value, 'Process')");
    expect(script).not.toContain('CLAUDE_CODE_OAUTH_TOKEN=');
  });
});
