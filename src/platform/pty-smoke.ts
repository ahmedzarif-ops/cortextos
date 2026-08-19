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
  // Keep the Windows shell alive after emitting the token. Closing a ConPTY
  // only after `cmd /c` has already exited makes node-pty's cleanup helper try
  // to attach to a vanished console, producing a spurious AttachConsole error.
  const args = isWindows ? ['/q', '/k', 'echo', 'pty-ok'] : ['pty-ok'];
  const pty = ptyModule.spawn(command, args, {
    name: 'xterm-256color', cols: 80, rows: 24,
  });

  await new Promise<void>((resolve, reject) => {
    let output = '';
    let settled = false;
    let closeRequested = false;
    let dataSubscription: Disposable | undefined;
    let exitSubscription: Disposable | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { dataSubscription?.dispose(); } catch { /* best-effort */ }
      try { exitSubscription?.dispose(); } catch { /* best-effort */ }
      // Best-effort fallback for setup failures before the success token. The
      // normal Windows path closes the still-live shell from onData below.
      if (isWindows && !closeRequested) {
        closeRequested = true;
        try { pty.kill(); } catch { /* child/session may already be closed */ }
      }
      if (error) reject(error);
      else resolve();
    };

    dataSubscription = pty.onData((data) => {
      output += data;
      if (isWindows && output.includes('pty-ok') && !closeRequested) {
        closeRequested = true;
        try { pty.kill(); } catch (err) {
          finish(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
    exitSubscription = pty.onExit(({ exitCode }) => {
      finish((isWindows || exitCode === 0) && output.includes('pty-ok')
        ? undefined
        : new Error(`spawn test failed (exit ${exitCode})`));
    });
    timer = setTimeout(() => {
      finish(new Error('spawn test timed out'));
    }, timeoutMs);
  });
}
