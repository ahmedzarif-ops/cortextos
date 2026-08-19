import { describe, expect, it, vi } from 'vitest';
import { getAgentRuntimeChecks, type RuntimeProbe } from '../../../src/cli/doctor';

describe('doctor agent runtime checks', () => {
  it('verifies executable and authentication readiness for all runtimes', () => {
    const outputs = new Map<string, string>([
      ['claude --version', '2.1.0\n'],
      ['claude auth status', '{"loggedIn":true,"account":"private@example.test"}'],
      ['codex --version', 'codex-cli 1.2.3\n'],
      ['codex login status', 'Logged in using ChatGPT\n'],
      ['opencode --version', '1.0.99\n'],
      ['opencode auth list', '\u001b[32m1 credential\u001b[0m\nOpenAI oauth'],
    ]);
    const probe: RuntimeProbe = vi.fn((command, args) => ({
      ok: true,
      stdout: outputs.get([command, ...args].join(' ')) ?? '',
    }));

    const checks = getAgentRuntimeChecks(probe);

    expect(checks).toHaveLength(6);
    expect(checks.every((check) => check.status === 'pass')).toBe(true);
    expect(checks.filter((check) => check.name.endsWith(' auth')).map((check) => check.message))
      .toEqual(['Ready', 'Ready', 'Ready']);
    // Auth command output (including account/provider metadata) is never used
    // as the displayed diagnostic message.
    expect(JSON.stringify(checks)).not.toContain('private@example.test');
    expect(JSON.stringify(checks)).not.toContain('OpenAI oauth');
  });

  it('does not mistake an installed executable for authenticated credentials', () => {
    const probe: RuntimeProbe = (command, args) => {
      if (args.includes('--version')) return { ok: true, stdout: `${command} 1.0.0` };
      if (command === 'claude') return { ok: true, stdout: '{"loggedIn":false}' };
      if (command === 'codex') return { ok: true, stdout: 'Not logged in' };
      return { ok: true, stdout: '0 credentials' };
    };

    const checks = getAgentRuntimeChecks(probe);

    expect(checks.filter((check) => check.name.endsWith(' auth'))).toEqual([
      expect.objectContaining({ name: 'Claude Code auth', status: 'warn' }),
      expect.objectContaining({ name: 'Codex auth', status: 'warn' }),
      expect.objectContaining({ name: 'OpenCode auth', status: 'warn' }),
    ]);
  });

  it('does not run auth commands for missing executables', () => {
    const probe = vi.fn<RuntimeProbe>(() => ({ ok: false, stdout: '' }));

    const checks = getAgentRuntimeChecks(probe);

    expect(probe).toHaveBeenCalledTimes(3);
    expect(checks.find((check) => check.name === 'Claude Code CLI')?.status).toBe('fail');
    expect(checks.find((check) => check.name === 'Codex CLI')?.status).toBe('warn');
    expect(checks.find((check) => check.name === 'OpenCode CLI')?.status).toBe('warn');
    expect(checks.filter((check) => check.name.endsWith(' auth')).every((check) =>
      check.message === 'Unavailable (CLI not executable)')).toBe(true);
  });
});
