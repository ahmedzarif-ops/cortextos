import { spawn } from 'node:child_process';

export interface HeadlessProcess {
  pid: number;
  write(data: string): void;
  onData(callback: (data: string) => void): { dispose(): void };
  onExit(callback: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  kill(signal?: string): void;
}

export interface HeadlessProcessOptions {
  cwd?: string;
  env?: Record<string, string>;
}

/**
 * Launch a protocol server without allocating a terminal. Codex app-server is
 * controlled over WebSocket and never reads terminal input, so ConPTY only
 * adds a failure surface on Windows (including AttachConsole failures under
 * SSH/service sessions).
 */
export function spawnHeadlessProcess(
  file: string,
  args: string[],
  options: HeadlessProcessOptions,
): HeadlessProcess {
  const child = spawn(file, args, {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return {
    pid: child.pid ?? 0,
    write(data: string): void {
      if (child.stdin.writable) child.stdin.write(data);
    },
    onData(callback: (data: string) => void): { dispose(): void } {
      const listener = (chunk: Buffer | string) => callback(chunk.toString());
      child.stdout.on('data', listener);
      child.stderr.on('data', listener);
      return {
        dispose(): void {
          child.stdout.off('data', listener);
          child.stderr.off('data', listener);
        },
      };
    },
    onExit(callback: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
      let delivered = false;
      const deliver = (exitCode: number) => {
        if (delivered) return;
        delivered = true;
        callback({ exitCode });
      };
      const exitListener = (code: number | null) => deliver(code ?? 1);
      const errorListener = () => deliver(1);
      child.once('exit', exitListener);
      child.once('error', errorListener);
      return {
        dispose(): void {
          child.off('exit', exitListener);
          child.off('error', errorListener);
        },
      };
    },
    kill(signal?: string): void {
      child.kill(signal as NodeJS.Signals | undefined);
    },
  };
}
