import { randomBytes } from 'crypto';
import { existsSync } from 'fs';
import { join, win32 } from 'path';
import type { WsTcpEndpoint } from '../utils/ws-unix-client.js';

const SOCKET_BASENAME = 'codex.sock';
const SOCKET_PATH_WARN_BYTES = 100;
const LOOPBACK_HOST = '127.0.0.1';

export interface CodexUnixEndpoint {
  kind: 'unix';
  listenArg: string;
  cwd: string;
  socketPath: string;
  fallbackReason?: string;
}

export interface CodexLoopbackEndpoint {
  kind: 'loopback';
  listenArg: string;
  cwd: string;
  connectTarget: WsTcpEndpoint | null;
}

export type CodexAppServerEndpoint = CodexUnixEndpoint | CodexLoopbackEndpoint;

export interface CodexAppServerCommand {
  file: string;
  argsPrefix: string[];
}

/** Resolve the npm-installed Codex shim without spreading shell logic. */
export function resolveCodexAppServerCommand(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  arch: NodeJS.Architecture = process.arch,
  fileExists: (path: string) => boolean = existsSync,
): CodexAppServerCommand {
  if (platform === 'win32') {
    const nativeBinary = resolveWindowsCodexBinary(env, arch, fileExists);
    if (nativeBinary) return { file: nativeBinary, argsPrefix: [] };
    return {
      file: env.ComSpec || env.COMSPEC || 'cmd.exe',
      argsPrefix: ['/d', '/s', '/c', 'codex'],
    };
  }
  return { file: 'codex', argsPrefix: [] };
}

function resolveWindowsCodexBinary(
  env: NodeJS.ProcessEnv,
  arch: NodeJS.Architecture,
  fileExists: (path: string) => boolean,
): string | null {
  const target = arch === 'arm64'
    ? { packageArch: 'arm64', triple: 'aarch64-pc-windows-msvc' }
    : arch === 'x64'
      ? { packageArch: 'x64', triple: 'x86_64-pc-windows-msvc' }
      : null;
  if (!target) return null;

  const pathValue = env.PATH || env.Path || env.path || '';
  for (const rawEntry of pathValue.split(win32.delimiter)) {
    const prefix = rawEntry.trim().replace(/^"|"$/g, '');
    if (!prefix) continue;
    const packageName = `codex-win32-${target.packageArch}`;
    const relativeBinary = win32.join('vendor', target.triple, 'bin', 'codex.exe');
    const candidates = [
      win32.join(prefix, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', packageName, relativeBinary),
      win32.join(prefix, 'node_modules', '@openai', packageName, relativeBinary),
    ];
    for (const candidate of candidates) {
      if (fileExists(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Select the smallest native Codex app-server transport for the host OS.
 *
 * Unix keeps the established filesystem socket contract. Windows uses Codex's
 * loopback-only WebSocket listener with port 0 so the OS chooses a collision-
 * free port. The selected port is learned from Codex's startup banner.
 */
export function resolveCodexAppServerEndpoint(
  stateDir: string,
  platform: NodeJS.Platform = process.platform,
): CodexAppServerEndpoint {
  if (platform === 'win32') {
    return {
      kind: 'loopback',
      listenArg: `ws://${LOOPBACK_HOST}:0`,
      cwd: stateDir,
      connectTarget: null,
    };
  }

  const defaultPath = join(stateDir, SOCKET_BASENAME);
  if (Buffer.byteLength(defaultPath) < SOCKET_PATH_WARN_BYTES) {
    return {
      kind: 'unix',
      listenArg: `unix://./${SOCKET_BASENAME}`,
      cwd: stateDir,
      socketPath: defaultPath,
    };
  }

  const fallbackBasename = `cas-${randomBytes(4).toString('hex')}.sock`;
  return {
    kind: 'unix',
    listenArg: `unix://./${fallbackBasename}`,
    cwd: '/tmp',
    socketPath: join('/tmp', fallbackBasename),
    fallbackReason: 'state socket path exceeded 100 bytes',
  };
}

/** Parse only the loopback address emitted by `codex app-server`. */
export function parseCodexLoopbackEndpoint(output: string): WsTcpEndpoint | null {
  const match = output.match(/listening on:\s+ws:\/\/127\.0\.0\.1:(\d{1,5})/i);
  if (!match) return null;
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: LOOPBACK_HOST, port };
}
