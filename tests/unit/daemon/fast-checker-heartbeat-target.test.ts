import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile, type ExecFileOptions } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join, resolve } from 'path';
import { FastChecker } from '../../../src/daemon/fast-checker';
import type { BusPaths } from '../../../src/types';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFile: vi.fn() };
});

const { execFile: realExecFile } = await vi.importActual<typeof import('child_process')>('child_process');
const cliSource = resolve(__dirname, '../../../src/cli/index.ts');
const tsxLoader = require.resolve('tsx');
const intendedAgent = 'watchdog-owner';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.mocked(execFile).mockReset();
});

describe('FastChecker watchdog heartbeat target through the real CLI', () => {
  it.each([
    { label: 'overrides a different inherited agent name', inheritedName: 'other-seat', instance: 'watchdog-test', cwdEnv: false },
    { label: 'ignores an inherited cwd env file and its instance fallback', inheritedName: undefined, instance: undefined, cwdEnv: true },
    { label: 'does not fall back to the inherited cwd basename', inheritedName: undefined, instance: 'watchdog-test', cwdEnv: false },
  ])('$label', async ({ inheritedName, instance, cwdEnv }) => {
    const sandbox = mkdtempSync(join(tmpdir(), 'watchdog-heartbeat-target-'));
    const inheritedCwd = join(sandbox, 'cwd-seat');
    const sandboxHome = join(sandbox, 'home');
    const expectedInstance = instance ?? 'default';
    const ctxRoot = join(sandboxHome, '.cortextos', expectedInstance);
    const stateDir = join(ctxRoot, 'state', intendedAgent);
    mkdirSync(inheritedCwd, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    expect(basename(inheritedCwd)).not.toBe(intendedAgent);

    // Remove live fleet context before the watchdog spreads process.env. HOME
    // is isolated only in the child; the Vitest process's home is unchanged.
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('CTX_')) vi.stubEnv(key, undefined);
    }
    vi.stubEnv('CTX_INSTANCE_ID', instance);
    vi.stubEnv('CTX_AGENT_NAME', inheritedName);
    vi.stubEnv('CTX_ROOT', ctxRoot);
    if (cwdEnv) {
      writeFileSync(join(inheritedCwd, '.cortextos-env'),
        'CTX_AGENT_NAME=env-file-seat\nCTX_INSTANCE_ID=wrong-instance\n');
    }

    // Keep actual other-seat bytes, including a same-name seat in a different
    // instance. A cwd regression can misroute the instance even with a correct
    // CTX_AGENT_NAME, so name-only assertions would miss that failure.
    const protectedFiles = new Map<string, string>();
    for (const instanceName of [expectedInstance, 'wrong-instance']) {
      for (const agentName of ['other-seat', 'env-file-seat', 'cwd-seat', intendedAgent]) {
        if (instanceName === expectedInstance && agentName === intendedAgent) continue;
        const file = join(sandboxHome, '.cortextos', instanceName, 'state', agentName, 'heartbeat.json');
        const bytes = JSON.stringify({ agent: agentName, status: `preserve ${instanceName}/${agentName}; discussing [watchdog] in prose`, last_heartbeat: '2020-01-01T00:00:00Z' }) + '\n';
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(file, bytes);
        protectedFiles.set(file, bytes);
      }
    }

    const paths: BusPaths = {
      ctxRoot,
      stateDir,
      inbox: join(ctxRoot, 'inbox', intendedAgent),
      inflight: join(ctxRoot, 'inflight', intendedAgent),
      processed: join(ctxRoot, 'processed', intendedAgent),
      logDir: join(ctxRoot, 'logs', intendedAgent),
      taskDir: join(ctxRoot, 'tasks'),
      approvalDir: join(ctxRoot, 'approvals'),
      analyticsDir: join(ctxRoot, 'analytics'),
    };
    const log = vi.fn();
    const agent = { name: intendedAgent, isBootstrapped: () => true } as any;
    const checker = new FastChecker(agent, paths, sandbox, { log });
    const childRuns: Promise<{ error: Error | null; stdout: string; stderr: string }>[] = [];

    // Intercept executable lookup only: run THIS checkout's real CLI, env
    // resolver, path resolver and heartbeat writer. Missing options inherit
    // the simulated daemon cwd/env exactly as execFile normally would. Never
    // execute an installed cortextos binary or give the child the live home.
    vi.mocked(execFile).mockImplementation(((file: string, args: string[], optionsOrCallback: ExecFileOptions | Function, callback?: Function) => {
      expect(file).toBe('cortextos');
      expect(args.slice(0, 2)).toEqual(['bus', 'update-heartbeat']);
      const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
      const onComplete = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback!;
      const childEnv = { ...(options.env ?? process.env), HOME: sandboxHome, USERPROFILE: sandboxHome };
      let child: ReturnType<typeof realExecFile>;
      childRuns.push(new Promise((done) => {
        child = realExecFile(process.execPath, ['--import', tsxLoader, cliSource, ...args], {
          ...options,
          cwd: options.cwd ?? inheritedCwd,
          env: childEnv,
          encoding: 'utf8',
          timeout: 5000,
        }, (error, stdout, stderr) => {
          onComplete(error, stdout, stderr);
          done({ error, stdout, stderr });
        });
      }));
      return child!;
    }) as typeof execFile);

    // Park unrelated inbox/context polling, but install and fire the actual
    // watchdog interval from start(). Only interval timers are accelerated;
    // the child process still has its real five-second timeout.
    let releasePoll!: () => void;
    const poll = new Promise<void>((done) => { releasePoll = done; });
    vi.spyOn(checker as any, 'pollCycle').mockReturnValue(poll);
    vi.spyOn(checker as any, 'sleepInterruptible').mockResolvedValue(undefined);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const running = checker.start();
    try {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(50 * 60 * 1000);
      expect(childRuns).toHaveLength(1);
      const result = await childRuns[0];
      expect(result.error, result.stderr).toBeNull();
      expect(log.mock.calls.flat().join('\n')).not.toContain('Heartbeat watchdog error:');

      const changedOtherSeats = [...protectedFiles].filter(([file, bytes]) => readFileSync(file, 'utf8') !== bytes)
        .map(([file]) => file.slice(sandboxHome.length));
      expect.soft(changedOtherSeats).toEqual([]);
      const target = join(stateDir, 'heartbeat.json');
      expect(existsSync(target), `Missing intended heartbeat: ${target}`).toBe(true);
      const heartbeat = JSON.parse(readFileSync(target, 'utf8'));
      expect(heartbeat.agent).toBe(intendedAgent);
      expect(heartbeat.status).toMatch(/^\[watchdog\] watchdog-owner alive — idle session \d{4}-/);
      expect(Number.isFinite(Date.parse(heartbeat.last_heartbeat))).toBe(true);
    } finally {
      checker.stop();
      releasePoll();
      await running;
      await Promise.all(childRuns);
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
