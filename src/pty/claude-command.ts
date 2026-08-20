import { existsSync } from 'fs';
import { win32 } from 'path';

export interface ClaudeCommand {
  file: string;
  argsPrefix: string[];
}

/**
 * Resolve Claude Code to a native executable when possible.
 *
 * npm's Windows claude.cmd shim can contain a quoted absolute executable path.
 * Launching that shim through ConPTY from a Task Scheduler/S4U environment adds
 * another cmd.exe quoting layer and turns the quotes into part of the filename.
 * The package ships claude.exe, so prefer it directly and retain a narrow cmd
 * fallback for older installations.
 */
export function resolveClaudeCommand(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (path: string) => boolean = existsSync,
  arch: NodeJS.Architecture = process.arch,
): ClaudeCommand {
  if (platform !== 'win32') return { file: 'claude', argsPrefix: [] };

  const pathValue = env.PATH || env.Path || env.path || '';
  for (const rawEntry of pathValue.split(win32.delimiter)) {
    const prefix = rawEntry.trim().replace(/^"|"$/g, '');
    if (!prefix) continue;
    const candidates = [
      win32.join(prefix, 'claude.exe'),
      win32.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
      // Current Claude Code packages keep the native binary in an
      // architecture-specific optional dependency. npm may still generate a
      // claude.ps1/.cmd shim pointing at the legacy bin/claude.exe path even
      // when that file is absent, so resolve the shipped executable directly.
      win32.join(
        prefix,
        'node_modules',
        '@anthropic-ai',
        'claude-code',
        'node_modules',
        '@anthropic-ai',
        `claude-code-win32-${arch === 'arm64' ? 'arm64' : 'x64'}`,
        'claude.exe',
      ),
    ];
    for (const candidate of candidates) {
      if (fileExists(candidate)) return { file: candidate, argsPrefix: [] };
    }
  }

  return {
    file: env.ComSpec || env.COMSPEC || 'cmd.exe',
    argsPrefix: ['/d', '/s', '/c', 'claude'],
  };
}
