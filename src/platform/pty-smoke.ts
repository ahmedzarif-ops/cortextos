import { spawn } from 'child_process';

export interface SmokeChildProcess {
  kill(): boolean;
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'exit', listener: (code: number | null) => void): this;
}

export type SmokeProcessSpawner = (
  command: string,
  args: readonly string[],
  options: Record<string, unknown>,
) => SmokeChildProcess;

// Keep node-pty in a process boundary. On Windows its ConPTY output worker can
// retain a MessagePort after a normally exited shell, keeping doctor/install
// alive. Calling the public kill() method after exit has a separate race that
// can print a false `AttachConsole failed` error. A one-shot child proves the
// same native spawn contract and then exits with all native handles contained.
const SMOKE_SCRIPT = String.raw`
try {
  const pty = require('node-pty');
  const windows = process.platform === 'win32';
  const terminal = pty.spawn(windows ? 'cmd.exe' : '/bin/echo', windows ? ['/c', 'echo', 'pty-ok'] : ['pty-ok'], {
    name: 'xterm-256color', cols: 80, rows: 24
  });
  let output = '';
  terminal.onData((data) => { output += data; });
  terminal.onExit(({ exitCode }) => {
    process.exit(exitCode === 0 && output.includes('pty-ok') ? 0 : 1);
  });
  setTimeout(() => process.exit(1), 4000);
} catch {
  process.exit(1);
}
`;

/** Verify that node-pty can load, spawn, exchange output, and exit cleanly. */
export function verifyPtySpawn(
  timeoutMs = 5_000,
  spawnProcess: SmokeProcessSpawner = spawn as unknown as SmokeProcessSpawner,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };

    let child: SmokeChildProcess;
    try {
      child = spawnProcess(process.execPath, ['-e', SMOKE_SCRIPT], {
        stdio: 'ignore',
        windowsHide: true,
        cwd: process.cwd(),
      });
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    child.once('error', (err) => finish(err));
    child.once('exit', (code) => {
      if (timedOut) {
        finish(new Error('spawn test timed out'));
      } else if (code === 0) {
        finish();
      } else {
        finish(new Error(`spawn test failed (exit ${code ?? 'unknown'})`));
      }
    });
    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* process may already be exiting */ }
    }, timeoutMs);
  });
}
