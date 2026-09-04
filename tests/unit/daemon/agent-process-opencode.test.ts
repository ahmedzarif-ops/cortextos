import { describe, it, expect, vi, beforeEach } from 'vitest';

let capturedOnExit: ((exitCode: number, signal?: number) => void) | null = null;

const mockOpencodePty = {
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn(),
  write: vi.fn(),
  getPid: vi.fn().mockReturnValue(13579),
  isAlive: vi.fn().mockReturnValue(true),
  onExit: vi.fn().mockImplementation((cb: (exitCode: number, signal?: number) => void) => {
    capturedOnExit = cb;
  }),
  getOutputBuffer: vi.fn().mockReturnValue({ isBootstrapped: vi.fn().mockReturnValue(true) }),
};

const mockAgentPty = {
  ...mockOpencodePty,
  getPid: vi.fn().mockReturnValue(12345),
  // CodexAppServerPTY exposes setTelegramHandle; start() calls it when a codex
  // agent has a Telegram handle wired (src/daemon/agent-process.ts).
  setTelegramHandle: vi.fn(),
};

const mockOpencodeSessionExists = vi.fn().mockReturnValue(false);

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY() { return mockAgentPty; },
}));

vi.mock('../../../src/pty/codex-app-server-pty.js', () => ({
  CodexAppServerPTY: function CodexAppServerPTY() { return mockAgentPty; },
}));

vi.mock('../../../src/pty/hermes-pty.js', () => ({
  HermesPTY: function HermesPTY() { return mockAgentPty; },
  hermesDbExists: vi.fn().mockReturnValue(false),
}));

vi.mock('../../../src/pty/opencode-pty.js', () => ({
  OpencodePTY: function OpencodePTY() { return mockOpencodePty; },
  opencodeSessionExists: (...args: unknown[]) => mockOpencodeSessionExists(...args),
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
};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
    get existsSync() { return fsMocks.existsSync; },
    get readFileSync() { return fsMocks.readFileSync; },
    get writeFileSync() { return fsMocks.writeFileSync; },
    get appendFileSync() { return fsMocks.appendFileSync; },
    get statSync() { return fsMocks.statSync; },
  };
});

const { AgentProcess } = await import('../../../src/daemon/agent-process.js');

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/test-ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'opencode-agent',
  agentDir: '/tmp/fw/orgs/acme/agents/opencode-agent',
  org: 'acme',
  projectRoot: '/tmp/fw',
};

const contextPath = '/tmp/fw/orgs/acme/context.json';

function envFor(name: string) {
  return {
    ...mockEnv,
    agentName: name,
    agentDir: `/tmp/fw/orgs/acme/agents/${name}`,
  };
}

function readWithOrchestrator(
  orchestrator: unknown,
  fallback: (path: string) => string = () => '',
) {
  fsMocks.readFileSync.mockImplementation((path: string) =>
    path === contextPath ? JSON.stringify({ orchestrator }) : fallback(path),
  );
}

beforeEach(() => {
  capturedOnExit = null;
  for (const pty of [mockOpencodePty, mockAgentPty]) {
    pty.spawn.mockClear();
    pty.kill.mockClear();
    pty.write.mockClear();
    pty.getPid.mockClear();
    pty.isAlive.mockReset().mockReturnValue(true);
    pty.onExit.mockClear();
    pty.getOutputBuffer.mockClear();
  }
  mockOpencodeSessionExists.mockReset().mockReturnValue(false);
  fsMocks.existsSync.mockReset().mockReturnValue(false);
  fsMocks.readFileSync.mockReset();
  fsMocks.writeFileSync.mockReset();
  fsMocks.appendFileSync.mockReset();
  fsMocks.statSync.mockReset();
});

describe('AgentProcess opencode runtime', () => {
  it('selects OpencodePTY for runtime opencode', async () => {
    const ap = new AgentProcess('opencode-agent', mockEnv, { runtime: 'opencode' });
    await ap.start();

    expect(mockOpencodePty.spawn).toHaveBeenCalledWith('fresh', expect.any(String));
    expect(ap.getStatus().pid).toBe(13579);
  });

  it('uses opencode session marker for continue mode', async () => {
    mockOpencodeSessionExists.mockReturnValue(true);
    const ap = new AgentProcess('opencode-agent', mockEnv, { runtime: 'opencode' });
    await ap.start();

    expect(mockOpencodeSessionExists).toHaveBeenCalledWith('/tmp/test-ctx', 'opencode-agent');
    expect(mockOpencodePty.spawn).toHaveBeenCalledWith('continue', expect.any(String));
  });

  it('preserves telegram_polling false as a Chief prompt and runtime opt-out', async () => {
    readWithOrchestrator('chief');
    const ap = new AgentProcess('chief', envFor('chief'), {
      runtime: 'opencode',
      telegram_polling: false,
    });
    const sendMessage = vi.fn().mockResolvedValue(undefined);

    ap.setTelegramHandle({ sendChatAction: vi.fn().mockResolvedValue(undefined), sendMessage } as any, '12345');
    await ap.start();

    const prompt = mockOpencodePty.spawn.mock.calls[0]?.[1] ?? '';
    expect(prompt).not.toContain('send a Telegram message');
    expect(prompt).not.toContain('Send a Telegram message');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('keeps the configured Chief fresh-start prompt send-free because the daemon owns it', async () => {
    readWithOrchestrator('chief');
    const ap = new AgentProcess('chief', envFor('chief'), { runtime: 'opencode' });

    ap.setTelegramHandle({ sendChatAction: vi.fn().mockResolvedValue(undefined) } as any, '12345');
    await ap.start();

    const prompt = mockOpencodePty.spawn.mock.calls[0]?.[1] ?? '';
    expect(prompt).toContain('DAEMON LIFECYCLE OWNER');
    expect(prompt).not.toContain('Send a Telegram message to the user saying you are back online.');
    expect(prompt).not.toContain('ONE VOICE LIFECYCLE GATE');
  });

  it('sends daemon-direct back-online Telegram for configured Chief on fresh start', async () => {
    readWithOrchestrator('chief');
    const ap = new AgentProcess('chief', envFor('chief'), { runtime: 'opencode' });
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const api = { sendChatAction: vi.fn().mockResolvedValue(undefined), sendMessage };

    ap.setTelegramHandle(api as any, '12345');
    await ap.start();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith('12345', 'Agent chief is back online');
  });

  it('leaves opencode crash-recovery back-online to AgentManager (no AgentProcess duplicate)', async () => {
    readWithOrchestrator('chief');
    const ap = new AgentProcess('chief', envFor('chief'), { runtime: 'opencode' });
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    ap.setTelegramHandle({ sendChatAction: vi.fn().mockResolvedValue(undefined), sendMessage } as any, '12345');
    (ap as any).status = 'crashed';
    await ap.start();

    const prompt = mockOpencodePty.spawn.mock.calls[0]?.[1] ?? '';
    expect(prompt).toContain('DAEMON LIFECYCLE OWNER');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('keeps the configured Chief continue prompt send-free because the daemon owns it', async () => {
    readWithOrchestrator('chief');
    mockOpencodeSessionExists.mockReturnValue(true);
    const ap = new AgentProcess('chief', envFor('chief'), { runtime: 'opencode' });

    ap.setTelegramHandle({ sendChatAction: vi.fn().mockResolvedValue(undefined) } as any, '12345');
    await ap.start();

    const prompt = mockOpencodePty.spawn.mock.calls[0]?.[1] ?? '';
    expect(mockOpencodePty.spawn).toHaveBeenCalledWith('continue', expect.any(String));
    expect(prompt).toContain('DAEMON LIFECYCLE OWNER');
    expect(prompt).not.toContain('After checking inbox, send a Telegram message to the user saying you are back online.');
    expect(prompt).not.toContain('ONE VOICE LIFECYCLE GATE');
  });

  it('sends daemon-direct back-online Telegram for configured Chief on continue start', async () => {
    readWithOrchestrator('chief');
    mockOpencodeSessionExists.mockReturnValue(true);
    const ap = new AgentProcess('chief', envFor('chief'), { runtime: 'opencode' });
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const api = { sendChatAction: vi.fn().mockResolvedValue(undefined), sendMessage };

    ap.setTelegramHandle(api as any, '12345');
    await ap.start();

    expect(mockOpencodePty.spawn).toHaveBeenCalledWith('continue', expect.any(String));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith('12345', 'Agent chief is back online');
  });

  it('silences prompt and daemon lifecycle Telegram on opencode continue when explicitly disabled', async () => {
    readWithOrchestrator('chief');
    mockOpencodeSessionExists.mockReturnValue(true);
    const ap = new AgentProcess('chief', envFor('chief'), {
      runtime: 'opencode',
      telegram_lifecycle_notifications: false,
    });
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const api = { sendChatAction: vi.fn().mockResolvedValue(undefined), sendMessage };

    ap.setTelegramHandle(api as any, '12345');
    await ap.start();

    const prompt = mockOpencodePty.spawn.mock.calls[0]?.[1] ?? '';
    expect(mockOpencodePty.spawn).toHaveBeenCalledWith('continue', expect.any(String));
    expect(prompt).toContain('ONE VOICE LIFECYCLE GATE');
    expect(prompt).not.toContain('send a Telegram message to the user saying you are back online.');
    expect(prompt).not.toContain('Send a Telegram message to the user saying you are back online.');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('lets the daemon send both opencode handoff notices for configured Chief', async () => {
    const handoffDocPath = '/tmp/opencode-handoff.md';
    fsMocks.existsSync.mockImplementation((path: string) =>
      typeof path === 'string'
      && (path.endsWith('.handoff-doc-path')
        || path.endsWith('.restart-planned')
        || path === handoffDocPath),
    );
    readWithOrchestrator('chief', (path) =>
      path.endsWith('.restart-planned') ? 'context handoff at 92%\n' : handoffDocPath,
    );

    const ap = new AgentProcess('chief', envFor('chief'), { runtime: 'opencode' });
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const api = { sendChatAction: vi.fn().mockResolvedValue(undefined), sendMessage };

    ap.setTelegramHandle(api as any, '12345');
    await ap.start();

    const prompt = mockOpencodePty.spawn.mock.calls[0]?.[1] ?? '';
    expect(prompt).toContain('CONTEXT HANDOFF');
    expect(prompt).toContain('HANDOFF UX');
    expect(prompt).toContain('The daemon owns the lifecycle notification for this restart');
    expect(prompt).not.toContain('VERY FIRST tool call MUST be a Bash call running');
    expect(prompt).not.toContain('cortextos bus send-telegram');
    // msg1: hook parity — codex/opencode don't run Claude Code hooks, so the
    // daemon emits the planned-restart lifecycle notif itself.
    expect(sendMessage).toHaveBeenNthCalledWith(1, '12345', '🔄 chief restarted (planned): context handoff at 92%');
    // msg2: daemon-owned too. The prompt is forbidden from adding a third.
    expect(sendMessage).toHaveBeenNthCalledWith(2, '12345', 'Agent chief is back online (context handoff)');
    expect(sendMessage).not.toHaveBeenCalledWith('12345', 'Agent chief is back online');
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('preserves opencode handoff recovery without any lifecycle Telegram when explicitly disabled', async () => {
    const handoffDocPath = '/tmp/opencode-handoff.md';
    fsMocks.existsSync.mockImplementation((path: string) =>
      typeof path === 'string'
      && (path.endsWith('.handoff-doc-path')
        || path.endsWith('.restart-planned')
        || path === handoffDocPath),
    );
    readWithOrchestrator('chief', (path) =>
      path.endsWith('.restart-planned') ? 'context handoff at 92%\n' : handoffDocPath,
    );

    const ap = new AgentProcess('chief', envFor('chief'), {
      runtime: 'opencode',
      telegram_lifecycle_notifications: false,
    });
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const api = { sendChatAction: vi.fn().mockResolvedValue(undefined), sendMessage };

    ap.setTelegramHandle(api as any, '12345');
    await ap.start();

    const prompt = mockOpencodePty.spawn.mock.calls[0]?.[1] ?? '';
    expect(prompt).toContain('CONTEXT HANDOFF');
    expect(prompt).toContain('ONE VOICE LIFECYCLE GATE');
    expect(prompt).not.toContain('HANDOFF UX');
    expect(prompt).not.toContain('cortextos bus send-telegram');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('lets the daemon send codex msg1 and msg2 exactly once each on handoff restart', async () => {
    const handoffDocPath = '/tmp/codex-handoff.md';
    fsMocks.existsSync.mockImplementation((path: string) =>
      typeof path === 'string'
      && (path.endsWith('.handoff-doc-path')
        || path.endsWith('.restart-planned')
        || path === handoffDocPath),
    );
    readWithOrchestrator('chief', (path) =>
      path.endsWith('.restart-planned') ? 'context handoff at 88%\n' : handoffDocPath,
    );

    const ap = new AgentProcess('chief', envFor('chief'), { runtime: 'codex-app-server' });
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const api = { sendChatAction: vi.fn().mockResolvedValue(undefined), sendMessage };

    ap.setTelegramHandle(api as any, '12345');
    await ap.start();

    const prompt = mockAgentPty.spawn.mock.calls[0]?.[1] ?? '';
    expect(prompt).not.toContain('cortextos bus send-telegram');
    // msg1: daemon-emitted hook parity, same as opencode.
    expect(sendMessage).toHaveBeenNthCalledWith(1, '12345', '🔄 chief restarted (planned): context handoff at 88%');
    // msg2: daemon-owned; the prompt no longer self-sends "back —", so this is
    // exactly two messages, never three.
    expect(sendMessage).toHaveBeenNthCalledWith(2, '12345', 'Agent chief is back online (context handoff)');
    expect(sendMessage).not.toHaveBeenCalledWith('12345', 'Agent chief is back online');
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('keeps a Telegram-enabled specialist fresh start silent', async () => {
    readWithOrchestrator('chief');
    const ap = new AgentProcess('growth', envFor('growth'), { runtime: 'opencode' });
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    ap.setTelegramHandle({ sendChatAction: vi.fn(), sendMessage } as any, '12345');
    await ap.start();

    const prompt = mockOpencodePty.spawn.mock.calls[0]?.[1] ?? '';
    expect(prompt).toContain('ONE VOICE LIFECYCLE GATE');
    expect(prompt).not.toContain('Send a Telegram message to the user saying you are back online.');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does not use Claude /exit choreography on stop', async () => {
    const ap = new AgentProcess('opencode-agent', mockEnv, { runtime: 'opencode' });
    await ap.start();
    expect(capturedOnExit).not.toBeNull();

    const stopPromise = ap.stop();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const writes = mockOpencodePty.write.mock.calls.map((call: string[]) => call[0]);
    expect(writes).toContain('\x03');
    expect(writes).not.toContain('/exit\r\n');

    capturedOnExit!(0, 0);
    await stopPromise;
  }, 10000);
});
