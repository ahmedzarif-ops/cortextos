import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { globalInstallArgs, shouldInstallLegacyOptionalDependencies } from '../../../src/cli/install.js';

describe('core install optional dependencies', () => {
  it('defers the historical POSIX helper stack on native Windows only', () => {
    expect(shouldInstallLegacyOptionalDependencies('win32')).toBe(false);
    expect(shouldInstallLegacyOptionalDependencies('darwin')).toBe(true);
    expect(shouldInstallLegacyOptionalDependencies('linux')).toBe(true);
  });

  it('allows only the Claude postinstall needed to materialize its Windows executable', () => {
    expect(globalInstallArgs('@anthropic-ai/claude-code', 'win32')).toEqual([
      'install', '-g', '--allow-scripts=@anthropic-ai/claude-code', '@anthropic-ai/claude-code',
    ]);
    expect(globalInstallArgs('pm2', 'win32')).toEqual(['install', '-g', 'pm2']);
    expect(globalInstallArgs('@anthropic-ai/claude-code', 'darwin')).toEqual([
      'install', '-g', '@anthropic-ai/claude-code',
    ]);
    expect(globalInstallArgs('unsafe;package', 'win32')).toEqual([]);
  });

  it('allows only the native dependency build scripts required by this repository', () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    expect(manifest.allowScripts).toEqual({ esbuild: true, 'node-pty': true });
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
