import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A codex-app-server thread file is written ONLY by a live codex session and is
 * cleared by nothing. A seat that moves to another runtime therefore freezes its
 * last codex reading forever, and every later reader names a dead session as the
 * live one.
 *
 * Measured on this fleet 2026-09-03: all six seats still reported
 * actualModel=gpt-5.6-sol while every one of them was running Claude. Staleness
 * is not detectable from the file — an IDLE codex seat and a DEPARTED codex seat
 * produce byte-identical content, so no reader can defend itself. The runtime
 * change is knowable at exactly one moment, the cutover, which is what these
 * tests pin.
 */

const mockPty = {
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn(),
  write: vi.fn(),
  getPid: vi.fn().mockReturnValue(4242),
  getActualModel: vi.fn().mockReturnValue(undefined),
  isAlive: vi.fn().mockReturnValue(true),
  onExit: vi.fn(),
  getOutputBuffer: vi.fn().mockReturnValue({ isBootstrapped: vi.fn().mockReturnValue(true) }),
  setTelegramHandle: vi.fn(),
};

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY() { return mockPty; },
}));
vi.mock('../../../src/pty/codex-app-server-pty.js', () => ({
  CodexAppServerPTY: function CodexAppServerPTY() { return mockPty; },
}));
vi.mock('../../../src/pty/hermes-pty.js', () => ({
  HermesPTY: function HermesPTY() { return mockPty; },
  hermesDbExists: vi.fn().mockReturnValue(false),
}));
vi.mock('../../../src/pty/opencode-pty.js', () => ({
  OpencodePTY: function OpencodePTY() { return mockPty; },
  opencodeSessionExists: vi.fn().mockReturnValue(false),
}));
vi.mock('../../../src/pty/inject.js', () => ({
  injectMessage: vi.fn(),
  MessageDedup: class { isDuplicate() { return false; } },
}));
vi.mock('../../../src/utils/atomic.js', () => ({
  ensureDir: vi.fn(),
  atomicWriteSync: vi.fn(),
}));
vi.mock('../../../src/utils/env.js', () => ({
  writeCortextosEnv: vi.fn(),
  resolveEnv: vi.fn().mockReturnValue({ instanceId: 'test', ctxRoot: '/tmp/test' }),
}));
vi.mock('../../../src/bus/reminders.js', () => ({
  getOverdueReminders: vi.fn().mockReturnValue([]),
}));
vi.mock('../../../src/utils/paths.js', () => ({
  resolvePaths: vi.fn().mockReturnValue({}),
}));

const fsMocks = {
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  statSync: vi.fn(),
  unlinkSync: vi.fn(),
};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    mkdirSync: vi.fn(),
    get existsSync() { return fsMocks.existsSync; },
    get readFileSync() { return fsMocks.readFileSync; },
    get writeFileSync() { return fsMocks.writeFileSync; },
    get appendFileSync() { return fsMocks.appendFileSync; },
    get statSync() { return fsMocks.statSync; },
    get unlinkSync() { return fsMocks.unlinkSync; },
  };
});

const { AgentProcess } = await import('../../../src/daemon/agent-process.js');

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/test-ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'seat',
  agentDir: '/tmp/fw/orgs/acme/agents/seat',
  org: 'acme',
} as never;

const THREAD = '/tmp/test-ctx/state/seat/codex-app-server-thread.json';
const SUPERSEDED = '/tmp/test-ctx/state/seat/codex-app-server-thread.superseded.json';

const THREAD_BODY = JSON.stringify({
  threadId: '01a068be-25b8-7582-9d5f-517334d061d5',
  cwd: '/tmp/fw/orgs/acme/agents/seat',
  actualModel: 'gpt-5.6-sol',
  modelProvider: 'openai',
  updatedAt: '2026-09-03T19:28:07.849Z',
});

function threadPresent(present: boolean) {
  fsMocks.existsSync.mockImplementation((p: string) => (p === THREAD ? present : false));
}

function supersededPayload(): Record<string, unknown> | null {
  const call = fsMocks.writeFileSync.mock.calls.find((c: unknown[]) => c[0] === SUPERSEDED);
  if (!call) return null;
  try {
    return JSON.parse(String(call[1])) as Record<string, unknown>;
  } catch {
    return null;
  }
}

describe('codex thread state is retired at runtime cutover', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMocks.existsSync.mockReturnValue(false);
    fsMocks.readFileSync.mockReturnValue(THREAD_BODY);
  });

  it('retires a leftover codex thread file when the seat starts on claude-code', async () => {
    threadPresent(true);

    await new AgentProcess('seat', mockEnv, { runtime: 'claude-code' } as never).start();

    // The lie is gone from the live path...
    expect(fsMocks.unlinkSync).toHaveBeenCalledWith(THREAD);
    // ...but the evidence of the prior tenure is kept, not destroyed.
    const payload = supersededPayload();
    expect(payload, 'superseded file was not written').not.toBeNull();
    expect(payload!['actualModel']).toBe('gpt-5.6-sol');
    expect(payload!['supersededByRuntime']).toBe('claude-code');
    expect(typeof payload!['supersededAt']).toBe('string');
  });

  it('leaves the thread file alone when the seat is still on codex-app-server', async () => {
    // Negative control. Without this, a method that deleted the file
    // unconditionally would pass the test above and silently break every codex
    // resume — the file is also the codex continue-vs-fresh marker.
    threadPresent(true);

    await new AgentProcess('seat', mockEnv, { runtime: 'codex-app-server' } as never).start();

    expect(fsMocks.unlinkSync).not.toHaveBeenCalledWith(THREAD);
    expect(supersededPayload()).toBeNull();
  });

  it('does nothing when there is no codex thread file to retire', async () => {
    threadPresent(false);

    await new AgentProcess('seat', mockEnv, { runtime: 'claude-code' } as never).start();

    expect(fsMocks.unlinkSync).not.toHaveBeenCalledWith(THREAD);
    expect(supersededPayload()).toBeNull();
  });

  it('still retires the file when its contents are unparseable', async () => {
    // Malformed content is not a reason to leave a false reading in place, and
    // it is not a reason to drop the evidence either.
    threadPresent(true);
    fsMocks.readFileSync.mockReturnValue('{ this is not json');

    await new AgentProcess('seat', mockEnv, { runtime: 'claude-code' } as never).start();

    expect(fsMocks.unlinkSync).toHaveBeenCalledWith(THREAD);
    const call = fsMocks.writeFileSync.mock.calls.find((c: unknown[]) => c[0] === SUPERSEDED);
    expect(call, 'unparseable content should still be preserved verbatim').toBeDefined();
    expect(String(call![1])).toContain('this is not json');
  });

  it('does not prevent the agent starting if retirement fails', async () => {
    // A seat that boots carrying a stale evidence file is bad. A seat that will
    // not boot at all is worse.
    threadPresent(true);
    fsMocks.writeFileSync.mockImplementation((p: string) => {
      if (p === SUPERSEDED) throw new Error('EACCES');
    });

    const ap = new AgentProcess('seat', mockEnv, { runtime: 'claude-code' } as never);
    await expect(ap.start()).resolves.not.toThrow();
    expect(mockPty.spawn).toHaveBeenCalled();
  });
});
