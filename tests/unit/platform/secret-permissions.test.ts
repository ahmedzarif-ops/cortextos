import { describe, expect, it, vi } from 'vitest';
import {
  restrictSecretFile,
  secretPermissionInternals,
  writeSecretFileSync,
  type SecretPermissionDependencies,
} from '../../../src/platform/secret-permissions.js';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function deps(overrides: Partial<SecretPermissionDependencies>): SecretPermissionDependencies {
  return {
    platform: 'linux',
    chmod: vi.fn(),
    secureWindowsAcl: vi.fn(() => ({ status: 0 })),
    ...overrides,
  };
}

describe('restrictSecretFile', () => {
  it('uses mode 0600 on Unix without invoking PowerShell', () => {
    const d = deps({ platform: 'darwin' });
    restrictSecretFile('/tmp/agent.env', d);
    expect(d.chmod).toHaveBeenCalledWith('/tmp/agent.env', 0o600);
    expect(d.secureWindowsAcl).not.toHaveBeenCalled();
  });

  it('uses the Windows ACL adapter instead of chmod', () => {
    const d = deps({ platform: 'win32' });
    restrictSecretFile('C:\\Agents\\agent.env', d);
    expect(d.secureWindowsAcl).toHaveBeenCalledWith('C:\\Agents\\agent.env');
    expect(d.chmod).not.toHaveBeenCalled();
  });

  it('fails closed when the Windows ACL cannot be restricted', () => {
    const d = deps({
      platform: 'win32',
      secureWindowsAcl: vi.fn(() => ({ status: 1 })),
    });
    expect(() => restrictSecretFile('C:\\Agents\\agent.env', d))
      .toThrow('Could not restrict Windows permissions for secret file');
  });

  it('replaces inherited rules and grants only current-user and SYSTEM SIDs', () => {
    const script = secretPermissionInternals.WINDOWS_ACL_SCRIPT;
    expect(script).toContain('SetAccessRuleProtection($true, $false)');
    expect(script).toContain('RemoveAccessRuleSpecific');
    expect(script).toContain('WindowsIdentity]::GetCurrent().User');
    expect(script).toContain("SecurityIdentifier('S-1-5-18')");
  });

  it('writes contents only after establishing restricted permissions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ctx-secret-'));
    const path = join(dir, 'agent.env');
    try {
      writeSecretFileSync(path, 'BOT_TOKEN=temporary\n');
      expect(readFileSync(path, 'utf-8')).toBe('BOT_TOKEN=temporary\n');
      if (process.platform !== 'win32') {
        expect(statSync(path).mode & 0o777).toBe(0o600);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
