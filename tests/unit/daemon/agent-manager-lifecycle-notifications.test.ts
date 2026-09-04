import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { AgentStatus, BusPaths } from '../../../src/types/index.js';

// This suite exercises the manager's routing functions only. Mock the PTY-owning
// class before importing agent-manager so no native process layer is loaded.
vi.mock('../../../src/daemon/agent-process.js', () => ({
  AgentProcess: class {},
}));

const {
  createAgentLifecycleStatusHandler,
  routeAgentAlertThroughOneVoice,
} = await import('../../../src/daemon/agent-manager.js');

describe('AgentManager ONE VOICE alert routing', () => {
  let root: string;
  let paths: BusPaths;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'manager-one-voice-'));
    paths = {
      ctxRoot: root,
      inbox: join(root, 'inbox', 'sender'),
      inflight: join(root, 'inflight', 'sender'),
      processed: join(root, 'processed', 'sender'),
      logDir: join(root, 'logs', 'sender'),
      stateDir: join(root, 'state', 'sender'),
      taskDir: join(root, 'orgs', 'acme', 'tasks'),
      approvalDir: join(root, 'orgs', 'acme', 'approvals'),
      analyticsDir: join(root, 'orgs', 'acme', 'analytics'),
      deliverablesDir: join(root, 'orgs', 'acme', 'deliverables'),
    };
    writeContext('chief');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function status(status: AgentStatus['status'], crashCount?: number): AgentStatus {
    return { name: 'chief', status, crashCount };
  }

  function writeContext(orchestrator: unknown): void {
    const orgDir = join(root, 'orgs', 'acme');
    mkdirSync(orgDir, { recursive: true });
    writeFileSync(join(orgDir, 'context.json'), JSON.stringify({ orchestrator }), 'utf-8');
  }

  function inbox(target: string): Array<Record<string, any>> {
    const dir = join(root, 'inbox', target);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => JSON.parse(readFileSync(join(dir, file), 'utf-8')));
  }

  it('keeps Chief crash and HALTED alerts direct when routine lifecycle is disabled', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ result: { message_id: 91 } });
    const handler = createAgentLifecycleStatusHandler({
      agentName: 'chief',
      frameworkRoot: root,
      lifecycleNotificationsEnabled: false,
      telegramPollingEnabled: true,
      telegramApi: { sendMessage } as any,
      telegramChatId: '12345',
      paths,
      ctxRoot: root,
      org: 'acme',
    });

    handler(status('crashed', 2));
    handler(status('running'));
    handler(status('halted', 2));
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));

    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      '12345',
      'Agent chief crashed (crash #2) — auto-restarting',
    );
    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      '12345',
      'Agent chief HALTED — exceeded crash limit. Restart manually with: cortextos start chief',
    );
    expect(sendMessage).not.toHaveBeenCalledWith(
      '12345',
      'Agent chief recovered and is back online',
    );
  });

  it('routes specialist crash and HALTED internally while honoring the routine recovery opt-out', () => {
    const sendMessage = vi.fn().mockResolvedValue({ result: { message_id: 92 } });
    const handler = createAgentLifecycleStatusHandler({
      agentName: 'sentinel',
      frameworkRoot: root,
      lifecycleNotificationsEnabled: false,
      telegramPollingEnabled: false,
      telegramApi: { sendMessage } as any,
      telegramChatId: '12345',
      paths,
      ctxRoot: root,
      org: 'acme',
    });

    handler({ name: 'sentinel', status: 'crashed', crashCount: 1 });
    handler({ name: 'sentinel', status: 'running' });
    handler({ name: 'sentinel', status: 'halted', crashCount: 1 });

    expect(sendMessage).not.toHaveBeenCalled();
    const messages = inbox('chief');
    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.text).sort()).toEqual([
      'Agent sentinel crashed (crash #1) — auto-restarting',
      'Agent sentinel HALTED — exceeded crash limit. Restart manually with: cortextos start sentinel',
    ].sort());
    expect(messages.every((message) => message.to === 'chief' && message.priority === 'high')).toBe(true);
  });

  it('routes specialist recovery internally when routine lifecycle is enabled', () => {
    const sendMessage = vi.fn().mockResolvedValue({ result: { message_id: 97 } });
    const handler = createAgentLifecycleStatusHandler({
      agentName: 'sentinel',
      frameworkRoot: root,
      lifecycleNotificationsEnabled: true,
      telegramPollingEnabled: true,
      telegramApi: { sendMessage } as any,
      telegramChatId: '12345',
      paths,
      ctxRoot: root,
      org: 'acme',
    });

    handler({ name: 'sentinel', status: 'crashed', crashCount: 1 });
    handler({ name: 'sentinel', status: 'running' });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(inbox('chief').map((message) => message.text).sort()).toEqual([
      'Agent sentinel crashed (crash #1) — auto-restarting',
      'Agent sentinel recovered and is back online',
    ].sort());
  });

  it('fails closed when configured-orchestrator authority is absent', () => {
    unlinkSync(join(root, 'orgs', 'acme', 'context.json'));
    const sendMessage = vi.fn().mockResolvedValue({ result: { message_id: 93 } });
    const handler = createAgentLifecycleStatusHandler({
      agentName: 'chief',
      frameworkRoot: root,
      lifecycleNotificationsEnabled: true,
      telegramPollingEnabled: true,
      telegramApi: { sendMessage } as any,
      telegramChatId: '12345',
      paths,
      ctxRoot: root,
      org: 'acme',
    });

    handler(status('crashed', 1));
    handler(status('halted', 1));

    expect(sendMessage).not.toHaveBeenCalled();
    expect(inbox('chief')).toHaveLength(0);
  });

  it('suppresses direct Chief actionable alerts when telegram_polling is false', () => {
    const sendMessage = vi.fn().mockResolvedValue({ result: { message_id: 98 } });
    const handler = createAgentLifecycleStatusHandler({
      agentName: 'chief',
      frameworkRoot: root,
      lifecycleNotificationsEnabled: true,
      telegramPollingEnabled: false,
      telegramApi: { sendMessage } as any,
      telegramChatId: '12345',
      paths,
      ctxRoot: root,
      org: 'acme',
    });

    handler(status('crashed', 1));
    handler(status('halted', 1));

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('re-resolves file-backed authority at each send and fails closed after corruption', () => {
    const sendMessage = vi.fn().mockResolvedValue({ result: { message_id: 99 } });
    const handler = createAgentLifecycleStatusHandler({
      agentName: 'chief',
      frameworkRoot: root,
      lifecycleNotificationsEnabled: true,
      telegramPollingEnabled: true,
      telegramApi: { sendMessage } as any,
      telegramChatId: '12345',
      paths,
      ctxRoot: root,
      org: 'acme',
    });

    writeFileSync(join(root, 'orgs', 'acme', 'context.json'), '{bad-json', 'utf-8');
    handler(status('crashed', 1));
    expect(sendMessage).not.toHaveBeenCalled();

    writeContext('sentinel');
    handler(status('halted', 1));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(inbox('sentinel')[0]).toMatchObject({ from: 'chief', to: 'sentinel' });
  });

  it('loses authority the instant context.json is removed or blanked, and regains it when restored', () => {
    const sendMessage = vi.fn().mockResolvedValue({ result: { message_id: 100 } });
    const handler = createAgentLifecycleStatusHandler({
      agentName: 'chief',
      frameworkRoot: root,
      lifecycleNotificationsEnabled: true,
      telegramPollingEnabled: true,
      telegramApi: { sendMessage } as any,
      telegramChatId: '12345',
      paths,
      ctxRoot: root,
      org: 'acme',
    });
    const contextPath = join(root, 'orgs', 'acme', 'context.json');

    handler(status('crashed', 1));
    unlinkSync(contextPath);
    handler(status('halted', 1));
    writeFileSync(contextPath, '   ', 'utf-8');
    handler(status('crashed', 2));
    writeFileSync(contextPath, '\uFEFF', 'utf-8');
    handler(status('crashed', 3));
    writeFileSync(contextPath, JSON.stringify({ orchestrator: ' chief ' }), 'utf-8');
    handler(status('halted', 2));
    writeContext('chief');
    handler(status('halted', 3));

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls.map((call) => call[1])).toEqual([
      'Agent chief crashed (crash #1) — auto-restarting',
      'Agent chief HALTED — exceeded crash limit. Restart manually with: cortextos start chief',
    ]);
    expect(inbox('chief')).toHaveLength(0);
  });

  it('never double-sends a recovery: manager owns it exactly once per crash', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ result: { message_id: 101 } });
    const handler = createAgentLifecycleStatusHandler({
      agentName: 'chief',
      frameworkRoot: root,
      lifecycleNotificationsEnabled: true,
      telegramPollingEnabled: true,
      telegramApi: { sendMessage } as any,
      telegramChatId: '12345',
      paths,
      ctxRoot: root,
      org: 'acme',
    });

    handler(status('crashed', 1));
    handler(status('running'));
    handler(status('running'));
    handler(status('stopped'));
    handler(status('running'));

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(sendMessage.mock.calls.map((call) => call[1])).toEqual([
      'Agent chief crashed (crash #1) — auto-restarting',
      'Agent chief recovered and is back online',
    ]);
  });

  it('uses the same destination gate for manager security and poller alerts', async () => {
    const chiefApi = vi.fn().mockResolvedValue({ result: { message_id: 94 } });
    routeAgentAlertThroughOneVoice({
      agentName: 'chief',
      frameworkRoot: root,
      telegramPollingEnabled: true,
      telegramApi: { sendMessage: chiefApi } as any,
      telegramChatId: '12345',
      paths,
      ctxRoot: root,
      org: 'acme',
      text: 'chief security alert',
    });

    const specialistApi = vi.fn().mockResolvedValue({ result: { message_id: 95 } });
    routeAgentAlertThroughOneVoice({
      agentName: 'growth',
      frameworkRoot: root,
      telegramPollingEnabled: true,
      telegramApi: { sendMessage: specialistApi } as any,
      telegramChatId: '12345',
      paths,
      ctxRoot: root,
      org: 'acme',
      text: 'specialist poller alert',
    });

    const absentApi = vi.fn().mockResolvedValue({ result: { message_id: 96 } });
    routeAgentAlertThroughOneVoice({
      agentName: 'growth',
      frameworkRoot: join(root, 'missing-framework'),
      telegramPollingEnabled: true,
      telegramApi: { sendMessage: absentApi } as any,
      telegramChatId: '12345',
      paths,
      ctxRoot: root,
      org: 'acme',
      text: 'missing authority alert',
    });

    await vi.waitFor(() => expect(chiefApi).toHaveBeenCalledWith('12345', 'chief security alert'));
    expect(specialistApi).not.toHaveBeenCalled();
    expect(absentApi).not.toHaveBeenCalled();
    expect(inbox('chief')).toHaveLength(1);
    expect(inbox('chief')[0]).toMatchObject({
      from: 'growth',
      to: 'chief',
      priority: 'high',
      text: 'specialist poller alert',
    });
  });
});
