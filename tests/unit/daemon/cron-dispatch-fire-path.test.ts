import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Same PTY/FastChecker/Telegram mocks as agent-manager.test.ts: AgentManager
// reaches native bindings otherwise. Nothing about the CRON path is mocked.
vi.mock('../../../src/daemon/agent-process.js', () => ({
  AgentProcess: class {
    name: string; dir: string;
    constructor(name: string, dir: string) { this.name = name; this.dir = dir; }
    async start() { /* no-op */ }
    async stop() { /* no-op */ }
    getStatus() { return { name: this.name, status: 'stopped' }; }
    onExit() { /* no-op */ }
  },
}));
vi.mock('../../../src/daemon/fast-checker.js', () => ({
  FastChecker: class { start() { /* no-op */ } stop() { /* no-op */ } wake() { /* no-op */ } },
}));
vi.mock('../../../src/telegram/api.js', () => ({ TelegramAPI: class { constructor() { /* no-op */ } } }));
vi.mock('../../../src/telegram/poller.js', () => ({ TelegramPoller: class { start() { /* no-op */ } stop() { /* no-op */ } } }));

const { AgentManager } = await import('../../../src/daemon/agent-manager.js');

/**
 * ⛔ THIS FILE EXISTS TO PROVE A NEGATIVE: that adding `cron.dispatch` changed
 * NOTHING for the crons that do not use it.
 *
 * A unit test of dispatchCron on its own cannot say that — it never touches the
 * branch. The assertion that matters is about the FIRE PATH: given a cron with no
 * dispatch block, injectAgent is still called with the same string it has always
 * been called with; given one WITH a dispatch block, injectAgent is not called at
 * all, and a failed dispatch does not quietly fall back to it.
 */
describe('cron fire path: the default is unchanged and the dispatch path never touches the seat', () => {
  let testDir: string;
  let ctxRoot: string;
  let frameworkRoot: string;
  let cronDir: string;
  let binDir: string;
  let ledgerPath: string;
  let savedEnv: Record<string, string | undefined>;

  const ENV_KEYS = ['CORTEXTOS_HERMES_CALL', 'HERMES_LEDGER', 'CTX_ROOT'] as const;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cron-fire-path-'));
    ctxRoot = join(testDir, 'instance');
    frameworkRoot = join(testDir, 'framework');
    cronDir = join(ctxRoot, '.cortextOS', 'state', 'agents', 'alice');
    binDir = join(testDir, 'bin');
    ledgerPath = join(testDir, 'hermes-usage.jsonl');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    mkdirSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'), { recursive: true });
    mkdirSync(cronDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });

    savedEnv = {};
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    // The daemon reads process.env at fire time, so these are set for real and
    // restored in afterEach rather than injected — injecting them would test a
    // path the daemon does not take.
    process.env['CTX_ROOT'] = ctxRoot;
    process.env['HERMES_LEDGER'] = ledgerPath;
    process.env['CORTEXTOS_HERMES_CALL'] = join(binDir, 'hermes-call.sh');
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k] as string;
    }
    rmSync(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function writeCronsFile(cron: Record<string, unknown>): void {
    writeFileSync(join(cronDir, 'crons.json'), JSON.stringify({
      updated_at: new Date().toISOString(),
      crons: [{ schedule: '1m', enabled: true, created_at: new Date().toISOString(), ...cron }],
    }));
  }

  function writeWrapper(body: string): void {
    const p = join(binDir, 'hermes-call.sh');
    writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`, 'utf-8');
    chmodSync(p, 0o755);
  }

  function makeManager(): InstanceType<typeof AgentManager> {
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    (am as any).agents.set('alice', { process: { config: {} } as any, checker: {} });
    return am;
  }

  function readReceipts(): Record<string, unknown>[] {
    const p = join(cronDir, 'cron-dispatch-receipts.jsonl');
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf-8').split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l));
  }

  /**
   * ⛔ WHY THIS EXISTS, AND WHY FAKE TIMERS ALONE ARE NOT ENOUGH HERE.
   * Fake timers make the TICK deterministic, but a dispatch spawns a REAL child
   * process, and a real child exits in real milliseconds that fake time does not
   * advance. The first version of these tests asserted immediately after
   * `advanceTimersByTimeAsync` and read an empty receipt file — a test that failed
   * for a reason that had nothing to do with the code under test, and which would
   * equally have PASSED by luck on a faster machine. So: fake timers to trigger
   * the fire, real time to wait for it to land.
   */
  async function waitForReceipts(n: number, timeoutMs = 10_000): Promise<Record<string, unknown>[]> {
    vi.useRealTimers();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = readReceipts();
      if (r.length >= n) return r;
      if (Date.now() >= deadline) return r; // return what there is; the assertion reports it
      await new Promise(res => setTimeout(res, 20));
    }
  }

  it('NO dispatch block: still injects into the seat, with the string it always used', async () => {
    vi.useFakeTimers();
    try {
      writeCronsFile({ name: 'heartbeat', prompt: 'Read HEARTBEAT.md and follow it.' });
      const am = makeManager();
      const injectSpy = vi.spyOn(am, 'injectAgent').mockReturnValue(true);

      expect(am.reloadCrons('alice')).toBe(true);
      await vi.advanceTimersByTimeAsync(90_000);

      expect(injectSpy).toHaveBeenCalledTimes(1);
      const [agent, injected] = injectSpy.mock.calls[0];
      expect(agent).toBe('alice');
      // The exact legacy shape: [CRON FIRED <iso>] <name>: <prompt>
      expect(injected).toMatch(/^\[CRON FIRED \d{4}-\d{2}-\d{2}T[\d:.]+Z\] heartbeat: Read HEARTBEAT\.md and follow it\.$/);
      // and no receipt is written for a cron that never dispatched
      expect(readReceipts()).toHaveLength(0);
      (am as any).cronSchedulers.get('alice').stop();
    } finally { vi.useRealTimers(); }
  });

  it('WITH a dispatch block: the seat is NOT injected and a receipt is written', async () => {
    vi.useFakeTimers();
    try {
      writeWrapper(`
cat > /dev/null
TASK=""
while [ $# -gt 0 ]; do case "$1" in --task) TASK="$2"; shift 2;; *) shift 2;; esac; done
printf '{"task_id":"%s","model_served":"deepseek/deepseek-v4.1-flash","tokens_in":9,"tokens_out":5,"cost_usd":0.0001}\\n' "$TASK" >> "$HERMES_LEDGER"
echo "five lines of digest"
`);
      writeCronsFile({
        name: 'nightly-digest',
        prompt: 'Summarise the lanes.',
        dispatch: { runtime: 'hermes', model: 'deepseek/deepseek-v4.1-flash' },
      });
      const am = makeManager();
      const injectSpy = vi.spyOn(am, 'injectAgent').mockReturnValue(true);

      expect(am.reloadCrons('alice')).toBe(true);
      await vi.advanceTimersByTimeAsync(90_000);
      const receipts = await waitForReceipts(1);

      expect(injectSpy).not.toHaveBeenCalled();
      expect(receipts).toHaveLength(1);
      expect(receipts[0]['cron']).toBe('nightly-digest');
      expect(receipts[0]['outcome']).toBe('ok');
      expect(receipts[0]['model_served']).toBe('deepseek/deepseek-v4.1-flash');
      // due_at threaded from the scheduler — a late fire is distinguishable from an on-time one
      expect(typeof receipts[0]['due_at']).toBe('string');
      (am as any).cronSchedulers.get('alice').stop();
    } finally { vi.useRealTimers(); }
  });

  it('a FAILED dispatch does not fall back to the seat — the whole point of the field', async () => {
    vi.useFakeTimers();
    try {
      writeWrapper(`
cat > /dev/null
echo "REFUSED BY SPEND GATE: projected \\$20.10 >= cap \\$20" >&2
exit 73
`);
      writeCronsFile({
        name: 'nightly-digest',
        prompt: 'Summarise the lanes.',
        dispatch: { runtime: 'hermes', model: 'deepseek/deepseek-v4.1-flash' },
      });
      const am = makeManager();
      const injectSpy = vi.spyOn(am, 'injectAgent').mockReturnValue(true);
      vi.spyOn(console, 'error').mockImplementation(() => { /* quiet, asserted below */ });

      expect(am.reloadCrons('alice')).toBe(true);
      await vi.advanceTimersByTimeAsync(90_000);
      // Only the FIRST attempt is awaited: the receipt is written before the throw,
      // and fireWithRetry's 1s/4s/16s backoff would add 21 real seconds for no
      // extra information. The scheduler is stopped immediately after.
      const receipts = await waitForReceipts(1);
      (am as any).cronSchedulers.get('alice').stop();

      expect(injectSpy).not.toHaveBeenCalled();
      expect(receipts.length).toBeGreaterThanOrEqual(1);
      expect(receipts[0]['outcome']).toBe('spend_refused');
      expect(receipts[0]['rc']).toBe(73);
      expect(String(receipts[0]['stderr_head'])).toContain('SPEND GATE');

      // ⭐ THE ASSERTION THAT MATTERS: whatever else it is called, it is NEVER
      // recorded as a normal fire. "fired" is the word every dashboard and every
      // staleness check reads as "this cron ran".
      const execLog = readFileSync(join(cronDir, 'cron-execution.log'), 'utf-8');
      const statuses = execLog.split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l).status);
      expect(statuses.length).toBeGreaterThanOrEqual(1);
      expect(statuses).not.toContain('fired');
      expect(statuses.every(st => st === 'retried' || st === 'failed')).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('a MISSING wrapper fails the fire loudly instead of quietly using the seat', async () => {
    vi.useFakeTimers();
    try {
      // no wrapper written at all
      writeCronsFile({
        name: 'nightly-digest',
        prompt: 'Summarise the lanes.',
        dispatch: { runtime: 'hermes', model: 'deepseek/deepseek-v4.1-flash' },
      });
      const am = makeManager();
      const injectSpy = vi.spyOn(am, 'injectAgent').mockReturnValue(true);
      vi.spyOn(console, 'error').mockImplementation(() => { /* quiet */ });

      expect(am.reloadCrons('alice')).toBe(true);
      await vi.advanceTimersByTimeAsync(90_000);
      const receipts = await waitForReceipts(1);
      (am as any).cronSchedulers.get('alice').stop();

      expect(injectSpy).not.toHaveBeenCalled();
      expect(receipts[0]['outcome']).toBe('wrapper_missing');
      expect(String(receipts[0]['stderr_head'])).toContain('hermes-call.sh');
    } finally { vi.useRealTimers(); }
  });
});
