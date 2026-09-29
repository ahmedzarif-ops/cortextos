
/**
 * hook-ask-telegram.ts - Non-blocking PreToolUse hook for AskUserQuestion
 * Sends question(s) to Telegram, saves state file, exits immediately.
 * The fast-checker daemon handles responses and navigates multi-question flows.
 */

import { TelegramAPI } from '../telegram/api';
import {
  readStdin,
  parseHookInput,
  loadEnv,
  buildAskState,
  buildAskSingleSelectKeyboard,
  buildAskMultiSelectKeyboard,
  formatQuestionMessage,
} from './index';
import { resolveOwnerContactRoute, rerouteQuestion } from './one-voice';
import { resolvePaths } from '../utils/paths';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

async function main(): Promise<void> {
  const input = await readStdin();
  const { tool_input } = parseHookInput(input);

  const questions = tool_input.questions || [];
  if (questions.length === 0) {
    process.exit(0);
  }

  const env = loadEnv();

  // ONE VOICE: only the configured orchestrator may put a question in the
  // owner's hand. Every other seat's question goes to the orchestrator's inbox
  // and the tool call is blocked (exit 2 feeds stderr back to the model), so
  // no menu is left open in a terminal nobody watches. Checked before the
  // credential test: a specialist without a bot must not be left waiting either.
  const org = process.env.CTX_ORG;
  const route = resolveOwnerContactRoute(env.agentName, process.env.CTX_FRAMEWORK_ROOT, org);
  if (route.kind === 'reroute') {
    const { reason } = rerouteQuestion({
      paths: resolvePaths(env.agentName, process.env.CTX_INSTANCE_ID || 'default', org),
      agentName: env.agentName,
      orchestrator: route.orchestrator,
      questions,
    });
    process.stderr.write(reason + '\n');
    process.exit(2);
  }

  if (!env.botToken || !env.chatId) {
    process.exit(0);
  }

  // Save state file for fast-checker
  mkdirSync(env.stateDir, { recursive: true });
  const stateFile = join(env.stateDir, 'ask-state.json');
  const state = buildAskState(questions);
  writeFileSync(stateFile, JSON.stringify(state), 'utf-8');

  // Send first question
  const q = questions[0];
  const isMultiSelect = q.multiSelect || false;
  const options = (q.options || []).map((o: any) => o.label || o);

  const messageText = formatQuestionMessage(env.agentName, 0, questions.length, q);

  const keyboard = isMultiSelect
    ? buildAskMultiSelectKeyboard(0, options)
    : buildAskSingleSelectKeyboard(0, options);

  const api = new TelegramAPI(env.botToken);

  try {
    await api.sendMessage(env.chatId, messageText, keyboard);
  } catch {
    // Non-blocking - exit even on send failure
  }

  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`hook-ask-telegram error: ${err}\n`);
  process.exit(0);
});
