import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('child_process', () => ({ execFile: vi.fn() }));
vi.mock('../../../src/bus/message', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/bus/message')>();
  return { ...actual, checkInbox: vi.fn(() => []), ackInbox: vi.fn(), sendMessage: vi.fn() };
});

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { appendDigest, digestPath, formatDigest, isDigestible, resolveDigestMode } from '../../../src/daemon/inbox-digest';
import { FastChecker } from '../../../src/daemon/fast-checker';
import { ackInbox, checkInbox } from '../../../src/bus/message';

/**
 * Every message injected into the orchestrator costs a full turn. Measured over
 * one week: 582 messages to the orchestrator, about 45% FYI/ack/no-action.
 * Routine ones can be read in a batch; anything that asks for the orchestrator
 * must still be delivered live.
 */

const msg = (text: string, priority: any = 'normal', id = 'm1') =>
  ({ id, from: 'worker', to: 'boss', priority, text, timestamp: new Date().toISOString() }) as any;

describe('isDigestible', () => {
  it('routine FYI / ack / status / no-action notes are digestible', () => {
    for (const t of ['FYI: build finished', 'ack, no action needed', 'Received.', 'Status: all green', 'Done: PR merged', 'noted for the record']) {
      expect(isDigestible(msg(t)), t).toBe(true);
    }
  });

  it('THE KEEP ARM: anything that asks for the orchestrator is delivered live', () => {
    for (const t of ['FYI: should I merge?', 'FYI decision needed on X', 'ack, but I am blocked on Y', 'status: blocker on deploy', 'noted; needs your approval', 'FYI urgent']) {
      expect(isDigestible(msg(t)), t).toBe(false);
    }
  });

  it('high/urgent priority and plain work messages are never digested', () => {
    expect(isDigestible(msg('FYI: build finished', 'high'))).toBe(false);
    expect(isDigestible(msg('FYI: build finished', 'urgent'))).toBe(false);
    expect(isDigestible(msg('Here is the draft for the landing page'))).toBe(false);
  });

  it('mode defaults to shadow; only off/on are taken as given', () => {
    expect(resolveDigestMode(undefined)).toBe('shadow');
    expect(resolveDigestMode('bogus')).toBe('shadow');
    expect(resolveDigestMode('on')).toBe('on');
    expect(resolveDigestMode('off')).toBe('off');
  });
});

describe('digest file', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'digest-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('appends one line per message and formats a readable day', () => {
    const now = new Date('2026-01-02T03:04:05Z');
    appendDigest(dir, msg('FYI: one', 'normal', 'a'), 'on', now);
    appendDigest(dir, msg('ack: two', 'low', 'b'), 'shadow', now);
    const lines = readFileSync(digestPath(dir, '2026-01-02'), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ id: 'a', mode: 'on', delivered_live: false });
    const text = formatDigest(dir, '2026-01-02');
    expect(text).toContain('03:04Z worker: FYI: one');
    expect(text).toContain('worker (also delivered live): ack: two');
    expect(formatDigest(dir, '2026-01-03')).toBe('');
  });
});

describe('FastChecker routes orchestrator FYIs by mode', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'digest-fc-'));
    mkdirSync(join(root, 'orgs', 'acme', 'agents', 'boss'), { recursive: true });
    writeFileSync(join(root, 'orgs', 'acme', 'context.json'), JSON.stringify({ orchestrator: 'boss' }));
    vi.mocked(ackInbox).mockReset();
  });
  afterEach(() => { vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); });

  async function poll(name: string, mode: string | undefined, messages: any[]) {
    const stateDir = join(root, 'state', name);
    mkdirSync(stateDir, { recursive: true });
    const paths = { ctxRoot: root, inbox: join(root, 'inbox'), inflight: join(root, 'inflight'), processed: join(root, 'processed'), logDir: join(root, 'logs'), stateDir, taskDir: root, approvalDir: root, analyticsDir: root } as any;
    const injected: string[] = [];
    const agent = {
      name,
      hasEverBootstrapped: () => true,
      getAgentDir: () => join(root, 'orgs', 'acme', 'agents', name),
      getConfig: () => (mode ? { inbox_digest: mode } : {}),
      injectMessage: (t: string) => { injected.push(t); return true; },
    } as any;
    vi.mocked(checkInbox).mockReturnValueOnce(messages);
    const c = new FastChecker(agent, paths, root, { log: () => {} });
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const cycle = (c as any).pollCycle();
    await vi.advanceTimersByTimeAsync(10_000);
    await cycle;
    vi.useRealTimers();
    return { injected: injected.join(''), digestFile: digestPath(stateDir, new Date().toISOString().slice(0, 10)) };
  }

  it('shadow (default): still delivered live, and logged as would-digest', async () => {
    const r = await poll('boss', undefined, [msg('FYI: build finished', 'normal', 'f1')]);
    expect(r.injected).toContain('FYI: build finished');
    expect(JSON.parse(readFileSync(r.digestFile, 'utf-8'))).toMatchObject({ id: 'f1', mode: 'shadow', delivered_live: true });
  });

  it('on: the FYI is not delivered, is acked, and goes to the digest; a question still wakes the orchestrator', async () => {
    const r = await poll('boss', 'on', [msg('FYI: build finished', 'normal', 'f1'), msg('Can I merge?', 'normal', 'q1')]);
    expect(r.injected).not.toContain('FYI: build finished');
    expect(r.injected).toContain('Can I merge?');
    expect(vi.mocked(ackInbox).mock.calls.map((c) => c[1])).toEqual(expect.arrayContaining(['f1', 'q1']));
    expect(JSON.parse(readFileSync(r.digestFile, 'utf-8'))).toMatchObject({ id: 'f1', delivered_live: false });
  });

  it('a non-orchestrator never digests, whatever its config says', async () => {
    const r = await poll('worker', 'on', [msg('FYI: build finished', 'normal', 'f1')]);
    expect(r.injected).toContain('FYI: build finished');
    expect(existsSync(r.digestFile)).toBe(false);
  });

  it('off: no digest file at all', async () => {
    const r = await poll('boss', 'off', [msg('FYI: build finished', 'normal', 'f1')]);
    expect(r.injected).toContain('FYI: build finished');
    expect(existsSync(r.digestFile)).toBe(false);
  });
});
