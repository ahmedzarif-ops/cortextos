import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { vi } from 'vitest';
vi.mock('node-pty', () => ({ spawn: () => { throw new Error('not spawned in this test'); } }));

const { readLocalOverrides } = await import('../../../src/utils/local-overrides.js');
const { AgentPTY } = await import('../../../src/pty/agent-pty.js');
const { CodexAppServerPTY } = await import('../../../src/pty/codex-app-server-pty.js');

/**
 * LOCAL OVERRIDE DELIVERY, AND THE PARITY BETWEEN THE TWO ADAPTERS.
 *
 * These run against the REAL filesystem, deliberately. The property under test
 * is a glob's semantics — top level, not recursive — and a mocked `readdirSync`
 * returns whatever the test author already believes, which is the belief being
 * checked. A fixture tree can be wrong; a mock cannot even be wrong.
 */

let ROOT = '';
let AGENT_DIR = '';
const DEEP_MARKER = 'DEEP_MARKER_MUST_NOT_BE_INJECTED_7f3a';
const A_MARKER = 'MARKER_FROM_A_FILE_11b2';
const B_MARKER = 'MARKER_FROM_B_FILE_44c9';

beforeAll(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'ctx-local-overrides-'));
  AGENT_DIR = join(ROOT, 'orgs', 'acme', 'agents', 'alice');
  const localDir = join(AGENT_DIR, 'local');
  mkdirSync(join(localDir, 'sub'), { recursive: true });
  // Written out of sort order on purpose: order must come from the sort, not the fs.
  writeFileSync(join(localDir, 'b.md'), `beta ${B_MARKER}`);
  writeFileSync(join(localDir, 'a.md'), `alpha ${A_MARKER}`);
  writeFileSync(join(localDir, 'notes.txt'), 'not markdown, must be ignored');
  writeFileSync(join(localDir, 'sub', 'deep.md'), `deep ${DEEP_MARKER}`);
  // A DIRECTORY whose name ends in .md — matches the glob, is not readable as a file.
  mkdirSync(join(localDir, 'dir.md'));
});

afterAll(() => { if (ROOT) rmSync(ROOT, { recursive: true, force: true }); });

const mockEnv = (agentDir: string) => ({
  instanceId: 'test',
  ctxRoot: join(tmpdir(), 'ctx-local-overrides-ctxroot'),
  frameworkRoot: '/tmp/fw',
  agentName: 'alice',
  agentDir,
  org: 'acme',
  projectRoot: '/tmp/fw',
}) as any;

function agentPtyArgs(agentDir: string): string[] {
  const pty = new AgentPTY(mockEnv(agentDir), {} as any);
  return (pty as unknown as { buildClaudeArgs(m: 'fresh' | 'continue', p: string): string[] })
    .buildClaudeArgs('fresh', 'BOOT_PROMPT');
}

function codexBootPrompt(agentDir: string): string {
  const pty = new CodexAppServerPTY(mockEnv(agentDir), {} as any, join(ROOT, 'codex.log'));
  return (pty as unknown as { composeBootPrompt(p: string): string }).composeBootPrompt('BOOT_PROMPT');
}

describe('readLocalOverrides: the file-set rule', () => {
  it('THE FIXTURE IS REAL (vacuous-pass guard): the nested file exists and carries its marker', () => {
    const deep = join(AGENT_DIR, 'local', 'sub', 'deep.md');
    expect(existsSync(deep)).toBe(true);
    expect(readFileSync(deep, 'utf-8')).toContain(DEEP_MARKER);
  });

  it('reads TOP-LEVEL *.md only, in sort order', () => {
    const r = readLocalOverrides(AGENT_DIR);
    expect(r.files).toEqual(['a.md', 'b.md']);
    expect(r.content).toBe(`alpha ${A_MARKER}\n\nbeta ${B_MARKER}`);
  });

  it('DOES NOT RECURSE — a glob does not descend, and local/ is a working directory', () => {
    const r = readLocalOverrides(AGENT_DIR);
    expect(r.content).not.toContain(DEEP_MARKER);
    expect(r.files).not.toContain('deep.md');
  });

  it('ignores non-markdown files', () => {
    expect(readLocalOverrides(AGENT_DIR).content).not.toContain('not markdown');
  });

  it('skips a DIRECTORY named *.md and still delivers the rest (the inline version dropped everything)', () => {
    const r = readLocalOverrides(AGENT_DIR);
    expect(r.skipped).toEqual(['dir.md']);
    expect(r.files).toEqual(['a.md', 'b.md']);
    expect(r.content).toContain(A_MARKER);
    expect(r.content).toContain(B_MARKER);
  });

  it('returns empty for a missing agentDir and for a dir with no local/', () => {
    expect(readLocalOverrides(undefined).content).toBe('');
    expect(readLocalOverrides(join(ROOT, 'no-such-agent')).content).toBe('');
  });
});

describe('adapter parity: both runtimes deliver the SAME bytes', () => {
  it('AgentPTY passes the content as --append-system-prompt', () => {
    const args = agentPtyArgs(AGENT_DIR);
    const i = args.indexOf('--append-system-prompt');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe(readLocalOverrides(AGENT_DIR).content);
  });

  it('CodexAppServerPTY embeds the same content in the boot turn, and keeps the boot prompt', () => {
    const out = codexBootPrompt(AGENT_DIR);
    expect(out).toContain(readLocalOverrides(AGENT_DIR).content);
    expect(out).toContain('BOOT_PROMPT');
    expect(out).toContain('<local-overrides');
  });

  it('THE PARITY ASSERTION: the bytes claude receives are the bytes codex receives', () => {
    const args = agentPtyArgs(AGENT_DIR);
    const claudeContent = args[args.indexOf('--append-system-prompt') + 1]!;
    const codexOut = codexBootPrompt(AGENT_DIR);
    expect(codexOut).toContain(claudeContent);
    // and neither carries the nested file
    expect(claudeContent).not.toContain(DEEP_MARKER);
    expect(codexOut).not.toContain(DEEP_MARKER);
  });

  it('no local/ at all: codex boot prompt is the prompt, unchanged', () => {
    expect(codexBootPrompt(join(ROOT, 'no-such-agent'))).toBe('BOOT_PROMPT');
  });
});

describe('size cap: DROP LOUDLY, never truncate', () => {
  let bigDir = '';
  beforeAll(() => {
    bigDir = join(ROOT, 'orgs', 'acme', 'agents', 'bulky');
    mkdirSync(join(bigDir, 'local'), { recursive: true });
    // One file comfortably over the 128 KiB cap.
    writeFileSync(join(bigDir, 'local', 'huge.md'), 'X'.repeat(200 * 1024));
  });

  it('the fixture really is over the cap (vacuous-pass guard)', () => {
    expect(readLocalOverrides(bigDir).bytes).toBeGreaterThan(128 * 1024);
  });

  it('drops the overrides entirely rather than shipping a truncated instruction set', () => {
    const out = codexBootPrompt(bigDir);
    expect(out).toBe('BOOT_PROMPT');
    expect(out).not.toContain('X'.repeat(1000));
    expect(out).not.toContain('<local-overrides');
  });
});
