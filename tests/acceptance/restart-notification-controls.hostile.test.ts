import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pty = {
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

vi.mock('../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY() { return pty; },
}));

vi.mock('../../src/pty/codex-app-server-pty.js', () => ({
  CodexAppServerPTY: function CodexAppServerPTY() { return pty; },
}));

vi.mock('../../src/pty/hermes-pty.js', () => ({
  HermesPTY: function HermesPTY() { return pty; },
  hermesDbExists: vi.fn().mockReturnValue(false),
}));

vi.mock('../../src/pty/opencode-pty.js', () => ({
  OpencodePTY: function OpencodePTY() { return pty; },
  opencodeSessionExists: vi.fn().mockReturnValue(false),
}));

vi.mock('../../src/pty/inject.js', () => ({
  injectMessage: vi.fn(),
  MessageDedup: class { isDuplicate() { return false; } },
}));

vi.mock('../../src/utils/atomic.js', () => ({
  ensureDir: vi.fn(),
  atomicWriteSync: vi.fn(),
}));

vi.mock('../../src/utils/env.js', () => ({
  writeCortextosEnv: vi.fn(),
  resolveEnv: vi.fn().mockReturnValue({ instanceId: 'test', ctxRoot: '/tmp/test' }),
}));

vi.mock('../../src/bus/reminders.js', () => ({
  getOverdueReminders: vi.fn().mockReturnValue([]),
}));

vi.mock('../../src/utils/paths.js', () => ({
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
    get existsSync() { return fsMocks.existsSync; },
    get readFileSync() { return fsMocks.readFileSync; },
    get writeFileSync() { return fsMocks.writeFileSync; },
    get appendFileSync() { return fsMocks.appendFileSync; },
    get statSync() { return fsMocks.statSync; },
    get unlinkSync() { return fsMocks.unlinkSync; },
  };
});

const { AgentProcess } = await import('../../src/daemon/agent-process.js');

type Runtime = 'claude-code' | 'hermes' | 'codex-app-server' | 'opencode';

const runtimes: Runtime[] = ['claude-code', 'hermes', 'codex-app-server', 'opencode'];
// Only these two runtimes take the daemon-direct lifecycle push path; the
// others are hook-driven, so a "no push" assertion on them proves nothing.
const daemonPushRuntimes: Runtime[] = ['codex-app-server', 'opencode'];
const ownerChatId = '12345';

const frameworkRoot = '/tmp/hostile-notification-fw';
const org = 'acme';
const contextPath = `${frameworkRoot}/orgs/${org}/context.json`;
const handoffPath = '/tmp/guard-handoff.md';

/**
 * Lifecycle-Telegram authority is resolved from orgs/<org>/context.json — a
 * file a specialist seat does not own — and NOT from any value the seat
 * supplies about itself. These helpers stand that file up, or deliberately
 * withhold it, so the fixture exercises the real authority source.
 */
function withOrgContext(orchestrator: string | null, opts?: { handoff?: boolean }) {
  fsMocks.existsSync.mockImplementation((p: string) => {
    if (p === contextPath) return orchestrator !== null;
    if (opts?.handoff) return p.endsWith('.handoff-doc-path') || p === handoffPath;
    return false;
  });
  fsMocks.readFileSync.mockImplementation((p: string) => {
    if (p === contextPath) {
      if (orchestrator === null) throw new Error('ENOENT: no org context');
      return JSON.stringify({ orchestrator });
    }
    if (opts?.handoff && (p.endsWith('.handoff-doc-path') || p === handoffPath)) {
      return handoffPath;
    }
    throw new Error(`ENOENT: ${p}`);
  });
}

function expectNoOwnerSendImperative(prompt: string) {
  expect(prompt).not.toMatch(/send(?:ing)? (?:a )?telegram message to the user/i);
  expect(prompt).not.toContain('cortextos bus send-telegram');
  expect(prompt).not.toContain('$CTX_TELEGRAM_CHAT_ID');
}

function makeAgent(
  name: string,
  orchestratorClaim: string | undefined,
  runtime: Runtime,
  extraConfig: Record<string, unknown> = {},
) {
  const sendMessage = vi.fn().mockResolvedValue({ result: { message_id: 1 } });
  const agent = new AgentProcess(name, {
    instanceId: 'test',
    ctxRoot: '/tmp/hostile-notification-ctx',
    frameworkRoot,
    agentName: name,
    agentDir: `${frameworkRoot}/orgs/${org}/agents/${name}`,
    org,
    projectRoot: frameworkRoot,
    orchestrator: orchestratorClaim,
  }, { runtime, ...extraConfig });
  agent.setTelegramHandle({
    sendMessage,
    sendChatAction: vi.fn().mockResolvedValue(undefined),
  } as never, ownerChatId);
  return { agent, sendMessage };
}

/**
 * Drive the REAL startup path. Authority is computed inside start(), so a test
 * that only calls the prompt builder asserts against an uninitialised field
 * and would pass even if the gate were deleted. Asserting on the prompt handed
 * to pty.spawn also tests what the daemon actually sends, not a private helper.
 */
async function boot(
  name: string,
  orchestratorClaim: string | undefined,
  runtime: Runtime,
  extraConfig: Record<string, unknown> = {},
) {
  const { agent, sendMessage } = makeAgent(name, orchestratorClaim, runtime, extraConfig);
  await agent.start();
  const prompt = pty.spawn.mock.calls.at(-1)?.[1] as string;
  expect(prompt, 'pty.spawn was never called — startup path did not run').toBeTypeOf('string');
  return { agent, sendMessage, prompt };
}

beforeEach(() => {
  vi.clearAllMocks();
  pty.spawn.mockReset().mockResolvedValue(undefined);
  pty.isAlive.mockReturnValue(true);
  pty.getPid.mockReturnValue(4242);
  fsMocks.existsSync.mockReset().mockReturnValue(false);
  fsMocks.readFileSync.mockReset();
  withOrgContext('chief');
});

afterEach(() => {
  vi.clearAllTimers();
});

describe('ONE VOICE startup and lifecycle notification boundary', () => {
  describe('positive controls — the configured orchestrator keeps its voice', () => {
    // Exactly one sender per runtime is the whole point of the noise fix: the
    // daemon sends for daemon-push runtimes, the agent sends for the rest.
    // Asserting both halves is what catches a double-notification regression.
    it('daemon sends for the orchestrator on a daemon-push runtime, and the agent is told not to', async () => {
      const { sendMessage, prompt } = await boot('chief', 'chief', 'codex-app-server');

      expect(sendMessage).toHaveBeenCalledWith(ownerChatId, 'Agent chief is back online');
      expect(prompt).toContain('DAEMON LIFECYCLE OWNER');
      expectNoOwnerSendImperative(prompt);
    });

    it.each(['claude-code', 'hermes'] as Runtime[])(
      'agent sends for the orchestrator on hook-driven runtime %s, and the daemon does not',
      async (runtime) => {
        const { sendMessage, prompt } = await boot('chief', 'chief', runtime);

        expect(prompt).toContain('Send a Telegram message to the user saying you are back online.');
        expect(sendMessage).not.toHaveBeenCalled();
      },
    );

    it('preserves the orchestrator planned-restart owner notification', async () => {
      withOrgContext('chief', { handoff: true });
      const { sendMessage } = await boot('chief', 'chief', 'opencode');

      const texts = sendMessage.mock.calls.map((c) => c[1] as string);
      expect(texts.some((t) => /restarted \(planned\)/.test(t))).toBe(true);
      expect(texts).toContain('Agent chief is back online (context handoff)');
    });
  });

  describe('specialist suppression', () => {
    it.each(runtimes)('suppresses the fresh-start owner-send instruction for %s', async (runtime) => {
      const { prompt } = await boot('guard', 'chief', runtime);
      expectNoOwnerSendImperative(prompt);
    });

    it.each(runtimes)('suppresses the handoff first-action owner command for %s', async (runtime) => {
      withOrgContext('chief', { handoff: true });
      const { prompt } = await boot('guard', 'chief', runtime);

      expect(prompt).toContain('CONTEXT HANDOFF');
      expectNoOwnerSendImperative(prompt);
    });

    it.each(daemonPushRuntimes)('suppresses daemon-direct owner pushes for %s', async (runtime) => {
      const { sendMessage } = await boot('guard', 'chief', runtime);
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it.each(daemonPushRuntimes)(
      'suppresses daemon-direct planned-restart owner pushes for %s',
      async (runtime) => {
        withOrgContext('chief', { handoff: true });
        const { sendMessage } = await boot('guard', 'chief', runtime);
        expect(sendMessage).not.toHaveBeenCalled();
      },
    );
  });

  describe('authority is the org file, not the seat', () => {
    it('fails closed for a specialist when the org context is unreadable', async () => {
      withOrgContext(null);
      const { sendMessage, prompt } = await boot('guard', undefined, 'codex-app-server');

      expectNoOwnerSendImperative(prompt);
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('fails closed for the orchestrator itself when the org context is unreadable', async () => {
      withOrgContext(null);
      const { sendMessage, prompt } = await boot('chief', 'chief', 'codex-app-server');

      expectNoOwnerSendImperative(prompt);
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('does not let a specialist self-authorize by claiming to be the orchestrator', async () => {
      // context.json names chief; guard passes orchestrator: 'guard' about itself.
      withOrgContext('chief');
      const { sendMessage, prompt } = await boot('guard', 'guard', 'codex-app-server');

      expectNoOwnerSendImperative(prompt);
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('rejects a malformed orchestrator value rather than coercing it', async () => {
      withOrgContext('  chief  ');
      const { sendMessage, prompt } = await boot('chief', 'chief', 'codex-app-server');

      expectNoOwnerSendImperative(prompt);
      expect(sendMessage).not.toHaveBeenCalled();
    });
  });

  it('keeps the explicit Telegram-disabled control at zero owner pushes', async () => {
    const { sendMessage, prompt } = await boot('chief', 'chief', 'codex-app-server', {
      telegram_polling: false,
    });

    expectNoOwnerSendImperative(prompt);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('honours the per-agent lifecycle-notification opt-out for the orchestrator', async () => {
    const { sendMessage, prompt } = await boot('chief', 'chief', 'codex-app-server', {
      telegram_lifecycle_notifications: false,
    });

    expectNoOwnerSendImperative(prompt);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
