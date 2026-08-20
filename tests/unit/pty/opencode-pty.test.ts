import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'path';
import { homedir } from 'os';

const fsMocks = {
  existsSync: vi.fn().mockReturnValue(false),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn().mockReturnValue([]),
  copyFileSync: vi.fn(),
};
const secretPermissionMocks = {
  restrictSecretFile: vi.fn(),
};

let spawnCall: { file: string; args: string[]; options: any } | null = null;
const mockPty = {
  pid: 42,
  write: vi.fn(),
  onData: vi.fn(),
  onExit: vi.fn(),
  kill: vi.fn(),
  resize: vi.fn(),
};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    get existsSync() { return fsMocks.existsSync; },
    get mkdirSync() { return fsMocks.mkdirSync; },
    get writeFileSync() { return fsMocks.writeFileSync; },
    get unlinkSync() { return fsMocks.unlinkSync; },
    get readFileSync() { return fsMocks.readFileSync; },
    get readdirSync() { return fsMocks.readdirSync; },
    get copyFileSync() { return fsMocks.copyFileSync; },
  };
});

vi.mock('node-pty', () => ({
  spawn: vi.fn().mockImplementation((file: string, args: string[], options: any) => {
    spawnCall = { file, args, options };
    return mockPty;
  }),
}));

vi.mock('../../../src/platform/secret-permissions.js', () => ({
  restrictSecretFile: secretPermissionMocks.restrictSecretFile,
}));

const { OpencodePTY, opencodeSessionExists, resolveOpencodeBinary } = await import('../../../src/pty/opencode-pty.js');
const { terminateProcessTree } = await import('../../../src/platform/process.js');

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'opencode-agent',
  agentDir: '/tmp/fw/orgs/acme/agents/opencode-agent',
  org: 'acme',
  projectRoot: '/tmp/fw',
};
const expectedAgentConfigDir = join(mockEnv.agentDir, '.opencode');
const expectedAgentEnv = join(mockEnv.agentDir, '.env');
const expectedOrgSecrets = join(mockEnv.projectRoot, 'orgs', mockEnv.org, 'secrets.env');
const expectedStateDir = join(mockEnv.ctxRoot, 'state', mockEnv.agentName);
const expectedOpencodeRoot = join(expectedStateDir, 'opencode');
const expectedProcessMarker = join(expectedStateDir, 'opencode-process.json');
const expectedSessionMarker = join(expectedStateDir, 'opencode-session.json');

beforeEach(() => {
  spawnCall = null;
  mockPty.write.mockClear();
  mockPty.onData.mockClear();
  mockPty.onExit.mockClear();
  mockPty.kill.mockClear();
  fsMocks.existsSync.mockReset().mockReturnValue(false);
  fsMocks.mkdirSync.mockReset();
  fsMocks.writeFileSync.mockReset();
  fsMocks.unlinkSync.mockReset();
  fsMocks.readFileSync.mockReset();
  fsMocks.readdirSync.mockReset().mockReturnValue([]);
  fsMocks.copyFileSync.mockReset();
  secretPermissionMocks.restrictSecretFile.mockReset();
});

describe('OpencodePTY', () => {
  function installSpawnMock(pty: OpencodePTY): void {
    (pty as unknown as { spawnFn: typeof mockSpawn }).spawnFn = mockSpawn;
  }

  const mockSpawn = (file: string, args: string[], options: any) => {
    spawnCall = { file, args, options };
    return mockPty;
  };

  it('returns opencode as the binary name', () => {
    const pty = new OpencodePTY(mockEnv, {});
    expect((pty as unknown as { getBinaryName(): string }).getBinaryName()).toBe('opencode');
  });

  it('resolves the official npm package native executable on Windows', () => {
    const npmBin = 'C:\\ProgramData\\cortextos\\npm-global';
    const nativeExe = `${npmBin}\\node_modules\\opencode-ai\\bin\\opencode.exe`;

    expect(resolveOpencodeBinary('win32', npmBin, (candidate) => candidate === nativeExe))
      .toBe(nativeExe);
  });

  it('builds fresh args with --model and --agent but no launch-time prompt', () => {
    const pty = new OpencodePTY(mockEnv, {
      model: 'anthropic/claude-sonnet-4',
      opencode_agent: 'build',
    });
    const args = (pty as unknown as { buildClaudeArgs(m: string, p: string): string[] })
      .buildClaudeArgs('fresh', 'hello');

    expect(args).toEqual([
      '--model', 'anthropic/claude-sonnet-4',
      '--agent', 'build',
    ]);
  });

  it('adds --continue in continue mode without passing a launch-time prompt', () => {
    const pty = new OpencodePTY(mockEnv, {});
    const args = (pty as unknown as { buildClaudeArgs(m: string, p: string): string[] })
      .buildClaudeArgs('continue', 'resume me');

    expect(args).toEqual(['--continue']);
  });

  it('starts the persistent TUI without a launch-time prompt', async () => {
    const pty = new OpencodePTY(mockEnv, {
      model: 'openai/gpt-4.1-nano',
      opencode_agent: 'build',
    });
    installSpawnMock(pty);
    await pty.spawn('fresh', 'boot prompt');

    expect(spawnCall?.args).toEqual([
      '--model', 'openai/gpt-4.1-nano',
      '--agent', 'build',
    ]);
  });

  it('sets OPENCODE_CONFIG_DIR under the agent directory when spawning', async () => {
    const pty = new OpencodePTY(mockEnv, {});
    installSpawnMock(pty);
    await pty.spawn('fresh', 'boot');

    expect(spawnCall?.file).toBe('opencode');
    expect(spawnCall?.options.env.OPENCODE_CONFIG_DIR)
      .toBe(expectedAgentConfigDir);
  });

  it('isolates OpenCode data, config, state, and cache under cortextOS agent state', async () => {
    const pty = new OpencodePTY(mockEnv, {});
    installSpawnMock(pty);
    await pty.spawn('fresh', 'boot');

    expect(spawnCall?.options.env.XDG_DATA_HOME)
      .toBe(join(expectedOpencodeRoot, 'data'));
    expect(spawnCall?.options.env.XDG_CONFIG_HOME)
      .toBe(join(expectedOpencodeRoot, 'config'));
    expect(spawnCall?.options.env.XDG_STATE_HOME)
      .toBe(join(expectedOpencodeRoot, 'state'));
    expect(spawnCall?.options.env.XDG_CACHE_HOME)
      .toBe(join(expectedOpencodeRoot, 'cache'));
  });

  it('seeds missing isolated OpenCode auth from the native user login without exposing it', async () => {
    const homeAuth = join(homedir(), '.local', 'share', 'opencode', 'auth.json');
    const isolatedAuth = join(expectedOpencodeRoot, 'data', 'opencode', 'auth.json');
    fsMocks.existsSync.mockImplementation((path: string) => path === homeAuth);

    const pty = new OpencodePTY(mockEnv, {});
    installSpawnMock(pty);
    await pty.spawn('fresh', '');

    expect(fsMocks.copyFileSync).toHaveBeenCalledWith(homeAuth, isolatedAuth);
    expect(secretPermissionMocks.restrictSecretFile).toHaveBeenCalledWith(isolatedAuth);
  });

  it('preserves an existing isolated OpenCode credential instead of overwriting it', async () => {
    const homeAuth = join(homedir(), '.local', 'share', 'opencode', 'auth.json');
    const isolatedAuth = join(expectedOpencodeRoot, 'data', 'opencode', 'auth.json');
    fsMocks.existsSync.mockImplementation((path: string) =>
      path === homeAuth || path === isolatedAuth);

    const pty = new OpencodePTY(mockEnv, {});
    installSpawnMock(pty);
    await pty.spawn('fresh', '');

    expect(fsMocks.copyFileSync).not.toHaveBeenCalled();
  });

  it('overrides inherited XDG roots so OpenCode state stays agent-isolated by default', async () => {
    fsMocks.existsSync.mockImplementation((path: string) => path === expectedAgentEnv);
    fsMocks.readFileSync.mockImplementation((path: string) => {
      if (path === expectedAgentEnv) {
        return [
          'XDG_DATA_HOME=/global/data',
          'XDG_CONFIG_HOME=/global/config',
          'XDG_STATE_HOME=/global/state',
          'XDG_CACHE_HOME=/global/cache',
          '',
        ].join('\n');
      }
      return '';
    });

    const pty = new OpencodePTY(mockEnv, {});
    installSpawnMock(pty);
    await pty.spawn('fresh', 'boot');

    expect(spawnCall?.options.env.XDG_DATA_HOME)
      .toBe(join(expectedOpencodeRoot, 'data'));
    expect(spawnCall?.options.env.XDG_CONFIG_HOME)
      .toBe(join(expectedOpencodeRoot, 'config'));
    expect(spawnCall?.options.env.XDG_STATE_HOME)
      .toBe(join(expectedOpencodeRoot, 'state'));
    expect(spawnCall?.options.env.XDG_CACHE_HOME)
      .toBe(join(expectedOpencodeRoot, 'cache'));
  });

  it('supports an explicit OPENCODE_XDG_ROOT override for custom isolated roots', async () => {
    fsMocks.existsSync.mockImplementation((path: string) => path === expectedAgentEnv);
    fsMocks.readFileSync.mockImplementation((path: string) => {
      if (path === expectedAgentEnv) {
        return 'OPENCODE_XDG_ROOT=/custom/opencode\n';
      }
      return '';
    });

    const pty = new OpencodePTY(mockEnv, {});
    installSpawnMock(pty);
    await pty.spawn('fresh', 'boot');

    expect(spawnCall?.options.env.XDG_DATA_HOME).toBe(join('/custom/opencode', 'data'));
    expect(spawnCall?.options.env.XDG_CONFIG_HOME).toBe(join('/custom/opencode', 'config'));
    expect(spawnCall?.options.env.XDG_STATE_HOME).toBe(join('/custom/opencode', 'state'));
    expect(spawnCall?.options.env.XDG_CACHE_HOME).toBe(join('/custom/opencode', 'cache'));
  });

  it('keeps OPENCODE_CONFIG_DIR under the agent directory even when working_directory differs', async () => {
    // AgentPTY now validates a non-empty working_directory via super.spawn's
    // existsSync check, so the configured path must resolve as present.
    fsMocks.existsSync.mockImplementation((p: string) => p === '/tmp/project-checkout');
    const pty = new OpencodePTY(mockEnv, { working_directory: '/tmp/project-checkout' });
    installSpawnMock(pty);
    await pty.spawn('fresh', 'boot');

    expect(spawnCall?.options.cwd).toBe('/tmp/project-checkout');
    expect(spawnCall?.options.env.OPENCODE_CONFIG_DIR)
      .toBe(expectedAgentConfigDir);
  });

  it('maps GEMINI_API_KEY to OpenCode Google provider env name when needed', async () => {
    fsMocks.existsSync.mockImplementation((path: string) => path === expectedOrgSecrets);
    fsMocks.readFileSync.mockImplementation((path: string) => {
      if (path === expectedOrgSecrets) return 'GEMINI_API_KEY=gemini-secret\n';
      return '';
    });

    const pty = new OpencodePTY(mockEnv, {});
    installSpawnMock(pty);
    await pty.spawn('fresh', 'boot');

    expect(spawnCall?.options.env.GOOGLE_GENERATIVE_AI_API_KEY).toBe('gemini-secret');
  });

  it('writes a session marker but does not bootstrap before real TUI readiness', async () => {
    const pty = new OpencodePTY(mockEnv, {});
    installSpawnMock(pty);
    await pty.spawn('fresh', 'boot');

    expect(fsMocks.mkdirSync).toHaveBeenCalledWith(expectedStateDir, { recursive: true });
    expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
      expectedSessionMarker,
      expect.stringContaining('"runtime": "opencode"'),
      'utf-8',
    );
    expect(pty.getOutputBuffer().isBootstrapped()).toBe(false);

    pty.getOutputBuffer().push('Ask anything');
    expect(pty.getOutputBuffer().isBootstrapped()).toBe(true);

    const currentTui = new OpencodePTY(mockEnv, {});
    expect(currentTui.getOutputBuffer().isBootstrapped()).toBe(false);
    currentTui.getOutputBuffer().push('ctrl+p commands');
    expect(currentTui.getOutputBuffer().isBootstrapped()).toBe(true);
  });

  it('does not inherit Claude fallback readiness without OpenCode chat chrome', async () => {
    vi.useFakeTimers();
    try {
      const pty = new OpencodePTY(mockEnv, {});
      installSpawnMock(pty);
      await pty.spawn('fresh', '');
      pty.getOutputBuffer().push('OpenCode rendered frame\n');

      await vi.advanceTimersByTimeAsync(15_000);
      expect(pty.isReadyForMessages()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('injects the startup prompt only after real TUI output is quiescent', async () => {
    vi.useFakeTimers();
    try {
      const pty = new OpencodePTY(mockEnv, {});
      installSpawnMock(pty);
      await pty.spawn('fresh', 'boot prompt');

      expect(mockPty.write).not.toHaveBeenCalled();
      pty.getOutputBuffer().push('OpenCode rendered frame\n');
      await vi.advanceTimersByTimeAsync(STARTUP_TICKS(9));

      const written = mockPty.write.mock.calls.map((call) => call[0]).join('');
      expect(written).toContain('boot prompt');
      expect(written).toContain('[OPENCODE STARTUP EXECUTION REQUIREMENT]');
      expect(written).toContain('Execute it now as the next model turn');

      await vi.advanceTimersByTimeAsync(300);
      expect(mockPty.write.mock.calls.at(-1)?.[0]).toBe('\r');
    } finally {
      vi.useRealTimers();
    }
  });

  it('submits the startup prompt reliably across repeated fresh boots', async () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 4; i++) {
        const pty = new OpencodePTY(mockEnv, {});
        installSpawnMock(pty);
        await pty.spawn('fresh', `handoff prompt ${i}`);

        pty.getOutputBuffer().push('Ask anything\n');
        await vi.advanceTimersByTimeAsync(STARTUP_TICKS(1));
        await vi.advanceTimersByTimeAsync(150);
        await vi.advanceTimersByTimeAsync(300);
      }

      const writes = mockPty.write.mock.calls.map((call) => call[0]);
      for (let i = 0; i < 4; i++) {
        expect(writes).toContainEqual(expect.stringContaining(`handoff prompt ${i}`));
      }
      expect(writes.filter((write) => write === '\r')).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('injects inbound messages as raw control-stripped text for the OpenCode TUI', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const pty = new OpencodePTY(mockEnv, {});
      installSpawnMock(pty);
      await pty.spawn('fresh', '');
      mockPty.write.mockClear();

      pty.injectMessage('hello\x1b[31m red\rthere');

      // Esc fires first (synchronously) to exit any lingering OpenCode shell mode.
      expect(mockPty.write).toHaveBeenCalledTimes(1);
      expect(mockPty.write.mock.calls[0][0]).toBe('\x1b');

      // Content is typed after the shell-reset settle delay.
      await vi.advanceTimersByTimeAsync(150);
      expect(mockPty.write.mock.calls[1][0]).toBe('hello red\nthere');
      expect(mockPty.write.mock.calls[1][0]).not.toContain('\x1b[200~');
      expect(mockPty.write.mock.calls[1][0]).not.toContain('\x1b[201~');

      // Enter is submitted after the existing 300ms deferral.
      await vi.advanceTimersByTimeAsync(300);
      expect(mockPty.write.mock.calls.at(-1)?.[0]).toBe('\r');
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('adds a strict Telegram send requirement for OpenCode Telegram inbound', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const pty = new OpencodePTY(mockEnv, {});
      installSpawnMock(pty);
      await pty.spawn('fresh', '');
      mockPty.write.mockClear();

      pty.injectMessage([
        '=== TELEGRAM from [USER: James] (chat_id:7940429114) ===',
        '```',
        'Yo',
        '```',
        "Reply using: cortextos bus send-telegram 7940429114 '<your reply>'",
      ].join('\n'));

      // Esc fires first to exit shell mode, then content after the settle delay.
      expect(mockPty.write.mock.calls[0][0]).toBe('\x1b');
      await vi.advanceTimersByTimeAsync(150);

      const written = mockPty.write.mock.calls[1][0];
      expect(written).toContain('=== TELEGRAM from [USER: James] (chat_id:7940429114) ===');
      expect(written).toContain('[OPENCODE TELEGRAM DELIVERY REQUIREMENT]');
      expect(written).toContain("cortextos bus send-telegram 7940429114 '<your reply>'");
      expect(written).toContain('A plain answer printed only in the OpenCode TUI is NOT delivered');

      await vi.advanceTimersByTimeAsync(300);
      expect(mockPty.write.mock.calls.at(-1)?.[0]).toBe('\r');
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('elevates Telegram reply target context for ambiguous OpenCode follow-ups', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const pty = new OpencodePTY(mockEnv, {});
      installSpawnMock(pty);
      await pty.spawn('fresh', '');
      mockPty.write.mockClear();

      pty.injectMessage([
        '=== TELEGRAM from [USER: James] (chat_id:7940429114) ===',
        '[Replying to: "Code review done — 95 files, ~18.5k lines analyzed. Full HTML breakdown attached.\\n[document: hermes-memory-review.html]"]',
        '```',
        "what's this?",
        '```',
        "Reply using: cortextos bus send-telegram 7940429114 '<your reply>'",
      ].join('\n'));

      expect(mockPty.write.mock.calls[0][0]).toBe('\x1b');
      await vi.advanceTimersByTimeAsync(150);

      const written = mockPty.write.mock.calls[1][0];
      expect(written).toContain('[OPENCODE REPLY TARGET]');
      expect(written).toContain('The Telegram user replied to this specific prior message:');
      expect(written).toContain('Code review done — 95 files');
      expect(written).toContain('[document: hermes-memory-review.html]');
      expect(written).toContain('If the user says "this", "that", "it"');
      expect(written).toContain('[OPENCODE TELEGRAM DELIVERY REQUIREMENT]');

      await vi.advanceTimersByTimeAsync(300);
      expect(mockPty.write.mock.calls.at(-1)?.[0]).toBe('\r');
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('escapes OpenCode shell mode before every Telegram inbound injection', async () => {
    // Regression for the multi-turn shell-mode bug: after the agent runs the
    // reply-protocol `send-telegram` command the TUI is left in shell mode, so
    // a second inbound must get its own Esc reset before being typed, otherwise
    // it lands at the zsh prompt and produces no reply. Each injection =
    // Esc -> (150ms) content -> (300ms) Enter, so advance 450ms per message.
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const pty = new OpencodePTY(mockEnv, {});
      installSpawnMock(pty);
      await pty.spawn('fresh', '');
      mockPty.write.mockClear();

      const firstTelegram = [
        '=== TELEGRAM from [USER: James] (chat_id:7940429114) ===',
        '```',
        'First',
        '```',
        "Reply using: cortextos bus send-telegram 7940429114 '<your reply>'",
      ].join('\n');
      const secondTelegram = [
        '=== TELEGRAM from [USER: James] (chat_id:7940429114) ===',
        '```',
        'Second after shell command',
        '```',
        "Reply using: cortextos bus send-telegram 7940429114 '<your reply>'",
      ].join('\n');

      pty.injectMessage(firstTelegram);
      await vi.advanceTimersByTimeAsync(450);
      pty.injectMessage(secondTelegram);
      await vi.advanceTimersByTimeAsync(450);

      expect(mockPty.write.mock.calls.map((call) => call[0])).toEqual([
        '\x1b',
        expect.stringContaining('First'),
        '\r',
        '\x1b',
        expect.stringContaining('Second after shell command'),
        '\r',
      ]);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('exit-recovers when a cron/heartbeat left the TUI at a real zsh shell prompt', async () => {
    // Regression for the heartbeat/check-inbox shell bug: OpenCode's own crons
    // run terminal commands that leave the TUI at a bare `$` prompt. The NEXT
    // Telegram inbound then lands at zsh (`command not found`) and produces no
    // reply. Esc alone does not exit that stuck prompt — a typed `exit` does.
    // When the tail shows a zsh prompt with no chat markers, injection must be
    // Esc -> (150ms) exit + Enter -> (500ms settle) content -> (300ms) Enter.
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const pty = new OpencodePTY(mockEnv, {});
      installSpawnMock(pty);
      await pty.spawn('fresh', '');
      mockPty.write.mockClear();

      // Simulate the post-cron stuck state: a real zsh prompt at the tail, no
      // chat readiness markers anywhere near it.
      pty.getOutputBuffer().push('cortextos bus update-heartbeat\n');
      pty.getOutputBuffer().push('heartbeat updated\n');
      pty.getOutputBuffer().push('boris@host cortextos % ');

      pty.injectMessage([
        '=== TELEGRAM from [USER: James] (chat_id:7940429114) ===',
        '```',
        'Yo',
        '```',
        "Reply using: cortextos bus send-telegram 7940429114 '<your reply>'",
      ].join('\n'));

      // Esc fires synchronously.
      expect(mockPty.write.mock.calls[0][0]).toBe('\x1b');

      // After the 150ms reset delay, the typed exit-recovery fires (NOT content).
      await vi.advanceTimersByTimeAsync(150);
      expect(mockPty.write.mock.calls[1][0]).toBe('exit');
      expect(mockPty.write.mock.calls[2][0]).toBe('\r');

      // Content is typed only after the 500ms shell-exit settle delay.
      await vi.advanceTimersByTimeAsync(500);
      const written = mockPty.write.mock.calls[3][0];
      expect(written).toContain('=== TELEGRAM from [USER: James] (chat_id:7940429114) ===');
      expect(written).toContain('[OPENCODE TELEGRAM DELIVERY REQUIREMENT]');

      // Then the usual submit Enter.
      await vi.advanceTimersByTimeAsync(300);
      expect(mockPty.write.mock.calls.at(-1)?.[0]).toBe('\r');
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('does NOT type a spurious exit when the TUI tail shows chat readiness', async () => {
    // The conservative default: when chat markers are present at the tail, even
    // if a `$`/`%` appears earlier in scrollback, injection stays in chat mode
    // (Esc -> content -> Enter) and never submits a stray `exit` chat message.
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const pty = new OpencodePTY(mockEnv, {});
      installSpawnMock(pty);
      await pty.spawn('fresh', '');
      mockPty.write.mockClear();

      // A normal chat-ready tail: the input chrome is rendered.
      pty.getOutputBuffer().push('some earlier shell output $ \n');
      pty.getOutputBuffer().push('Ask anything\n');
      pty.getOutputBuffer().push('ctrl+p commands\n');

      pty.injectMessage('hello there');

      expect(mockPty.write.mock.calls[0][0]).toBe('\x1b');
      await vi.advanceTimersByTimeAsync(150);
      expect(mockPty.write.mock.calls[1][0]).toBe('hello there');
      // No `exit` was ever written.
      expect(mockPty.write.mock.calls.map((call) => call[0])).not.toContain('exit');

      await vi.advanceTimersByTimeAsync(300);
      expect(mockPty.write.mock.calls.at(-1)?.[0]).toBe('\r');
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('does not blindly inject the startup prompt when TUI readiness is never detected', async () => {
    vi.useFakeTimers();
    try {
      const pty = new OpencodePTY(mockEnv, {});
      installSpawnMock(pty);
      await pty.spawn('fresh', 'boot prompt');

      await vi.advanceTimersByTimeAsync(STARTUP_TICKS(65));

      expect(mockPty.write).not.toHaveBeenCalled();
      expect(pty.getOutputBuffer().getRecent()).toContain('startup prompt not injected');
    } finally {
      vi.useRealTimers();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'SIGTERMs a stale recorded OpenCode process, confirms dead, and removes the marker', async () => {
    // Simulate a process that exits on SIGTERM: signal-0 probes report alive
    // until SIGTERM lands, then ESRCH (gone). No SIGKILL escalation is needed.
    let terminated = false;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
      if (sig === 'SIGTERM') { terminated = true; return true; }
      if (sig === 0) {
        if (terminated) {
          const err = new Error('ESRCH') as NodeJS.ErrnoException;
          err.code = 'ESRCH';
          throw err;
        }
        return true;
      }
      return true;
    }) as typeof process.kill);
    const markerPath = join(mockEnv.ctxRoot, 'state', mockEnv.agentName, 'opencode-process.json');
    fsMocks.existsSync.mockImplementation((path: string) => path === markerPath);
    fsMocks.readFileSync.mockImplementation((path: string) => {
      if (path === markerPath) {
        return JSON.stringify({ pid: 24680 });
      }
      return '';
    });

    try {
      const pty = new OpencodePTY(mockEnv, {});
      installSpawnMock(pty);
      await pty.spawn('fresh', '');

      expect(killSpy).toHaveBeenCalledWith(24680, 'SIGTERM');
      expect(killSpy).not.toHaveBeenCalledWith(24680, 'SIGKILL');
      expect(fsMocks.unlinkSync).toHaveBeenCalledWith(markerPath);
    } finally {
      killSpy.mockRestore();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'escalates to SIGKILL when the stale process survives SIGTERM', async () => {
    // signal-0 always reports alive until SIGKILL lands — the reap must escalate
    // and still remove the marker after confirming death.
    let killed = false;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
      if (sig === 'SIGKILL') { killed = true; return true; }
      if (sig === 0) {
        if (killed) {
          const err = new Error('ESRCH') as NodeJS.ErrnoException;
          err.code = 'ESRCH';
          throw err;
        }
        return true; // survives the SIGTERM window
      }
      return true; // SIGTERM is a no-op for this process
    }) as typeof process.kill);
    const markerPath = join(mockEnv.ctxRoot, 'state', mockEnv.agentName, 'opencode-process.json');
    fsMocks.existsSync.mockImplementation((path: string) => path === markerPath);
    fsMocks.readFileSync.mockImplementation((path: string) => {
      if (path === markerPath) {
        return JSON.stringify({ pid: 24680 });
      }
      return '';
    });

    try {
      const pty = new OpencodePTY(mockEnv, {});
      installSpawnMock(pty);
      await pty.spawn('fresh', '');

      expect(killSpy).toHaveBeenCalledWith(24680, 'SIGTERM');
      expect(killSpy).toHaveBeenCalledWith(24680, 'SIGKILL');
      expect(fsMocks.unlinkSync).toHaveBeenCalledWith(markerPath);
    } finally {
      killSpy.mockRestore();
    }
  }, 10000);

  it('removes a stale marker when the recorded process is already gone on this host', async () => {
    const markerPath = join(mockEnv.ctxRoot, 'state', mockEnv.agentName, 'opencode-process.json');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((() => {
      const err = new Error('gone') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    }) as typeof process.kill);
    fsMocks.existsSync.mockImplementation((path: string) => path === markerPath);
    fsMocks.readFileSync.mockImplementation((path: string) =>
      path === markerPath ? JSON.stringify({ runtime: 'opencode', pid: 24680 }) : '');

    try {
      const pty = new OpencodePTY(mockEnv, {});
      installSpawnMock(pty);
      await pty.spawn('fresh', '');
      expect(fsMocks.unlinkSync).toHaveBeenCalledWith(markerPath);
    } finally {
      killSpy.mockRestore();
    }
  });

  it('removes the recorded OpenCode process marker on explicit kill', async () => {
    const pty = new OpencodePTY(mockEnv, {});
    installSpawnMock(pty);
    await pty.spawn('fresh', '');

    pty.kill();

    expect(mockPty.kill).toHaveBeenCalled();
    expect(fsMocks.unlinkSync).toHaveBeenCalledWith(
      join(mockEnv.ctxRoot, 'state', mockEnv.agentName, 'opencode-process.json'),
    );
  });
});

describe('native process tree termination', () => {
  it('uses Windows taskkill tree mode and escalates to forced termination', async () => {
    let alive = true;
    let clock = 0;
    const taskkill = vi.fn(async (_pid: number, force: boolean) => {
      if (force) alive = false;
    });
    const signal = vi.fn((_pid: number, sig: NodeJS.Signals | 0) => {
      expect(sig).toBe(0);
      if (!alive) {
        const err = new Error('gone') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }
    });

    const result = await terminateProcessTree(24680, {
      termGraceMs: 20,
      killGraceMs: 20,
      pollIntervalMs: 5,
    }, {
      platform: 'win32',
      signal,
      runTaskkill: taskkill,
      sleep: async (ms: number) => { clock += ms; },
      now: () => clock,
    });

    expect(taskkill.mock.calls).toEqual([
      [24680, false],
      [24680, true],
    ]);
    expect(result).toEqual({ terminated: true, forced: true });
  });

  it('retains a truthful failure result when forced Windows tree termination cannot kill the pid', async () => {
    let clock = 0;
    const result = await terminateProcessTree(24680, {
      termGraceMs: 10,
      killGraceMs: 10,
      pollIntervalMs: 5,
    }, {
      platform: 'win32',
      signal: () => {},
      runTaskkill: async () => {},
      sleep: async (ms: number) => { clock += ms; },
      now: () => clock,
    });

    expect(result).toEqual({ terminated: false, forced: true });
  });
});

function STARTUP_TICKS(count: number): number {
  return count * 500;
}

describe('opencodeSessionExists', () => {
  it('checks the cortextOS state marker for this agent', () => {
    const expected = join('/tmp/ctx', 'state', 'opencode-agent', 'opencode-session.json');
    fsMocks.existsSync.mockImplementation((path: string) => path === expected);

    expect(opencodeSessionExists('/tmp/ctx', 'opencode-agent')).toBe(true);
  });
});
