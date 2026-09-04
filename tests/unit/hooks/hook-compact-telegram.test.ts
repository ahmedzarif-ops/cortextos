import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { BusPaths } from '../../../src/types/index.js';

const pathState = vi.hoisted(() => ({ paths: null as BusPaths | null }));
vi.mock('../../../src/utils/paths.js', () => ({
  resolvePaths: () => pathState.paths,
}));

const ENV_KEYS = [
  'BOT_TOKEN',
  'CHAT_ID',
  'CTX_AGENT_DIR',
  'CTX_AGENT_NAME',
  'CTX_FRAMEWORK_ROOT',
  'CTX_INSTANCE_ID',
  'CTX_ORG',
  'CTX_ROOT',
] as const;
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
for (const key of ENV_KEYS) delete process.env[key];

// Import only after clearing the inherited live-agent environment: this hook
// self-invokes at module load, and the empty credential state makes that a no-op.
const { runCompactTelegram } = await import('../../../src/hooks/hook-compact-telegram.js');

describe('hook-compact-telegram ONE VOICE gate', () => {
  let root: string;
  let frameworkRoot: string;
  let ctxRoot: string;
  let agentDir: string;
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'compact-one-voice-'));
    frameworkRoot = join(root, 'framework');
    ctxRoot = join(root, 'instance');
    agentDir = join(frameworkRoot, 'orgs', 'acme', 'agents', 'chief');
    mkdirSync(agentDir, { recursive: true });

    pathState.paths = {
      ctxRoot,
      inbox: join(ctxRoot, 'inbox', 'chief'),
      inflight: join(ctxRoot, 'inflight', 'chief'),
      processed: join(ctxRoot, 'processed', 'chief'),
      logDir: join(ctxRoot, 'logs', 'chief'),
      stateDir: join(ctxRoot, 'state', 'chief'),
      taskDir: join(ctxRoot, 'orgs', 'acme', 'tasks'),
      approvalDir: join(ctxRoot, 'orgs', 'acme', 'approvals'),
      analyticsDir: join(ctxRoot, 'orgs', 'acme', 'analytics'),
      deliverablesDir: join(ctxRoot, 'orgs', 'acme', 'deliverables'),
    };

    process.env.BOT_TOKEN = '123:test-token';
    process.env.CHAT_ID = '456';
    process.env.CTX_AGENT_DIR = agentDir;
    process.env.CTX_AGENT_NAME = 'chief';
    process.env.CTX_FRAMEWORK_ROOT = frameworkRoot;
    process.env.CTX_INSTANCE_ID = 'compact-test';
    process.env.CTX_ORG = 'acme';
    process.env.CTX_ROOT = ctxRoot;

    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 808 } }),
    });
    globalThis.fetch = fetchMock as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of ENV_KEYS) delete process.env[key];
    pathState.paths = null;
    rmSync(root, { recursive: true, force: true });
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function writeContext(orchestrator: unknown): void {
    writeFileSync(
      join(frameworkRoot, 'orgs', 'acme', 'context.json'),
      JSON.stringify({ orchestrator }),
      'utf-8',
    );
  }

  it('lets exact configured Chief send compaction notice and records receipts', async () => {
    writeContext('chief');
    writeFileSync(join(agentDir, 'config.json'), '{}', 'utf-8');

    await runCompactTelegram();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      chat_id: '456',
      text: '[chief] Context compacting... resuming shortly',
    });
    const outbound = join(ctxRoot, 'logs', 'chief', 'outbound-messages.jsonl');
    expect(existsSync(outbound)).toBe(true);
    expect(JSON.parse(readFileSync(outbound, 'utf-8').trim())).toMatchObject({
      agent: 'chief',
      message_id: 808,
      parse_mode: 'none',
    });
  });

  it('never lets a specialist send the compaction notice directly', async () => {
    writeContext('chief');
    process.env.CTX_AGENT_NAME = 'sentinel';
    process.env.CTX_AGENT_DIR = join(frameworkRoot, 'orgs', 'acme', 'agents', 'sentinel');
    mkdirSync(process.env.CTX_AGENT_DIR, { recursive: true });
    writeFileSync(join(process.env.CTX_AGENT_DIR, 'config.json'), '{}', 'utf-8');

    await runCompactTelegram();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['missing authority', null],
    ['empty authority', ''],
    ['non-string authority', 7],
  ])('fails closed for %s', async (_label, orchestrator: unknown) => {
    if (orchestrator !== null) writeContext(orchestrator);
    writeFileSync(join(agentDir, 'config.json'), '{}', 'utf-8');

    await runCompactTelegram();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('honors telegram_polling false as the global direct-lifecycle opt-out for configured Chief', async () => {
    writeContext('chief');
    writeFileSync(
      join(agentDir, 'config.json'),
      JSON.stringify({ telegram_polling: false }),
      'utf-8',
    );

    await runCompactTelegram();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(existsSync(join(ctxRoot, 'logs', 'chief', 'outbound-messages.jsonl'))).toBe(false);
  });

  it('honors configured Chief routine-lifecycle opt-out', async () => {
    writeContext('chief');
    writeFileSync(
      join(agentDir, 'config.json'),
      JSON.stringify({ telegram_lifecycle_notifications: false }),
      'utf-8',
    );

    await runCompactTelegram();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
