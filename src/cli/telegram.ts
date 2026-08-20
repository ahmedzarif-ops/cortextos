import { Command } from 'commander';
import { existsSync, readFileSync, realpathSync, statSync } from 'fs';
import { resolve, join, relative, isAbsolute } from 'path';
import { password } from '@inquirer/prompts';
import { TelegramAPI } from '../telegram/api.js';
import { writeSecretFileSync } from '../platform/secret-permissions.js';
import { stripBom } from '../utils/strip-bom.js';
import { validateAgentName, validateInstanceId, validateOrgName } from '../utils/validate.js';
import { discoverProjectRoot } from './enable-agent.js';

const TELEGRAM_TOKEN_PATTERN = /^\d{6,20}:[A-Za-z0-9_-]{30,}$/;
const CREDENTIAL_KEYS = ['BOT_TOKEN', 'CHAT_ID', 'ALLOWED_USER'] as const;

export interface TelegramIdentity {
  chatId: string;
  userId: string;
}

interface TelegramUpdatesClient {
  getUpdates(offset: number, timeout?: number): Promise<unknown>;
}

export interface TelegramOnboardOptions {
  agent: string;
  org: string;
  instance: string;
  useExistingToken: boolean;
}

export interface TelegramOnboardDependencies {
  projectRoot: () => string;
  promptForToken: () => Promise<string>;
  createClient: (token: string) => TelegramUpdatesClient;
  fileExists: (path: string) => boolean;
  isDirectory: (path: string) => boolean;
  realPath: (path: string) => string;
  readFile: (path: string) => string;
  writeSecretFile: (path: string, content: string) => void;
  wait: (milliseconds: number) => Promise<void>;
  log: (message: string) => void;
}

const defaultDependencies: TelegramOnboardDependencies = {
  projectRoot: discoverProjectRoot,
  promptForToken: () => password({
    message: 'Telegram bot token:',
    mask: '*',
  }),
  createClient: token => new TelegramAPI(token),
  fileExists: existsSync,
  isDirectory: path => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
  realPath: realpathSync,
  readFile: path => readFileSync(path, 'utf-8'),
  writeSecretFile: writeSecretFileSync,
  wait: milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds)),
  log: message => console.log(message),
};

/**
 * Choose the newest valid private-user message without consuming it. Telegram
 * returns updates in ascending update_id order, but sorting here also makes the
 * behavior deterministic for mocked or proxied responses.
 */
export function selectLatestPrivateTelegramIdentity(payload: unknown): TelegramIdentity | null {
  if (!payload || typeof payload !== 'object') return null;
  const result = (payload as { result?: unknown }).result;
  if (!Array.isArray(result)) return null;

  let selected: { updateId: number; index: number; identity: TelegramIdentity } | null = null;
  for (let index = 0; index < result.length; index++) {
    const update = result[index];
    if (!update || typeof update !== 'object') continue;
    const record = update as {
      update_id?: unknown;
      message?: {
        chat?: { id?: unknown; type?: unknown };
        from?: { id?: unknown; is_bot?: unknown };
      };
    };
    const message = record.message;
    const chatId = message?.chat?.id;
    const userId = message?.from?.id;
    if (
      message?.chat?.type !== 'private' ||
      message?.from?.is_bot === true ||
      !Number.isSafeInteger(chatId) ||
      !Number.isSafeInteger(userId)
    ) {
      continue;
    }

    const updateId = Number.isSafeInteger(record.update_id)
      ? record.update_id as number
      : index;
    if (!selected || updateId > selected.updateId || (updateId === selected.updateId && index > selected.index)) {
      selected = {
        updateId,
        index,
        identity: { chatId: String(chatId), userId: String(userId) },
      };
    }
  }

  return selected?.identity ?? null;
}

function readEnvValue(content: string, key: string): string | null {
  for (const line of stripBom(content).split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || match[1] !== key) continue;
    const raw = match[2].trim();
    if (
      raw.length >= 2 &&
      ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
    ) {
      return raw.slice(1, -1);
    }
    return raw;
  }
  return null;
}

/** Replace only the three Telegram credential fields, preserving every other line. */
export function updateTelegramEnv(
  content: string,
  values: { botToken: string; chatId: string; allowedUser: string },
): string {
  // Normalize away a UTF-8 BOM. It is unnecessary for UTF-8 and otherwise
  // prevents dotenv-style /^KEY=/ readers from recognizing the first field.
  content = stripBom(content);
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const hadTrailingNewline = /(?:\r\n|\n)$/.test(content);
  const lines = content ? content.split(/\r?\n/) : [];
  if (hadTrailingNewline) lines.pop();

  const replacements: Record<(typeof CREDENTIAL_KEYS)[number], string> = {
    BOT_TOKEN: values.botToken,
    CHAT_ID: values.chatId,
    ALLOWED_USER: values.allowedUser,
  };
  const written = new Set<string>();
  const output: string[] = [];

  for (const line of lines) {
    const match = line.match(/^\s*(?:export\s+)?(BOT_TOKEN|CHAT_ID|ALLOWED_USER)\s*=/);
    const key = match?.[1] as (typeof CREDENTIAL_KEYS)[number] | undefined;
    if (!key) {
      output.push(line);
      continue;
    }
    // Canonicalize each managed field and remove stale duplicate definitions.
    if (!written.has(key)) {
      output.push(`${key}=${replacements[key]}`);
      written.add(key);
    }
  }

  for (const key of CREDENTIAL_KEYS) {
    if (!written.has(key)) output.push(`${key}=${replacements[key]}`);
  }

  // Secret env files are conventionally newline terminated. This does not
  // change the contents of any preserved line.
  return `${output.join(newline)}${newline}`;
}

function validateOptions(options: TelegramOnboardOptions): void {
  try {
    validateAgentName(options.agent);
    validateOrgName(options.org);
    validateInstanceId(options.instance);
  } catch {
    throw new Error('Telegram onboarding received an invalid name.');
  }
}

function pathIsInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function resolveAgentEnv(
  projectRoot: string,
  org: string,
  agent: string,
): { agentsRoot: string; agentDir: string; envPath: string } {
  const agentsRoot = resolve(projectRoot, 'orgs', org, 'agents');
  const agentDir = resolve(agentsRoot, agent);
  if (!pathIsInside(agentsRoot, agentDir)) {
    throw new Error('Telegram onboarding could not locate the requested agent.');
  }
  return { agentsRoot, agentDir, envPath: join(agentDir, '.env') };
}

/**
 * Securely discover and store a private Telegram identity for one agent.
 * getUpdates always uses offset 0, so the daemon can still receive the same
 * first message when its poller starts.
 */
export async function onboardTelegramAgent(
  options: TelegramOnboardOptions,
  dependencies: TelegramOnboardDependencies = defaultDependencies,
): Promise<void> {
  validateOptions(options);
  let projectRoot: string;
  try {
    projectRoot = dependencies.projectRoot();
  } catch {
    throw new Error('Telegram onboarding could not resolve the project.');
  }
  const { agentsRoot, agentDir, envPath } = resolveAgentEnv(
    projectRoot,
    options.org,
    options.agent,
  );
  if (!dependencies.fileExists(agentDir) || !dependencies.isDirectory(agentDir)) {
    throw new Error('Telegram onboarding could not locate the requested agent.');
  }
  try {
    if (!pathIsInside(dependencies.realPath(agentsRoot), dependencies.realPath(agentDir))) {
      throw new Error('outside agent root');
    }
    if (
      dependencies.fileExists(envPath) &&
      !pathIsInside(dependencies.realPath(agentDir), dependencies.realPath(envPath))
    ) {
      throw new Error('credential file outside agent directory');
    }
  } catch {
    throw new Error('Telegram onboarding could not validate the agent path.');
  }

  let existing = '';
  if (dependencies.fileExists(envPath)) {
    try {
      existing = dependencies.readFile(envPath);
    } catch {
      throw new Error('Telegram onboarding could not read the credential file.');
    }
  }

  let token: string;
  try {
    token = options.useExistingToken
      ? readEnvValue(existing, 'BOT_TOKEN') ?? ''
      : (await dependencies.promptForToken()).trim();
  } catch {
    throw new Error('Telegram token entry was not completed.');
  }
  if (!TELEGRAM_TOKEN_PATTERN.test(token)) {
    throw new Error(options.useExistingToken
      ? 'No valid existing Telegram token is provisioned for this agent.'
      : 'The Telegram token format is invalid.');
  }

  dependencies.log('Send a private message to the bot. Waiting securely for it now...');
  let api: TelegramUpdatesClient;
  try {
    api = dependencies.createClient(token);
  } catch {
    throw new Error('Telegram onboarding could not initialize securely.');
  }
  let identity: TelegramIdentity | null = null;
  for (let attempt = 0; attempt < 3 && !identity; attempt++) {
    try {
      // Offset 0 is intentional: never acknowledge/consume the message needed
      // by the agent's first live long poll.
      identity = selectLatestPrivateTelegramIdentity(await api.getUpdates(0, 30));
    } catch {
      // Do not surface Telegram errors: they may contain a tokenized request URL.
    }
    // An already-pending non-private update makes offset=0 return immediately.
    // Keep the offset unconsumed, but leave the user time to send the private
    // message before retrying rather than burning all attempts at once.
    if (!identity && attempt < 2) {
      try {
        await dependencies.wait(5_000);
      } catch {
        throw new Error('Telegram onboarding was interrupted.');
      }
    }
  }
  if (!identity) {
    throw new Error('No private Telegram message was detected. Send a message and retry.');
  }

  const updated = updateTelegramEnv(existing, {
    botToken: token,
    chatId: identity.chatId,
    allowedUser: identity.userId,
  });
  try {
    dependencies.writeSecretFile(envPath, updated);
  } catch {
    throw new Error('Telegram credentials could not be stored securely.');
  }
  dependencies.log('Telegram credentials configured securely.');
}

/** Build a fresh command tree so the runtime mapping can be tested in isolation. */
export function createTelegramCommand(
  dependencies: TelegramOnboardDependencies = defaultDependencies,
): Command {
  const onboardCommand = new Command('onboard')
    .description('Securely discover and configure Telegram credentials for an agent')
    .argument('<agent>', 'Agent name')
    .requiredOption('--org <org>', 'Organization name')
    .option('--instance <id>', 'Instance ID', 'default')
    .option('--use-existing-token', 'Use BOT_TOKEN already provisioned in the agent credential file', false)
    .action(async (agent: string, options: { org: string; instance: string; useExistingToken: boolean }) => {
      await onboardTelegramAgent({ agent, ...options }, dependencies);
    });

  return new Command('telegram')
    .description('Configure Telegram integrations')
    .addCommand(onboardCommand);
}

export const telegramCommand = createTelegramCommand();
