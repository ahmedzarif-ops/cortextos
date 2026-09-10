import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Real filesystem discovery and real SQLite; only the one unreadable file is fault injected.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-cache-'));
const home = path.join(root, 'home');
process.env.CTX_ROOT = root;
process.env.CTX_FRAMEWORK_ROOT = root;
let costs: typeof import('../cost-parser');
let db: typeof import('../db')['db'];
const org = 'hyphen-org';
const now = Date.parse('2026-09-10T05:00:00Z');
const api = { provider: 'openai', billing_mode: 'api', service_tier: 'standard', region: 'global', model: 'gpt-5-codex', observed_model: 'gpt-5-codex', model_source: 'observed', cache_write_known: true };
const codex = (n: number, input: number, extra = {}) => ({ ...api, timestamp: new Date(now + n * 1000).toISOString(), session_id: 's', turn_id: 't', input_tokens: input, output_tokens: 0, ...extra });
const claude = (output: number) => ({ provider: 'anthropic', billing_mode: 'api', service_tier: 'standard', region: 'global', timestamp: new Date(now).toISOString(), sessionId: 's', requestId: 'r', message: { id: 'm', model: 'claude-opus-4-6', usage: { input_tokens: 100, output_tokens: output } } });
function write(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}
function agent(name: string, runtime: string, organization = org) {
  const dir = path.join(root, 'orgs', organization, 'agents', name);
  write(path.join(dir, 'config.json'), { runtime });
  return dir;
}
function log(name: string, rows: unknown[]) {
  const file = path.join(root, 'logs', name, 'codex-tokens.jsonl');
  write(file, rows.map(r => typeof r === 'string' ? r : JSON.stringify(r)).join('\n'));
  return file;
}
function transcript(dir: string, name = 's.jsonl') {
  return path.join(home, '.claude', 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'), name);
}
beforeAll(async () => { costs = await import('../cost-parser'); db = (await import('../db')).db; });
beforeEach(() => {
  for (const dir of ['orgs', 'logs', 'home', 'config']) fs.rmSync(path.join(root, dir), { recursive: true, force: true });
  for (const table of ['usage_entries_v2', 'usage_health_v2', 'cost_entries']) db.prepare(`DELETE FROM ${table}`).run();
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  vi.spyOn(Date, 'now').mockReturnValue(now + 60000);
});
afterEach(() => vi.restoreAllMocks());

describe('usage scan and SQLite cache integration', () => {
  it('repeated sync is idempotent; overlapping sessions and organization filters survive persistence', () => {
    agent('alpha', 'codex-app-server'); agent('beta', 'codex-app-server', 'other-org');
    log('alpha', [codex(0, 0), codex(1, 100), codex(0, 0, { session_id:'s2' }), codex(2, 400, { session_id:'s2' })]);
    log('beta', [codex(0, 0), codex(1, 600)]);
    expect(costs.syncCosts().inserted).toBe(3);
    expect(costs.syncCosts().inserted).toBe(0);
    expect(costs.getCurrentMonthCost(org)).toMatchObject({ tokens: 500, entries: 2, cost: .000625, cost_status: 'estimated' });
    expect(costs.getUsageHealth(org).instruments.map(i => i.agent)).toEqual(['alpha']);
    expect(costs.getCostEntries(Infinity, 'other-org')).toHaveLength(1);
  });
  it('finds the encoded real path through a symlink with hyphenated org and nested transcripts', () => {
    const real = agent('real-seat', 'claude');
    const link = path.join(root, 'aliases', 'linked-seat');
    fs.mkdirSync(path.dirname(link), { recursive: true }); fs.symlinkSync(real, link);
    // Discovery chooses the framework path, which itself is a symlink.
    const agentLink = path.join(root, 'orgs', org, 'agents', 'linked-seat');
    fs.symlinkSync(real, agentLink);
    write(path.join(root, 'config', 'enabled-agents.json'), { 'linked-seat': { enabled: true, org } });
    write(transcript(fs.realpathSync(link), 'subagents/a.jsonl'), claude(10));
    const rows = costs.scanClaudeProjectsCosts().filter(e => e.agent === 'linked-seat');
    expect(rows).toHaveLength(1); expect(rows[0].org).toBe(org);
  });
  it('a growing Claude message replaces active usage while preserving the old audit row', () => {
    const dir = agent('alpha', 'claude'); const file = transcript(dir);
    write(file, claude(10)); costs.syncCosts();
    write(file, [JSON.stringify(claude(10)), JSON.stringify(claude(30))].join('\n')); costs.syncCosts();
    expect(costs.getCostEntries()).toHaveLength(1);
    expect(costs.getCostEntries()[0].output_tokens).toBe(30);
    expect(db.prepare('SELECT COUNT(*) AS n FROM usage_entries_v2').get()).toEqual({ n: 2 });
    expect(costs.syncCosts().inserted).toBe(0);
  });
  it('rescan preserves the first stored price snapshot, and legacy guessed prices stay excluded', () => {
    agent('alpha', 'codex-app-server'); log('alpha', [codex(0,0), codex(1,100)]);
    costs.syncCosts(); const entry = costs.getCostEntries()[0];
    const frozen = { ...entry, cost_micros: 777, cost_usd: .000777, price_version: 'prior-snapshot' };
    db.prepare('UPDATE usage_entries_v2 SET payload = ? WHERE event_id = ?').run(JSON.stringify(frozen), entry.event_id);
    db.prepare('INSERT INTO cost_entries (timestamp,agent,org,model,cost_usd) VALUES (?,?,?,?,?)').run(entry.timestamp,'alpha',org,'legacy',999);
    costs.syncCosts(); expect(costs.getCostEntries()[0]).toEqual(frozen);
    expect(costs.getCurrentMonthCost(org).cost).toBe(.000777);
    expect(costs.getUsageHealth(org).legacy_rows_excluded).toBe(1);
    expect(db.prepare('SELECT cost_usd FROM cost_entries').get()).toEqual({ cost_usd: 999 });
  });
  it('known plus unknown retains an estimated subtotal with an unknown total in every aggregate', () => {
    agent('alpha', 'codex-app-server');
    log('alpha', [codex(0,0),codex(1,100),codex(2,200,{billing_mode:'subscription'})]); costs.syncCosts();
    const expected = { tokens: 200, cost: null, cost_status:'unknown', estimated_usd:.000125, billed_usd:null, unknown_entries:1 };
    expect(costs.getCurrentMonthCost(org)).toMatchObject(expected);
    expect(costs.getDailyCosts(30,org)[0]).toMatchObject(expected);
    expect(costs.getCostByModel(org)[0]).toMatchObject(expected);
    expect(costs.getDailyCostByModel(30,org)[0]).toMatchObject({ 'gpt-5-codex': null, cost_status:'unknown' });
  });
  it('missing sources deactivate the current view, retain audit history and never report zero spend', () => {
    agent('alpha','codex-app-server'); const file = log('alpha',[codex(0,0),codex(1,100)]); costs.syncCosts();
    fs.unlinkSync(file); costs.syncCosts();
    expect(costs.getUsageHealth(org).instruments[0].status).toBe('missing');
    expect(costs.getCurrentMonthCost(org)).toMatchObject({ cost:null, cost_status:'unknown', entries:0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM usage_entries_v2').get()).toEqual({ n:1 });
  });
  it('stale sources, empty sources and changed runtime remain explicit', () => {
    const dir = agent('alpha','codex-app-server');
    log('alpha',[codex(0,0,{timestamp:'2026-09-09T00:00:00Z'})]); costs.syncCosts();
    expect(costs.getUsageHealth(org).instruments[0].status).toBe('stale');
    log('alpha',[]); costs.syncCosts(); expect(costs.getUsageHealth(org).instruments[0].status).toBe('empty');
    write(path.join(dir,'config.json'),{runtime:'hermes'}); costs.syncCosts();
    expect(costs.getUsageHealth(org).instruments).toMatchObject([{ runtime:'hermes',status:'unsupported' }]);
    expect(costs.getCurrentMonthCost(org).cost).toBeNull();
  });
  it('an unreadable Claude file alongside a fresh file prevents a complete total', () => {
    const dir = agent('alpha','claude'); const good = transcript(dir); const bad = transcript(dir,'broken.jsonl');
    write(good,claude(10)); write(bad,claude(20));
    const original = fs.readFileSync;
    vi.spyOn(fs,'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (file === bad) throw Object.assign(new Error('fixture unreadable'),{code:'EACCES'});
      return (original as Function)(file,...args);
    }) as typeof fs.readFileSync);
    costs.syncCosts();
    expect(costs.getUsageHealth(org).instruments.filter(i=>i.status==='fresh')).toEqual([]);
    expect(costs.getCurrentMonthCost(org)).toMatchObject({cost:null,cost_status:'unknown',estimated_usd:.00075});
  });
  it('malformed and reset telemetry produces visible issues after persistence', () => {
    agent('alpha','codex-app-server'); log('alpha',[codex(0,0),codex(1,100),codex(2,20),'broken']); costs.syncCosts();
    expect(costs.getUsageHealth(org).issues.map(i=>i.code)).toEqual(expect.arrayContaining(['malformed_json','cumulative_regression_or_invalid_delta']));
    expect(costs.getCurrentMonthCost(org).cost).toBeNull();
    expect(costs.getCostEntries()).toEqual([]);
  });
});
