import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', () => ({ execFile: vi.fn() }));
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FastChecker } from '../../../src/daemon/fast-checker';
import { sendMessage } from '../../../src/bus/message';
import { REROUTED_ASK_FILE, rerouteQuestion } from '../../../src/hooks/one-voice';
import type { BusPaths } from '../../../src/types';

/**
 * ONE VOICE, the half that the ask hook cannot do alone: a specialist's
 * question is rerouted to the orchestrator, and the orchestrator's reply must
 * arrive marked as THE ANSWER. Without the mark, a seat whose question was
 * blocked can fall back to asking the owner in plain text in its own terminal
 * and keep waiting there after the orchestrator has already answered.
 */

const ANSWER_NOTE = "It IS the user's answer";

function pathsFor(ctxRoot: string, agent: string): BusPaths {
  const paths = {
    ctxRoot,
    inbox: join(ctxRoot, 'inbox', agent),
    inflight: join(ctxRoot, 'inflight', agent),
    processed: join(ctxRoot, 'processed', agent),
    logDir: join(ctxRoot, 'logs', agent),
    stateDir: join(ctxRoot, 'state', agent),
    taskDir: join(ctxRoot, 'tasks'),
    approvalDir: join(ctxRoot, 'approvals'),
    analyticsDir: join(ctxRoot, 'analytics'),
  } as BusPaths;
  for (const dir of Object.values(paths)) mkdirSync(dir, { recursive: true });
  return paths;
}

function mockAgent(name: string, injected = true) {
  return {
    name,
    hasEverBootstrapped: vi.fn().mockReturnValue(true),
    injectMessage: vi.fn().mockReturnValue(injected),
    write: vi.fn(),
  } as any;
}

describe('FastChecker — orchestrator answer to a rerouted question', () => {
  let ctxRoot: string;
  let growth: BusPaths;
  let chief: BusPaths;

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'fastchecker-one-voice-'));
    growth = pathsFor(ctxRoot, 'growth');
    chief = pathsFor(ctxRoot, 'chief');
  });

  afterEach(() => {
    rmSync(ctxRoot, { recursive: true, force: true });
  });

  function askAndAnswer(): string {
    const { msgId } = rerouteQuestion({
      paths: growth,
      agentName: 'growth',
      orchestrator: 'chief',
      questions: [{ question: 'Which pricing?', options: [{ label: 'C' }] }],
    });
    expect(msgId).not.toBeNull();
    return msgId!;
  }

  it('marks the reply as the answer, leaves other messages unmarked, and clears the link', async () => {
    const askId = askAndAnswer();
    sendMessage(chief, 'guard', 'growth', 'normal', 'unrelated note', askId); // right id, wrong sender
    sendMessage(chief, 'chief', 'growth', 'normal', 'another thread');        // right sender, no link
    sendMessage(chief, 'chief', 'growth', 'normal', 'Go with C.', askId);

    const agent = mockAgent('growth');
    const checker = new FastChecker(agent, growth, '/tmp/framework');
    await (checker as any).pollCycle();

    expect(agent.injectMessage).toHaveBeenCalledTimes(1);
    const block = String(agent.injectMessage.mock.calls[0][0]);
    const sections = block.split('=== AGENT MESSAGE from ').slice(1);
    expect(sections).toHaveLength(3);
    const marked = sections.filter((s) => s.includes(ANSWER_NOTE));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain('Go with C.');
    expect(marked[0].startsWith(`chief [reply_to: ${askId}]`)).toBe(true);
    expect(existsSync(join(growth.stateDir, REROUTED_ASK_FILE))).toBe(false);
  }, 20000);

  it('keeps the link when injection fails, so the redelivered answer is still marked', async () => {
    const askId = askAndAnswer();
    sendMessage(chief, 'chief', 'growth', 'normal', 'Go with C.', askId);

    const agent = mockAgent('growth', false);
    const checker = new FastChecker(agent, growth, '/tmp/framework');
    await (checker as any).pollCycle();

    expect(String(agent.injectMessage.mock.calls[0][0])).toContain(ANSWER_NOTE);
    expect(existsSync(join(growth.stateDir, REROUTED_ASK_FILE))).toBe(true);
  });

  it('marks nothing when no question is pending', async () => {
    sendMessage(chief, 'chief', 'growth', 'normal', 'Go with C.', '123-growth-abcde');

    const agent = mockAgent('growth', false);
    const checker = new FastChecker(agent, growth, '/tmp/framework');
    await (checker as any).pollCycle();

    expect(String(agent.injectMessage.mock.calls[0][0])).not.toContain(ANSWER_NOTE);
  });
});
