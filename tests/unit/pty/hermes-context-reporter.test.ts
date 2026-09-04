import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { HermesContextReporter, estimateTokens } from '../../../src/pty/hermes-context-reporter.js';

/**
 * Hermes seats wrote NO context_status.json at all: 203 messages across two
 * live seats, zero writes, while claude and codex seats updated as controls.
 * The daemon's context gate reads that file, so those seats could never trip a
 * handoff.
 *
 * These tests build a real SQLite database in the Hermes schema and run the
 * real reporter against it. The two arms that matter are the traps, because
 * both of them produce a confident, plausible, WRONG number that no ordinary
 * test would catch.
 */

let dir: string;
let profileHome: string;
let stateDir: string;

const SESSION = '20260904_140622_a59949';
const MODEL = 'google/gemini-3.8-flash';
const BASE_URL = 'https://inference-api.nousresearch.com/v1';

function sqlite(sql: string): void {
  execFileSync('sqlite3', [join(profileHome, 'state.db'), sql], { encoding: 'utf-8' });
}

function seed(opts: { tokenCountNull?: boolean; cumulativeTotals?: boolean } = {}): void {
  rmSync(join(profileHome, 'state.db'), { force: true });
  sqlite(`
    create table sessions (
      id text primary key, source text, model text, billing_base_url text,
      started_at real, ended_at real, message_count integer,
      input_tokens integer, output_tokens integer, cache_read_tokens integer
    );
    create table messages (
      id integer primary key, session_id text, role text, content text,
      tool_calls text, reasoning_content text, timestamp real,
      token_count integer, active integer default 1, compacted integer default 0
    );
  `);
  // Cumulative lifetime totals as a live seat actually carries them — far
  // beyond the window. Present on purpose: if the reporter ever reads these,
  // the percentage arm below goes absurd and the test says so.
  const inTok = opts.cumulativeTotals === false ? 10 : 4340125;
  const cacheTok = opts.cumulativeTotals === false ? 10 : 91433928;
  sqlite(
    `insert into sessions values ('${SESSION}','cli','${MODEL}','${BASE_URL}',1.0,null,3,${inTok},78948,${cacheTok});`,
  );
  const tc = opts.tokenCountNull === false ? '100' : 'null';
  for (let i = 1; i <= 3; i++) {
    // 400 bytes of content per row => 1200 bytes total => 300 estimated tokens.
    sqlite(
      `insert into messages (session_id, role, content, tool_calls, reasoning_content, timestamp, token_count, active, compacted)
       values ('${SESSION}','user','${'x'.repeat(400)}','','',${i},${tc},1,0);`,
    );
  }
}

function reporter(): HermesContextReporter {
  return new HermesContextReporter({ stateDir, profileHome, startedAtMs: 0 });
}

function readStatus(): any {
  return JSON.parse(readFileSync(join(stateDir, 'context_status.json'), 'utf-8'));
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-ctx-'));
  profileHome = join(dir, 'profile');
  stateDir = join(dir, 'state');
  mkdirSync(profileHome, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(profileHome, 'context_length_cache.yaml'),
    `context_lengths:\n  deepseek/deepseek-v4-flash@${BASE_URL}: 1048576\n  ${MODEL}@${BASE_URL}: 1048576\n`,
    'utf-8',
  );
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('HermesContextReporter', () => {
  it('writes a status file for a live hermes session', () => {
    seed();
    expect(reporter().reportOnce()).toBe(true);
    expect(existsSync(join(stateDir, 'context_status.json'))).toBe(true);
    const s = readStatus();
    expect(s.session_id).toBe(SESSION);
    expect(typeof s.written_at).toBe('string');
  });

  it('takes the window from the hermes cache, never a constant', () => {
    seed();
    reporter().reportOnce();
    expect(readStatus().context_window_size).toBe(1048576);
    // And it must FAIL rather than invent one when the cache cannot answer.
    const orphan = new HermesContextReporter({ stateDir, profileHome: join(dir, 'no-such-profile') });
    expect(orphan.reportOnce()).toBe(false);
  });

  it('TRAP 1: does not read the cumulative lifetime totals', () => {
    // sessions.input_tokens 4,340,125 + cache_read 91,433,928 against a
    // 1,048,576 window. Any implementation that sums them reports >8000% —
    // clamped to 100 — and fires the handoff gate forever. A fixture with
    // small numbers in those columns would hide this completely.
    seed({ cumulativeTotals: true });
    reporter().reportOnce();
    const s = readStatus();
    expect(s.used_percentage).toBeLessThan(1);
    expect(s.used_percentage).toBeGreaterThan(0);
    // 3 rows x 400 bytes / 4 bytes-per-token
    expect(s.estimate_basis.estimated_tokens).toBe(300);
  });

  it('TRAP 2: a NULL token_count column does not become a confident zero', () => {
    // messages.token_count exists and is NULL on all 842 rows of a live seat.
    // SUM(COALESCE(token_count,0)) is a clean 0, which renders as 0% occupancy
    // and would never trip anything. The estimate must not depend on it.
    seed({ tokenCountNull: true });
    reporter().reportOnce();
    const s = readStatus();
    expect(s.estimate_basis.estimated_tokens).toBe(300);
    expect(s.used_percentage).toBeGreaterThan(0);
  });

  it('labels the number as an estimate, because every other runtime measures it', () => {
    seed();
    reporter().reportOnce();
    const s = readStatus();
    expect(s.source).toBe('estimated');
    expect(s.estimate_basis.bytes_per_token).toBe(4);
    expect(s.estimate_basis.method).toContain('bytes-per-token');
  });

  it('estimateTokens returns null, never 0, when there is nothing to measure', () => {
    // A zero would render as "plenty of room" and is indistinguishable from a
    // healthy empty session — the exact confusion this whole task exists for.
    expect(estimateTokens({ msgs: 0, content_bytes: 0 })).toBeNull();
    expect(estimateTokens({ msgs: 5, content_bytes: 0, toolcall_bytes: 0, reasoning_bytes: 0 })).toBeNull();
    expect(estimateTokens({ msgs: 1, content_bytes: 400 })).toBe(100);
  });

  it('advances written_at as the session grows, and does not rewrite when idle', () => {
    seed();
    const r = reporter();
    expect(r.reportOnce()).toBe(true);
    const first = readStatus();
    // Idle: same content, so no new write — a status file that churns without
    // change makes a stalled writer harder to spot, not easier.
    expect(r.reportOnce()).toBe(false);
    sqlite(
      `insert into messages (session_id, role, content, tool_calls, reasoning_content, timestamp, token_count, active, compacted)
       values ('${SESSION}','user','${'y'.repeat(800)}','','',9,null,1,0);`,
    );
    expect(r.reportOnce()).toBe(true);
    const second = readStatus();
    expect(second.estimate_basis.estimated_tokens).toBeGreaterThan(first.estimate_basis.estimated_tokens);
  });

  it('ignores messages that have left the live context', () => {
    seed();
    sqlite(
      `insert into messages (session_id, role, content, tool_calls, reasoning_content, timestamp, token_count, active, compacted)
       values ('${SESSION}','user','${'z'.repeat(40000)}','','',10,null,0,1);`,
    );
    reporter().reportOnce();
    // The compacted row is 100x the live content; if the filter were dropped
    // the estimate would jump by ~10,000 tokens.
    expect(readStatus().estimate_basis.estimated_tokens).toBe(300);
  });
});
