import { describe, expect, it } from 'vitest';
import { resolveClaudeCommand } from '../../../src/pty/claude-command.js';

describe('resolveClaudeCommand', () => {
  it('selects the packaged native executable behind an npm Windows shim', () => {
    const prefix = 'C:\\ProgramData\\cortextos\\npm-global';
    const expected = `${prefix}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
    expect(resolveClaudeCommand('win32', { PATH: prefix }, path => path === expected)).toEqual({
      file: expected,
      argsPrefix: [],
    });
  });

  it('uses a shell adapter only when no native executable is available', () => {
    expect(resolveClaudeCommand('win32', { PATH: 'C:\\bin', ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, () => false))
      .toEqual({
        file: 'C:\\Windows\\System32\\cmd.exe',
        argsPrefix: ['/d', '/s', '/c', 'claude'],
      });
  });

  it('keeps the direct command on Unix', () => {
    expect(resolveClaudeCommand('linux', {}, () => false)).toEqual({ file: 'claude', argsPrefix: [] });
  });
});
