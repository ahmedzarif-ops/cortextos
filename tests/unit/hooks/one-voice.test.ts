import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { BusPaths } from '../../../src/types/index.js';
import {
  REROUTED_ASK_FILE,
  clearReroutedAsk,
  formatReroutedQuestion,
  isAnswerToReroutedAsk,
  readReroutedAsk,
  rerouteQuestion,
  resolveOwnerContactRoute,
} from '../../../src/hooks/one-voice.js';

function writeContext(frameworkRoot: string, org: string, body: string): void {
  mkdirSync(join(frameworkRoot, 'orgs', org), { recursive: true });
  writeFileSync(join(frameworkRoot, 'orgs', org, 'context.json'), body);
}

function pathsFor(ctxRoot: string, agent: string): BusPaths {
  return {
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
}

const QUESTIONS = [
  {
    question: 'Which pricing should I ship?',
    header: 'Pricing',
    multiSelect: true,
    options: [{ label: 'Catalog branch' }, { label: 'Refund wording' }],
  },
];

describe('resolveOwnerContactRoute', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'one-voice-route-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('reroutes every seat that is not the configured orchestrator', () => {
    writeContext(root, 'acme', JSON.stringify({ orchestrator: 'chief' }));
    expect(resolveOwnerContactRoute('growth', root, 'acme')).toEqual({ kind: 'reroute', orchestrator: 'chief' });
  });

  it('lets only the exact configured orchestrator reach the owner', () => {
    writeContext(root, 'acme', JSON.stringify({ orchestrator: 'chief' }));
    expect(resolveOwnerContactRoute('chief', root, 'acme')).toEqual({ kind: 'owner' });
    expect(resolveOwnerContactRoute('Chief', root, 'acme')).toEqual({ kind: 'reroute', orchestrator: 'chief' });
  });

  it('is unconfigured with no org context, no orchestrator field, or an unreadable file', () => {
    expect(resolveOwnerContactRoute('growth', undefined, 'acme')).toEqual({ kind: 'unconfigured' });
    expect(resolveOwnerContactRoute('growth', root, undefined)).toEqual({ kind: 'unconfigured' });
    expect(resolveOwnerContactRoute('growth', root, 'acme')).toEqual({ kind: 'unconfigured' });
    writeContext(root, 'acme', JSON.stringify({ timezone: 'UTC' }));
    expect(resolveOwnerContactRoute('growth', root, 'acme')).toEqual({ kind: 'unconfigured' });
    writeContext(root, 'acme', '{not json');
    expect(resolveOwnerContactRoute('growth', root, 'acme')).toEqual({ kind: 'unconfigured' });
  });
});

describe('rerouteQuestion', () => {
  let ctxRoot: string;
  beforeEach(() => { ctxRoot = mkdtempSync(join(tmpdir(), 'one-voice-reroute-')); });
  afterEach(() => { rmSync(ctxRoot, { recursive: true, force: true }); });

  it('puts the question in the orchestrator inbox at high priority and records the link', () => {
    const paths = pathsFor(ctxRoot, 'growth');
    const result = rerouteQuestion({ paths, agentName: 'growth', orchestrator: 'chief', questions: QUESTIONS });

    expect(result.msgId).toMatch(/^\d+-growth-/);
    const inbox = join(ctxRoot, 'inbox', 'chief');
    const files = readdirSync(inbox);
    expect(files).toHaveLength(1);
    expect(files[0].startsWith('1-')).toBe(true); // high priority
    const msg = JSON.parse(readFileSync(join(inbox, files[0]), 'utf-8'));
    expect(msg.from).toBe('growth');
    expect(msg.to).toBe('chief');
    expect(msg.priority).toBe('high');
    expect(msg.text).toContain('Which pricing should I ship?');
    expect(msg.text).toContain('Catalog branch | Refund wording');
    expect(msg.text).toContain('did NOT reach the owner');

    expect(readReroutedAsk(paths.stateDir)).toMatchObject({ msg_id: result.msgId, orchestrator: 'chief' });
    expect(result.reason).toContain(`msg ${result.msgId}`);
    expect(result.reason).toContain("IS the user's answer");
    expect(result.reason).toContain('Do not ask the owner');
  });

  it('fails closed when the send fails: no link recorded, and the model is told not to ask the owner', () => {
    const paths = pathsFor(ctxRoot, 'growth');
    const result = rerouteQuestion({ paths, agentName: 'growth', orchestrator: 'not a valid name', questions: QUESTIONS });

    expect(result.msgId).toBeNull();
    expect(existsSync(join(paths.stateDir, REROUTED_ASK_FILE))).toBe(false);
    expect(result.reason).toContain('failed');
    expect(result.reason).toContain('Do not ask the owner');
  });
});

describe('formatReroutedQuestion', () => {
  it('lists every question with its options, including plain-string options', () => {
    const text = formatReroutedQuestion('growth', [
      ...QUESTIONS,
      { question: 'Ship today?', options: ['Yes', 'No'] },
    ]);
    expect(text).toContain('1. Which pricing should I ship? (multi-select)');
    expect(text).toContain('2. Ship today?');
    expect(text).toContain('Options: Yes | No');
  });
});

describe('isAnswerToReroutedAsk', () => {
  const pending = { msg_id: 'm-1', orchestrator: 'chief', asked_at: '2026-09-29T00:00:00.000Z' };

  it('matches only the orchestrator replying to the rerouted message id', () => {
    expect(isAnswerToReroutedAsk({ from: 'chief', reply_to: 'm-1' }, pending)).toBe(true);
  });

  it('rejects another sender, another reply_to, no reply_to, or nothing pending', () => {
    expect(isAnswerToReroutedAsk({ from: 'guard', reply_to: 'm-1' }, pending)).toBe(false);
    expect(isAnswerToReroutedAsk({ from: 'chief', reply_to: 'm-2' }, pending)).toBe(false);
    expect(isAnswerToReroutedAsk({ from: 'chief', reply_to: null }, pending)).toBe(false);
    expect(isAnswerToReroutedAsk({ from: 'chief', reply_to: 'm-1' }, null)).toBe(false);
  });
});

describe('readReroutedAsk / clearReroutedAsk', () => {
  let stateDir: string;
  beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'one-voice-state-')); });
  afterEach(() => { rmSync(stateDir, { recursive: true, force: true }); });

  it('returns null for a missing or malformed record and clears idempotently', () => {
    expect(readReroutedAsk(stateDir)).toBeNull();
    writeFileSync(join(stateDir, REROUTED_ASK_FILE), '{"msg_id": 5}');
    expect(readReroutedAsk(stateDir)).toBeNull();
    clearReroutedAsk(stateDir);
    clearReroutedAsk(stateDir);
    expect(existsSync(join(stateDir, REROUTED_ASK_FILE))).toBe(false);
  });
});
