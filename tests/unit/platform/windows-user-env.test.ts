import { describe, expect, it, vi } from 'vitest';
import { withWindowsUserProviderEnv } from '../../../src/platform/windows-user-env';

describe('Windows persisted provider environment', () => {
  it('restores a missing user-scoped Claude token for daemon/tool children', () => {
    const read = vi.fn((name: string) => name === 'CLAUDE_CODE_OAUTH_TOKEN' ? 'persisted-oauth' : undefined);

    const result = withWindowsUserProviderEnv({ PATH: 'C:\\Tools' }, 'win32', read);

    expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBe('persisted-oauth');
    expect(result.PATH).toBe('C:\\Tools');
  });

  it('never overwrites an explicit process credential', () => {
    const read = vi.fn(() => 'persisted-oauth');

    const result = withWindowsUserProviderEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'explicit-oauth' }, 'win32', read);

    expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBe('explicit-oauth');
    expect(read).not.toHaveBeenCalledWith('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('does not consult Windows user state on macOS or Linux', () => {
    const read = vi.fn(() => 'should-not-be-read');

    expect(withWindowsUserProviderEnv({ PATH: '/usr/bin' }, 'linux', read))
      .toEqual({ PATH: '/usr/bin' });
    expect(read).not.toHaveBeenCalled();
  });

  it('fails closed without exposing lookup errors', () => {
    const result = withWindowsUserProviderEnv({}, 'win32', () => {
      throw new Error('secret-bearing provider failure');
    });

    expect(result).toEqual({});
  });
});
