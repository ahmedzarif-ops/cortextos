import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const ROOT_ONBOARDING = '.claude/commands/onboarding.md';
const WINDOWS_REFERENCE = 'references/onboarding-windows.md';
const WINDOWS_INSTALL_SCRIPT = 'scripts/onboarding-windows-install.ps1';
const WINDOWS_INSTANCE_SCRIPT = 'scripts/onboarding-windows-select-instance.ps1';

function read(relative: string): string {
  // Git may materialize Markdown with CRLF on Windows. The onboarding contract
  // is about the document's content, not the checkout's newline convention.
  return readFileSync(join(ROOT, relative), 'utf-8').replace(/\r\n?/g, '\n');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fencedBlocks(doc: string, language: string): string[] {
  const pattern = new RegExp('```' + language + '\\n([\\s\\S]*?)```', 'g');
  return [...doc.matchAll(pattern)].map((match) => match[1]);
}

describe('canonical root onboarding OS routing', () => {
  it('detects the host with Node and routes win32 to one operational reference', () => {
    const root = read(ROOT_ONBOARDING);

    expect(root).toContain('node -p "process.platform"');
    expect(root).toContain('If the result is `win32`, use');
    expect(root).toContain(WINDOWS_REFERENCE);
    expect(root).toContain('use the Read tool directly');
    expect(root).toContain('Do not use Glob, `find`, or any shell command');
    expect(root).toContain('as the sole Phase 2');
    expect(root).toContain('active-session authentication proof');
    expect(root).toContain('do not spawn a nested');
    expect(root).toContain('do not load the Windows reference');
    expect(root).toContain('do not ask the user to translate them');
    expect(fencedBlocks(root, 'powershell')).toHaveLength(0);
  });

  it('preserves the initial conversation wording and pacing byte-for-byte', () => {
    const root = read(ROOT_ONBOARDING);
    const welcome = root.slice(
      root.indexOf('## Phase 1: Welcome'),
      root.indexOf('## Phase 2: Dependency Check'),
    );

    expect(sha256(welcome)).toBe('abf8488cef2f65f839d82b5e15726fcde988064747dbe114f1c42f7dbc6b5ad1');
    expect(welcome).toContain('Ask: "Ready to get started?');
  });

  it('preserves the existing macOS/Linux executable blocks byte-for-byte', () => {
    const root = read(ROOT_ONBOARDING);
    const posixBlocks = fencedBlocks(root, 'bash');

    expect(posixBlocks).toHaveLength(4);
    expect(sha256(posixBlocks.join('\n---\n')))
      .toBe('6b7c415a5ac8517d8ebeb0b071aad3d0c620f6480ed9ad2e629bb07da110f95b');
  });

  it('covers every Windows operation without cloning the conversation', () => {
    const windows = read(WINDOWS_REFERENCE);

    for (const required of [
      'node --version',
      'onboarding-windows-install.ps1',
      'onboarding-windows-select-instance.ps1',
      'enabled-agents.json',
      'Invoke-RestMethod',
      'npm run build',
      'pm2 start $Ecosystem',
      'pm2 save',
      'install-windows-pm2-startup.ps1',
      'node .\\dist\\cli.js doctor',
      'node .\\dist\\cli.js status',
      'Get-Content -LiteralPath',
      'Get-NetTCPConnection',
      "Start-Process 'http://localhost:3000'",
      'headless VPS',
    ]) {
      expect(windows, required).toContain(required);
    }

    expect(windows).not.toContain('## Phase 1: Welcome');
    expect(windows).not.toContain('Ready to get started?');
    expect(windows).not.toContain('What do you want to call your Orchestrator?');
  });

  it('contains no forbidden POSIX command in the Windows executable route', () => {
    const windows = read(WINDOWS_REFERENCE);
    const powershellBlocks = fencedBlocks(windows, 'powershell');
    const commands = powershellBlocks.join('\n');
    const dependencyCheck = powershellBlocks[0];

    expect(dependencyCheck).toContain('node --version');
    expect(dependencyCheck).toContain('pm2 --version');
    expect(dependencyCheck).toContain('powershell.exe -NoLogo -NoProfile -NonInteractive -Command');
    expect(dependencyCheck).toContain('node --version; npm --version; pm2 --version');
    expect(dependencyCheck).not.toContain('&&');
    expect(dependencyCheck).not.toContain('doctor');
    expect(dependencyCheck).not.toContain('claude');
    expect(commands).not.toMatch(/(^|[\s;&|])(?:wsl|bash|sudo|chmod|which|uname|grep|sed|touch|cat|tail|lsof|awk|jq)(?=$|[\s;&|])/im);
    expect(commands).not.toContain('pm2 startup');
    expect(commands).not.toContain('node -p "process.platform"');
    expect(commands).not.toMatch(/(^|\s)claude(?:\.cmd|\.ps1)?\s/im);
    expect(commands).not.toContain('npm run dev');
    expect(commands).not.toMatch(/(?:^|\s)&(?:\s|$)/m);
    expect(windows).toContain('do not ask the user to translate');
    expect(windows).toContain('Never invoke WSL or Git Bash');
    expect(windows).toContain('Successful execution of this active `/onboarding` session proves');
    expect(windows).toContain('false unauthenticated result');
    expect(windows).toContain('Never fall back to Bash or POSIX utilities');
    expect(windows).toContain('Submit the\nexact line once without rewriting it');
  });

  it('installs dashboard dependencies before the Windows full-suite gate', () => {
    const windows = read(WINDOWS_REFERENCE);
    const script = read(WINDOWS_INSTALL_SCRIPT);
    const rootInstall = script.indexOf("Invoke-NativeStage 'Root dependency installation'");
    const dashboardInstall = script.indexOf("Invoke-NativeStage 'Dashboard dependency installation'");
    const fullSuite = script.indexOf("Invoke-NativeStage 'Full test suite'");
    const build = script.indexOf("Invoke-NativeStage 'CLI build'");
    const coreInstall = script.indexOf("Invoke-NativeStage 'Core state installation'");

    expect(windows).toContain('-File ./scripts/onboarding-windows-install.ps1');
    expect(windows).not.toContain('-File .\\scripts\\onboarding-windows-install.ps1');
    expect(windows).toContain('do not split or rewrite this command');
    expect(rootInstall).toBeGreaterThanOrEqual(0);
    expect(dashboardInstall).toBeGreaterThanOrEqual(0);
    expect(dashboardInstall).toBeGreaterThan(rootInstall);
    expect(fullSuite).toBeGreaterThan(dashboardInstall);
    expect(build).toBeGreaterThan(fullSuite);
    expect(coreInstall).toBeGreaterThan(build);
    expect(script).toContain('if ($LASTEXITCODE -ne 0)');
  });

  it('selects instance state through one checked-in native command', () => {
    const windows = read(WINDOWS_REFERENCE);
    const script = read(WINDOWS_INSTANCE_SCRIPT);

    expect(windows).toContain('-File ./scripts/onboarding-windows-select-instance.ps1');
    expect(windows).toContain('Read the `instanceId` field');
    expect(windows).toContain('Do not reimplement or verify');
    expect(windows).not.toContain('Use harness file and JSON tools to select the instance');
    expect(script).toContain("[Environment]::GetFolderPath('UserProfile')");
    expect(script).toContain('ConvertFrom-Json');
    expect(script).toContain("$EnabledAgents -is [PSCustomObject]");
    expect(script).toContain("$Candidate = 'cortextos' + $Index");
    expect(script).not.toContain('$env:USERPROFILE');
  });

  it('keeps Windows failure diagnosis on native tools', () => {
    const root = read(ROOT_ONBOARDING);
    const windows = read(WINDOWS_REFERENCE);

    expect(root).toContain("loaded Windows reference's native failure-diagnosis route");
    expect(root).toContain('do not propose');
    expect(windows).toContain('Use the harness Read/JSON tools');
    expect(windows).toContain('Never fall back to Bash or POSIX utilities');
  });
});
