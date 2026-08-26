import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { addAgentCommand } from '../../../src/cli/add-agent';

describe('add-agent --runtime hermes isolation contract', () => {
  let tempRoot: string;
  let tempHome: string;
  let originalHome: string | undefined;
  let originalProjectRoot: string | undefined;
  let originalFrameworkRoot: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'hermes-add-agent-'));
    tempHome = mkdtempSync(join(tmpdir(), 'hermes-add-agent-home-'));
    originalHome = process.env.HOME;
    originalProjectRoot = process.env.CTX_PROJECT_ROOT;
    originalFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
    process.env.HOME = tempHome;
    process.env.CTX_PROJECT_ROOT = tempRoot;
    process.env.CTX_FRAMEWORK_ROOT = tempRoot;

    symlinkSync(join(__dirname, '..', '..', '..', 'templates'), join(tempRoot, 'templates'), 'dir');
    mkdirSync(join(tempRoot, 'orgs', 'testorg', 'agents'), { recursive: true });
    writeFileSync(join(tempRoot, 'orgs', 'testorg', 'context.json'), JSON.stringify({
      name: 'testorg', timezone: 'UTC', orchestrator: 'chief',
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalProjectRoot === undefined) delete process.env.CTX_PROJECT_ROOT;
    else process.env.CTX_PROJECT_ROOT = originalProjectRoot;
    if (originalFrameworkRoot === undefined) delete process.env.CTX_FRAMEWORK_ROOT;
    else process.env.CTX_FRAMEWORK_ROOT = originalFrameworkRoot;
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('rejects a Hermes agent without an explicit model before creating files', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__TEST_PROCESS_EXIT_${code}__`);
    }) as never);

    await expect(addAgentCommand.parseAsync([
      'node', 'cli', 'hermes-missing-model', '--runtime', 'hermes', '--org', 'testorg',
    ])).rejects.toThrow(/__TEST_PROCESS_EXIT_1__/);

    expect(existsSync(join(tempRoot, 'orgs', 'testorg', 'agents', 'hermes-missing-model'))).toBe(false);
  });

  it('scaffolds explicit profile, routing pins, and cortextOS cron ownership', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await addAgentCommand.parseAsync([
      'node', 'cli', 'hermes-worker', '--runtime', 'hermes', '--org', 'testorg',
      '--model', 'z-ai/glm-5.3-flash', '--provider', 'nous', '--reasoning', 'high',
    ]);

    const configPath = join(tempRoot, 'orgs', 'testorg', 'agents', 'hermes-worker', 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config).toMatchObject({
      runtime: 'hermes',
      hermes_profile: 'hermes-worker',
      model: 'z-ai/glm-5.3-flash',
      hermes_provider: 'nous',
      hermes_reasoning: 'high',
      hermes_cron_ownership: 'cortextos',
    });
    expect(readFileSync(join(tempRoot, 'orgs', 'testorg', 'agents', 'hermes-worker', 'TOOLS.md'), 'utf-8'))
      .toContain('All cortextOS commands');
    expect(logSpy.mock.calls.flat().join('\n'))
      .toContain('hermes profile create hermes-worker --clone --no-alias');
  });

  it.each(['_hidden', 'default', 'shared', 'a'.repeat(65)])(
    'rejects Hermes profile-incompatible agent name %s before creating files',
    async (name) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`__TEST_PROCESS_EXIT_${code}__`);
      }) as never);

      await expect(addAgentCommand.parseAsync([
        'node', 'cli', name, '--runtime', 'hermes', '--org', 'testorg',
        '--model', 'deepseek/deepseek-v4-flash',
      ])).rejects.toThrow(/__TEST_PROCESS_EXIT_1__/);
      expect(existsSync(join(tempRoot, 'orgs', 'testorg', 'agents', name))).toBe(false);
    },
  );

  it('rejects moving model aliases before creating files', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__TEST_PROCESS_EXIT_${code}__`);
    }) as never);

    await expect(addAgentCommand.parseAsync([
      'node', 'cli', 'hermes-alias', '--runtime', 'hermes', '--org', 'testorg',
      '--model', '~deepseek/deepseek-v4-flash',
    ])).rejects.toThrow(/__TEST_PROCESS_EXIT_1__/);
    expect(existsSync(join(tempRoot, 'orgs', 'testorg', 'agents', 'hermes-alias'))).toBe(false);
  });
});
