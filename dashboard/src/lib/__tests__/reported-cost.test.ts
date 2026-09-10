import { describe, expect, it } from 'vitest';
import { normalizeUsage, type UsageSource } from '../usage-normalizer';

const row = (output = 10, extra: Record<string, unknown> = {}) => ({
  timestamp: '2026-09-10T00:00:00Z', sessionId: 'session', requestId: 'request',
  message: { id: 'message', model: 'claude-opus-5', usage: { input_tokens: 100, output_tokens: output }, ...extra },
});
const source = (rows: unknown[], file = '/fixture/claude.jsonl'): UsageSource => ({
  agent: 'guard', org: 'org', runtime: 'claude', source_file: file,
  content: rows.map(r => JSON.stringify(r)).join('\n'),
});

describe('Claude transcript-reported costUSD compatibility', () => {
  it.each([0, 1.234567])('preserves nested reported amount %s without asserting billing or a price', costUSD => {
    const { entries, issues } = normalizeUsage([source([row(10, { costUSD })])]);
    expect(issues).toEqual([]);
    expect(entries[0]).toMatchObject({
      reported_cost_usd: costUSD, reported_cost_micros: Math.round(costUSD * 1e6),
      reported_cost_source: 'message.costUSD', source_file: '/fixture/claude.jsonl',
      cost_usd: null, cost_status: 'unknown', unknown_reason: 'unknown_billing_mode', price_version: null,
    });
  });
  it('preserves a top-level amount and labels its field, including subscription observations', () => {
    const { entries } = normalizeUsage([source([{ ...row(), costUSD: 2, billing_mode: 'subscription' }])]);
    expect(entries[0]).toMatchObject({ reported_cost_usd: 2, reported_cost_source: 'costUSD', cost_usd: null, unknown_reason: 'subscription_not_cash_charge' });
  });
  it('deduplicates message aliases and copied files, retaining an amount omitted in a replay', () => {
    const a = source([row(10, { costUSD: 2 }), row()]);
    const { entries, issues } = normalizeUsage([a, { ...a, source_file: '/copy.jsonl' }]);
    expect(issues).toEqual([]); expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ reported_cost_usd: 2, total_tokens: 110 });
  });
  it('uses the maximal usage snapshot amount instead of summing streaming observations', () => {
    const { entries } = normalizeUsage([source([row(10, { costUSD: 1 }), row(20, { costUSD: 2 })])]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ output_tokens: 20, reported_cost_usd: 2 });
  });
  it('does not carry an earlier amount onto a larger snapshot missing costUSD', () => {
    const { entries } = normalizeUsage([source([row(10, { costUSD: 1 }), row(20)])]);
    expect(entries[0]).toMatchObject({ output_tokens: 20, reported_cost_usd: null });
  });
  it.each([-1, '2.00', null, {}, 1e30])('rejects invalid reported amount %j and retains validated tokens', costUSD => {
    const { entries, issues } = normalizeUsage([source([row(10, { costUSD })])]);
    expect(entries[0]).toMatchObject({ reported_cost_usd: null, total_tokens: 110 });
    expect(issues.map(i => i.code)).toContain('invalid_reported_cost');
  });
  it('rejects nonfinite JSON numbers', () => {
    const s = source([row(10, { costUSD: 123 })]);
    s.content = s.content.replace('"costUSD":123', '"costUSD":1e400');
    expect(normalizeUsage([s]).issues.map(i => i.code)).toContain('invalid_reported_cost');
  });
  it('conflicting amounts at the same token snapshot retain tokens with an unknown reported amount', () => {
    const { entries, issues } = normalizeUsage([source([row(10, { costUSD: 1 }), row(10, { costUSD: 2 })])]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ reported_cost_usd: null, total_tokens: 110 });
    expect(issues.map(i => i.code)).toContain('conflicting_reported_cost');
  });
  it('conflicting nested and top-level amounts cannot choose a convenient value', () => {
    const { entries, issues } = normalizeUsage([source([{ ...row(10, { costUSD: 1 }), costUSD: 2 }])]);
    expect(entries[0]).toMatchObject({ reported_cost_usd: null, total_tokens: 110 });
    expect(issues.map(i => i.code)).toContain('conflicting_reported_cost');
  });
  it('a newly reported amount changes the cache identity even when tokens are unchanged', () => {
    const plain = normalizeUsage([source([row()])]).entries[0];
    const reported = normalizeUsage([source([row(10, { costUSD: 1 })])]).entries[0];
    expect(reported.event_id).not.toBe(plain.event_id);
  });
});
