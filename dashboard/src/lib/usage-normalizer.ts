import { createHash } from 'crypto';
import { PRICE_VERSION, PRICE_OBSERVED_AT, resolvePrice, priceMicros, type PriceContext } from './usage-pricing';
import type { CostEntry } from './types';

export interface UsageSource { source_file: string; agent: string; org: string; runtime: 'claude' | 'codex'; content: string }
export interface UsageIssue { source_file: string; agent: string; org: string; code: string; line?: number }
export interface NormalizedUsage { entries: CostEntry[]; issues: UsageIssue[] }
type Obj = Record<string, unknown>;
const object = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const str = (v: unknown): string | null => typeof v === 'string' && v.length > 0 ? v : null;
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const hash = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const timestamp = (v: unknown): string | null => typeof v === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
interface RecordUsage {
  source: UsageSource; line: number; time: string; model: string; session: string;
  identity: string; request: string | null; turn: string | null;
  counters: number[]; context: PriceContext; cacheKnown: boolean;
}
function issue(r: RecordUsage, code: string): UsageIssue {
  return { source_file: r.source.source_file, agent: r.source.agent, org: r.source.org, code, line: r.line };
}
function entry(r: RecordUsage, tokens: number[], previous?: number[]): CostEntry {
  const [input, output, read, write, write1h] = tokens;
  const p = resolvePrice(r.model, r.context);
  let reason: string | null = null;
  if (r.context.billing_mode !== 'api') reason = r.context.billing_mode === 'subscription' ? 'subscription_not_cash_charge' : 'unknown_billing_mode';
  else if (!r.cacheKnown) reason = 'unknown_cache_write_breakdown';
  else if (!p) reason = 'unknown_price_context';
  // This snapshot does not assert historical rate validity.
  else if (Date.parse(r.time) < Date.parse(PRICE_OBSERVED_AT)) reason = 'no_historical_price_version';
  const micros = reason || !p ? null : priceMicros(p, input, output, write, read, write1h);
  if (micros === null && !reason) reason = 'price_overflow';
  return {
    event_id: hash([2, r.source.org, r.source.agent, r.source.runtime, r.session, r.identity, r.model, r.context, r.cacheKnown, previous ?? null, r.counters]),
    timestamp: r.time, agent: r.source.agent, org: r.source.org, model: r.model,
    provider: r.context.provider ?? 'unknown', billing_mode: r.context.billing_mode ?? 'unknown',
    session_id: r.session, request_id: r.request, turn_id: r.turn,
    input_tokens: input, output_tokens: output, cache_read_tokens: read,
    cache_write_tokens: write + write1h, cache_write_1h_tokens: write1h,
    total_tokens: input + output + read + write + write1h,
    cost_usd: micros === null ? null : micros / 1e6, cost_micros: micros,
    cost_status: micros === null ? 'unknown' : 'estimated', unknown_reason: reason,
    price_version: p ? PRICE_VERSION : null, price_source: p?.source ?? null,
    price_context: JSON.stringify(r.context), source_file: r.source.source_file,
  };
}
/** Whole-source normalization: timestamps order observations; identities deduplicate them.
 * Codex totals are SESSION cumulative, including across turn changes. A new session's
 * first snapshot establishes a baseline; a nonzero baseline is explicitly unallocated.
 * A regression poisons that session, never interpreted as fresh billable usage.
 */
export function normalizeUsage(sources: UsageSource[]): NormalizedUsage {
  const issues: UsageIssue[] = [];
  const groups = new Map<string, RecordUsage[]>();
  const records: RecordUsage[] = [];
  for (const source of sources) {
    source.content.split('\n').forEach((line, i) => {
      if (!line.trim()) return;
      const bad = (code: string) => issues.push({ source_file: source.source_file, agent: source.agent, org: source.org, code, line: i + 1 });
      let raw: Obj;
      try { raw = object(JSON.parse(line)); } catch { bad('malformed_json'); return; }
      const msg = object(raw.message);
      const usage = object(msg.usage ?? raw.usage);
      if (source.runtime === 'claude' && !Object.keys(usage).length) return; // transcript prose, not usage
      const time = timestamp(raw.timestamp);
      if (time && Date.parse(time) > Date.now()) { bad('future_timestamp'); return; }
      const session = str(source.runtime === 'codex' ? raw.session_id : raw.sessionId ?? raw.session_id);
      const request = str(raw.requestId ?? raw.request_id);
      const identity = source.runtime === 'codex' ? str(raw.turn_id) : str(msg.id) ?? request;
      if (!time || !session || !identity) { bad('invalid_timestamp_or_identity'); return; }
      let counters: unknown[];
      let cacheKnown = true;
      if (source.runtime === 'codex') {
        counters = [raw.input_tokens, raw.output_tokens, raw.cache_read_tokens ?? 0, raw.cache_write_tokens ?? 0, 0];
        cacheKnown = raw.cache_write_known === true || raw.model === 'gpt-5-codex';
      } else {
        const creation = object(usage.cache_creation);
        const write = usage.cache_creation_input_tokens ?? 0;
        const w5 = creation.ephemeral_5m_input_tokens;
        const w1 = creation.ephemeral_1h_input_tokens;
        cacheKnown = write === 0 || (count(w5) && count(w1) && count(write) && w5 + w1 === write);
        counters = [usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens ?? 0,
          cacheKnown && write !== 0 ? w5 : write, cacheKnown && write !== 0 ? w1 : 0];
      }
      if (!counters.every(count) || !Number.isSafeInteger((counters as number[]).reduce((a,b) => a+b,0))) { bad('invalid_counters'); return; }
      const c = counters as number[];
      if (source.runtime === 'codex' && c[2] + c[3] > c[0]) { bad('cache_exceeds_input'); return; }
      const context: PriceContext = {
        provider: str(raw.model_provider ?? raw.provider) ?? 'unknown',
        billing_mode: str(raw.billing_mode) ?? 'unknown',
        service_tier: str(raw.service_tier ?? usage.service_tier) ?? 'unknown',
        region: str(raw.region) ?? 'unknown', context_band: str(raw.context_band) ?? 'unknown',
      };
      const r: RecordUsage = { source, line: i+1, time, session, identity, request,
        turn: source.runtime === 'codex' ? identity : null,
        model: str(msg.model ?? raw.model) ?? 'unknown', counters: c, context, cacheKnown };
      records.push(r);
    });
  }
  // Join message IDs to request IDs before grouping. Repeated blocks may omit
  // requestId; retries with distinct request IDs must not silently coalesce.
  const requests = new Map<string, Set<string>>();
  const messageKey = (r: RecordUsage) => JSON.stringify([r.source.org, r.source.agent, r.session, r.identity]);
  for (const r of records) if (r.source.runtime === 'claude' && r.request) {
    const key = messageKey(r); const set = requests.get(key) ?? new Set<string>();
    set.add(r.request); requests.set(key, set);
  }
  for (const r of records) {
    let identity = r.identity;
    if (r.source.runtime === 'claude') {
      const mapped = requests.get(messageKey(r));
      if (mapped && mapped.size > 1) { issues.push(issue(r, 'conflicting_request_identity')); continue; }
      const request = mapped?.values().next().value ?? r.request;
      identity = request ? `request:${request}` : `message:${identity}`;
      r.request = request ?? null;
      r.identity = identity;
    }
    const key = JSON.stringify([r.source.org, r.source.agent, r.source.runtime, r.session, r.source.runtime === 'claude' ? identity : null]);
    const group = groups.get(key) ?? []; group.push(r); groups.set(key, group);
  }
  const entries: CostEntry[] = [];
  for (const group of groups.values()) {
    group.sort((a,b) => a.time.localeCompare(b.time) || a.source.source_file.localeCompare(b.source.source_file) || a.line-b.line);
    const first = group[0];
    if (first.source.runtime === 'claude') {
      // Streaming content blocks share a message id; take the maximum validated
      // cumulative usage, never add the repeated input counters.
      let current = first;
      let invalid = false;
      for (const r of group.slice(1)) {
        const sameMeta = r.model === first.model && JSON.stringify(r.context) === JSON.stringify(first.context) &&
          (!r.request || !first.request || r.request === first.request) && r.cacheKnown === first.cacheKnown;
        const le = r.counters.every((n,i) => n <= current.counters[i]);
        const ge = r.counters.every((n,i) => n >= current.counters[i]);
        if (!sameMeta || (!le && !ge)) { invalid = true; issues.push(issue(r, 'conflicting_message_usage')); break; }
        if (ge) current = { ...r, time: first.time };
      }
      if (!invalid && current.counters.some(n => n > 0)) entries.push(entry(current, current.counters));
    } else {
      let previous = first;
      const pending: CostEntry[] = [];
      const seen = new Set([hash(first.counters)]);
      let invalid = false;
      if (first.counters.some(n => n > 0)) issues.push(issue(first, 'unallocated_initial_cumulative_baseline'));
      for (const r of group.slice(1)) {
        const fingerprint = hash(r.counters);
        if (seen.has(fingerprint)) continue;
        const delta = r.counters.map((n,i) => n - previous.counters[i]);
        // Input includes cache reads/writes in Codex. Normalize to disjoint buckets.
        if (delta.some(n => n < 0) || delta[2] + delta[3] > delta[0]) {
          issues.push(issue(r, 'cumulative_regression_or_invalid_delta')); invalid = true; break;
        }
        if (r.time === previous.time && delta.some(n => n > 0)) {
          issues.push(issue(r, 'ambiguous_observation_order')); invalid = true; break;
        }
        seen.add(fingerprint);
        const tokens = [...delta]; tokens[0] -= tokens[2] + tokens[3];
        if (tokens.some(n => n > 0)) pending.push(entry(r, tokens, previous.counters));
        previous = r;
      }
      if (!invalid) entries.push(...pending);
    }
  }
  return { entries, issues };
}
