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
    expect(script).toContain('New-ScheduledTaskTrigger -AtLogOn');
    expect(script).toContain('[System.Security.Principal.WindowsIdentity]::GetCurrent().Name');
    expect(script).not.toContain('$env:USERDOMAIN\\$env:USERNAME');
    expect(script).toContain('-EncodedCommand $encodedAction');
    expect(script).not.toMatch(/Developer Mode/i);
    expect(script).not.toMatch(/pm2-windows-(startup|service).*\binstall\b/i);
  });

  it('resolves version-manager PM2 shims without persisting the cmd wrapper', () => {
    expect(script).toContain('Get-Command pm2.cmd -CommandType Application');
    expect(script).toContain("Join-Path (Split-Path $pm2Command.Source -Parent) 'node_modules\\pm2\\bin\\pm2'");
    expect(script).toContain('& $nodeLiteral $pm2BinLiteral resurrect');
  });
});
