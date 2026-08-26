import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture the PTY exit handler so tests can simulate exits
let capturedOnExit: ((exitCode: number, signal?: number) => void) | null = null;

const mockPty = {
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn(),
  write: vi.fn(),
  getPid: vi.fn().mockReturnValue(12345),
  isAlive: vi.fn().mockReturnValue(true),
  onExit: vi.fn().mockImplementation((cb: (exitCode: number, signal?: number) => void) => {
    capturedOnExit = cb;
  }),
  getOutputBuffer: vi.fn().mockReturnValue({ isBootstrapped: vi.fn().mockReturnValue(false) }),
};

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY() { return mockPty; },
}));

// hermesDbExists is the key hook — we control it per-test
const mockHermesDbExists = vi.fn().mockReturnValue(false);

vi.mock('../../../src/pty/hermes-pty.js', () => ({
  HermesPTY: function HermesPTY() { return mockPty; },
  hermesDbExists: (...args: unknown[]) => mockHermesDbExists(...args),
}));

const mockInjectMessage = vi.fn();
vi.mock('../../../src/pty/inject.js', () => ({
  injectMessage: mockInjectMessage,
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
  agentName: 'hermes-agent',
  agentDir: '/tmp/fw/orgs/acme/agents/hermes-agent',
  org: 'acme',
  projectRoot: '/tmp/fw',
};

beforeEach(() => {
  capturedOnExit = null;
  mockHermesDbExists.mockReset().mockReturnValue(false);
  mockPty.spawn.mockClear();
  mockPty.kill.mockClear();
  mockPty.write.mockClear();
  mockPty.isAlive.mockReset().mockReturnValue(true);
  mockPty.onExit.mockClear();
  mockInjectMessage.mockClear();
  fsMocks.existsSync.mockReset().mockReturnValue(false);
  fsMocks.readFileSync.mockReset();
  fsMocks.writeFileSync.mockReset();
  fsMocks.appendFileSync.mockReset();
  fsMocks.statSync.mockReset();
  fsMocks.unlinkSync.mockReset();
});

describe('AgentProcess - Hermes runtime: shouldContinue', () => {
  it('spawns in fresh mode when Hermes state.db does not exist', async () => {
    mockHermesDbExists.mockReturnValue(false);
    const ap = new AgentProcess('hermes-agent', mockEnv, {
      runtime: 'hermes', hermes_profile: 'hermes-agent',
    });
    await ap.start();
    expect(mockPty.spawn).toHaveBeenCalledWith('fresh', expect.any(String));
  });

  it('spawns in continue mode when Hermes state.db exists', async () => {
    mockHermesDbExists.mockReturnValue(true);
    const ap = new AgentProcess('hermes-agent', mockEnv, {
      runtime: 'hermes', hermes_profile: 'hermes-agent',
    });
    await ap.start();
    expect(mockPty.spawn).toHaveBeenCalledWith('continue', expect.any(String));
  });

  it('checks the configured profile under the Hermes root', async () => {
    const originalHermesHome = process.env['HERMES_HOME'];
    process.env['HERMES_HOME'] = '/custom/hermes';
    mockHermesDbExists.mockReturnValue(false);

    const ap = new AgentProcess('hermes-agent', mockEnv, {
      runtime: 'hermes', hermes_profile: 'hermes-agent',
    });
    await ap.start();

    expect(mockHermesDbExists).toHaveBeenCalledWith('hermes-agent', '/custom/hermes', 'hermes-agent');
    process.env['HERMES_HOME'] = originalHermesHome;
  });

  it('passes the agent name as a safe fallback for legacy configs without hermes_profile', async () => {
    const ap = new AgentProcess('hermes-agent', mockEnv, { runtime: 'hermes' });
    await ap.start();

    expect(mockHermesDbExists).toHaveBeenCalledWith(undefined, process.env['HERMES_HOME'], 'hermes-agent');
    expect(mockPty.spawn).toHaveBeenCalledWith('fresh', expect.any(String));
  });

  it('contains invalid Hermes profile validation to this seat during startup', async () => {
    mockHermesDbExists.mockImplementation(() => { throw new Error('invalid profile'); });
    const ap = new AgentProcess('hermes-agent', mockEnv, {
      runtime: 'hermes', hermes_profile: '../shared',
    });

    await expect(ap.start()).resolves.toBeUndefined();
    expect(mockPty.spawn).toHaveBeenCalledWith('fresh', expect.any(String));
  });

  it('honors .force-fresh before checking the Hermes profile database', async () => {
    const marker = '/tmp/test-ctx/state/hermes-agent/.force-fresh';
    fsMocks.existsSync.mockImplementation((path: string) => path === marker);
    mockHermesDbExists.mockReturnValue(true);

    const ap = new AgentProcess('hermes-agent', mockEnv, {
      runtime: 'hermes', hermes_profile: 'hermes-agent',
    });
    await ap.start();

    expect(mockPty.spawn).toHaveBeenCalledWith('fresh', expect.any(String));
    expect(fsMocks.unlinkSync).toHaveBeenCalledWith(marker);
    expect(mockHermesDbExists).not.toHaveBeenCalled();
  });
});

describe('AgentProcess - Hermes runtime: stop uses Ctrl+D', () => {
  it('sends Ctrl+D (not /exit) when stopping a hermes agent', async () => {
    const ap = new AgentProcess('hermes-agent', mockEnv, {
      runtime: 'hermes', hermes_profile: 'hermes-agent',
    });
    await ap.start();
    expect(capturedOnExit).not.toBeNull();

    const stopPromise = ap.stop();
    await new Promise(r => setTimeout(r, 100));

    // Ctrl+D should have been written, not /exit\r\n
    const writeCalls = mockPty.write.mock.calls.map((c: string[]) => c[0]);
    expect(writeCalls).toContain('\x04');
    expect(writeCalls).not.toContain('/exit\r\n');

    capturedOnExit!(0, 0);
    await stopPromise;
  }, 10000);
});
