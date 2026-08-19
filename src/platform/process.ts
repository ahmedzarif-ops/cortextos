import { execFile } from 'child_process';
import { platform } from 'os';

export interface ProcessTerminationOptions {
  termGraceMs?: number;
  killGraceMs?: number;
  pollIntervalMs?: number;
}

export interface ProcessTerminationDependencies {
  platform: NodeJS.Platform;
  signal: (pid: number, signal: NodeJS.Signals | 0) => void;
  runTaskkill: (pid: number, force: boolean) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export interface ProcessTerminationResult {
  terminated: boolean;
  forced: boolean;
}

const DEFAULT_TERM_GRACE_MS = 2000;
const DEFAULT_KILL_GRACE_MS = 2000;
const DEFAULT_POLL_INTERVAL_MS = 200;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run Windows' native tree-aware process terminator without a shell. npm CLI
 * entrypoints are commonly a cmd.exe + runtime child tree; signalling only the
 * wrapper PID can otherwise leave the real agent alive after daemon recovery.
 */
function runWindowsTaskkill(pid: number, force: boolean): Promise<void> {
  const args = ['/PID', String(pid), '/T'];
  if (force) args.push('/F');

  return new Promise((resolve) => {
    execFile('taskkill.exe', args, { windowsHide: true }, () => resolve());
  });
}

const defaultDependencies: ProcessTerminationDependencies = {
  platform: platform(),
  signal: (pid, signal) => { process.kill(pid, signal); },
  runTaskkill: runWindowsTaskkill,
  sleep: defaultSleep,
  now: Date.now,
};

/**
 * Signal-zero liveness probe. ESRCH means gone; EPERM means the process exists
 * but is owned by another principal. Node implements signal zero as an
 * existence check on Windows even though POSIX signal delivery is unavailable.
 */
export function isProcessAlive(
  pid: number,
  signal: ProcessTerminationDependencies['signal'] = defaultDependencies.signal,
): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    signal(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitForExit(
  pid: number,
  graceMs: number,
  pollIntervalMs: number,
  deps: ProcessTerminationDependencies,
): Promise<boolean> {
  const deadline = deps.now() + graceMs;
  while (deps.now() < deadline) {
    if (!isProcessAlive(pid, deps.signal)) return true;
    await deps.sleep(pollIntervalMs);
  }
  return !isProcessAlive(pid, deps.signal);
}

/**
 * Gracefully terminate a native process, then force it if needed. On Windows
 * both phases use taskkill /T so npm .cmd wrappers, ConPTY hosts, and the real
 * runtime process are handled as one tree. Unix retains the established
 * SIGTERM -> SIGKILL behavior.
 */
export async function terminateProcessTree(
  pid: number,
  options: ProcessTerminationOptions = {},
  dependencies: Partial<ProcessTerminationDependencies> = {},
): Promise<ProcessTerminationResult> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`Refusing to terminate invalid pid: ${pid}`);
  }
  if (pid === process.pid) {
    throw new Error(`Refusing to terminate the current process: ${pid}`);
  }

  const deps: ProcessTerminationDependencies = { ...defaultDependencies, ...dependencies };
  const termGraceMs = Math.max(0, options.termGraceMs ?? DEFAULT_TERM_GRACE_MS);
  const killGraceMs = Math.max(0, options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);

  if (!isProcessAlive(pid, deps.signal)) return { terminated: true, forced: false };

  if (deps.platform === 'win32') {
    await deps.runTaskkill(pid, false);
  } else {
    try {
      deps.signal(pid, 'SIGTERM');
    } catch {
      return { terminated: !isProcessAlive(pid, deps.signal), forced: false };
    }
  }

  if (await waitForExit(pid, termGraceMs, pollIntervalMs, deps)) {
    return { terminated: true, forced: false };
  }

  if (deps.platform === 'win32') {
    await deps.runTaskkill(pid, true);
  } else {
    try {
      deps.signal(pid, 'SIGKILL');
    } catch {
      return { terminated: !isProcessAlive(pid, deps.signal), forced: true };
    }
  }

  return {
    terminated: await waitForExit(pid, killGraceMs, pollIntervalMs, deps),
    forced: true,
  };
}
