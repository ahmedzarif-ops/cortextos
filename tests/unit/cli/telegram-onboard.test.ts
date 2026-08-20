import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  onboardTelegramAgent,
  createTelegramCommand,
  selectLatestPrivateTelegramIdentity,
  telegramCommand,
  updateTelegramEnv,
  type TelegramOnboardDependencies,
} from '../../../src/cli/telegram.js';
import { telegramValidationSuccessMessage } from '../../../src/cli/enable-agent.js';

const TOKEN = `123456:${'A'.repeat(35)}`;
const CHAT_ID = '987654321';
const USER_ID = '123456789';

function privateUpdate(updateId = 1, chatId = Number(CHAT_ID), userId = Number(USER_ID)) {
  return {
    update_id: updateId,
    message: {
      chat: { id: chatId, type: 'private' },
      from: { id: userId, is_bot: false },
      text: 'hi',
    },
  };
}

describe('telegram onboard CLI', () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture(existing = ''): {
    root: string;
    agentDir: string;
    envPath: string;
    writes: Array<{ path: string; content: string }>;
    logs: string[];
    deps: TelegramOnboardDependencies;
  } {
    const root = mkdtempSync(join(tmpdir(), 'telegram-onboard-'));
    roots.push(root);
    const agentDir = join(root, 'orgs', 'test-org', 'agents', 'orchestrator');
    const envPath = join(agentDir, '.env');
    mkdirSync(agentDir, { recursive: true });
    const writes: Array<{ path: string; content: string }> = [];
    const logs: string[] = [];
    const deps: TelegramOnboardDependencies = {
      projectRoot: () => root,
      promptForToken: vi.fn(async () => TOKEN),
      createClient: vi.fn(() => ({
        getUpdates: vi.fn(async () => ({ result: [privateUpdate()] })),
      })),
      fileExists: path => path === agentDir || (path === envPath && existing !== ''),
      isDirectory: path => path === agentDir,
      realPath: path => path,
      readFile: path => {
        if (path !== envPath) throw new Error('unexpected path');
        return existing;
      },
      writeSecretFile: (path, content) => writes.push({ path, content }),
      wait: vi.fn(async () => {}),
      log: message => logs.push(message),
    };
    return { root, agentDir, envPath, writes, logs, deps };
  }

  it('registers the documented nested command and automation option', () => {
    const onboard = telegramCommand.commands.find(command => command.name() === 'onboard');
    expect(onboard).toBeDefined();
    expect(onboard?.options.some(option => option.long === '--use-existing-token')).toBe(true);
    expect(onboard?.options.some(option => option.long === '--org' && option.mandatory)).toBe(true);
  });

  it('maps the real nested Commander invocation into secure automation behavior', async () => {
    const fx = fixture(`\uFEFFBOT_TOKEN=${TOKEN}\r\nOTHER=preserved\r\n`);
    const command = createTelegramCommand(fx.deps);

    await command.parseAsync([
      'node', 'cli', 'onboard', 'orchestrator',
      '--org', 'test-org',
      '--instance', 'dogfood-2',
      '--use-existing-token',
    ]);

    expect(fx.deps.promptForToken).not.toHaveBeenCalled();
    expect(fx.writes).toHaveLength(1);
    expect(fx.writes[0].content.startsWith('\uFEFF')).toBe(false);
    expect(fx.writes[0].content).toContain(`BOT_TOKEN=${TOKEN}\r\n`);
    expect(fx.writes[0].content).toContain('OTHER=preserved\r\n');
  });

  it('lets callers override Commander exit behavior for missing required options', async () => {
    const fx = fixture();
    const command = createTelegramCommand(fx.deps).exitOverride();
    command.commands.forEach(subcommand => subcommand.exitOverride());
    command.configureOutput({ writeErr: () => {} });
    command.commands.forEach(subcommand => subcommand.configureOutput({ writeErr: () => {} }));

    await expect(command.parseAsync(['node', 'cli', 'onboard', 'orchestrator']))
      .rejects.toMatchObject({ code: 'commander.missingMandatoryOptionValue' });
    expect(fx.deps.promptForToken).not.toHaveBeenCalled();
    expect(fx.writes).toHaveLength(0);
  });

  it('keeps enable-agent validation success output independent of identifiers', () => {
    const message = telegramValidationSuccessMessage();
    expect(message).toBe('Telegram credentials validated.');
    expect(message).not.toContain(CHAT_ID);
    expect(message).not.toContain(USER_ID);
    expect(message).not.toContain(TOKEN);
  });

  it('selects the newest private human message by update id', () => {
    expect(selectLatestPrivateTelegramIdentity({
      result: [
        privateUpdate(40, 40, 41),
        { update_id: 99, message: { chat: { id: -100, type: 'supergroup' }, from: { id: 99 } } },
        privateUpdate(60, 60, 61),
        { update_id: 100, message: { chat: { id: 100, type: 'private' }, from: { id: 101, is_bot: true } } },
      ],
    })).toEqual({ chatId: '60', userId: '61' });
  });

  it('returns null for malformed and group-only updates', () => {
    expect(selectLatestPrivateTelegramIdentity({ result: [null, {}, {
      update_id: 2,
      message: { chat: { id: -2, type: 'group' }, from: { id: 3 } },
    }] })).toBeNull();
    expect(selectLatestPrivateTelegramIdentity({ result: 'not-an-array' })).toBeNull();
  });

  it('updates only managed values while preserving unrelated CRLF env lines', () => {
    const original = [
      '# keep this comment',
      'OTHER=value with spaces',
      'BOT_TOKEN=stale',
      'export CHAT_ID=stale-chat',
      'BOT_TOKEN=duplicate-stale',
      '',
    ].join('\r\n');
    const updated = updateTelegramEnv(original, {
      botToken: TOKEN,
      chatId: CHAT_ID,
      allowedUser: USER_ID,
    });

    expect(updated).toContain('# keep this comment\r\n');
    expect(updated).toContain('OTHER=value with spaces\r\n');
    expect(updated.match(/BOT_TOKEN=/g)).toHaveLength(1);
    expect(updated.match(/CHAT_ID=/g)).toHaveLength(1);
    expect(updated.match(/ALLOWED_USER=/g)).toHaveLength(1);
    expect(updated).not.toContain('stale');
    expect(updated.endsWith('\r\n')).toBe(true);
  });

  it('uses masked interactive input, polls at offset zero, and writes via the secret writer', async () => {
    const fx = fixture('# existing config\nOTHER=preserved\n');
    const getUpdates = vi.fn(async () => ({ result: [privateUpdate()] }));
    fx.deps.createClient = vi.fn(() => ({ getUpdates }));

    await onboardTelegramAgent({
      agent: 'orchestrator',
      org: 'test-org',
      instance: 'default',
      useExistingToken: false,
    }, fx.deps);

    expect(fx.deps.promptForToken).toHaveBeenCalledOnce();
    expect(getUpdates).toHaveBeenCalledWith(0, 30);
    expect(fx.writes).toHaveLength(1);
    expect(fx.writes[0].path).toBe(fx.envPath);
    expect(fx.writes[0].content).toContain('OTHER=preserved\n');
    expect(fx.writes[0].content).toContain(`BOT_TOKEN=${TOKEN}\n`);
    expect(fx.writes[0].content).toContain(`CHAT_ID=${CHAT_ID}\n`);
    expect(fx.writes[0].content).toContain(`ALLOWED_USER=${USER_ID}\n`);
    expect(fx.logs.at(-1)).toBe('Telegram credentials configured securely.');
    const visible = fx.logs.join('\n');
    expect(visible).not.toContain(TOKEN);
    expect(visible).not.toContain(CHAT_ID);
    expect(visible).not.toContain(USER_ID);
    expect(visible).not.toContain('api.telegram.org');
  });

  it('uses an already-provisioned token without invoking the interactive prompt', async () => {
    const fx = fixture(`# automation handoff\nBOT_TOKEN='${TOKEN}'\nOTHER=preserved\n`);
    fx.deps.promptForToken = vi.fn(async () => { throw new Error('must not prompt'); });

    await onboardTelegramAgent({
      agent: 'orchestrator',
      org: 'test-org',
      instance: 'default',
      useExistingToken: true,
    }, fx.deps);

    expect(fx.deps.promptForToken).not.toHaveBeenCalled();
    expect(fx.deps.createClient).toHaveBeenCalledWith(TOKEN);
    expect(fx.writes).toHaveLength(1);
    expect(fx.writes[0].content).toContain('OTHER=preserved\n');
  });

  it('never advances the Telegram offset across retries and never leaks transport errors', async () => {
    const fx = fixture();
    const getUpdates = vi.fn(async () => {
      throw new Error(`https://api.telegram.org/bot${TOKEN}/getUpdates?chat=${CHAT_ID}`);
    });
    fx.deps.createClient = vi.fn(() => ({ getUpdates }));

    let failure = '';
    try {
      await onboardTelegramAgent({
        agent: 'orchestrator',
        org: 'test-org',
        instance: 'default',
        useExistingToken: false,
      }, fx.deps);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }

    expect(failure).toBe('No private Telegram message was detected. Send a message and retry.');
    expect(getUpdates).toHaveBeenCalledTimes(3);
    expect(getUpdates.mock.calls).toEqual([[0, 30], [0, 30], [0, 30]]);
    expect(fx.deps.wait).toHaveBeenCalledTimes(2);
    expect(fx.deps.wait).toHaveBeenCalledWith(5_000);
    expect(fx.writes).toHaveLength(0);
    const visible = `${fx.logs.join('\n')}\n${failure}`;
    expect(visible).not.toContain(TOKEN);
    expect(visible).not.toContain(CHAT_ID);
    expect(visible).not.toContain('api.telegram.org');
  });

  it('fails generically when an existing token is absent', async () => {
    const fx = fixture('OTHER=preserved\n');
    await expect(onboardTelegramAgent({
      agent: 'orchestrator',
      org: 'test-org',
      instance: 'default',
      useExistingToken: true,
    }, fx.deps)).rejects.toThrow('No valid existing Telegram token is provisioned for this agent.');
    expect(fx.deps.createClient).not.toHaveBeenCalled();
    expect(fx.writes).toHaveLength(0);
  });

  it.each([
    { agent: '../escape', org: 'test-org', instance: 'default' },
    { agent: 'orchestrator', org: '../escape', instance: 'default' },
    { agent: 'orchestrator', org: 'test-org', instance: '../escape' },
  ])('rejects invalid names before resolving a filesystem path: %o', async invalid => {
    const fx = fixture();
    const root = vi.fn(() => fx.root);
    fx.deps.projectRoot = root;
    await expect(onboardTelegramAgent({ ...invalid, useExistingToken: false }, fx.deps))
      .rejects.toThrow('Telegram onboarding received an invalid name.');
    expect(root).not.toHaveBeenCalled();
    expect(fx.writes).toHaveLength(0);
  });

  it('rejects an agent directory whose canonical path escapes the org agents root', async () => {
    const fx = fixture();
    fx.deps.realPath = path => path === fx.agentDir ? join(fx.root, 'outside', 'agent') : path;
    await expect(onboardTelegramAgent({
      agent: 'orchestrator',
      org: 'test-org',
      instance: 'default',
      useExistingToken: false,
    }, fx.deps)).rejects.toThrow('Telegram onboarding could not validate the agent path.');
    expect(fx.deps.promptForToken).not.toHaveBeenCalled();
    expect(fx.writes).toHaveLength(0);
  });

  it('does not expose secret contents when secure storage fails', async () => {
    const fx = fixture();
    fx.deps.writeSecretFile = () => { throw new Error(`failed writing ${TOKEN} ${CHAT_ID}`); };
    await expect(onboardTelegramAgent({
      agent: 'orchestrator',
      org: 'test-org',
      instance: 'default',
      useExistingToken: false,
    }, fx.deps)).rejects.toThrow('Telegram credentials could not be stored securely.');
    expect(fx.logs.join('\n')).not.toContain(TOKEN);
    expect(fx.logs.join('\n')).not.toContain(CHAT_ID);
  });

  it.each([
    {
      stage: 'project discovery',
      prepare: (fx: ReturnType<typeof fixture>) => {
        fx.deps.projectRoot = () => { throw new Error(`raw ${TOKEN} ${CHAT_ID}`); };
      },
      expected: 'Telegram onboarding could not resolve the project.',
    },
    {
      stage: 'masked prompt',
      prepare: (fx: ReturnType<typeof fixture>) => {
        fx.deps.promptForToken = async () => { throw new Error(`raw ${TOKEN} ${CHAT_ID}`); };
      },
      expected: 'Telegram token entry was not completed.',
    },
    {
      stage: 'client initialization',
      prepare: (fx: ReturnType<typeof fixture>) => {
        fx.deps.createClient = () => { throw new Error(`raw ${TOKEN} ${CHAT_ID}`); };
      },
      expected: 'Telegram onboarding could not initialize securely.',
    },
    {
      stage: 'retry wait',
      prepare: (fx: ReturnType<typeof fixture>) => {
        fx.deps.createClient = () => ({ getUpdates: async () => ({ result: [] }) });
        fx.deps.wait = async () => { throw new Error(`raw ${TOKEN} ${CHAT_ID}`); };
      },
      expected: 'Telegram onboarding was interrupted.',
    },
  ])('redacts raw errors from $stage', async ({ prepare, expected }) => {
    const fx = fixture();
    prepare(fx);
    let failure = '';
    try {
      await onboardTelegramAgent({
        agent: 'orchestrator',
        org: 'test-org',
        instance: 'default',
        useExistingToken: false,
      }, fx.deps);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    expect(failure).toBe(expected);
    expect(failure).not.toContain(TOKEN);
    expect(failure).not.toContain(CHAT_ID);
    expect(fx.logs.join('\n')).not.toContain(TOKEN);
    expect(fx.logs.join('\n')).not.toContain(CHAT_ID);
    expect(fx.writes).toHaveLength(0);
  });
});
