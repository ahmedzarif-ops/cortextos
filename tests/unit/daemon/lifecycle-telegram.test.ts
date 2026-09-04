import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { BusPaths } from '../../../src/types/index.js';
import {
  DAEMON_LIFECYCLE_OWNER_MARKER,
  DAEMON_PID_ENV,
  clearDaemonLifecycleOwnerMarker,
  hasLiveDaemonLifecycleOwner,
  isLifecycleTelegramAuthorized,
  parseDaemonPid,
  resolveConfiguredOrchestrator,
  sendLifecycleTelegramWithReceipt,
  writeDaemonLifecycleOwnerMarker,
} from '../../../src/telegram/lifecycle.js';

describe('lifecycle Telegram authority and receipts', () => {
  let root: string;
  let contextPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lifecycle-telegram-'));
    const orgDir = join(root, 'orgs', 'acme');
    mkdirSync(orgDir, { recursive: true });
    contextPath = join(orgDir, 'context.json');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('accepts an exact BOM-prefixed configured orchestrator', () => {
    writeFileSync(contextPath, `\uFEFF${JSON.stringify({ orchestrator: 'chief' })}`, 'utf-8');
    expect(resolveConfiguredOrchestrator(root, 'acme')).toBe('chief');
    expect(isLifecycleTelegramAuthorized({
      agentName: 'chief',
      frameworkRoot: root,
      org: 'acme',
      lifecycleNotificationsEnabled: undefined,
    })).toBe(true);
  });

  it.each([
    ['missing context', null],
    ['BOM only', '\uFEFF'],
    ['malformed JSON', '{not-json'],
    ['missing field', JSON.stringify({})],
    ['empty string', JSON.stringify({ orchestrator: '' })],
    ['whitespace only', JSON.stringify({ orchestrator: '   ' })],
    ['surrounding whitespace', JSON.stringify({ orchestrator: ' chief ' })],
    ['non-string', JSON.stringify({ orchestrator: 7 })],
    ['invalid agent name', JSON.stringify({ orchestrator: 'Chief/admin' })],
  ])('fails closed for %s', (_label, content: string | null) => {
    if (content !== null) writeFileSync(contextPath, content, 'utf-8');
    expect(resolveConfiguredOrchestrator(root, 'acme')).toBeNull();
    expect(isLifecycleTelegramAuthorized({
      agentName: 'chief',
      frameworkRoot: root,
      org: 'acme',
      lifecycleNotificationsEnabled: true,
    })).toBe(false);
  });

  it('requires exact agent equality and preserves the per-agent opt-out', () => {
    writeFileSync(contextPath, JSON.stringify({ orchestrator: 'chief' }), 'utf-8');
    expect(isLifecycleTelegramAuthorized({
      agentName: 'sentinel',
      frameworkRoot: root,
      org: 'acme',
      lifecycleNotificationsEnabled: true,
    })).toBe(false);
    expect(isLifecycleTelegramAuthorized({
      agentName: 'chief',
      frameworkRoot: root,
      org: 'acme',
      lifecycleNotificationsEnabled: false,
    })).toBe(false);
  });

  it('records outbound, cache, and activity receipts after successful direct delivery', async () => {
    const ctxRoot = join(root, 'instance');
    const paths: BusPaths = {
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
    const sendMessage = vi.fn().mockResolvedValue({ result: { message_id: 314 } });

    await sendLifecycleTelegramWithReceipt({
      api: { sendMessage } as any,
      paths,
      ctxRoot,
      agentName: 'chief',
      org: 'acme',
      chatId: '12345',
      text: 'Agent chief is back online',
    });

    expect(sendMessage).toHaveBeenCalledWith('12345', 'Agent chief is back online');
    const outboundPath = join(ctxRoot, 'logs', 'chief', 'outbound-messages.jsonl');
    const outbound = JSON.parse(readFileSync(outboundPath, 'utf-8').trim());
    expect(outbound).toMatchObject({
      agent: 'chief',
      chat_id: '12345',
      text: 'Agent chief is back online',
      message_id: 314,
      parse_mode: 'html',
    });
    expect(readFileSync(join(ctxRoot, 'state', 'chief', 'last-telegram-12345.txt'), 'utf-8'))
      .toBe('Agent chief is back online');

    const eventDir = join(paths.analyticsDir, 'events', 'chief');
    expect(existsSync(eventDir)).toBe(true);
    const eventFile = join(eventDir, `${new Date().toISOString().split('T')[0]}.jsonl`);
    const event = JSON.parse(readFileSync(eventFile, 'utf-8').trim());
    expect(event).toMatchObject({
      agent: 'chief',
      org: 'acme',
      category: 'message',
      event: 'telegram_sent',
      metadata: {
        chat_id: '12345',
        message_id: 314,
        preview: 'Agent chief is back online',
      },
    });
  });
});

describe('daemon lifecycle owner marker provenance', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'lifecycle-owner-marker-'));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('names the env var the PTY builders inject', () => {
    expect(DAEMON_PID_ENV).toBe('CTX_DAEMON_PID');
  });

  it.each([
    ['live pid', String(process.pid), process.pid],
    ['undefined', undefined, undefined],
    ['empty', '', undefined],
    ['zero', '0', undefined],
    ['negative', '-5', undefined],
    ['float', '12.5', undefined],
    ['leading zero', '007', undefined],
    ['whitespace padded', ' 42', undefined],
    ['non-numeric', 'pid', undefined],
    ['too long', '12345678901', undefined],
  ])('parseDaemonPid handles %s', (_label, value, expected) => {
    expect(parseDaemonPid(value as string | undefined)).toBe(expected);
  });

  it('writes this process as owner and recognizes it only with the matching expected PID', () => {
    writeDaemonLifecycleOwnerMarker(stateDir, 'chief');
    const marker = JSON.parse(readFileSync(join(stateDir, DAEMON_LIFECYCLE_OWNER_MARKER), 'utf-8'));
    expect(marker).toEqual({ daemonPid: process.pid, agentName: 'chief' });

    expect(hasLiveDaemonLifecycleOwner(stateDir, 'chief', process.pid)).toBe(true);
    expect(hasLiveDaemonLifecycleOwner(stateDir, 'chief', undefined)).toBe(false);
    expect(hasLiveDaemonLifecycleOwner(stateDir, 'chief', process.ppid)).toBe(false);
    expect(hasLiveDaemonLifecycleOwner(stateDir, 'sentinel', process.pid)).toBe(false);
  });

  it('rejects a matching but dead daemon PID', () => {
    const deadPid = 2147483000;
    writeFileSync(
      join(stateDir, DAEMON_LIFECYCLE_OWNER_MARKER),
      JSON.stringify({ daemonPid: deadPid, agentName: 'chief' }),
      'utf-8',
    );
    expect(hasLiveDaemonLifecycleOwner(stateDir, 'chief', deadPid)).toBe(false);
  });

  it('clears the marker on stop and tolerates a missing marker', () => {
    writeDaemonLifecycleOwnerMarker(stateDir, 'chief');
    clearDaemonLifecycleOwnerMarker(stateDir);
    expect(existsSync(join(stateDir, DAEMON_LIFECYCLE_OWNER_MARKER))).toBe(false);
    expect(() => clearDaemonLifecycleOwnerMarker(stateDir)).not.toThrow();
    expect(hasLiveDaemonLifecycleOwner(stateDir, 'chief', process.pid)).toBe(false);
  });
});
