import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { join, sep } from 'path';
import { tmpdir } from 'os';

// Claude's conversation directory lives under the home directory; point it at a sandbox.
const fakeHome = mkdtempSync(join(tmpdir(), 'continuity-home-'));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => fakeHome };
});

import {
  HANDOFF_NEWER_MARGIN_MS,
  newestHandoff,
  readLastSession,
  staleResumeReason,
  writeLastSession,
} from '../../../src/daemon/session-continuity';
import { AgentProcess } from '../../../src/daemon/agent-process';

/**
 * A restart must not reopen a conversation when something newer was recorded
 * elsewhere: a runtime or model switch, or a handoff written after it. Observed:
 * a seat switched back to its original runtime resumed the conversation from
 * before the switch and skipped two days of handoffs.
 */

const T0 = Date.parse('2026-01-01T00:00:00Z');

function touch(path: string, ms: number, body = 'x\n'): void {
  writeFileSync(path, body);
  utimesSync(path, ms / 1000, ms / 1000);
}

describe('staleResumeReason', () => {
  const claude = { runtime: 'claude-code', model: 'model-a' };
  const at = (ms: number) => ({ path: '/p', mtimeMs: ms });

  it('no last-session record and no newer handoff: resume (first start on this version is not a reason)', () => {
    expect(staleResumeReason({ last: null, current: claude, handoff: at(T0), transcript: at(T0) })).toBeNull();
  });

  it('a runtime switch is a reason', () => {
    expect(staleResumeReason({ last: { runtime: 'codex-app-server', model: 'model-a' }, current: claude, handoff: null, transcript: null }))
      .toMatch(/runtime changed \(codex-app-server -> claude-code\)/);
  });

  it('a model switch is a reason', () => {
    expect(staleResumeReason({ last: { runtime: 'claude-code', model: 'model-b' }, current: claude, handoff: null, transcript: null }))
      .toMatch(/model changed \(model-b -> model-a\)/);
  });

  it('a handoff newer than the conversation (past the margin) is a reason; inside the margin is not', () => {
    const t = at(T0);
    expect(staleResumeReason({ last: claude, current: claude, handoff: at(T0 + HANDOFF_NEWER_MARGIN_MS + 1), transcript: t }))
      .toMatch(/handoff document is newer/);
    expect(staleResumeReason({ last: claude, current: claude, handoff: at(T0 + HANDOFF_NEWER_MARGIN_MS), transcript: t })).toBeNull();
  });

  it('the normal case, a conversation newer than its last handoff, resumes', () => {
    expect(staleResumeReason({ last: claude, current: claude, handoff: at(T0), transcript: at(T0 + 3_600_000) })).toBeNull();
  });

  it('with no transcript to compare (non-Claude runtimes), only the identity counts', () => {
    expect(staleResumeReason({ last: claude, current: claude, handoff: at(T0 + 9e9), transcript: null })).toBeNull();
  });
});

describe('last-session record and newest handoff', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'continuity-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('round-trips, and a missing or malformed record reads as null', () => {
    expect(readLastSession(dir)).toBeNull();
    writeLastSession(dir, { runtime: 'claude-code', model: 'm' });
    expect(readLastSession(dir)).toEqual({ runtime: 'claude-code', model: 'm' });
    writeFileSync(join(dir, 'last-session.json'), '{"runtime": 5}');
    expect(readLastSession(dir)).toBeNull();
  });

  it('newestHandoff picks the newest .md and ignores other files', () => {
    const h = join(dir, 'memory', 'handoffs');
    mkdirSync(h, { recursive: true });
    touch(join(h, 'handoff-a.md'), T0);
    touch(join(h, 'handoff-b.md'), T0 + 5_000);
    touch(join(h, 'notes.txt'), T0 + 9_000);
    expect(newestHandoff(dir)).toEqual({ path: join(h, 'handoff-b.md'), mtimeMs: T0 + 5_000 });
    expect(newestHandoff(join(dir, 'nope'))).toBeNull();
  });
});

describe('AgentProcess.shouldContinue with real files', () => {
  let root: string;
  let agentDir: string;
  let stateDir: string;
  let convDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'continuity-seat-'));
    agentDir = join(root, 'orgs', 'acme', 'agents', 'seat');
    stateDir = join(root, 'ctx', 'state', 'seat');
    convDir = join(fakeHome, '.claude', 'projects', agentDir.split(sep).join('-'));
    mkdirSync(join(agentDir, 'memory', 'handoffs'), { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(convDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(convDir, { recursive: true, force: true });
  });

  function seat(config: Record<string, unknown> = { runtime: 'claude-code', model: 'model-a' }) {
    const env = {
      instanceId: 'test', ctxRoot: join(root, 'ctx'), frameworkRoot: root, agentName: 'seat',
      agentDir, org: 'acme', projectRoot: root,
    };
    const logs: string[] = [];
    const ap = new AgentProcess('seat', env as any, config as any, (m: string) => logs.push(m));
    return { ap, logs, shouldContinue: () => (ap as any).shouldContinue() as boolean };
  }
  const marker = () => join(stateDir, '.handoff-doc-path');

  it('resumes a conversation newer than its last handoff (the normal restart)', () => {
    touch(join(agentDir, 'memory', 'handoffs', 'h1.md'), T0);
    touch(join(convDir, 'conv.jsonl'), T0 + 3_600_000);
    writeLastSession(stateDir, { runtime: 'claude-code', model: 'model-a' });
    expect(seat().shouldContinue()).toBe(true);
    expect(existsSync(marker())).toBe(false);
  });

  it('THE INCIDENT: a handoff written after the conversation forces fresh and points at that handoff', () => {
    const handoff = join(agentDir, 'memory', 'handoffs', 'h2.md');
    touch(join(convDir, 'conv.jsonl'), T0);
    touch(handoff, T0 + 47 * 3_600_000);
    writeLastSession(stateDir, { runtime: 'claude-code', model: 'model-a' });
    const s = seat();
    expect(s.shouldContinue()).toBe(false);
    expect(readFileSync(marker(), 'utf-8').trim()).toBe(handoff);
    expect(s.logs.some((l) => l.includes('Starting fresh instead of resuming: a handoff document is newer'))).toBe(true);
  });

  it('a runtime switch back forces fresh even when the transcript is newest', () => {
    touch(join(agentDir, 'memory', 'handoffs', 'h1.md'), T0);
    touch(join(convDir, 'conv.jsonl'), T0 + 3_600_000);
    writeLastSession(stateDir, { runtime: 'codex-app-server', model: 'other' });
    expect(seat().shouldContinue()).toBe(false);
    expect(existsSync(marker())).toBe(true);
  });

  it('an explicit pending handoff marker is never overwritten', () => {
    touch(join(convDir, 'conv.jsonl'), T0);
    touch(join(agentDir, 'memory', 'handoffs', 'h2.md'), T0 + 9_000_000);
    writeFileSync(marker(), '/explicit/handoff.md');
    writeLastSession(stateDir, { runtime: 'claude-code', model: 'model-a' });
    expect(seat().shouldContinue()).toBe(false);
    expect(readFileSync(marker(), 'utf-8')).toBe('/explicit/handoff.md');
  });

  it('no last-session record (upgrade) and an older handoff: resumes as before', () => {
    touch(join(agentDir, 'memory', 'handoffs', 'h1.md'), T0);
    touch(join(convDir, 'conv.jsonl'), T0 + 3_600_000);
    expect(seat().shouldContinue()).toBe(true);
  });
});
