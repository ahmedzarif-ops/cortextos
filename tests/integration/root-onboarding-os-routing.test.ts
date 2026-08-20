import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const ROOT_ONBOARDING = '.claude/commands/onboarding.md';
const WINDOWS_REFERENCE = 'references/onboarding-windows.md';

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
    expect(root).toContain('If the result is `win32`, read');
    expect(root).toContain(WINDOWS_REFERENCE);
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
      'claude auth status',
      'node .\\dist\\cli.js install',
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
    const commands = fencedBlocks(windows, 'powershell').join('\n');

    expect(commands).not.toMatch(/(^|[\s;&|])(?:wsl|bash|sudo|chmod|which|uname|grep|sed|touch|cat|tail|lsof|awk|jq)(?=$|[\s;&|])/im);
    expect(commands).not.toContain('pm2 startup');
    expect(commands).not.toContain('npm run dev');
    expect(commands).not.toMatch(/(?:^|\s)&(?:\s|$)/m);
    expect(windows).toContain('do not ask the user to translate');
    expect(windows).toContain('Never invoke WSL or Git Bash');
  });
});
