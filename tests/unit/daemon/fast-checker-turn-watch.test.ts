import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('child_process', () => ({ execFile: vi.fn() }));
vi.mock('../../../src/bus/message', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/bus/message')>();
  return { ...actual, sendMessage: vi.fn() };
});

import { execFile } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FastChecker } from '../../../src/daemon/fast-checker';
import { sendMessage } from '../../../src/bus/message';
import { TURN_STALL_MS } from '../../../src/daemon/turn-watch';
import type { BusPaths } from '../../../src/types';

/**
 * Wiring of the turn watch into FastChecker: a seat that accepted an injection
 * and took no turn must stop reading as alive — heartbeat STALLED, a state file,
 * one note to the orchestrator — and must never be restarted by this path.
 */

const T0 = Date.parse('2026-01-01T00:00:00Z');
const ORG = 'acme';

describe('FastChecker turn watch', () => {
  let root: string;
  let paths: BusPaths;
  let logs: string[];
  let transcript: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fc-turnwatch-'));
    const ctxRoot = join(root, 'ctx');
    paths = {
      ctxRoot,
      inbox: join(ctxRoot, 'inbox'),
      inflight: join(ctxRoot, 'inflight'),
      processed: join(ctxRoot, 'processed'),
      logDir: join(ctxRoot, 'logs'),
      stateDir: join(ctxRoot, 'state'),
      taskDir: join(ctxRoot, 'tasks'),
      approvalDir: join(ctxRoot, 'approvals'),
      analyticsDir: join(ctxRoot, 'analytics'),
    } as unknown as BusPaths;
    for (const d of Object.values(paths)) mkdirSync(d as string, { recursive: true });
    mkdirSync(join(root, 'orgs', ORG, 'agents', 'worker'), { recursive: true });
    writeFileSync(join(root, 'orgs', ORG, 'context.json'), JSON.stringify({ orchestrator: 'boss' }));
    transcript = join(root, 'session.jsonl');
    logs = [];
    vi.mocked(execFile).mockReset();
    vi.mocked(sendMessage).mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  });

  function checker(name = 'worker', runtime?: string) {
    const agent = {
      name,
      hasEverBootstrapped: () => true,
      getAgentDir: () => join(root, 'orgs', ORG, 'agents', name),
      getConfig: () => (runtime ? { runtime } : {}),
    } as any;
    return new FastChecker(agent, paths, root, { log: (m: string) => logs.push(m) });
  }

  function watchTranscript(mtimeMs: number) {
    writeFileSync(transcript, '{}\n');
    utimesSync(transcript, mtimeMs / 1000, mtimeMs / 1000);
    writeFileSync(join(paths.stateDir, 'context_status.json'), JSON.stringify({ transcript_path: transcript }));
  }

  function injectAt(c: FastChecker, ms: number) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(ms);
    (c as any).noteInjected();
    vi.useRealTimers();
  }

  const heartbeats = () =>
    vi.mocked(execFile).mock.calls.map((call) => (call[1] as string[])[2]);
  const watchFile = () => JSON.parse(readFileSync(join(paths.stateDir, 'turn_watch.json'), 'utf-8'));

  it('THE STALL ARM: an injection with no turn after the threshold marks the seat STALLED, once', () => {
    const c = checker();
    watchTranscript(T0 - 60_000);
    injectAt(c, T0);

    c.checkTurnWatch(T0 + TURN_STALL_MS - 1);
    expect(heartbeats()).toEqual([]);
    expect(existsSync(join(paths.stateDir, 'turn_watch.json'))).toBe(false);

    c.checkTurnWatch(T0 + TURN_STALL_MS);
    expect(heartbeats()).toHaveLength(1);
    expect(heartbeats()[0]).toBe(`STALLED: message injected ${new Date(T0).toISOString()}, no turn since (12m)`);
    expect(watchFile()).toMatchObject({ state: 'stalled', pending_since: new Date(T0).toISOString(), sources: ['transcript'] });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [, from, to, priority, text] = vi.mocked(sendMessage).mock.calls[0];
    expect([from, to, priority]).toEqual(['worker', 'boss', 'normal']);
    expect(text.startsWith('[daemon turn-watch] worker STALLED: ')).toBe(true);
    expect(logs.some((l) => l.startsWith('TURN WATCH STALLED'))).toBe(true);

    // Reported once per episode, not once per poll.
    c.checkTurnWatch(T0 + TURN_STALL_MS * 3);
    expect(heartbeats()).toHaveLength(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('a turn after the injection is healthy: no heartbeat, no message, no file', () => {
    const c = checker();
    watchTranscript(T0 + 30_000);
    injectAt(c, T0);
    c.checkTurnWatch(T0 + TURN_STALL_MS * 2);
    expect(heartbeats()).toEqual([]);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(existsSync(join(paths.stateDir, 'turn_watch.json'))).toBe(false);
    expect((c as any).turnPendingSince).toBe(0);
  });

  it('keeps the OLDEST unanswered injection: steady traffic cannot reset the clock', () => {
    const c = checker();
    watchTranscript(T0 - 60_000);
    injectAt(c, T0);
    injectAt(c, T0 + TURN_STALL_MS - 1_000);
    c.checkTurnWatch(T0 + TURN_STALL_MS);
    expect(heartbeats()[0]).toContain(new Date(T0).toISOString());
  });

  it('while stalled, the idle watchdog keeps saying STALLED instead of "alive"', () => {
    const c = checker();
    expect((c as any).watchdogStatus(T0)).toMatch(/^\[watchdog\] worker alive — idle session /);
    watchTranscript(T0 - 60_000);
    injectAt(c, T0);
    c.checkTurnWatch(T0 + TURN_STALL_MS);
    expect((c as any).watchdogStatus(T0 + 50 * 60_000)).toBe(
      `STALLED: message injected ${new Date(T0).toISOString()}, no turn since (50m)`,
    );
  });

  it('recovery: the next turn clears the stall, says so in the heartbeat, and resets the file', () => {
    const c = checker();
    watchTranscript(T0 - 60_000);
    injectAt(c, T0);
    c.checkTurnWatch(T0 + TURN_STALL_MS);
    watchTranscript(T0 + TURN_STALL_MS + 5_000);
    c.checkTurnWatch(T0 + TURN_STALL_MS + 10_000);
    expect(heartbeats()).toHaveLength(2);
    expect(heartbeats()[1]).toMatch(/^\[turn-watch\] worker turn resumed .* after 12m stalled$/);
    expect(watchFile()).toMatchObject({ state: 'ok', pending_since: null });
    expect((c as any).watchdogStatus(T0)).toMatch(/^\[watchdog\] worker alive/);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('THE UNKNOWN ARM: a seat with no turn signal is reported unwatched, not healthy and not stalled', () => {
    const c = checker();
    injectAt(c, T0);
    c.checkTurnWatch(T0 + TURN_STALL_MS);
    expect(watchFile()).toMatchObject({ state: 'unknown', sources: [] });
    expect(logs.filter((l) => l.startsWith('TURN WATCH UNKNOWN'))).toHaveLength(1);
    expect(heartbeats()).toEqual([]);
    expect(sendMessage).not.toHaveBeenCalled();
    c.checkTurnWatch(T0 + TURN_STALL_MS * 2);
    expect(logs.filter((l) => l.startsWith('TURN WATCH UNKNOWN'))).toHaveLength(1);
  });

  it('the orchestrator stalling marks its own heartbeat and messages nobody', () => {
    const c = checker('boss');
    watchTranscript(T0 - 60_000);
    injectAt(c, T0);
    c.checkTurnWatch(T0 + TURN_STALL_MS);
    expect(heartbeats()[0]).toMatch(/^STALLED: /);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('never restarts the seat', () => {
    const c = checker();
    const restart = vi.spyOn(c as any, 'forceContextRestart');
    watchTranscript(T0 - 60_000);
    injectAt(c, T0);
    c.checkTurnWatch(T0 + TURN_STALL_MS * 10);
    expect(restart).not.toHaveBeenCalled();
    for (const call of vi.mocked(execFile).mock.calls) {
      expect((call[1] as string[]).slice(0, 2)).toEqual(['bus', 'update-heartbeat']);
    }
  });

  describe('through the real poll cycle', () => {
    async function poll(c: FastChecker) {
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      const cycle = (c as any).pollCycle();
      await vi.advanceTimersByTimeAsync(10_000);
      await cycle;
      vi.useRealTimers();
    }

    it('a delivered message starts the clock; an undelivered one does not', async () => {
      const c = checker();
      (c as any).agent.injectMessage = vi.fn().mockReturnValue(false);
      c.queueTelegramMessage('=== TELEGRAM from x ===\nhello\n');
      await poll(c);
      expect((c as any).turnPendingSince).toBe(0);

      (c as any).agent.injectMessage = vi.fn().mockReturnValue(true);
      c.queueTelegramMessage('=== TELEGRAM from x ===\nhello again\n');
      const before = Date.now();
      await poll(c);
      expect((c as any).turnPendingSince).toBeGreaterThanOrEqual(before);
    });

    it('each poll runs the turn watch', async () => {
      const c = checker();
      (c as any).agent.injectMessage = vi.fn().mockReturnValue(true);
      watchTranscript(Date.now() - TURN_STALL_MS * 3);
      (c as any).turnPendingSince = Date.now() - TURN_STALL_MS - 60_000;
      await poll(c);
      expect(heartbeats()).toHaveLength(1);
      expect(heartbeats()[0]).toMatch(/^STALLED: /);
    });
  });

  describe('codex app-server seats (status writes follow model responses)', () => {
    function statusWrittenAt(ms: number) {
      writeFileSync(join(paths.stateDir, 'context_status.json'),
        JSON.stringify({ transcript_path: null, written_at: new Date(ms).toISOString() }));
    }
    function frozenIdleFlag() {
      writeFileSync(join(paths.stateDir, 'last_idle.flag'), String(Math.floor((T0 - 9 * 86_400_000) / 1000)));
    }

    it('a frozen idle flag plus a status write after the injection is a turn, not a stall', () => {
      const c = checker('worker', 'codex-app-server');
      frozenIdleFlag();
      statusWrittenAt(T0 + 20 * 60_000);
      injectAt(c, T0);
      c.checkTurnWatch(T0 + 24 * 60_000);
      expect(heartbeats()).toEqual([]);
      expect(sendMessage).not.toHaveBeenCalled();
      expect((c as any).turnPendingSince).toBe(0);
    });

    it('a long turn still writing status is not a stall, even with no idle flag since', () => {
      const c = checker('worker', 'codex-app-server');
      frozenIdleFlag();
      statusWrittenAt(T0 + 11 * 60_000);
      injectAt(c, T0);
      c.checkTurnWatch(T0 + TURN_STALL_MS + 60_000);
      expect(heartbeats()).toEqual([]);
    });

    it('a frozen idle flag and NO status write after the injection is a real stall', () => {
      const c = checker('worker', 'codex-app-server');
      frozenIdleFlag();
      statusWrittenAt(T0 - 60_000);
      injectAt(c, T0);
      c.checkTurnWatch(T0 + TURN_STALL_MS);
      expect(heartbeats()[0]).toMatch(/^STALLED: /);
      expect(watchFile()).toMatchObject({ state: 'stalled', sources: ['status_write'] });
    });

    it('a frozen idle flag as the ONLY file is unknown, never stalled', () => {
      const c = checker('worker', 'codex-app-server');
      frozenIdleFlag();
      injectAt(c, T0);
      c.checkTurnWatch(T0 + TURN_STALL_MS);
      expect(heartbeats()).toEqual([]);
      expect(watchFile()).toMatchObject({ state: 'unknown', sources: [] });
    });
  });

  describe('seats whose status writes are NOT proof of a turn', () => {
    function statusWrittenAt(ms: number) {
      writeFileSync(join(paths.stateDir, 'context_status.json'),
        JSON.stringify({ transcript_path: null, written_at: new Date(ms).toISOString() }));
    }

    it('THE FALSE-OK ARM, hermes: a status write after the injection (inbound row persisted) is unknown, not a turn', () => {
      const c = checker('worker', 'hermes');
      writeFileSync(join(paths.stateDir, 'last_idle.flag'), String(Math.floor((T0 - 9 * 86_400_000) / 1000)));
      statusWrittenAt(T0 + 20_000);
      injectAt(c, T0);
      c.checkTurnWatch(T0 + TURN_STALL_MS);
      expect((c as any).turnPendingSince).toBe(T0);
      expect(watchFile()).toMatchObject({ state: 'unknown', sources: [] });
      expect(heartbeats()).toEqual([]);
    });

    it('a Claude seat whose hook got no transcript_path is unknown, not "turned" by a timer refresh', () => {
      const c = checker('worker', 'claude-code');
      statusWrittenAt(T0 + TURN_STALL_MS - 1_000);
      injectAt(c, T0);
      c.checkTurnWatch(T0 + TURN_STALL_MS);
      expect(watchFile()).toMatchObject({ state: 'unknown', sources: [] });
    });
  });

  it('an agent whose config cannot be read does not break the poll: it just does not opt in', () => {
    const c = checker('worker', 'codex-app-server');
    (c as any).agent.getConfig = undefined;
    writeFileSync(join(paths.stateDir, 'context_status.json'),
      JSON.stringify({ transcript_path: null, written_at: new Date(T0 + 60_000).toISOString() }));
    injectAt(c, T0);
    expect(() => c.checkTurnWatch(T0 + TURN_STALL_MS)).not.toThrow();
    expect(watchFile()).toMatchObject({ state: 'unknown' });
  });

  it('nothing injected means nothing to watch', () => {
    const c = checker();
    c.checkTurnWatch(T0 + TURN_STALL_MS * 10);
    expect(heartbeats()).toEqual([]);
    expect(existsSync(join(paths.stateDir, 'turn_watch.json'))).toBe(false);
  });
});
