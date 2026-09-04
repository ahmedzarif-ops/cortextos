import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { atomicWriteSync } from '../utils/atomic.js';

/**
 * Writes `context_status.json` for a Hermes seat.
 *
 * Three runtimes, three mechanisms: claude-code gets the file from the harness
 * statusLine hook, the codex adapter writes it from the app-server token
 * stream, and OpenCode polls its own SQLite. Hermes had NOTHING — measured
 * 2026-09-04, 203 messages across two seats produced zero writes, with claude
 * and codex seats updating as live controls. The daemon's Tier 1/Tier 2 context
 * gate reads this file, so a Hermes seat approaching real exhaustion could
 * never trip a handoff while the dashboard showed it comfortable.
 *
 * Modelled on OpencodeContextReporter deliberately: same shape, same atomic
 * write, same `sqlite3 -readonly` access. `-readonly` is not incidental — a
 * live seat owns this database, and a probe that writes is not read-only.
 */

/** Conservative and deliberate. See estimateTokens. */
const BYTES_PER_TOKEN = 4;

interface ReporterOptions {
  stateDir: string;
  /** `~/.hermes/profiles/<seat>`, from hermesProfileHome — never guessed. */
  profileHome: string;
  /** Only sessions started at/after this are considered. 0 = any. */
  startedAtMs?: number;
  /** Injected for tests. */
  now?: () => Date;
}

interface SessionRow {
  id?: unknown;
  model?: unknown;
  billing_base_url?: unknown;
  started_at?: unknown;
}

interface ByteRow {
  content_bytes?: unknown;
  toolcall_bytes?: unknown;
  reasoning_bytes?: unknown;
  msgs?: unknown;
  counted_tokens?: unknown;
  null_token_counts?: unknown;
}

export class HermesContextReporter {
  private readonly stateDir: string;
  private readonly profileHome: string;
  private readonly startedAtMs: number;
  private readonly now: () => Date;
  private lastKey: string | null = null;

  constructor(options: ReporterOptions) {
    this.stateDir = options.stateDir;
    this.profileHome = options.profileHome;
    this.startedAtMs = options.startedAtMs ?? 0;
    this.now = options.now ?? (() => new Date());
  }

  dbPath(): string {
    return join(this.profileHome, 'state.db');
  }

  reportOnce(): boolean {
    try {
      const dbPath = this.dbPath();
      if (!existsSync(dbPath)) return false;

      const session = this.findSession(dbPath);
      if (!session || typeof session.id !== 'string' || !session.id) return false;

      const bytes = this.findBytes(dbPath, session.id);
      if (!bytes) return false;

      const tokens = estimateTokens(bytes);
      if (tokens === null) return false;

      const cap = this.resolveContextCap(session);
      if (cap === null || cap <= 0) return false;

      const key = `${session.id}:${tokens}`;
      if (key === this.lastKey) return false;
      this.lastKey = key;

      const payload = JSON.stringify({
        used_percentage: Math.min(100, (tokens / cap) * 100),
        context_window_size: cap,
        exceeds_200k_tokens: tokens > 200000,
        current_usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        session_id: session.id,
        written_at: this.now().toISOString(),
        // ⛔ NOT decoration. Every other runtime writes a MEASURED percentage;
        // this one is derived from content length. A reader that cannot tell
        // them apart will eventually treat this number as authoritative.
        source: 'estimated',
        estimate_basis: {
          method: 'active-message-bytes/bytes-per-token',
          bytes_per_token: BYTES_PER_TOKEN,
          estimated_tokens: tokens,
        },
      });

      atomicWriteSync(join(this.stateDir, 'context_status.json'), payload);
      return true;
    } catch {
      // Non-fatal: the reader reports UNKNOWN on a stale or missing file, which
      // is the whole point of the reader half. Failing silently here is safe
      // ONLY because that half exists.
      return false;
    }
  }

  private findSession(dbPath: string): SessionRow | null {
    const rows = this.queryRows<SessionRow>(
      dbPath,
      `select id, model, billing_base_url, started_at from sessions
       where ended_at is null
         and started_at >= ${this.startedAtMs / 1000}
       order by started_at desc limit 1`,
    );
    return rows[0] ?? null;
  }

  /**
   * ⛔ THE TRAP THIS METHOD EXISTS TO AVOID, WRITTEN DOWN BECAUSE IT WOULD PASS
   * EVERY UNIT TEST: `sessions.input_tokens` and `sessions.cache_read_tokens`
   * are CUMULATIVE LIFETIME TOTALS, not occupancy. Measured on a live seat:
   * input 4,340,125 and cache_read 91,433,928 against a 1,048,576 window.
   * Summing them yields >8000% and fires the handoff gate instantly, forever —
   * and a fixture with small numbers in those columns looks perfectly correct.
   * Occupancy must come from the messages still IN the context.
   *
   * ⛔ AND THE SECOND TRAP, WHICH IS WORSE BECAUSE IT LOOKS LIKE DATA:
   * `messages.token_count` EXISTS and is NULL on every row (842 of 842 on a
   * live seat). `SUM(COALESCE(token_count,0))` therefore returns a clean 0,
   * which renders as 0% occupancy and would never trip anything. That is why
   * this query returns `null_token_counts` — so the caller can tell "no tokens
   * recorded" from "no tokens used" instead of reading the reassuring one.
   */
  private findBytes(dbPath: string, sessionId: string): ByteRow | null {
    const rows = this.queryRows<ByteRow>(
      dbPath,
      `select
         count(*) as msgs,
         sum(length(coalesce(content,''))) as content_bytes,
         sum(length(coalesce(tool_calls,''))) as toolcall_bytes,
         sum(length(coalesce(reasoning_content,''))) as reasoning_bytes,
         sum(coalesce(token_count,0)) as counted_tokens,
         sum(case when token_count is null then 1 else 0 end) as null_token_counts
       from messages
       where session_id = ${sqlString(sessionId)}
         and active = 1 and compacted = 0`,
    );
    return rows[0] ?? null;
  }

  /**
   * The window comes from what Hermes itself cached per profile, never from a
   * constant. A hardcoded cap is a number that is right until someone changes
   * the model — and the incident that produced this file involved a seat
   * reporting a 258,400 window that belonged to a runtime it no longer ran.
   */
  private resolveContextCap(session: SessionRow): number | null {
    const model = typeof session.model === 'string' ? session.model : '';
    const baseUrl = typeof session.billing_base_url === 'string' ? session.billing_base_url : '';
    if (!model) return null;

    const cachePath = join(this.profileHome, 'context_length_cache.yaml');
    if (!existsSync(cachePath)) return null;

    let text: string;
    try {
      text = readFileSync(cachePath, 'utf-8');
    } catch {
      return null;
    }

    const wanted = baseUrl ? `${model}@${baseUrl}` : model;
    for (const line of text.split('\n')) {
      const m = line.match(/^\s{2,}(\S+):\s*(\d+)\s*$/);
      if (!m) continue;
      if (m[1] === wanted || m[1].startsWith(`${model}@`)) {
        const n = Number(m[2]);
        return Number.isFinite(n) && n > 0 ? n : null;
      }
    }
    return null;
  }

  private queryRows<T>(dbPath: string, sql: string): T[] {
    const output = execFileSync('sqlite3', ['-readonly', '-json', dbPath, sql], {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    if (!output) return [];
    const parsed: unknown = JSON.parse(output);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  }
}

/**
 * Bytes to tokens, and the divisor is a SAFETY CHOICE, not a measurement.
 *
 * 4 bytes/token is folklore; our own corpus measured ~5.9. Using the SMALLER
 * divisor deliberately over-estimates the token count, so the reported
 * occupancy is high rather than low. A premature handoff costs one restart; a
 * missed one loses a session. When an estimate must be wrong, it should be
 * wrong toward the recoverable failure.
 *
 * Returns null rather than 0 when there is nothing to measure — a zero here
 * would render as "plenty of room" and is indistinguishable from a healthy
 * empty session.
 */
export function estimateTokens(bytes: {
  content_bytes?: unknown;
  toolcall_bytes?: unknown;
  reasoning_bytes?: unknown;
  msgs?: unknown;
}): number | null {
  const msgs = asNumber(bytes.msgs) ?? 0;
  if (msgs <= 0) return null;
  const total =
    (asNumber(bytes.content_bytes) ?? 0) +
    (asNumber(bytes.toolcall_bytes) ?? 0) +
    (asNumber(bytes.reasoning_bytes) ?? 0);
  if (total <= 0) return null;
  return Math.ceil(total / BYTES_PER_TOKEN);
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
