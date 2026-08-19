import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf-8');
}

describe('Windows onboarding portability contract', () => {
  it('routes root onboarding through native Windows commands and persistence', () => {
    const doc = read('.claude/commands/onboarding.md');
    expect(doc).toContain('## Cross-platform execution contract');
    expect(doc).toContain('node -p "process.platform"');
    expect(doc).toContain('scripts\\install-windows-pm2-startup.ps1');
    expect(doc).toContain('never run `pm2 startup`');
    expect(doc).toContain('Start-Process http://localhost:3000');
    expect(doc).toContain('Get-NetTCPConnection -LocalPort 3000');
    expect(doc).not.toContain('It will ask for your Mac password');
  });

  it('gives every shipped first-boot skill a native host contract', () => {
    const skills = [
      'community/skills/onboarding/SKILL.md',
      'templates/agent/.claude/skills/onboarding/SKILL.md',
      'templates/agent-codex/plugins/cortextos-agent-skills/skills/onboarding/SKILL.md',
      'templates/agent-opencode/plugins/cortextos-agent-skills/skills/onboarding/SKILL.md',
      'templates/orchestrator/.claude/skills/onboarding/SKILL.md',
      'templates/analyst/.claude/skills/onboarding/SKILL.md',
    ];
    for (const path of skills) {
      const content = read(path);
      expect(content, path).toContain('## Native host contract');
      expect(content, path).toMatch(/Windows use (?:native )?PowerShell/);
      expect(content, path).not.toContain('[[ -f "${CTX_ROOT}');
      expect(content, path).not.toContain('touch "$CTX_ROOT');
    }
  });

  it('tells each primary agent role to translate semantic examples itself', () => {
    for (const path of [
      'templates/agent/ONBOARDING.md',
      'templates/agent-codex/ONBOARDING.md',
      'templates/agent-opencode/ONBOARDING.md',
      'templates/orchestrator/ONBOARDING.md',
      'templates/analyst/ONBOARDING.md',
    ]) {
      const content = read(path);
      expect(content, path).toContain('**Native-shell rule:**');
      expect(content, path).toContain('without asking the user');
    }
  });

  it('keeps setup tokens out of child command lines and writes sender authorization', () => {
    const setup = read('src/cli/setup.ts');
    expect(setup).toContain('ALLOWED_USER=${allowedUser}');
    expect(setup).toContain("mask: '*'");
    expect(setup).toContain('api.getUpdates(0, 30)');
    expect(setup).not.toContain("spawnSync(process.execPath, ['-e', script, botToken]");
  });

  it('keeps CLI handoff text executable in native Windows PowerShell', () => {
    const install = read('src/cli/install.ts');
    const dashboard = read('src/cli/dashboard.ts');
    const start = read('src/cli/start.ts');
    expect(install).not.toContain('View password with: cat');
    expect(dashboard).not.toContain('View password with: cat');
    expect(install).not.toContain('ecosystem && pm2 start');
    expect(start).not.toContain('ecosystem && pm2 start');
    expect(start).not.toContain('pm2-windows-startup');
    expect(start).toContain('install-windows-pm2-startup.ps1');
  });
});
