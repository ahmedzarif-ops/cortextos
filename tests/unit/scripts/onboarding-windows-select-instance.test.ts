import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = join(process.cwd(), 'scripts', 'onboarding-windows-select-instance.ps1');
const describeWindows = process.platform === 'win32' ? describe : describe.skip;

describeWindows('Windows onboarding instance selector', () => {
  let userHome: string;

  beforeEach(() => {
    userHome = mkdtempSync(join(tmpdir(), 'cortextos-instance-selector-'));
  });

  afterEach(() => {
    rmSync(userHome, { recursive: true, force: true });
  });

  function select(): { instanceId: string } {
    const stdout = execFileSync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', script,
      '-UserHome', userHome,
    ], { encoding: 'utf8' });
    return JSON.parse(stdout.trim()) as { instanceId: string };
  }

  it('reuses default only when enabled-agents is an empty object', () => {
    const configDir = join(userHome, '.cortextos', 'default', 'config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'enabled-agents.json'), '{}\n');

    expect(select()).toEqual({ instanceId: 'default' });
  });

  it('returns the first absent numbered instance without creating it', () => {
    mkdirSync(join(userHome, '.cortextos', 'default', 'config'), { recursive: true });
    writeFileSync(join(userHome, '.cortextos', 'default', 'config', 'enabled-agents.json'), '{"agent":{}}\n');
    mkdirSync(join(userHome, '.cortextos', 'cortextos1'), { recursive: true });

    expect(select()).toEqual({ instanceId: 'cortextos2' });
  });

  it.each(['not json', '[]', 'null'])('does not reuse default for %s', invalid => {
    const configDir = join(userHome, '.cortextos', 'default', 'config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'enabled-agents.json'), invalid);

    expect(select()).toEqual({ instanceId: 'cortextos1' });
  });
});
