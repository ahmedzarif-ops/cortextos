/**
 * Inbox digest — keeps routine FYI traffic from waking the orchestrator.
 *
 * Every message injected into the orchestrator costs a full turn over its whole
 * context. Measured over one week: 582 messages to the orchestrator, roughly 45%
 * of them acknowledgements, FYIs or "no action" notes. Those can be read once,
 * in a batch, instead of one turn each.
 *
 * Classification is deliberately conservative: a message is digestible only if
 * it is normal/low priority, reads as an FYI/ack/status, and carries nothing
 * that asks for the orchestrator (a question mark, decision, blocker, approval,
 * urgent). Anything in doubt is delivered live.
 *
 * Modes (config `inbox_digest`): "off" = today's behaviour; "shadow" (default)
 * = deliver live AND log what would have been digested, so precision can be
 * measured before anything is diverted; "on" = digestible messages go to the
 * digest file and are acked without waking the orchestrator.
 */

import { appendFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { ensureDir } from '../utils/atomic.js';
import type { InboxMessage } from '../types/index.js';

export type DigestMode = 'off' | 'shadow' | 'on';

const DIGEST_PATTERN =
  /\b(fyi|no action( needed)?|no reply( needed)?|ack(nowledged)?|received|noted|for the record|corroborat\w*)\b|\b(status( update)?|done|completed):/i;
const KEEP_PATTERN = /\?|\b(decision|decide|blocker|blocked|approval|approve|urgent|asap)\b/i;

export function resolveDigestMode(value: unknown): DigestMode {
  return value === 'off' || value === 'on' ? value : 'shadow';
}

/** True when a message can be read in a batch instead of waking the orchestrator. */
export function isDigestible(msg: Pick<InboxMessage, 'priority' | 'text'>): boolean {
  if (msg.priority !== 'normal' && msg.priority !== 'low') return false;
  const text = msg.text || '';
  if (KEEP_PATTERN.test(text)) return false;
  return DIGEST_PATTERN.test(text);
}

export function digestPath(stateDir: string, day: string): string {
  return join(stateDir, 'digest', `${day}.jsonl`);
}

/** Append one message to the day's digest. Never throws. */
export function appendDigest(stateDir: string, msg: InboxMessage, mode: DigestMode, now: Date = new Date()): void {
  try {
    ensureDir(join(stateDir, 'digest'));
    appendFileSync(
      digestPath(stateDir, now.toISOString().slice(0, 10)),
      JSON.stringify({
        ts: now.toISOString(),
        mode,
        delivered_live: mode !== 'on',
        id: msg.id,
        from: msg.from,
        priority: msg.priority,
        sent_at: msg.timestamp,
        text: msg.text,
      }) + '\n',
    );
  } catch { /* the message is still handled by the caller */ }
}

/** Human-readable digest for one day ('' when empty). */
export function formatDigest(stateDir: string, day: string): string {
  const p = digestPath(stateDir, day);
  if (!existsSync(p)) return '';
  const lines: string[] = [];
  for (const raw of readFileSync(p, 'utf-8').split('\n')) {
    if (!raw.trim()) continue;
    try {
      const e = JSON.parse(raw);
      const body = String(e.text ?? '').replace(/\s+/g, ' ').slice(0, 160);
      lines.push(`${String(e.ts).slice(11, 16)}Z ${e.from}${e.delivered_live ? ' (also delivered live)' : ''}: ${body}`);
    } catch { /* skip a torn line */ }
  }
  return lines.join('\n');
}
