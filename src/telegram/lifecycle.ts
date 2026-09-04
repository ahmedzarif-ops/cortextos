import { readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import type { BusPaths } from '../types/index.js';
import { logEvent } from '../bus/event.js';
import { atomicWriteSync } from '../utils/atomic.js';
import { validateAgentName } from '../utils/validate.js';
import { stripBom } from '../utils/strip-bom.js';
import type { TelegramAPI } from './api.js';
import { cacheLastSent, logOutboundMessage } from './logging.js';

/**
 * Resolve the one agent allowed to initiate owner-facing lifecycle Telegram.
 *
 * Authority comes only from orgs/<org>/context.json. Missing or malformed
 * context, a non-string/blank orchestrator, surrounding whitespace, or an
 * invalid agent name all fail closed to null.
 */
export function resolveConfiguredOrchestrator(
  frameworkRoot: string | undefined,
  org: string | undefined,
): string | null {
  if (!frameworkRoot || !org) return null;

  try {
    const contextPath = join(frameworkRoot, 'orgs', org, 'context.json');
    const parsed: unknown = JSON.parse(stripBom(readFileSync(contextPath, 'utf-8')));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

    const orchestrator = (parsed as Record<string, unknown>).orchestrator;
    if (
      typeof orchestrator !== 'string'
      || orchestrator.length === 0
      || orchestrator.trim() !== orchestrator
    ) {
      return null;
    }

    try {
      validateAgentName(orchestrator);
    } catch {
      return null;
    }
    return orchestrator;
  } catch {
    return null;
  }
}

/**
 * True only when this exact agent is the configured org orchestrator and its
 * own lifecycle-notification preference has not opted out.
 */
export function isLifecycleTelegramAuthorized(opts: {
  agentName: string;
  frameworkRoot: string | undefined;
  org: string | undefined;
  lifecycleNotificationsEnabled: boolean | undefined;
}): boolean {
  if (opts.lifecycleNotificationsEnabled === false) return false;
  const orchestrator = resolveConfiguredOrchestrator(opts.frameworkRoot, opts.org);
  return orchestrator !== null && opts.agentName === orchestrator;
}

/** Read the optional per-agent routine-lifecycle preference from config.json. */
export function readLifecycleNotificationsPreference(
  agentDir: string | undefined,
): boolean | undefined {
  return readLifecycleConfigPreference(agentDir, 'telegram_lifecycle_notifications');
}

/** Read the global direct-Telegram lifecycle opt-out from config.json. */
export function readTelegramPollingPreference(
  agentDir: string | undefined,
): boolean | undefined {
  return readLifecycleConfigPreference(agentDir, 'telegram_polling');
}

function readLifecycleConfigPreference(
  agentDir: string | undefined,
  key: 'telegram_lifecycle_notifications' | 'telegram_polling',
): boolean | undefined {
  if (!agentDir) return undefined;
  try {
    const parsed: unknown = JSON.parse(
      stripBom(readFileSync(join(agentDir, 'config.json'), 'utf-8')),
    );
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const value = (parsed as Record<string, unknown>)[key];
    return typeof value === 'boolean' ? value : undefined;
  } catch {
    return undefined;
  }
}

export const DAEMON_LIFECYCLE_OWNER_MARKER = '.daemon-lifecycle-owner.json';

/**
 * Environment variable the daemon injects into every managed PTY. A Claude
 * Code hook inherits it, so the hook can prove the process that spawned it is
 * the same daemon that wrote the owner marker. A manually launched agent has
 * no such variable and therefore keeps standalone hook crash coverage.
 */
export const DAEMON_PID_ENV = 'CTX_DAEMON_PID';

/** Strictly parse a daemon PID from the injected environment value. */
export function parseDaemonPid(value: string | undefined): number | undefined {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,9}$/.test(value)) return undefined;
  return Number(value);
}

/**
 * Mark this agent lifecycle as daemon-owned. The SessionEnd hook checks the
 * daemon PID before yielding real runtime-crash delivery to AgentManager, so a
 * stale marker left by a dead daemon cannot suppress a standalone hook alert.
 */
export function writeDaemonLifecycleOwnerMarker(stateDir: string, agentName: string): void {
  atomicWriteSync(
    join(stateDir, DAEMON_LIFECYCLE_OWNER_MARKER),
    JSON.stringify({ daemonPid: process.pid, agentName }),
  );
}

export function clearDaemonLifecycleOwnerMarker(stateDir: string): void {
  try {
    unlinkSync(join(stateDir, DAEMON_LIFECYCLE_OWNER_MARKER));
  } catch { /* missing/unwritable marker is non-fatal during teardown */ }
}

/**
 * True only when three facts agree: the caller's environment carries a daemon
 * PID injected by the spawning daemon, the on-disk marker for this exact agent
 * records that same PID, and that PID is still alive. A live PID alone is not
 * provenance: a manual standalone session running beside a live daemon must
 * not have its crash alert suppressed by a marker it did not inherit.
 */
export function hasLiveDaemonLifecycleOwner(
  stateDir: string,
  agentName: string,
  expectedDaemonPid: number | undefined,
): boolean {
  if (!Number.isInteger(expectedDaemonPid) || (expectedDaemonPid as number) <= 0) return false;
  try {
    const parsed: unknown = JSON.parse(stripBom(readFileSync(
      join(stateDir, DAEMON_LIFECYCLE_OWNER_MARKER),
      'utf-8',
    )));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const marker = parsed as Record<string, unknown>;
    if (marker.agentName !== agentName) return false;
    if (!Number.isInteger(marker.daemonPid) || (marker.daemonPid as number) <= 0) return false;
    if (marker.daemonPid !== expectedDaemonPid) return false;
    try {
      process.kill(marker.daemonPid as number, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  } catch {
    return false;
  }
}

/** Record durable receipt surfaces after a successful lifecycle delivery. */
export function recordLifecycleTelegramReceipt(opts: {
  paths: BusPaths;
  ctxRoot: string;
  agentName: string;
  org: string;
  chatId: string | number;
  text: string;
  messageId: number;
  parseMode: 'html' | 'none';
}): void {
  try {
    logOutboundMessage(
      opts.ctxRoot,
      opts.agentName,
      opts.chatId,
      opts.text,
      opts.messageId,
      { parseMode: opts.parseMode },
    );
  } catch { /* delivery succeeded; receipt logging is best-effort */ }

  try {
    cacheLastSent(opts.ctxRoot, opts.agentName, opts.chatId, opts.text);
  } catch { /* delivery succeeded; context cache is best-effort */ }

  try {
    const preview = opts.text.length > 120 ? opts.text.slice(0, 120) + '…' : opts.text;
    logEvent(
      opts.paths,
      opts.agentName,
      opts.org,
      'message',
      'telegram_sent',
      'info',
      { chat_id: opts.chatId, message_id: opts.messageId, preview },
    );
  } catch { /* delivery succeeded; activity receipt is best-effort */ }
}

/**
 * Send a daemon-owned lifecycle message and record the same durable receipt
 * surfaces as `cortextos bus send-telegram`: outbound JSONL, last-sent cache,
 * and a telegram_sent activity event. Receipt failures remain non-fatal after
 * a successful Telegram delivery; daemon observability must not destabilize
 * the managed agent lifecycle.
 */
export async function sendLifecycleTelegramWithReceipt(opts: {
  api: TelegramAPI;
  paths: BusPaths;
  ctxRoot: string;
  agentName: string;
  org: string;
  chatId: string | number;
  text: string;
}): Promise<void> {
  const result = await opts.api.sendMessage(opts.chatId, opts.text);
  const messageId = result?.result?.message_id ?? 0;
  recordLifecycleTelegramReceipt({
    paths: opts.paths,
    ctxRoot: opts.ctxRoot,
    agentName: opts.agentName,
    org: opts.org,
    chatId: opts.chatId,
    text: opts.text,
    messageId,
    parseMode: 'html',
  });
}
