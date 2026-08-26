import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'path';
import { homedir } from 'os';

const fsMocks = {
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    get existsSync() { return fsMocks.existsSync; },
    get readFileSync() { return fsMocks.readFileSync; },
    get writeFileSync() { return fsMocks.writeFileSync; },
  };
});

// Stub node-pty so HermesPTY can be imported without a native addon
vi.mock('node-pty', () => ({
  spawn: vi.fn().mockReturnValue({
    pid: 99,
    write: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
    kill: vi.fn(),
    resize: vi.fn(),
  }),
}));

const { hermesDbExists, hermesProfileHome, HermesPTY } = await import('../../../src/pty/hermes-pty.js');
const { assertNoHermesNativeCronCollision } = await import('../../../src/utils/hermes-runtime.js');

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'hermes-agent',
  agentDir: '/tmp/fw/orgs/acme/agents/hermes-agent',
  org: 'acme',
  projectRoot: '/tmp/fw',
};

beforeEach(() => {
  fsMocks.existsSync.mockReset().mockReturnValue(false);
  fsMocks.readFileSync.mockReset();
  fsMocks.writeFileSync.mockReset();
});

describe('hermesDbExists', () => {
  it('returns false when the profile state.db does not exist', () => {
    fsMocks.existsSync.mockReturnValue(false);
    expect(hermesDbExists('hermes-agent')).toBe(false);
  });

  it('returns true when the profile state.db exists', () => {
    const expectedPath = join(homedir(), '.hermes', 'profiles', 'hermes-agent', 'state.db');
    fsMocks.existsSync.mockImplementation((p: string) => p === expectedPath);
    expect(hermesDbExists('hermes-agent')).toBe(true);
  });

  it('uses a custom Hermes root when provided', () => {
    const customRoot = '/custom/hermes';
    const expectedPath = join(customRoot, 'profiles', 'hermes-agent', 'state.db');
    fsMocks.existsSync.mockImplementation((p: string) => p === expectedPath);
    expect(hermesDbExists('hermes-agent', customRoot)).toBe(true);
  });

  it('normalizes a profile-scoped HERMES_HOME back to its root', () => {
    const customProfileHome = join('/custom/hermes', 'profiles', 'other-agent');
    expect(hermesProfileHome('hermes-agent', customProfileHome))
      .toBe(join('/custom/hermes', 'profiles', 'hermes-agent'));
  });

  it('returns false when the profile state.db is absent', () => {
    fsMocks.existsSync.mockReturnValue(false);
    expect(hermesDbExists('hermes-agent', '/custom/hermes')).toBe(false);
  });

  it('rejects the shared default profile for standing agents', () => {
    expect(() => hermesDbExists('default')).toThrow(/isolated named profile/);
  });
});

describe('HermesPTY', () => {
  it('getBinaryName returns "hermes"', () => {
    const pty = new HermesPTY(mockEnv, { hermes_profile: 'hermes-agent' });
    // Access protected method via cast
    expect((pty as unknown as { getBinaryName(): string }).getBinaryName()).toBe('hermes');
  });

  it('buildClaudeArgs pins profile, model, provider, and reasoning for fresh mode', () => {
    const pty = new HermesPTY(mockEnv, {
      hermes_profile: 'hermes-agent',
      model: 'z-ai/glm-5.3',
      hermes_provider: 'nous',
      hermes_reasoning: 'high',
    });
    const args = (pty as unknown as { buildClaudeArgs(m: string, p: string): string[] })
      .buildClaudeArgs('fresh', 'hello');
    expect(args).toEqual([
      '--profile', 'hermes-agent',
      '--model', 'z-ai/glm-5.3',
      '--provider', 'nous',
      '--reasoning', 'high',
    ]);
  });

  it('buildClaudeArgs adds --continue without dropping the per-seat pins', () => {
    const pty = new HermesPTY(mockEnv, {
      hermes_profile: 'hermes-agent',
      model: 'qwen/qwen3.8-max',
      hermes_provider: 'nous',
      hermes_reasoning: 'xhigh',
    });
    const args = (pty as unknown as { buildClaudeArgs(m: string, p: string): string[] })
      .buildClaudeArgs('continue', 'hello');
    expect(args).toEqual([
      '--profile', 'hermes-agent',
      '--model', 'qwen/qwen3.8-max',
      '--provider', 'nous',
      '--reasoning', 'xhigh',
      '--continue',
    ]);
  });

  it('falls back to the agent name when a legacy Hermes profile is missing', () => {
    const pty = new HermesPTY(mockEnv, {
      model: 'deepseek/deepseek-v4-flash', hermes_provider: 'nous', hermes_reasoning: 'high',
    });
    const args = (
      pty as unknown as { buildClaudeArgs(m: string, p: string): string[] }
    ).buildClaudeArgs('fresh', 'hello');
    expect(args.slice(0, 2)).toEqual(['--profile', 'hermes-agent']);
  });

  it('fails closed on a malformed Hermes profile name', () => {
    const pty = new HermesPTY(mockEnv, { hermes_profile: '../shared' });
    expect(() => (
      pty as unknown as { buildClaudeArgs(m: string, p: string): string[] }
    ).buildClaudeArgs('fresh', 'hello')).toThrow(/Invalid Hermes profile/);
  });

  it('sets HERMES_HOME to the same isolated profile used by --profile', () => {
    const pty = new HermesPTY(mockEnv, {
      hermes_profile: 'hermes-agent', model: 'deepseek/deepseek-v4-flash',
      hermes_provider: 'nous', hermes_reasoning: 'high',
    });
    const env: Record<string, string> = {};
    (pty as unknown as { customizeEnv(e: Record<string, string>): void }).customizeEnv(env);
    expect(env['HERMES_HOME']).toBe(join(homedir(), '.hermes', 'profiles', 'hermes-agent'));
    expect(env['HERMES_PROFILE']).toBe('hermes-agent');
  });

  it('uses the same daemon-level custom root for PTY env and DB probing', () => {
    const originalHermesHome = process.env['HERMES_HOME'];
    process.env['HERMES_HOME'] = '/custom/hermes';
    try {
      const pty = new HermesPTY(mockEnv, {
        hermes_profile: 'hermes-agent', model: 'deepseek/deepseek-v4-flash',
        hermes_provider: 'nous', hermes_reasoning: 'high',
      });
      const env: Record<string, string> = { HERMES_HOME: '/agent-local/wrong-root' };
      (pty as unknown as { customizeEnv(e: Record<string, string>): void }).customizeEnv(env);
      const expectedHome = join('/custom/hermes', 'profiles', 'hermes-agent');
      expect(env['HERMES_HOME']).toBe(expectedHome);

      fsMocks.existsSync.mockImplementation((p: string) => p === join(expectedHome, 'state.db'));
      expect(hermesDbExists('hermes-agent', process.env['HERMES_HOME'])).toBe(true);
    } finally {
      if (originalHermesHome === undefined) delete process.env['HERMES_HOME'];
      else process.env['HERMES_HOME'] = originalHermesHome;
    }
  });

  it('passes the pinned argv and matching profile env to the real spawn seam', async () => {
    const spawnMock = vi.fn().mockReturnValue({
      pid: 99,
      write: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
      kill: vi.fn(),
      resize: vi.fn(),
    });
    const originalHermesHome = process.env['HERMES_HOME'];
    delete process.env['HERMES_HOME'];
    try {
      const expectedProfileHome = join(homedir(), '.hermes', 'profiles', 'hermes-agent');
      fsMocks.existsSync.mockImplementation((p: string) => p === expectedProfileHome);
      const pty = new HermesPTY(mockEnv, {
        hermes_profile: 'hermes-agent',
        model: 'z-ai/glm-5.3-flash',
        hermes_provider: 'nous',
        hermes_reasoning: 'high',
      });
      (pty as unknown as { spawnFn: typeof spawnMock }).spawnFn = spawnMock;
      pty.getOutputBuffer().push('⚔ ❯ ');
      await pty.spawn('fresh', 'bootstrap');

      expect(spawnMock).toHaveBeenCalledWith(
        'hermes',
        [
          '--profile', 'hermes-agent',
          '--model', 'z-ai/glm-5.3-flash',
          '--provider', 'nous',
          '--reasoning', 'high',
        ],
        expect.objectContaining({
          env: expect.objectContaining({
            HERMES_HOME: join(homedir(), '.hermes', 'profiles', 'hermes-agent'),
            HERMES_PROFILE: 'hermes-agent',
          }),
        }),
      );
    } finally {
      if (originalHermesHome === undefined) delete process.env['HERMES_HOME'];
      else process.env['HERMES_HOME'] = originalHermesHome;
    }
  });

  it('fails once before spawning when the named profile directory is absent', async () => {
    const spawnMock = vi.fn();
    fsMocks.existsSync.mockReturnValue(false);
    const pty = new HermesPTY(mockEnv, {
      hermes_profile: 'hermes-agent', model: 'deepseek/deepseek-v4-flash',
      hermes_provider: 'nous', hermes_reasoning: 'high',
    });
    (pty as unknown as { spawnFn: typeof spawnMock }).spawnFn = spawnMock;

    await expect(pty.spawn('fresh', 'bootstrap')).rejects.toThrow(
      /hermes profile create hermes-agent --clone --no-alias/,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('uses the agent name as the isolated profile for legacy Hermes configs', () => {
    const pty = new HermesPTY(mockEnv, {
      model: 'deepseek/deepseek-v4-flash', hermes_provider: 'nous', hermes_reasoning: 'high',
    });
    const args = (pty as unknown as { buildClaudeArgs(m: string, p: string): string[] })
      .buildClaudeArgs('fresh', 'hello');
    expect(args.slice(0, 2)).toEqual(['--profile', 'hermes-agent']);
  });

  it('writes a cron payload through the real raw PTY seam without bracketed paste', async () => {
    vi.useFakeTimers();
    try {
      const rawWrite = vi.fn();
      const pty = new HermesPTY(mockEnv, { hermes_profile: 'hermes-agent' });
      (pty as unknown as { pty: { write(data: string): void } }).pty = { write: rawWrite };

      pty.injectMessage('[CRON] Run the isolated heartbeat canary.');
      expect(rawWrite).toHaveBeenCalledWith('[CRON] Run the isolated heartbeat canary.');
      expect(rawWrite.mock.calls.flat().join('')).not.toContain('\x1b[200~');

      await vi.advanceTimersByTimeAsync(300);
      expect(rawWrite).toHaveBeenLastCalledWith('\r');
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [{ hermes_profile: 'hermes-agent', hermes_provider: 'nous', hermes_reasoning: 'high' }, /model pin/],
    [{ hermes_profile: 'hermes-agent', model: 'deepseek/deepseek-v4-flash', hermes_reasoning: 'high' }, /provider pin/],
    [{ hermes_profile: 'hermes-agent', model: 'deepseek/deepseek-v4-flash', hermes_provider: 'nous' }, /reasoning pin/],
  ])('fails before argv construction when a mandatory routing pin is absent', (config, pattern) => {
    const pty = new HermesPTY(mockEnv, config);
    expect(() => (
      pty as unknown as { buildClaudeArgs(m: string, p: string): string[] }
    ).buildClaudeArgs('fresh', 'hello')).toThrow(pattern);
  });

  it('does not reach the real spawn seam when any mandatory routing pin is absent', async () => {
    const spawnMock = vi.fn();
    const pty = new HermesPTY(mockEnv, {
      hermes_profile: 'hermes-agent',
      model: 'deepseek/deepseek-v4-flash',
      hermes_provider: 'nous',
    });
    (pty as unknown as { spawnFn: typeof spawnMock }).spawnFn = spawnMock;

    await expect(pty.spawn('fresh', 'bootstrap')).rejects.toThrow(/reasoning pin/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('isBootstrapped() fires on "❯" in output', () => {
    const pty = new HermesPTY(mockEnv, { hermes_profile: 'hermes-agent' });
    pty.getOutputBuffer().push('⚔ ❯ ');
    expect(pty.getOutputBuffer().isBootstrapped()).toBe(true);
  });

  it('isBootstrapped() does not fire on output without "❯"', () => {
    const pty = new HermesPTY(mockEnv, { hermes_profile: 'hermes-agent' });
    pty.getOutputBuffer().push('loading...');
    expect(pty.getOutputBuffer().isBootstrapped()).toBe(false);
  });
});

describe('Hermes native cron collision guard', () => {
  it('allows an absent or disabled-only native jobs file', () => {
    fsMocks.existsSync.mockReturnValue(false);
    expect(() => assertNoHermesNativeCronCollision('hermes-agent', 'hermes-agent', '/custom/hermes')).not.toThrow();

    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue(JSON.stringify({ jobs: [{ enabled: false }, { state: 'paused' }] }));
    expect(() => assertNoHermesNativeCronCollision('hermes-agent', 'hermes-agent', '/custom/hermes')).not.toThrow();
  });

  it('blocks enabled or unreadable Hermes-native cron state', () => {
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue(JSON.stringify({ jobs: [{ enabled: true }] }));
    expect(() => assertNoHermesNativeCronCollision('hermes-agent', 'hermes-agent', '/custom/hermes'))
      .toThrow(/Cron ownership collision/);

    fsMocks.readFileSync.mockReturnValue('not-json');
    expect(() => assertNoHermesNativeCronCollision('hermes-agent', 'hermes-agent', '/custom/hermes'))
      .toThrow(/Cannot prove cron ownership/);
  });
});
