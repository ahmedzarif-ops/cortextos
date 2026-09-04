/**
 * hook-compact-telegram.ts — PreCompact hook.
 * Sends a Telegram notification when Claude Code begins context compaction,
 * so the user knows why the agent goes quiet for a moment (#18).
 *
 * This hook fires and returns immediately — it never blocks the compaction.
 * Registered in settings.json under the "PreCompact" event.
 *
 * Safety: fetch is raced against a 5s abort signal so this process always
 * exits well within the 10s settings.json timeout. A timed-out or failed
 * Telegram call must never abort compaction.
 */

import { loadEnv } from './index.js';
import {
  isLifecycleTelegramAuthorized,
  readLifecycleNotificationsPreference,
  readTelegramPollingPreference,
  recordLifecycleTelegramReceipt,
} from '../telegram/lifecycle.js';
import { resolvePaths } from '../utils/paths.js';

export async function runCompactTelegram(): Promise<void> {
  const env = loadEnv();

  if (!env.botToken || !env.chatId) return;

  const agentName = env.agentName || 'agent';
  const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
  const org = process.env.CTX_ORG;
  if (!frameworkRoot || !org) return;

  // Compaction is lifecycle churn, not an inbound reply. Only the exact org
  // orchestrator may initiate this owner-facing update, and its routine
  // lifecycle preference remains an additional opt-out.
  if (readTelegramPollingPreference(process.env.CTX_AGENT_DIR || process.cwd()) === false) {
    return;
  }
  if (!isLifecycleTelegramAuthorized({
    agentName,
    frameworkRoot,
    org,
    lifecycleNotificationsEnabled: readLifecycleNotificationsPreference(
      process.env.CTX_AGENT_DIR || process.cwd(),
    ),
  })) return;

  const text = `[${agentName}] Context compacting... resuming shortly`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const url = `https://api.telegram.org/bot${env.botToken}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.chatId,
        text,
      }),
      signal: controller.signal,
    });
    const result = await response.json() as any;
    if (!response.ok || result?.ok === false) return;
    recordLifecycleTelegramReceipt({
      paths: resolvePaths(agentName, process.env.CTX_INSTANCE_ID || 'default', org),
      ctxRoot: env.ctxRoot,
      agentName,
      org,
      chatId: env.chatId,
      text,
      messageId: result?.result?.message_id ?? 0,
      parseMode: 'none',
    });
  } catch {
    // Never fail — compaction must not be blocked
  } finally {
    clearTimeout(timer);
  }
}

runCompactTelegram().catch(() => process.exit(0));
