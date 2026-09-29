/**
 * one-voice.ts — who may put an interactive prompt in the owner's hand.
 *
 * The ask / permission / plan-mode hooks send to the seat's CHAT_ID. On a
 * specialist seat that chat is the owner's, so every specialist question used
 * to reach the owner directly. Authority comes from the same place as the
 * lifecycle gate (orgs/<org>/context.json `orchestrator`):
 *
 *  - the configured orchestrator keeps the original Telegram behaviour;
 *  - every other seat is rerouted to the orchestrator over the internal bus;
 *  - a deployment with no configured orchestrator (no org context, no field,
 *    or an unreadable file) keeps the original behaviour. There is nobody to
 *    reroute to, and a single-agent install messaging its own user is correct.
 */

import { existsSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import type { BusPaths } from '../types/index.js';
import { sendMessage } from '../bus/message.js';
import { atomicWriteSync } from '../utils/atomic.js';
import { resolveConfiguredOrchestrator } from '../telegram/lifecycle.js';

export type OwnerContactRoute =
  | { kind: 'owner' }
  | { kind: 'unconfigured' }
  | { kind: 'reroute'; orchestrator: string };

export function resolveOwnerContactRoute(
  agentName: string,
  frameworkRoot: string | undefined,
  org: string | undefined,
): OwnerContactRoute {
  const orchestrator = resolveConfiguredOrchestrator(frameworkRoot, org);
  if (orchestrator === null) return { kind: 'unconfigured' };
  if (agentName === orchestrator) return { kind: 'owner' };
  return { kind: 'reroute', orchestrator };
}

/** State file that links a rerouted question to the orchestrator's answer. */
export const REROUTED_ASK_FILE = 'rerouted-ask.json';

export interface ReroutedAsk {
  msg_id: string;
  orchestrator: string;
  asked_at: string;
}

export function formatReroutedQuestion(agentName: string, questions: any[]): string {
  const lines = [
    `QUESTION from ${agentName} (ONE VOICE: rerouted from AskUserQuestion; it did NOT reach the owner).`,
  ];
  questions.forEach((q, i) => {
    const options = (q?.options || [])
      .map((o: any) => (o && typeof o === 'object' ? o.label : o))
      .filter((o: unknown) => typeof o === 'string' && o.length > 0);
    const multi = q?.multiSelect ? ' (multi-select)' : '';
    lines.push(`${i + 1}. ${q?.question || '(no question text)'}${multi}`);
    if (options.length > 0) lines.push(`   Options: ${options.join(' | ')}`);
  });
  lines.push(`Answer it yourself or take it to the owner. Reply to this message id so ${agentName} sees it as the answer.`);
  return lines.join('\n');
}

export interface RerouteResult {
  /** Bus message id, or null when the send failed. */
  msgId: string | null;
  /** Text for the model (stderr of a blocking PreToolUse hook). */
  reason: string;
}

/**
 * Send a specialist's AskUserQuestion to the orchestrator and record the link
 * so the answer can be delivered as the answer. Never throws.
 */
export function rerouteQuestion(opts: {
  paths: BusPaths;
  agentName: string;
  orchestrator: string;
  questions: any[];
  now?: Date;
}): RerouteResult {
  const { paths, agentName, orchestrator, questions } = opts;
  let msgId: string | null = null;
  try {
    msgId = sendMessage(paths, agentName, orchestrator, 'high', formatReroutedQuestion(agentName, questions));
  } catch {
    msgId = null;
  }

  if (msgId === null) {
    return {
      msgId,
      reason:
        `ONE VOICE: AskUserQuestion does not reach the owner from this seat, and the reroute to ${orchestrator} failed. ` +
        `Do not ask the owner. Send your question with: cortextos bus send-message ${orchestrator} high '<question>'`,
    };
  }

  try {
    const record: ReroutedAsk = {
      msg_id: msgId,
      orchestrator,
      asked_at: (opts.now ?? new Date()).toISOString(),
    };
    atomicWriteSync(join(paths.stateDir, REROUTED_ASK_FILE), JSON.stringify(record));
  } catch {
    // The question was delivered; without the link the answer still arrives
    // as a normal agent message.
  }

  return {
    msgId,
    reason:
      `ONE VOICE: AskUserQuestion does not reach the owner from this seat. Your question went to ${orchestrator} (msg ${msgId}). ` +
      `${orchestrator}'s reply arrives as an AGENT MESSAGE marked as the answer to this question: that reply IS the user's answer, act on it. ` +
      'Do not ask the owner in plain text and do not wait at the terminal. End your turn or continue other work.',
  };
}

export function readReroutedAsk(stateDir: string): ReroutedAsk | null {
  const file = join(stateDir, REROUTED_ASK_FILE);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    if (typeof parsed?.msg_id !== 'string' || typeof parsed?.orchestrator !== 'string') return null;
    return parsed as ReroutedAsk;
  } catch {
    return null;
  }
}

export function clearReroutedAsk(stateDir: string): void {
  try { unlinkSync(join(stateDir, REROUTED_ASK_FILE)); } catch { /* already gone */ }
}

/**
 * True when an inbox message is the orchestrator's reply to the pending
 * rerouted question. Both the sender and the reply_to link must match.
 */
export function isAnswerToReroutedAsk(
  msg: { from: string; reply_to?: string | null },
  pending: ReroutedAsk | null,
): boolean {
  return pending !== null
    && msg.from === pending.orchestrator
    && typeof msg.reply_to === 'string'
    && msg.reply_to === pending.msg_id;
}

export const PERMISSION_REROUTE_REASON = (orchestrator: string): string =>
  `ONE VOICE: permission prompts do not reach the owner from this seat. Denied. ` +
  `If you need this action, ask ${orchestrator} with cortextos bus send-message, or file an approval with cortextos bus create-approval.`;
