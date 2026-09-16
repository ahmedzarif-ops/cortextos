/**
 * cron-dispatch.ts — run ONE cron as an isolated bounded turn on a named model.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS FOR
 * ─────────────────────────────────────────────────────────────────────────────
 * Without it, a cron has exactly one way to run: the daemon injects its prompt
 * into the agent's PTY and the SEAT's model answers. A cheap recurring job
 * therefore costs premium-seat tokens, and a `model` key in `cron.metadata` did
 * nothing at all because no code ever read it.
 *
 * When `cron.dispatch` is set, the fire never reaches the seat. The prompt goes
 * to `hermes-call.sh` as a single `/chat/completions` turn and a receipt is
 * written. The seat is not woken, not injected into, and not billed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⛔ WHY THIS SHELLS OUT INSTEAD OF REIMPLEMENTING THE CALL
 * ─────────────────────────────────────────────────────────────────────────────
 * `hermes-call.sh` is not a convenience wrapper. It owns the ledger (an unlogged
 * call is structurally impossible — output is withheld until the row is appended
 * AND read back), the pre-call spend gate, the alias ban, the long-context cost
 * cliff, and the empty-output guard. A TypeScript reimplementation would be a
 * SECOND spend gate, and two spend gates drift — at which point the fleet has two
 * numbers for one cap and believes the friendlier one. So this module is a CALLER,
 * never a second implementation, and it passes the wrapper's own exit code
 * through untouched.
 *
 * ⚠ THE WRAPPER IS NOT SHIPPED IN THIS REPOSITORY. It lives in an operator's
 * workspace. This module therefore resolves it at fire time and FAILS LOUDLY when
 * it is absent, naming every path it looked in. It does not degrade, and it does
 * not fall back to the seat: a silent fallback would spend exactly the budget the
 * field exists to protect, on a schedule, unattended.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⛔ WHAT A GREEN RECEIPT DOES NOT PROVE
 * ─────────────────────────────────────────────────────────────────────────────
 *   - `cost_usd` is priced off the model that was REQUESTED. When `model_served`
 *     differs, the figure is an estimate against the wrong price row. Both ids are
 *     on the receipt so the discrepancy is readable instead of averaged away.
 *   - The spend gate inside the wrapper sums only calls made THROUGH the wrapper.
 *     Anything reaching the provider by another route is invisible to it. A pass
 *     means "the wrapper path is under cap", never "the account is under cap".
 *   - `tokens_cached` is always null: the upstream ledger has no cache column, so
 *     a cache figure here could only be invented.
 */

import { execFile } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, accessSync, constants } from 'fs';
import { join, dirname } from 'path';
import { randomBytes } from 'crypto';
import type { CronDefinition, CronDispatchReceipt } from '../types/index.js';
import { cronDispatchReceiptsPathFor } from '../bus/crons-schema.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default output-token ceiling when the cron does not name one. */
export const DEFAULT_DISPATCH_MAX_TOKENS = 4096;

/**
 * Hard wall-clock ceiling for one dispatched turn, in milliseconds.
 *
 * 330s = the wrapper's own `curl -m 300` plus 30s of slack for jq, the ledger
 * append and the read-back. Deliberately LONGER than the inner timeout so that a
 * timeout here means "the wrapper itself hung", which is a different fault from
 * "the gateway was slow" and should not be reported as the same thing.
 */
export const DISPATCH_TIMEOUT_MS = 330_000;

/** Cap on captured wrapper output so one runaway turn cannot exhaust daemon memory. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** How many stderr characters land on the receipt. The refusal text is the payload. */
const STDERR_HEAD_CHARS = 500;

/**
 * Ledger tail scanned when joining a receipt to its row, in bytes.
 * Generous: a row is a few hundred bytes, so this covers thousands of recent calls
 * while never reading an unbounded file into the daemon.
 */
const LEDGER_TAIL_BYTES = 2 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Candidate locations for the wrapper, in precedence order.
 *
 * Exported so the failure message and the tests read from ONE list. A message that
 * names a different set of paths than the resolver searched is worse than no
 * message: it sends the operator to install the file somewhere that will not be
 * looked at.
 */
export function hermesCallCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  const explicit = env['CORTEXTOS_HERMES_CALL'];
  if (explicit && explicit.trim() !== '') out.push(explicit);
  const ctxRoot = env['CTX_ROOT'];
  if (ctxRoot && ctxRoot.trim() !== '') out.push(join(ctxRoot, '.cortextOS', 'bin', 'hermes-call.sh'));
  return out;
}

/** Thrown when no wrapper could be found. Carries the searched list for the receipt. */
export class WrapperMissingError extends Error {
  constructor(public readonly searched: string[]) {
    super(
      'Cron dispatch requires the sanctioned Hermes wrapper (hermes-call.sh) and it was not found. ' +
      `Searched, in order: ${searched.length > 0 ? searched.join(', ') : '(nothing — neither CORTEXTOS_HERMES_CALL nor CTX_ROOT is set)'}. ` +
      'Set CORTEXTOS_HERMES_CALL to the wrapper, or install it at $CTX_ROOT/.cortextOS/bin/hermes-call.sh. ' +
      'This cron was NOT run on the seat instead: falling back would spend the seat budget that dispatch exists to protect.'
    );
    this.name = 'WrapperMissingError';
  }
}

/** Resolve the wrapper or throw {@link WrapperMissingError}. */
export function resolveHermesCall(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = hermesCallCandidates(env);
  for (const c of candidates) {
    try {
      accessSync(c, constants.X_OK);
      return c;
    } catch {
      // A path that exists but is not executable is as unusable as an absent one,
      // and is reported the same way — with the full searched list.
    }
  }
  throw new WrapperMissingError(candidates);
}

/**
 * Ledger path the wrapper will write and this module will read back.
 *
 * ⛔ BOTH SIDES MUST AGREE. The wrapper defaults to this same path, but it is
 * passed EXPLICITLY into the child environment rather than left to a default,
 * because a default that drifts on one side produces receipts with every
 * observed field null and no error anywhere — a green dispatch with no evidence.
 */
export function resolveLedgerPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['HERMES_LEDGER'];
  if (explicit && explicit.trim() !== '') return explicit;
  const home = env['HOME'] ?? '';
  const instance = env['CTX_INSTANCE_ID'] ?? 'default';
  const org = env['CTX_ORG'] ?? 'default';
  return join(home, '.cortextos', instance, 'orgs', org, 'analytics', 'hermes-usage.jsonl');
}

// ---------------------------------------------------------------------------
// Receipt I/O
// ---------------------------------------------------------------------------

/** Absolute path to an agent's receipt log. */
export function receiptsPath(agentName: string, env: NodeJS.ProcessEnv = process.env): string {
  const ctxRoot = env['CTX_ROOT'] ?? process.cwd();
  return join(ctxRoot, cronDispatchReceiptsPathFor(agentName));
}

/**
 * Append one receipt.
 *
 * Never throws: a receipt-write failure must not turn a completed (billed) turn
 * into a thrown fire, because the money is already spent and losing the receipt
 * as well helps nobody. It warns on stderr instead, loudly enough to be found.
 */
export function writeReceipt(
  agentName: string,
  receipt: CronDispatchReceipt,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const path = receiptsPath(agentName, env);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(receipt)}\n`, 'utf-8');
  } catch (err) {
    console.error(
      `[cron-dispatch] WARNING: could not write receipt to ${path}: ${String(err)}. ` +
      `The turn already ran and may have been billed. Row, record it by hand: ${JSON.stringify(receipt)}`
    );
  }
}

/**
 * Map a wrapper exit code to a coarse outcome.
 *
 * The codes are the wrapper's, documented at its definition; they are restated
 * here as names so a receipt is readable without the shell script in hand.
 */
export function outcomeForRc(rc: number): string {
  switch (rc) {
    case 0: return 'ok';
    case 64: return 'refused';         // malformed call — nothing dispatched
    case 65: return 'refused_unpriced'; // model not in prices.json — THE unknown-model case
    case 66: return 'refused_context';  // long-context cost cliff
    case 67: return 'refused_no_token';
    case 68: return 'call_failed';      // dispatched; gateway failed; MAY have billed
    case 70: return 'ledger_failed';
    case 71: return 'ledger_failed';
    case 72: return 'empty_output';     // billed and produced nothing
    case 73: return 'spend_refused';    // the pre-call spend gate
    default: return 'error';
  }
}

/**
 * Find this call's ledger row by its correlation id.
 *
 * ⛔ WHY A CORRELATION ID AND NOT "THE LAST ROW". The daemon can fire several
 * crons in the same tick and the operator can be running the wrapper by hand at
 * the same moment. "Read the last line" would attach one cron's cost to another
 * cron's receipt, and both receipts would look perfectly well-formed. The id is
 * passed to the wrapper as `--task`, which it copies into `task_id` on the row —
 * so the join is exact, using the wrapper's existing contract with nothing added
 * to it.
 *
 * Returns null when no row matches, which is a real and expected state: a refusal
 * before dispatch writes no row at all.
 */
export function findLedgerRow(
  ledgerPath: string,
  correlationId: string,
): Record<string, unknown> | null {
  try {
    if (!existsSync(ledgerPath)) return null;
    const raw = readFileSync(ledgerPath, 'utf-8');
    const tail = raw.length > LEDGER_TAIL_BYTES ? raw.slice(raw.length - LEDGER_TAIL_BYTES) : raw;
    const lines = tail.split('\n');
    // Newest first: a correlation id is unique, but scanning backwards means the
    // common case touches one line instead of the whole tail.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line || line.trim() === '') continue;
      if (!line.includes(correlationId)) continue; // cheap reject before parsing
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        if (row['task_id'] === correlationId) return row;
      } catch {
        // A torn or truncated line is skipped, never allowed to abort the scan.
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Read a numeric ledger field, preserving the difference between absent and 0. */
function numOrNull(row: Record<string, unknown> | null, key: string): number | null {
  if (!row) return null;
  const v = row[key];
  return typeof v === 'number' ? v : null;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export interface DispatchResult {
  receipt: CronDispatchReceipt;
  /** The model's answer. Empty on any non-zero rc. */
  output: string;
}

/** Options for {@link dispatchCron}, all injectable so tests never touch live state. */
export interface DispatchCronOptions {
  agentName: string;
  cron: CronDefinition;
  /** ISO instant the fire was scheduled for, when the scheduler knows it. */
  dueAt?: string;
  env?: NodeJS.ProcessEnv;
  /** Correlation id override. Generated when absent; only tests should pass one. */
  correlationId?: string;
}

/**
 * Run one cron as an isolated bounded turn and write its receipt.
 *
 * ⛔ THROWS ON ANY NON-ZERO OUTCOME, and that is the contract. The caller is the
 * scheduler's `onFire`, which records a thrown fire as `status: "failed"` with the
 * message in `cron-execution.log`. A dispatch that quietly resolved on a refusal
 * would be logged `fired` — a cron that never ran, recorded in the same words as
 * one that did, which is the exact class of silent failure this codebase keeps
 * paying for.
 *
 * A receipt is written BEFORE the throw, on every path, including the refusals.
 */
export async function dispatchCron(opts: DispatchCronOptions): Promise<DispatchResult> {
  const env = opts.env ?? process.env;
  const { agentName, cron } = opts;
  const dispatch = cron.dispatch;
  if (!dispatch) {
    throw new Error(
      `dispatchCron called for cron "${cron.name}" which has no dispatch block — this is a caller bug. ` +
      'The absent-field path must stay on the seat injection it has always used.'
    );
  }

  const startedAt = Date.now();
  const correlationId = opts.correlationId ?? `cron-${agentName}-${cron.name}-${randomBytes(6).toString('hex')}`;
  const maxTokens = dispatch.max_tokens ?? DEFAULT_DISPATCH_MAX_TOKENS;
  const project = dispatch.project ?? 'fleet';
  const purpose = dispatch.purpose ?? `cron:${cron.name}`;
  const ledgerPath = resolveLedgerPath(env);

  const base = {
    due_at: opts.dueAt,
    cron: cron.name,
    agent: agentName,
    correlation_id: correlationId,
    model: dispatch.model,
    tokens_cached: null,
  } as const;

  const finish = (fields: Omit<CronDispatchReceipt, keyof typeof base | 'ts' | 'duration_ms'>): CronDispatchReceipt => {
    const receipt: CronDispatchReceipt = {
      ts: new Date().toISOString(),
      ...base,
      ...fields,
      duration_ms: Date.now() - startedAt,
    };
    writeReceipt(agentName, receipt, env);
    return receipt;
  };

  // --- resolve the wrapper ---------------------------------------------------
  let wrapper: string;
  try {
    wrapper = resolveHermesCall(env);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finish({
      model_served: null, tokens_in: null, tokens_out: null, cost_usd: null,
      rc: -1, outcome: 'wrapper_missing', stderr_head: message.slice(0, STDERR_HEAD_CHARS), output_chars: 0,
    });
    throw err;
  }

  // --- child environment: an ALLOWLIST, never an inherit ---------------------
  // The daemon's environment carries seat identity and whatever the operator's
  // shell had. A bounded inference turn needs almost none of it, and anything
  // extra is one more thing that can change what the wrapper does without anyone
  // deciding that it should. Only the variables the wrapper documents are passed.
  const childEnv: NodeJS.ProcessEnv = {
    PATH: env['PATH'] ?? '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: env['HOME'] ?? '',
    HERMES_LEDGER: ledgerPath,
    CTX_AGENT_NAME: agentName,
  };
  // Spend-gate knobs are forwarded only when the operator set them, so an unset
  // variable keeps the wrapper's own default rather than being pinned to a copy
  // of it here — two defaults for one cap is the drift this module refuses to add.
  for (const key of [
    'HERMES_FLEET_CAP_USD', 'HERMES_FLEET_WARN_USD', 'HERMES_UNMEASURED_ROW_USD',
    'HERMES_CYCLE_ANCHOR_DAY', 'HERMES_GATE',
  ]) {
    const v = env[key];
    if (v !== undefined) childEnv[key] = v;
  }

  const args = [
    '--model', dispatch.model,
    '--purpose', purpose,
    '--task', correlationId,
    '--max-tokens', String(maxTokens),
    '--project', project,
  ];

  // --- run -------------------------------------------------------------------
  // The prompt goes in on STDIN, not argv: it is operator-authored text of
  // unbounded length, and argv has a hard ceiling that would turn a long prompt
  // into an E2BIG the operator cannot read. The wrapper already reads stdin when
  // --prompt is absent.
  const run = await new Promise<{ rc: number; stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
    const child = execFile(
      wrapper, args,
      { env: childEnv, timeout: DISPATCH_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf-8' },
      (error, stdout, stderr) => {
        const killedByTimeout = Boolean(error && (error as NodeJS.ErrnoException).code === undefined && (error as { killed?: boolean }).killed);
        const rc = error && typeof (error as { code?: unknown }).code === 'number'
          ? (error as { code: number }).code
          : (error ? -1 : 0);
        resolve({ rc, stdout: stdout ?? '', stderr: stderr ?? '', timedOut: killedByTimeout });
      },
    );
    child.stdin?.end(cron.prompt);
  });

  const row = findLedgerRow(ledgerPath, correlationId);
  const stderrHead = run.stderr.slice(0, STDERR_HEAD_CHARS);
  const outcome = run.timedOut ? 'timeout' : outcomeForRc(run.rc);

  const receipt = finish({
    model_served: row && typeof row['model_served'] === 'string' ? (row['model_served'] as string) : null,
    tokens_in: numOrNull(row, 'tokens_in'),
    tokens_out: numOrNull(row, 'tokens_out'),
    cost_usd: numOrNull(row, 'cost_usd'),
    rc: run.rc,
    outcome,
    stderr_head: stderrHead,
    output_chars: run.rc === 0 ? run.stdout.length : 0,
  });

  if (run.rc !== 0) {
    throw new Error(
      `Cron "${cron.name}" dispatch to ${dispatch.model} FAILED: rc=${run.rc} (${outcome}). ` +
      `Receipt written to ${receiptsPath(agentName, env)} (correlation_id=${correlationId}). ` +
      `The cron was NOT run on the seat as a fallback. Wrapper stderr: ${stderrHead || '(empty)'}`
    );
  }

  return { receipt, output: run.stdout };
}
