import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * ONE VOICE at the hook boundary: the ask, permission and plan-mode hooks
 * send to CHAT_ID, which on a specialist seat is the OWNER's chat. Run the real
 * hook sources via tsx with a scrubbed environment (HOME points at a temp dir,
 * so the bus writes under it and no live instance is touched). A preload
 * records every fetch() and fails it, so each case can assert whether a
 * Telegram send was ATTEMPTED — the plan-mode hook allows on a failed send,
 * so its exit and output alone cannot tell the gate from a failed send.
 */

const ROOT = join(__dirname, '..', '..');
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');
const hook = (name: string) => join(ROOT, 'src', 'hooks', `${name}.ts`);
const RECORD_FETCH = join(ROOT, 'tests', 'helpers', 'record-fetch.cjs');

const ASK_INPUT = JSON.stringify({
  tool_name: 'AskUserQuestion',
  tool_input: { questions: [{ question: 'Which pricing?', header: 'Pricing', options: [{ label: 'C' }] }] },
});

describe('ONE VOICE hook gates', () => {
  let home: string;
  let frameworkRoot: string;
  let cwd: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'one-voice-hooks-'));
    frameworkRoot = join(home, 'framework');
    cwd = join(home, 'seat');
    mkdirSync(join(frameworkRoot, 'orgs', 'acme'), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(frameworkRoot, 'orgs', 'acme', 'context.json'), JSON.stringify({ orchestrator: 'chief' }));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function run(name: string, agent: string, input: string, extra: Record<string, string> = {}) {
    return spawnSync(TSX, [hook(name)], {
      input,
      cwd,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        CTX_AGENT_NAME: agent,
        CTX_FRAMEWORK_ROOT: frameworkRoot,
        CTX_ORG: 'acme',
        CTX_ROOT: join(home, '.cortextos', 'default'),
        BOT_TOKEN: '0:not-a-real-token',
        CHAT_ID: '1',
        NODE_OPTIONS: `--require ${RECORD_FETCH}`,
        RECORD_FETCH_LOG: fetchLog(),
        ...extra,
      },
    });
  }

  const fetchLog = () => join(home, 'fetch.log');
  const fetches = () => (existsSync(fetchLog()) ? readFileSync(fetchLog(), 'utf-8').trim().split('\n') : []);
  const chiefInbox = () => join(home, '.cortextos', 'default', 'inbox', 'chief');
  const inboxCount = () => (existsSync(chiefInbox()) ? readdirSync(chiefInbox()).length : 0);

  it('ask: a specialist question goes to the orchestrator inbox and the tool is blocked', () => {
    const r = run('hook-ask-telegram', 'growth', ASK_INPUT);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('ONE VOICE');
    expect(r.stderr).toContain("IS the user's answer");

    const files = readdirSync(chiefInbox());
    expect(files).toHaveLength(1);
    const msg = JSON.parse(readFileSync(join(chiefInbox(), files[0]), 'utf-8'));
    expect(msg.from).toBe('growth');
    expect(msg.text).toContain('Which pricing?');

    const link = JSON.parse(readFileSync(join(home, '.cortextos', 'default', 'state', 'growth', 'rerouted-ask.json'), 'utf-8'));
    expect(link.msg_id).toBe(msg.id);
    expect(fetches()).toEqual([]);
  }, 30000);

  it('ask: POSITIVE CONTROL — the orchestrator with credentials does attempt the Telegram send', () => {
    const r = run('hook-ask-telegram', 'chief', ASK_INPUT);
    expect(r.status).toBe(0);
    expect(fetches()).toEqual(['https://api.telegram.org/bot<token>/sendMessage']);
    expect(inboxCount()).toBe(0);
  }, 30000);

  it('ask: a specialist without Telegram credentials is rerouted too, not left at an open menu', () => {
    const r = run('hook-ask-telegram', 'growth', ASK_INPUT, { BOT_TOKEN: '', CHAT_ID: '' });
    expect(r.status).toBe(2);
    expect(inboxCount()).toBe(1);
  }, 30000);

  it('ask: the orchestrator is not rerouted (no credentials here, so the original path exits 0)', () => {
    const r = run('hook-ask-telegram', 'chief', ASK_INPUT, { BOT_TOKEN: '', CHAT_ID: '' });
    expect(r.status).toBe(0);
    expect(inboxCount()).toBe(0);
  }, 30000);

  it('ask: with no configured orchestrator the original path runs unchanged', () => {
    rmSync(join(frameworkRoot, 'orgs', 'acme', 'context.json'));
    const r = run('hook-ask-telegram', 'growth', ASK_INPUT, { BOT_TOKEN: '', CHAT_ID: '' });
    expect(r.status).toBe(0);
    expect(inboxCount()).toBe(0);
  }, 30000);

  it('permission: a specialist prompt is denied with the internal routes named, nothing sent', () => {
    const r = run('hook-permission-telegram', 'growth', JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }));
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput.decision.behavior).toBe('deny');
    expect(out.hookSpecificOutput.decision.message).toContain('ONE VOICE');
    expect(out.hookSpecificOutput.decision.message).toContain('chief');
    expect(inboxCount()).toBe(0);
    expect(fetches()).toEqual([]);
  }, 30000);

  it('planmode: a specialist plan is approved at once, nothing sent', () => {
    const r = run('hook-planmode-telegram', 'growth', JSON.stringify({ tool_name: 'ExitPlanMode', tool_input: {} }));
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput.decision.behavior).toBe('allow');
    expect(inboxCount()).toBe(0);
    expect(fetches()).toEqual([]);
  }, 30000);

  it('planmode: POSITIVE CONTROL — the orchestrator does attempt the send (failed send then allows)', () => {
    const r = run('hook-planmode-telegram', 'chief', JSON.stringify({ tool_name: 'ExitPlanMode', tool_input: {} }));
    expect(r.status).toBe(0);
    expect(fetches()).toEqual(['https://api.telegram.org/bot<token>/sendMessage']);
  }, 30000);
});
