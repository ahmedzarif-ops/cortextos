import { platform } from 'os';

interface Disposable {
  dispose(): void;
}

interface SmokePty {
  kill(): void;
  onData(callback: (data: string) => void): Disposable;
  onExit(callback: (event: { exitCode: number }) => void): Disposable;
}

interface PtyModule {
  spawn(file: string, args: string[], options: Record<string, unknown>): SmokePty;
}

/** Spawn one native PTY command and release every ConPTY/event resource. */
export async function verifyPtySpawn(
  ptyModule: PtyModule,
  platformName: NodeJS.Platform = platform(),
  timeoutMs = 5_000,
): Promise<void> {
  const isWindows = platformName === 'win32';
  const command = isWindows ? 'cmd.exe' : '/bin/echo';
  const args = isWindows ? ['/c', 'echo', 'pty-ok'] : ['pty-ok'];
  const pty = ptyModule.spawn(command, args, {
    name: 'xterm-256color', cols: 80, rows: 24,
  });

  await new Promise<void>((resolve, reject) => {
    let output = '';
    let settled = false;
    let dataSubscription: Disposable | undefined;
    let exitSubscription: Disposable | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { dataSubscription?.dispose(); } catch { /* best-effort */ }
      try { exitSubscription?.dispose(); } catch { /* best-effort */ }
      if (error) reject(error);
      else resolve();
    };

    dataSubscription = pty.onData((data) => { output += data; });
    exitSubscription = pty.onExit(({ exitCode }) => {
      finish(exitCode === 0 && output.includes('pty-ok')
        ? undefined
        : new Error(`spawn test failed (exit ${exitCode})`));
    });
    timer = setTimeout(() => {
      try { pty.kill(); } catch { /* already exited */ }
      finish(new Error('spawn test timed out'));
    }, timeoutMs);
  });
}
