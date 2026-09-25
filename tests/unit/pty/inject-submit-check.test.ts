import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));

const { composerHoldsUnsent } = await import('../../../src/pty/inject.js');
const { AgentPTY, SUBMIT_CHECK_MS } = await import('../../../src/pty/agent-pty.js');

// REAL bytes from the chief seat's screen log, 2026-09-25 04:14:50Z: the owner's Telegram was
// pasted, the Enter was written 300 ms later with no error, and the screen sat on
// `❯ [Pasted text #1 +8 lines]` — unsent — for four minutes. In 22 MB of that seat's screen
// log the placeholder appears exactly ONCE: pastes that submit never render it.
const HERE = dirname(fileURLToPath(import.meta.url));
const STUCK = readFileSync(join(HERE, 'fixtures/chief-stuck-paste-20260925.bin'), 'utf8');
const MSG = '=== TELEGRAM PHOTO from J (chat_id:1) ===\ncaption:\n```\nWhats going on fix this\n```';
const BORDER = '─'.repeat(40);
const EMPTY_COMPOSER = `${BORDER}\n❯ \n${BORDER}\n  ⏵⏵ bypass permissions on`;

describe('composerHoldsUnsent', () => {
  it('flags the real stuck screen (collapsed-paste placeholder in the composer)', () => {
    expect(composerHoldsUnsent(STUCK, MSG)).toBe(true);
  });
  it('does not flag an empty composer', () => {
    expect(composerHoldsUnsent(EMPTY_COMPOSER, MSG)).toBe(false);
  });
  it('does not flag the status line or unrelated text after the last prompt glyph', () => {
    expect(composerHoldsUnsent(`${BORDER}❯ ⏵⏵ bypass permissions on (shift+tab to cycle)`, MSG)).toBe(false);
  });
  it('flags a single-line message left raw in the composer', () => {
    const one = '=== AGENT MESSAGE from guard [msg_id: 1] === PASS';
    expect(composerHoldsUnsent(`${BORDER}\n❯ ${one}\n${BORDER}`, one)).toBe(true);
  });
  it('returns false when no prompt glyph is on screen at all', () => {
    expect(composerHoldsUnsent('booting...', MSG)).toBe(false);
  });
});

describe('AgentPTY sends ONE retry Enter when the injection is still in the composer', () => {
  const env = { instanceId: 't', ctxRoot: '/tmp/t', frameworkRoot: '/tmp/fw', agentName: 'chief',
    agentDir: '/tmp/fw/orgs/o/agents/chief', org: 'o', projectRoot: '/tmp/fw' } as any;
  let writes: string[]; let screen: string; let warn: ReturnType<typeof vi.spyOn>;
  function makePty() {
    const p = new AgentPTY(env, {}) as any;
    p.pty = { write: (d: string) => writes.push(d) };
    p._alive = true;
    p.outputBuffer = { getRecent: () => screen };
    return p;
  }
  beforeEach(() => { vi.useFakeTimers(); writes = []; warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { vi.useRealTimers(); warn.mockRestore(); });

  it('stuck screen -> paste, Enter at 300 ms, ONE retry Enter at the check, loud warning if still stuck', () => {
    screen = STUCK;
    makePty().injectMessage(MSG);
    vi.advanceTimersByTime(300);
    expect(writes.filter((w) => w === '\r')).toHaveLength(1);
    vi.advanceTimersByTime(SUBMIT_CHECK_MS);
    expect(writes.filter((w) => w === '\r')).toHaveLength(2);
    vi.advanceTimersByTime(SUBMIT_CHECK_MS * 3);
    expect(writes.filter((w) => w === '\r')).toHaveLength(2); // never more than one retry
    expect(warn.mock.calls.map((c) => String(c[0])).some((m) => m.includes('STILL NOT SUBMITTED'))).toBe(true);
  });

  it('the retry clears it -> no second warning', () => {
    screen = STUCK;
    makePty().injectMessage(MSG);
    vi.advanceTimersByTime(300 + SUBMIT_CHECK_MS);
    screen = EMPTY_COMPOSER;
    vi.advanceTimersByTime(SUBMIT_CHECK_MS);
    expect(warn.mock.calls.map((c) => String(c[0])).some((m) => m.includes('STILL NOT SUBMITTED'))).toBe(false);
  });

  it('normal submit -> exactly one Enter, no retry, no warning', () => {
    screen = EMPTY_COMPOSER;
    makePty().injectMessage(MSG);
    vi.advanceTimersByTime(300 + SUBMIT_CHECK_MS * 3);
    expect(writes.filter((w) => w === '\r')).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('seat died before the check -> no write, no throw', () => {
    screen = STUCK;
    const p = makePty();
    p.injectMessage(MSG);
    vi.advanceTimersByTime(300);
    p._alive = false;
    vi.advanceTimersByTime(SUBMIT_CHECK_MS);
    expect(writes.filter((w) => w === '\r')).toHaveLength(1);
  });
});
