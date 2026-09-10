// Observe-only usage accounting. Source logs are authoritative; SQLite is a cache.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { db } from '@/lib/db';
import { CTX_ROOT, getAllAgents, getAgentDir } from '@/lib/config';
import type { CostEntry } from '@/lib/types';
import { normalizeUsage, type UsageSource, type UsageIssue } from './usage-normalizer';
export { calculateCost } from './usage-pricing';

export const USAGE_STALE_MS = 6 * 60 * 60 * 1000;
export interface UsageInstrument {
  agent: string; org: string; runtime: string; source_file: string;
  status: 'fresh' | 'stale' | 'missing' | 'unreadable' | 'empty' | 'invalid' | 'unsupported';
  last_observation: string | null;
}
export interface UsageHealth {
  observed_at: string | null; stale_after_ms: number; instruments: UsageInstrument[];
  issues: UsageIssue[]; legacy_rows_excluded: number; state: 'observed' | 'unknown';
}
function readSources(runtime?: 'codex' | 'claude') {
  const sources: UsageSource[] = [];
  const instruments: UsageInstrument[] = [];
  const now = Date.now();
  const projects = path.join(os.homedir(), '.claude', 'projects');
  function read(file: string, agent: string, org: string, kind: 'codex' | 'claude', required: boolean) {
    let content: string;
    try { content = fs.readFileSync(file, 'utf8'); }
    catch (err) {
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      if (required || !missing) instruments.push({ agent, org, runtime: kind, source_file: file, status: missing ? 'missing' : 'unreadable', last_observation: null });
      return false;
    }
    sources.push({ source_file: file, agent, org, runtime: kind, content });
    const dates = content.split('\n').flatMap(line => {
      try {
        const v = JSON.parse(line);
        if (kind === 'claude' && !(v.message?.usage || v.usage)) return [];
        const time = typeof v.timestamp === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(v.timestamp) ? Date.parse(v.timestamp) : NaN;
        return Number.isFinite(time) && time <= now ? [time] : [];
      } catch { return []; }
    });
    const latest = dates.length ? dates.reduce((a,b) => Math.max(a,b), 0) : null;
    // Historical files on a different runtime remain readable history, not a
    // failing writer. Freshness is an observation age, never a diagnosis.
    if (required) instruments.push({ agent, org, runtime: kind, source_file: file,
      status: !content.trim() ? 'empty' : latest === null ? 'invalid' : now-latest > USAGE_STALE_MS ? 'stale' : 'fresh',
      last_observation: latest === null ? null : new Date(latest).toISOString() });
    return true;
  }
  for (const { name: agent, org } of getAllAgents()) {
    const agentDir = getAgentDir(agent, org);
    let configured = 'unknown';
    try { configured = JSON.parse(fs.readFileSync(path.join(agentDir, 'config.json'), 'utf8')).runtime ?? 'claude'; } catch { /* explicit unknown below */ }
    if (!runtime && !['claude', 'codex-app-server'].includes(configured)) instruments.push({ agent, org, runtime: configured, source_file: agentDir, status: 'unsupported', last_observation: null });
    if (!runtime || runtime === 'codex') read(path.join(CTX_ROOT, 'logs', agent, 'codex-tokens.jsonl'), agent, org, 'codex', configured === 'codex-app-server');
    if (runtime === 'codex') continue;
    // Match the complete encoded agent path, preserving org/agent hyphens and
    // instance boundaries. realpath handles the framework/state symlink layout.
    const dirs = new Set([agentDir]);
    try { dirs.add(fs.realpathSync(agentDir)); } catch { /* missing is surfaced below */ }
    let found = false;
    let failed = false;
    const files = new Set<string>();
    const walk = (dir: string, depth: number) => {
      let children: fs.Dirent[];
      try { children = fs.readdirSync(dir, { withFileTypes: true }); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') failed = true; return; }
      for (const child of children) {
        const file = path.join(dir, child.name);
        if (child.isFile() && child.name.endsWith('.jsonl')) files.add(file);
        else if (child.isDirectory() && depth < 3) walk(file, depth+1);
      }
    };
    for (const dir of dirs) walk(path.join(projects, dir.replace(/[^a-zA-Z0-9]/g, '-')), 0);
    for (const file of [...files].sort()) { found = true; if (!read(file, agent, org, 'claude', false)) failed = true; }
    if (configured === 'claude') {
      // One instrument per agent, so archived session files do not create a
      // stale-writer alarm when a newer session is producing observations.
      const own = sources.filter(s => s.agent === agent && s.org === org && s.runtime === 'claude');
      const dates = own.flatMap(s => s.content.split('\n').flatMap(l => {
        try { const r = JSON.parse(l); const t = Date.parse(r.timestamp); return r.message?.usage && /(?:Z|[+-]\d\d:\d\d)$/.test(r.timestamp) && Number.isFinite(t) && t <= now ? [t] : []; } catch { return []; }
      }));
      const latest = dates.length ? dates.reduce((a,b) => Math.max(a,b), 0) : null;
      instruments.push({ agent, org, runtime: 'claude', source_file: agentDir,
        status: failed ? 'unreadable' : !found ? 'missing' : own.every(s => !s.content.trim()) ? 'empty' : latest === null ? 'invalid' : now-latest > USAGE_STALE_MS ? 'stale' : 'fresh',
        last_observation: latest === null ? null : new Date(latest).toISOString() });
    }
  }
  return { sources, instruments };
}
export function scanClaudeProjectsCosts(): CostEntry[] { return normalizeUsage(readSources('claude').sources).entries; }
export function scanCodexLogsCosts(): CostEntry[] { return normalizeUsage(readSources('codex').sources).entries; }

// Additive cache generation: retain v1 rows for audit, never include their
// timestamp-only duplicates or guessed prices in the corrected totals.
const INSERT = db.prepare('INSERT OR IGNORE INTO usage_entries_v2 (event_id, payload, active) VALUES (?, ?, 1)');
const ACTIVATE = db.prepare('UPDATE usage_entries_v2 SET active = 1 WHERE event_id = ?');
export function persistCostEntries(entries: CostEntry[]): number {
  return db.transaction(() => {
    let inserted = 0;
    for (const e of entries) {
      inserted += INSERT.run(e.event_id, JSON.stringify(e)).changes;
      ACTIVATE.run(e.event_id);
    }
    return inserted;
  })();
}
export function syncCosts(): { scanned: number; inserted: number; health: UsageHealth } {
  const { sources, instruments } = readSources();
  const result = normalizeUsage(sources);
  const health: UsageHealth = { observed_at: new Date().toISOString(), stale_after_ms: USAGE_STALE_MS,
    instruments, issues: result.issues, legacy_rows_excluded: legacyCount(), state: instruments.length ? 'observed' : 'unknown' };
  const inserted = db.transaction(() => {
    db.prepare('UPDATE usage_entries_v2 SET active = 0').run();
    const n = persistCostEntries(result.entries);
    db.prepare('INSERT OR REPLACE INTO usage_health_v2 (id, payload) VALUES (1, ?)').run(JSON.stringify(health));
    return n;
  })();
  return { scanned: result.entries.length, inserted, health };
}
function legacyCount(org?: string): number {
  const query = db.prepare('SELECT COUNT(*) AS n FROM cost_entries' + (org ? ' WHERE org = ?' : ''));
  return ((org ? query.get(org) : query.get()) as { n: number }).n;
}
export function getUsageHealth(org?: string): UsageHealth {
  const row = db.prepare('SELECT payload FROM usage_health_v2 WHERE id = 1').get() as { payload: string } | undefined;
  const health: UsageHealth = row ? JSON.parse(row.payload) : { observed_at: null, stale_after_ms: USAGE_STALE_MS, instruments: [], issues: [], legacy_rows_excluded: legacyCount(), state: 'unknown' };
  health.legacy_rows_excluded = legacyCount(org);
  if (org) { health.instruments = health.instruments.filter(i => i.org === org); health.issues = health.issues.filter(i => i.org === org); }
  if (!health.observed_at || Date.now() - Date.parse(health.observed_at) > USAGE_STALE_MS) health.state = 'unknown';
  if (!health.instruments.length) health.state = 'unknown';
  for (const i of health.instruments) if (i.status === 'fresh' && i.last_observation && Date.now() - Date.parse(i.last_observation) > USAGE_STALE_MS) i.status = 'stale';
  return health;
}
export function getCostEntries(limit = 100, org?: string): CostEntry[] {
  const rows = db.prepare('SELECT payload FROM usage_entries_v2 WHERE active = 1').all() as { payload: string }[];
  return rows.map(r => ({ reported_cost_usd: null, reported_cost_micros: null, reported_cost_source: null, ...JSON.parse(r.payload) }) as CostEntry).filter(e => !org || e.org === org)
    .sort((a,b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit);
}
export interface CostSummary {
  cost: number | null; cost_status: 'estimated' | 'billed' | 'unknown';
  estimated_usd: number | null; billed_usd: number | null; unknown_entries: number;
  reported_usd: number | null; reported_entries: number;
  entries: number; tokens: number;
}
function summarize(entries: CostEntry[]): CostSummary {
  const unknown = entries.filter(e => e.cost_status === 'unknown').length;
  const estimated = entries.filter(e => e.cost_status === 'estimated');
  const billed = entries.filter(e => e.cost_status === 'billed');
  const reported = entries.filter(e => e.reported_cost_micros !== null);
  const reportedMicros = reported.reduce((n,e) => n + (e.reported_cost_micros ?? 0), 0);
  const sum = (es: CostEntry[]) => es.length ? es.reduce((n,e) => n+(e.cost_micros ?? 0),0) / 1e6 : null;
  return { cost: !entries.length || unknown || (estimated.length > 0 && billed.length > 0) ? null : sum(entries),
    cost_status: !entries.length || unknown || (estimated.length > 0 && billed.length > 0) ? 'unknown' : estimated.length ? 'estimated' : 'billed',
    estimated_usd: sum(estimated), billed_usd: sum(billed), unknown_entries: unknown,
    reported_usd: reported.length && Number.isSafeInteger(reportedMicros) ? reportedMicros / 1e6 : null,
    reported_entries: reported.length,
    entries: entries.length, tokens: entries.reduce((n,e) => n+e.total_tokens,0) };
}
function withCoverage(summary: CostSummary, org?: string): CostSummary {
  const health = getUsageHealth(org);
  if (health.state === 'unknown' || health.issues.length || health.instruments.some(i => i.status !== 'fresh'))
    return { ...summary, cost: null, cost_status: 'unknown' };
  return summary;
}
export function getDailyCosts(days = 30, org?: string): Array<CostSummary & { date: string }> {
  const cutoff = Date.now() - days * 86400000;
  const groups = new Map<string, CostEntry[]>();
  for (const e of getCostEntries(Infinity, org)) {
    if (Date.parse(e.timestamp) < cutoff) continue;
    const date = e.timestamp.slice(0,10); groups.set(date, [...(groups.get(date) ?? []),e]);
  }
  return [...groups].sort(([a],[b]) => a.localeCompare(b)).map(([date, entries]) => ({ date, ...withCoverage(summarize(entries), org) }));
}
export function getCostByModel(org?: string): Array<CostSummary & { model: string }> {
  const groups = new Map<string, CostEntry[]>();
  for (const e of getCostEntries(Infinity, org)) groups.set(e.model, [...(groups.get(e.model) ?? []),e]);
  return [...groups].map(([model, entries]) => ({ model, ...withCoverage(summarize(entries), org) }));
}
export function getDailyCostByModel(days = 30, org?: string): Array<Record<string, unknown>> {
  const groups = new Map<string, Map<string, CostEntry[]>>();
  for (const e of getCostEntries(Infinity, org)) {
    if (Date.parse(e.timestamp) < Date.now() - days*86400000) continue;
    const date = e.timestamp.slice(0,10);
    const models = groups.get(date) ?? new Map<string, CostEntry[]>();
    models.set(e.model, [...(models.get(e.model) ?? []), e]); groups.set(date, models);
  }
  return [...groups].sort(([a],[b]) => a.localeCompare(b)).map(([date, models]) => ({ date,
    ...Object.fromEntries([...models].map(([model, entries]) => [model, withCoverage(summarize(entries), org).cost])),
    cost_status: withCoverage(summarize([...models.values()].flat()), org).cost_status,
    unknown_entries: [...models.values()].flat().filter(e => e.cost_status === 'unknown').length,
  }));
}
export function getCurrentMonthCost(org?: string): CostSummary {
  const month = new Date().toISOString().slice(0,7);
  return withCoverage(summarize(getCostEntries(Infinity, org).filter(e => e.timestamp.startsWith(month))), org);
}
