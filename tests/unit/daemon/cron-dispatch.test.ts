import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, appendFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  dispatchCron,
  resolveHermesCall,
  hermesCallCandidates,
  findLedgerRow,
  outcomeForRc,
  receiptsPath,
  resolveLedgerPath,
  WrapperMissingError,
  DEFAULT_DISPATCH_MAX_TOKENS,
} from '../../../src/daemon/cron-dispatch.js';
import type { CronDefinition, CronDispatchReceipt } from '../../../src/types/index.js';

/**
 * These tests drive the REAL wrapper contract: a real executable on disk, real
 * argv, real stdin, a real exit code and a real JSONL ledger. Nothing about
 * `execFile` is mocked.
 *
 * ⛔ WHY NOT MOCK IT. The thing under test is a BOUNDARY — argv spelling, stdin
 * delivery, exit-code propagation, environment scoping and a file join. A mock of
 * child_process asserts the shape of my own mock and would stay green through
 * every one of those going wrong.
 */

let testDir: string;
let ctxRoot: string;
let binDir: string;
let ledgerPath: string;

/** Write an executable stub standing in for hermes-call.sh. */
function writeStub(body: string): string {
  const p = join(binDir, 'hermes-call.sh');
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`, 'utf-8');
  chmodSync(p, 0o755);
  return p;
}

/** A stub that behaves like the real wrapper on success: append a row, print content. */
function writeSuccessStub(opts: { modelServed?: string; cost?: number } = {}): string {
  const served = opts.modelServed ?? 'deepseek/deepseek-v4.1-flash';
  const cost = opts.cost ?? 0.000123;
  return writeStub(`
set -uo pipefail
MODEL=""; TASK=""; PURPOSE=""; MAXTOK=""; PROJECT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --model) MODEL="$2"; shift 2;;
    --task) TASK="$2"; shift 2;;
    --purpose) PURPOSE="$2"; shift 2;;
    --max-tokens) MAXTOK="$2"; shift 2;;
    --project) PROJECT="$2"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 64;;
  esac
done
PROMPT="$(cat)"
mkdir -p "$(dirname "$HERMES_LEDGER")"
printf '{"ts":"2026-09-16T03:00:00Z","agent":"%s","project":"%s","model":"%s","model_served":"${served}","purpose":"%s","task_id":"%s","tokens_in":11,"tokens_out":22,"cost_usd":${cost}}\\n' \\
  "\${CTX_AGENT_NAME:-}" "$PROJECT" "$MODEL" "$PURPOSE" "$TASK" >> "$HERMES_LEDGER"
printf 'ARGV_MODEL=%s MAXTOK=%s PROJECT=%s PURPOSE=%s PROMPT=%s\\n' "$MODEL" "$MAXTOK" "$PROJECT" "$PURPOSE" "$PROMPT"
`);
}

function makeCron(over: Partial<CronDefinition> = {}): CronDefinition {
  return {
    name: 'nightly-digest',
    prompt: 'Summarise the fleet lanes in five lines.',
    schedule: '0 3 * * *',
    enabled: true,
    created_at: '2026-09-16T02:00:00.000Z',
    dispatch: { runtime: 'hermes', model: 'deepseek/deepseek-v4.1-flash' },
    ...over,
  };
}

function testEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: testDir,
    CTX_ROOT: ctxRoot,
    HERMES_LEDGER: ledgerPath,
    CORTEXTOS_HERMES_CALL: join(binDir, 'hermes-call.sh'),
    ...extra,
  };
}

function readReceipts(agent = 'alice'): CronDispatchReceipt[] {
  const p = receiptsPath(agent, { CTX_ROOT: ctxRoot } as NodeJS.ProcessEnv);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8').split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l));
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'cron-dispatch-'));
  ctxRoot = join(testDir, 'ctx');
  binDir = join(testDir, 'bin');
  ledgerPath = join(testDir, 'analytics', 'hermes-usage.jsonl');
  mkdirSync(ctxRoot, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(join(testDir, 'analytics'), { recursive: true });
});

afterEach(() => {
  // Left in place deliberately on failure would be nicer for forensics, but a
  // per-test tmpdir that is never removed fills the disk over a full suite.
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------

describe('outcomeForRc: the wrapper exit codes are readable without the shell script', () => {
  it('names the codes an operator actually has to act on', () => {
    expect(outcomeForRc(0)).toBe('ok');
    expect(outcomeForRc(65)).toBe('refused_unpriced'); // THE unknown-model case
    expect(outcomeForRc(73)).toBe('spend_refused');
    expect(outcomeForRc(68)).toBe('call_failed');
    expect(outcomeForRc(72)).toBe('empty_output');
  });

  it('does not silently call an unrecognised code "ok"', () => {
    expect(outcomeForRc(99)).toBe('error');
    expect(outcomeForRc(-1)).toBe('error');
  });
});

describe('resolveHermesCall: a missing wrapper is loud and names where it looked', () => {
  it('prefers the explicit override', () => {
    const p = writeSuccessStub();
    expect(resolveHermesCall(testEnv())).toBe(p);
  });

  it('falls back to $CTX_ROOT/.cortextOS/bin/hermes-call.sh', () => {
    const installed = join(ctxRoot, '.cortextOS', 'bin', 'hermes-call.sh');
    mkdirSync(join(ctxRoot, '.cortextOS', 'bin'), { recursive: true });
    writeFileSync(installed, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(installed, 0o755);
    expect(resolveHermesCall({ CTX_ROOT: ctxRoot } as NodeJS.ProcessEnv)).toBe(installed);
  });

  it('throws WrapperMissingError listing EVERY path it searched', () => {
    let caught: unknown;
    try {
      resolveHermesCall({ CTX_ROOT: ctxRoot, CORTEXTOS_HERMES_CALL: '/nope/hermes-call.sh' } as NodeJS.ProcessEnv);
    } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(WrapperMissingError);
    const msg = (caught as Error).message;
    // The message and the resolver must read from the same list, or the operator
    // installs the file somewhere nothing will look.
    for (const c of hermesCallCandidates({ CTX_ROOT: ctxRoot, CORTEXTOS_HERMES_CALL: '/nope/hermes-call.sh' } as NodeJS.ProcessEnv)) {
      expect(msg).toContain(c);
    }
  });

  it('treats a present-but-not-executable wrapper as missing', () => {
    const p = join(binDir, 'hermes-call.sh');
    writeFileSync(p, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(p, 0o644);
    expect(() => resolveHermesCall(testEnv())).toThrow(WrapperMissingError);
  });
});

describe('findLedgerRow: the join is by correlation id, NOT by "the last row"', () => {
  it('picks this call\'s row even when a later row was appended by something else', () => {
    appendFileSync(ledgerPath, JSON.stringify({ task_id: 'mine', cost_usd: 1 }) + '\n');
    appendFileSync(ledgerPath, JSON.stringify({ task_id: 'someone-elses', cost_usd: 999 }) + '\n');
    const row = findLedgerRow(ledgerPath, 'mine');
    expect(row?.['cost_usd']).toBe(1);
  });

  it('returns null rather than the nearest row when nothing matches', () => {
    appendFileSync(ledgerPath, JSON.stringify({ task_id: 'other', cost_usd: 5 }) + '\n');
    expect(findLedgerRow(ledgerPath, 'absent')).toBeNull();
  });

  it('survives a torn line and a missing file', () => {
    appendFileSync(ledgerPath, '{"task_id":"broken",\n');
    appendFileSync(ledgerPath, JSON.stringify({ task_id: 'good', cost_usd: 2 }) + '\n');
    expect(findLedgerRow(ledgerPath, 'good')?.['cost_usd']).toBe(2);
    expect(findLedgerRow(join(testDir, 'no-such.jsonl'), 'good')).toBeNull();
  });

  it('does not match a row that merely CONTAINS the id in another field', () => {
    appendFileSync(ledgerPath, JSON.stringify({ task_id: 'other', purpose: 'about corr-1', cost_usd: 7 }) + '\n');
    expect(findLedgerRow(ledgerPath, 'corr-1')).toBeNull();
  });
});

describe('dispatchCron: the happy path', () => {
  it('runs the prompt on the named model, off the seat, and writes a joined receipt', async () => {
    writeSuccessStub();
    const res = await dispatchCron({
      agentName: 'alice',
      cron: makeCron(),
      dueAt: '2026-09-16T03:00:00.000Z',
      env: testEnv(),
      correlationId: 'corr-happy',
    });

    // The prompt reached the model over STDIN, and the cost knobs reached argv.
    expect(res.output).toContain('PROMPT=Summarise the fleet lanes in five lines.');
    expect(res.output).toContain('ARGV_MODEL=deepseek/deepseek-v4.1-flash');
    expect(res.output).toContain(`MAXTOK=${DEFAULT_DISPATCH_MAX_TOKENS}`);
    expect(res.output).toContain('PROJECT=fleet');
    expect(res.output).toContain('PURPOSE=cron:nightly-digest');

    const [receipt] = readReceipts();
    expect(receipt.rc).toBe(0);
    expect(receipt.outcome).toBe('ok');
    expect(receipt.cron).toBe('nightly-digest');
    expect(receipt.due_at).toBe('2026-09-16T03:00:00.000Z');
    expect(receipt.correlation_id).toBe('corr-happy');
    // Observed, not assumed: these come from the ledger row the wrapper wrote.
    expect(receipt.model_served).toBe('deepseek/deepseek-v4.1-flash');
    expect(receipt.tokens_in).toBe(11);
    expect(receipt.tokens_out).toBe(22);
    expect(receipt.cost_usd).toBeCloseTo(0.000123, 9);
    expect(receipt.output_chars).toBeGreaterThan(0);
  });

  it('records model_served SEPARATELY, so a substituted model is visible and not assumed', async () => {
    writeSuccessStub({ modelServed: 'deepseek/deepseek-v4.0-pro' });
    await dispatchCron({ agentName: 'alice', cron: makeCron(), env: testEnv(), correlationId: 'corr-sub' });
    const [receipt] = readReceipts();
    expect(receipt.model).toBe('deepseek/deepseek-v4.1-flash');
    expect(receipt.model_served).toBe('deepseek/deepseek-v4.0-pro');
    expect(receipt.model_served).not.toBe(receipt.model);
  });

  it('honours max_tokens, project and purpose from the cron', async () => {
    writeSuccessStub();
    const res = await dispatchCron({
      agentName: 'alice',
      env: testEnv(),
      correlationId: 'corr-opts',
      cron: makeCron({
        dispatch: { runtime: 'hermes', model: 'deepseek/deepseek-v4.1-flash', max_tokens: 256, project: 'dubia', purpose: 'lane-digest' },
      }),
    });
    expect(res.output).toContain('MAXTOK=256');
    expect(res.output).toContain('PROJECT=dubia');
    expect(res.output).toContain('PURPOSE=lane-digest');
  });

  it('reports tokens_cached as null, never 0 — the ledger has no cache column to read', async () => {
    writeSuccessStub();
    await dispatchCron({ agentName: 'alice', cron: makeCron(), env: testEnv(), correlationId: 'corr-cache' });
    const [receipt] = readReceipts();
    expect(receipt.tokens_cached).toBeNull();
    expect('tokens_cached' in receipt).toBe(true); // present, so nobody infers "no caching"
  });
});

describe('dispatchCron: the child environment is an ALLOWLIST, not an inherit', () => {
  it('passes the wrapper only what it documents, and no seat identity', async () => {
    // The target path is baked into the stub rather than passed as a variable —
    // passing it would require adding it to the allowlist, which is the very thing
    // under test.
    const dumpTarget = join(testDir, 'env-dump.txt');
    writeStub(`
cat > /dev/null
env | sort > "${dumpTarget}"
exit 0
`);
    // rc=0, so this RESOLVES. The observed fields on the receipt are all null
    // because this stub writes no ledger row — which is itself the honest outcome
    // and is asserted below rather than papered over.
    const res = await dispatchCron({
      agentName: 'alice',
      cron: makeCron(),
      correlationId: 'corr-env',
      env: testEnv({
        CTX_AGENT_DIR: '/live/seat/dir',
        CTX_FRAMEWORK_ROOT: '/live/framework',
        ANTHROPIC_API_KEY: 'sk-should-not-travel',
        AWS_SECRET_ACCESS_KEY: 'should-not-travel',
      }),
    });
    expect(res.receipt.rc).toBe(0);
    expect(res.receipt.model_served).toBeNull(); // no row to join => null, never guessed

    const dumped = readFileSync(dumpTarget, 'utf-8');
    expect(dumped).toContain('CTX_AGENT_NAME=alice');   // attribution: deliberately passed
    expect(dumped).toContain('HERMES_LEDGER=');          // both sides must agree on the path
    expect(dumped).not.toContain('CTX_AGENT_DIR=');
    expect(dumped).not.toContain('CTX_FRAMEWORK_ROOT=');
    expect(dumped).not.toContain('ANTHROPIC_API_KEY=');
    expect(dumped).not.toContain('AWS_SECRET_ACCESS_KEY=');
  });

  it('forwards a spend-gate knob when set, and does NOT invent one when unset', async () => {
    const dumpTarget = join(testDir, 'env-gate.txt');
    writeStub(`
cat > /dev/null
env | sort > "${dumpTarget}"
exit 0
`);
    await dispatchCron({
      agentName: 'alice', cron: makeCron(), correlationId: 'corr-gate',
      env: testEnv({ HERMES_FLEET_CAP_USD: '5' }),
    });
    const dumped = readFileSync(dumpTarget, 'utf-8');
    expect(dumped).toContain('HERMES_FLEET_CAP_USD=5');
    // A second default here would be a SECOND spend cap. The wrapper keeps its own.
    expect(dumped).not.toContain('HERMES_FLEET_WARN_USD=');
  });
});

describe('dispatchCron: every failure is loud, receipted, and never falls back to the seat', () => {
  it('throws on a MISSING wrapper and still writes a receipt', async () => {
    await expect(dispatchCron({
      agentName: 'alice', cron: makeCron(), correlationId: 'corr-missing',
      env: { ...testEnv(), CORTEXTOS_HERMES_CALL: join(binDir, 'absent.sh') },
    })).rejects.toThrow(WrapperMissingError);

    const [receipt] = readReceipts();
    expect(receipt.outcome).toBe('wrapper_missing');
    expect(receipt.rc).toBe(-1);
    expect(receipt.stderr_head).toContain('hermes-call.sh');
  });

  it('throws on an UNKNOWN MODEL (wrapper exit 65) and keeps the refusal text', async () => {
    writeStub(`
cat > /dev/null
echo "REFUSED: 'deepseek/made-up' not in prices.json — cost cannot be computed" >&2
exit 65
`);
    await expect(dispatchCron({
      agentName: 'alice', correlationId: 'corr-unknown', env: testEnv(),
      cron: makeCron({ dispatch: { runtime: 'hermes', model: 'deepseek/made-up' } }),
    })).rejects.toThrow(/rc=65 \(refused_unpriced\)/);

    const [receipt] = readReceipts();
    expect(receipt.outcome).toBe('refused_unpriced');
    expect(receipt.rc).toBe(65);
    expect(receipt.stderr_head).toContain('not in prices.json');
    expect(receipt.cost_usd).toBeNull();     // nothing dispatched, so nothing billed
    expect(receipt.model_served).toBeNull(); // and NOT quietly echoed back as the requested id
    expect(receipt.output_chars).toBe(0);
  });

  it('throws on a SPEND REFUSAL (wrapper exit 73) with the gate text intact', async () => {
    writeStub(`
cat > /dev/null
echo "REFUSED BY SPEND GATE: projected \\$20.10 >= cap \\$20" >&2
exit 73
`);
    await expect(dispatchCron({
      agentName: 'alice', cron: makeCron(), correlationId: 'corr-spend', env: testEnv(),
    })).rejects.toThrow(/spend_refused/);
    const [receipt] = readReceipts();
    expect(receipt.outcome).toBe('spend_refused');
    expect(receipt.stderr_head).toContain('SPEND GATE');
  });

  it('surfaces a BILLED-BUT-FAILED call (exit 68) as a failure, not as a quiet success', async () => {
    writeStub(`
cat > /dev/null
echo "CALL FAILED http=524 (logged with outcome=http_524, tokens/cost UNKNOWN)" >&2
exit 68
`);
    await expect(dispatchCron({
      agentName: 'alice', cron: makeCron(), correlationId: 'corr-524', env: testEnv(),
    })).rejects.toThrow(/call_failed/);
    expect(readReceipts()[0].outcome).toBe('call_failed');
  });

  it('surfaces EMPTY OUTPUT (exit 72) — a call that logged perfectly and produced nothing', async () => {
    writeStub(`
cat > /dev/null
echo "FAILED: EMPTY CONTENT WITH 4096 OUTPUT TOKENS BILLED" >&2
exit 72
`);
    await expect(dispatchCron({
      agentName: 'alice', cron: makeCron(), correlationId: 'corr-empty', env: testEnv(),
    })).rejects.toThrow(/empty_output/);
    expect(readReceipts()[0].outcome).toBe('empty_output');
  });

  it('refuses to be called for a cron with no dispatch block — that path belongs to the seat', async () => {
    writeSuccessStub();
    await expect(dispatchCron({
      agentName: 'alice', env: testEnv(),
      cron: makeCron({ dispatch: undefined }),
    })).rejects.toThrow(/no dispatch block/);
  });
});

describe('resolveLedgerPath: both sides of the join agree on one path', () => {
  it('uses HERMES_LEDGER when set', () => {
    expect(resolveLedgerPath({ HERMES_LEDGER: '/tmp/x.jsonl' } as NodeJS.ProcessEnv)).toBe('/tmp/x.jsonl');
  });

  it('otherwise derives the instance/org path the wrapper defaults to', () => {
    expect(resolveLedgerPath({ HOME: '/h', CTX_INSTANCE_ID: 'default', CTX_ORG: 'ygs' } as NodeJS.ProcessEnv))
      .toBe('/h/.cortextos/default/orgs/ygs/analytics/hermes-usage.jsonl');
  });
});
