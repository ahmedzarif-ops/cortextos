import { describe, it, expect, vi } from 'vitest';

vi.mock('child_process', () => ({ execFile: vi.fn() }));

import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ageLabel, ageLabelFromIso, MESSAGE_AGE_THRESHOLD_MS, withAgeLine } from '../../../src/daemon/message-age';
import { FastChecker } from '../../../src/daemon/fast-checker';

/**
 * A restart can re-deliver an old message that looks exactly like a new one.
 * Observed: an agent answered a two-day-old greeting as if it had just arrived.
 * Old messages must carry their age in front.
 */

const NOW = Date.parse('2026-01-03T12:00:00Z');

describe('ageLabel', () => {
  it('nothing under the threshold; labels at and past it', () => {
    expect(ageLabel(NOW - MESSAGE_AGE_THRESHOLD_MS + 1, NOW)).toBe('');
    expect(ageLabel(NOW - MESSAGE_AGE_THRESHOLD_MS, NOW)).toBe('[AGE: 1h 0m] ');
  });

  it('formats hours+minutes under a day and days+hours past it', () => {
    expect(ageLabel(NOW - (2 * 3600 + 15 * 60) * 1000, NOW)).toBe('[AGE: 2h 15m] ');
    expect(ageLabel(NOW - (2 * 86400 + 3 * 3600 + 59 * 60) * 1000, NOW)).toBe('[AGE: 2d 3h] ');
  });

  it('missing, non-finite or unparseable times give no label (never a wrong one)', () => {
    expect(ageLabel(undefined, NOW)).toBe('');
    expect(ageLabel(Number.NaN, NOW)).toBe('');
    expect(ageLabelFromIso('not a date', NOW)).toBe('');
    expect(ageLabelFromIso(undefined, NOW)).toBe('');
    expect(ageLabelFromIso('2026-01-01T12:00:00Z', NOW)).toBe('[AGE: 2d 0h] ');
  });

  it('a message from the future is not labeled', () => {
    expect(ageLabel(NOW + 60_000, NOW)).toBe('');
  });
});

describe('withAgeLine keeps the header first', () => {
  it('inserts the age as the second line; no label leaves the text untouched', () => {
    expect(withAgeLine('=== H ===\nbody\n', '[AGE: 1h 0m] ')).toBe('=== H ===\n[AGE: 1h 0m]\nbody\n');
    expect(withAgeLine('=== H ===', '[AGE: 1h 0m] ')).toBe('=== H ===\n[AGE: 1h 0m]');
    expect(withAgeLine('=== H ===\nbody\n', '')).toBe('=== H ===\nbody\n');
  });
});

describe('delivery paths carry the label', () => {
  function checker() {
    const dir = mkdtempSync(join(tmpdir(), 'age-'));
    const paths = { ctxRoot: dir, inbox: dir, inflight: dir, processed: dir, logDir: dir, stateDir: dir, taskDir: dir, approvalDir: dir, analyticsDir: dir } as any;
    const agent = { name: 'seat', hasEverBootstrapped: () => true, getConfig: () => ({}) } as any;
    return new FastChecker(agent, paths, dir, { log: () => {} });
  }

  it('an old Telegram message is queued with its age; a fresh one, or one with no date, is unchanged', () => {
    const c = checker();
    c.queueTelegramMessage('=== TELEGRAM old ===\n', Date.now() - 2 * 86_400_000);
    c.queueTelegramMessage('=== TELEGRAM new ===\n', Date.now() - 1_000);
    c.queueTelegramMessage('=== TELEGRAM undated ===\n');
    const queued = (c as any).telegramMessages.map((m: { formatted: string }) => m.formatted);
    expect(queued[0]).toBe('=== TELEGRAM old ===\n[AGE: 2d 0h]\n');
    expect(queued[1]).toBe('=== TELEGRAM new ===\n');
    expect(queued[2]).toBe('=== TELEGRAM undated ===\n');
  });

  it('an old bus message carries its age on the line under the header', () => {
    const c = checker();
    const old = (c as any).formatInboxMessage({
      id: 'm1', from: 'other', text: 'hello', timestamp: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    });
    const fresh = (c as any).formatInboxMessage({ id: 'm2', from: 'other', text: 'hello', timestamp: new Date().toISOString() });
    expect(old).toMatch(/^=== AGENT MESSAGE from other[^\n]*===\n\[AGE: 3h 0m\]\n/);
    expect(fresh).toMatch(/^=== AGENT MESSAGE from other/);
  });
});
