/**
 * send-message to a lane that has no agent dir but IS polled (codex, codex-shorts,
 * codex-substack: an external runtime ACKs into processed/<lane>/) used to print
 * "may never be read". Agents believed it and logged the hand-off as an error event
 * (scout, 2026-09-25, delivery_target_missing → codex-shorts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Transport removed: no arm can put a message on a real bus.
vi.mock('../../../src/bus/message.js', () => ({
  sendMessage: vi.fn(() => 'fake-msg-id'),
  checkInbox: vi.fn(() => []),
  ackInbox: vi.fn(),
}));

import { busCommand } from '../../../src/cli/bus';

const ENV_KEYS = ['CTX_ROOT', 'CTX_FRAMEWORK_ROOT', 'CTX_PROJECT_ROOT', 'CTX_AGENT_NAME', 'CTX_ORG', 'CTX_INSTANCE_ID'];

describe('send-message to an unregistered lane', () => {
  let root: string;
  let project: string;
  let saved: Record<string, string | undefined>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'polled-lane-root-'));
    project = mkdtempSync(join(tmpdir(), 'polled-lane-proj-'));
    mkdirSync(join(project, 'orgs', 'o', 'agents', 'sender'), { recursive: true });
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    Object.assign(process.env, {
      CTX_ROOT: root, CTX_FRAMEWORK_ROOT: project, CTX_PROJECT_ROOT: project,
      CTX_AGENT_NAME: 'sender', CTX_ORG: 'o', CTX_INSTANCE_ID: 'default',
    });
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  function queuedEvents() {
    const dir = join(root, 'orgs', 'o', 'analytics', 'events', 'sender');
    return readdirSync(dir)
      .flatMap((f) => readFileSync(join(dir, f), 'utf-8').trim().split('\n'))
      .map((l) => JSON.parse(l))
      .filter((e) => e.event === 'message_queued_unregistered');
  }

  it('a polled lane gets a note, not "may never be read", and a message-category warning event', async () => {
    mkdirSync(join(root, 'processed', 'codex-shorts'), { recursive: true });
    writeFileSync(join(root, 'processed', 'codex-shorts', 'm1.json'), '{}');

    await busCommand.parseAsync(['send-message', 'codex-shorts', 'normal', 'render this'], { from: 'user' });

    const stderr = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(stderr).toContain('inbox is polled (1 messages acked)');
    expect(stderr).not.toContain('may never be read');
    const [ev] = queuedEvents();
    expect(ev).toMatchObject({ category: 'message', severity: 'warning', metadata: { to: 'codex-shorts', polled: true } });
  });

  it('a lane nobody has ever acked still gets the loud warning', async () => {
    await busCommand.parseAsync(['send-message', 'nobody-home', 'normal', 'hello'], { from: 'user' });

    const stderr = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(stderr).toContain('may never be read');
    expect(queuedEvents()[0]).toMatchObject({ category: 'message', metadata: { polled: false } });
  });
});
