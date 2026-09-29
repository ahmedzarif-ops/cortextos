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
 *  - a deployment that has deliberately no orchestrator keeps the original
 *    behaviour: `orchestrator` absent or "" in a readable context.json (what
 *    `cortextos init` writes), or no context.json in an org with at most one
 *    agent, or no org at all. A standalone agent messaging its own user is
 *    correct.
 *  - anything else that fails to resolve is BLOCKED, never sent to the owner:
 *    an unreadable context.json, a non-empty `orchestrator` that does not
 *    resolve (a typo, surrounding whitespace, an invalid name), or a missing
 *    context.json in an org with more than one agent. One bad edit must not
 *    silently reopen every specialist's route to the owner.
 */

import { existsSync, readFileSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { stripBom } from '../utils/strip-bom.js';
import type { BusPaths } from '../types/index.js';
import { sendMessage } from '../bus/message.js';
import { atomicWriteSync } from '../utils/atomic.js';
import { resolveConfiguredOrchestrator } from '../telegram/lifecycle.js';

export type OwnerContactRoute =
  | { kind: 'owner' }
  | { kind: 'unconfigured' }
  | { kind: 'reroute'; orchestrator: string }
  | { kind: 'blocked'; why: string };

/** Infer framework root and org from an agent dir shaped `<root>/orgs/<org>/agents/<name>`. */
export function orgFromAgentDir(agentDir: string | undefined): { frameworkRoot: string; org: string } | null {
  const m = agentDir?.match(/^(.*)[\\/]orgs[\\/]([^\\/]+)[\\/]agents[\\/][^\\/]+[\\/]?$/);
  return m ? { frameworkRoot: m[1], org: m[2] } : null;
}

function countAgentDirs(frameworkRoot: string, org: string): number {
  try {
    return readdirSync(join(frameworkRoot, 'orgs', org, 'agents'), { withFileTypes: true })
      .filter((e) => e.isDirectory()).length;
  } catch {
    return 0;
  }
}

export function resolveOwnerContactRoute(
  agentName: string,
  frameworkRoot: string | undefined,
  org: string | undefined,
  agentDir?: string,
): OwnerContactRoute {
  if (!frameworkRoot || !org) {
    const inferred = orgFromAgentDir(agentDir);
    if (inferred) {
      frameworkRoot = frameworkRoot || inferred.frameworkRoot;
      org = org || inferred.org;
    }
  }

  const orchestrator = resolveConfiguredOrchestrator(frameworkRoot, org);
  if (orchestrator !== null) {
    return agentName === orchestrator ? { kind: 'owner' } : { kind: 'reroute', orchestrator };
  }
  if (!frameworkRoot || !org) return { kind: 'unconfigured' };

  const contextPath = join(frameworkRoot, 'orgs', org, 'context.json');
  if (!existsSync(contextPath)) {
    return countAgentDirs(frameworkRoot, org) > 1
      ? { kind: 'blocked', why: `orgs/${org}/context.json is missing in an org with more than one agent` }
      : { kind: 'unconfigured' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(readFileSync(contextPath, 'utf-8')));
  } catch {
    return { kind: 'blocked', why: `orgs/${org}/context.json cannot be read as JSON` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'blocked', why: `orgs/${org}/context.json is not a JSON object` };
  }
  const field = (parsed as Record<string, unknown>).orchestrator;
  if (field === undefined || field === '') return { kind: 'unconfigured' };
  return { kind: 'blocked', why: `orgs/${org}/context.json names an orchestrator that does not resolve (${JSON.stringify(field)})` };
}

export function blockedQuestionReason(why: string): string {
  return `ONE VOICE: AskUserQuestion is blocked because the org orchestrator cannot be resolved: ${why}. ` +
    'Do not ask the owner. Send your question to your orchestrator with cortextos bus send-message, and report the configuration fault.';
}

export function blockedPermissionReason(why: string): string {
  return `ONE VOICE: permission prompts are blocked because the org orchestrator cannot be resolved: ${why}. Denied. ` +
    'Ask your orchestrator with cortextos bus send-message, or file an approval with cortextos bus create-approval.';
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
