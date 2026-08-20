import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const script = join(process.cwd(), 'scripts', 'onboarding-windows-timezone.ps1');
const describeWindows = process.platform === 'win32' ? describe : describe.skip;

describe('Windows onboarding timezone script contract', () => {
  it('uses native Node and emits only structured timezone output', () => {
    const source = readFileSync(script, 'utf8');

    expect(source).toContain("& node.exe -p 'Intl.DateTimeFormat().resolvedOptions().timeZone'");
    expect(source).toContain("[PSCustomObject]@{ timezone = $Output } | ConvertTo-Json -Compress");
    expect(source).toContain('if ($LASTEXITCODE -ne 0)');
    expect(source).not.toMatch(/\b(?:bash|wsl|cmd\.exe)\b/i);
  });
});

describeWindows('Windows onboarding timezone probe', () => {
  it('returns a valid IANA timezone through Windows PowerShell', () => {
    const stdout = execFileSync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', script,
    ], { encoding: 'utf8', timeout: 20_000 });
    const result = JSON.parse(stdout.trim()) as { timezone: string };

    expect(result.timezone).toMatch(/^(?:UTC|[A-Za-z0-9_+\-]+(?:\/[A-Za-z0-9_+\-]+)+)$/);
  }, 25_000);
});
