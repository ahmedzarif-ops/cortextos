import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { shouldInstallLegacyOptionalDependencies } from '../../../src/cli/install.js';

describe('core install optional dependencies', () => {
  it('defers the historical POSIX helper stack on native Windows only', () => {
    expect(shouldInstallLegacyOptionalDependencies('win32')).toBe(false);
    expect(shouldInstallLegacyOptionalDependencies('darwin')).toBe(true);
    expect(shouldInstallLegacyOptionalDependencies('linux')).toBe(true);
  });

  it('keeps the Windows core path free of the Bash-only model installer', () => {
    const source = readFileSync(join(process.cwd(), 'src/cli/install.ts'), 'utf8');
    const deferred = source.indexOf("if (!shouldInstallLegacyOptionalDependencies(platform()))");
    const optionalElse = source.indexOf('} else {', deferred);
    const modelSpawn = source.indexOf("spawnSync('bash', [modelScript]", optionalElse);

    expect(deferred).toBeGreaterThan(-1);
    expect(optionalElse).toBeGreaterThan(deferred);
    expect(modelSpawn).toBeGreaterThan(optionalElse);
    expect(source.slice(deferred, optionalElse)).not.toContain("spawnSync('bash'");
    expect(source.slice(deferred, optionalElse)).toContain('deferred to guided onboarding');
  });
});
