import { describe, it, expect } from 'vitest';
import { normalizeUsage, type UsageSource } from '../usage-normalizer';
import { PRICES, resolvePrice, priceMicros, calculateCost } from '../usage-pricing';

const api = { provider: 'openai', billing_mode: 'api', service_tier: 'standard', region: 'global' };
const row = (n: number, input: number, output = 0, extra = {}) => ({
  timestamp: `2026-09-10T00:00:${String(n).padStart(2,'0')}Z`, session_id: 's1', turn_id: 't1', model: 'gpt-5-codex',
  ...api, input_tokens: input, output_tokens: output, cache_read_tokens: 0, cache_write_tokens: 0, ...extra,
});
const source = (rows: unknown[], extra: Partial<UsageSource> = {}): UsageSource => ({
  runtime: 'codex', agent: 'guard', org: 'hyphen-org', source_file: '/fixture/codex-tokens.jsonl',
  content: rows.map(r => typeof r === 'string' ? r : JSON.stringify(r)).join('\n'), ...extra,
});
const claude = (n: number, id: string, output: number, extra = {}) => ({
  timestamp: `2026-09-10T00:00:${String(n).padStart(2,'0')}Z`, sessionId: 'c1', requestId: `req-${id}`,
  ...api, provider: 'anthropic', message: { id, model: 'claude-opus-4-6', usage: { input_tokens: 100, output_tokens: output, cache_read_input_tokens: 20, cache_creation_input_tokens: 0 } }, ...extra,
});

describe('usage normalization boundaries', () => {
  it('subtracts session totals across turn boundaries and removes cache from input', () => {
    const r = normalizeUsage([source([row(0,0), row(1,100,10,{cache_read_tokens:40}), row(2,160,30,{turn_id:'t2',cache_read_tokens:50})])]);
    expect(r.issues).toEqual([]);
    expect(r.entries.map(e => [e.input_tokens,e.output_tokens,e.cache_read_tokens,e.total_tokens])).toEqual([[60,10,40,110],[50,20,10,80]]);
    expect(r.entries.reduce((n,e)=>n+e.total_tokens,0)).toBe(190);
    expect(r.entries[0].cost_usd).toBe(.00018);
    expect(r.entries[0].cost_status).toBe('estimated');
  });
  it('deduplicates repeated and replayed cumulative snapshots at different timestamps', () => {
    const r = normalizeUsage([source([row(0,0),row(1,100),row(2,100),row(3,200),row(4,100),row(5,300)])]);
    expect(r.entries).toHaveLength(3);
    expect(r.entries.reduce((n,e)=>n+e.input_tokens,0)).toBe(300);
  });
  it('overlapping sessions with identical turn IDs never share a baseline', () => {
    const r = normalizeUsage([source([row(0,0),row(0,0,0,{session_id:'s2'}),row(1,100),row(2,400,0,{session_id:'s2'}),row(3,150)])]);
    expect(r.entries.reduce((n,e)=>n+e.total_tokens,0)).toBe(550);
  });
  it('nonzero first observation is an unallocated baseline, not today spend', () => {
    const r = normalizeUsage([source([row(0,1000),row(1,1100)])]);
    expect(r.entries[0].input_tokens).toBe(100);
    expect(r.issues[0].code).toBe('unallocated_initial_cumulative_baseline');
  });
  it('counter reset quarantines the entire ambiguous session; fresh session still counts', () => {
    const r = normalizeUsage([source([row(0,0),row(1,100),row(2,20),row(3,150),row(0,0,0,{session_id:'s2'}),row(1,50,0,{session_id:'s2'})])]);
    expect(r.entries.map(e=>e.session_id)).toEqual(['s2']);
    expect(r.issues[0].code).toBe('cumulative_regression_or_invalid_delta');
  });
  it('same timestamp with different counters is ambiguous', () => {
    expect(normalizeUsage([source([row(0,0),row(1,100),row(1,200)])]).entries).toEqual([]);
  });
  it('invalid counters and missing dates/identities are visible issues', () => {
    const r = normalizeUsage([source(['bad json',row(0,-1),row(1,100,0,{cache_read_tokens:101}),row(2,NaN),row(3,10,0,{session_id:null}),row(4,10,0,{timestamp:null})])]);
    expect(r.entries).toEqual([]); expect(r.issues).toHaveLength(6);
  });
  it('deduplicates Claude content blocks and duplicate transcript files', () => {
    const a = source([claude(0,'m1',1),claude(1,'m1',30)],{runtime:'claude'});
    const r = normalizeUsage([a,{...a,source_file:'/copy.jsonl'}]);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({input_tokens:100, output_tokens:30,total_tokens:150,request_id:'req-m1'});
  });
  it('Claude concurrent requests with the same timestamp remain separate', () => {
    expect(normalizeUsage([source([claude(0,'m1',20),claude(0,'m2',30)],{runtime:'claude'})]).entries).toHaveLength(2);
  });
  it('conflicting message counters are rejected rather than summed', () => {
    const changed = claude(1,'m1',20); changed.message.usage.input_tokens = 1;
    const r = normalizeUsage([source([claude(0,'m1',10),changed],{runtime:'claude'})]);
    expect(r.entries).toEqual([]); expect(r.issues[0].code).toBe('conflicting_message_usage');
  });
  it('Claude 5m and 1h cache writes are priced separately', () => {
    const r = claude(0,'m1',0);
    Object.assign(r.message.usage,{input_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:300,cache_creation:{ephemeral_5m_input_tokens:100,ephemeral_1h_input_tokens:200}});
    const e = normalizeUsage([source([r],{runtime:'claude'})]).entries[0];
    expect(e.cost_micros).toBe(2625); expect(e.total_tokens).toBe(300);
  });
  it('unclassified cache writes never assume the cheapest TTL', () => {
    const r = claude(0,'m1',0); r.message.usage.cache_creation_input_tokens = 100;
    const e = normalizeUsage([source([r],{runtime:'claude'})]).entries[0];
    expect(e.cost_usd).toBeNull(); expect(e.unknown_reason).toBe('unknown_cache_write_breakdown');
  });
  it.each(['unknown','subscription'])('%s billing preserves tokens without a cash debit', billing_mode => {
    const e = normalizeUsage([source([row(0,0),row(1,100,0,{billing_mode})])]).entries[0];
    expect(e.total_tokens).toBe(100); expect(e.cost_usd).toBeNull(); expect(e.cost_status).toBe('unknown');
  });
  it('source costUSD is not invoice proof', () => {
    const r = claude(0,'m1',10,{costUSD:9,billing_mode:'unknown'});
    expect(normalizeUsage([source([r],{runtime:'claude'})]).entries[0].cost_status).toBe('unknown');
  });
  it('unknown model is retained with null cost, never a Sonnet price', () => {
    const e = normalizeUsage([source([row(0,0),row(1,100,0,{model:'gpt-new-unpriced'})])]).entries[0];
    expect(e.cost_usd).toBeNull(); expect(e.total_tokens).toBe(100);
  });
  it('historical rows do not silently receive the current rate snapshot', () => {
    const old = normalizeUsage([source([row(0,0,0,{timestamp:'2025-01-01T00:00:00Z'}),row(1,100,0,{timestamp:'2025-01-01T00:00:01Z'})])]);
    expect(old.entries[0].unknown_reason).toBe('no_historical_price_version');
  });
});
describe('exact versioned pricing', () => {
  it('pins Astra short and long context and declines an unknown tier', () => {
    const short = resolvePrice('gpt-6-astra',{...api,context_band:'short'})!;
    const long = resolvePrice('gpt-6-astra',{...api,context_band:'long'})!;
    expect(priceMicros(short,1e6,1e6,1e6,1e6)).toBe(73500000);
    expect(priceMicros(long,1e6,1e6,1e6,1e6)).toBe(122000000);
    expect(resolvePrice('gpt-6-astra',api)).toBeUndefined();
    expect(resolvePrice('gpt-6-astra',{...api,context_band:'short',service_tier:'priority'})).toBeUndefined();
  });
  it('never fuzzy matches a future model or a different provider', () => {
    expect(calculateCost('codex-thinking',1e6,0)).toBeNull();
    expect(calculateCost('claude-sonnet-99',1e6,0)).toBeNull();
    expect(resolvePrice('gpt-5-codex',{...api,provider:'azure'})).toBeUndefined();
    expect(PRICES.every(p=>p.source.startsWith('https://'))).toBe(true);
  });
});
