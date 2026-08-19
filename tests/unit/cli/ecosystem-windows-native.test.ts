import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ecosystemCommand, pm2ProcessName } from '../../../src/cli/ecosystem';

describe('cross-platform PM2 ecosystem generation', () => {
  const originalRoot = process.env.CTX_FRAMEWORK_ROOT;
  let tempRoot: string | undefined;

  afterEach(() => {
    if (originalRoot === undefined) delete process.env.CTX_FRAMEWORK_ROOT;
    else process.env.CTX_FRAMEWORK_ROOT = originalRoot;
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('keeps default names compatible and scopes disposable instance names', () => {
    expect(pm2ProcessName('cortextos-daemon', 'default')).toBe('cortextos-daemon');
    expect(pm2ProcessName('cortextos-daemon', 'windows-smoke')).toBe('cortextos-daemon-windows-smoke');
    expect(pm2ProcessName('cortextos-daemon', 'test instance/1')).toBe('cortextos-daemon-test-instance-1');
  });

  it('uses native Node entry points and instance-scoped PM2 names', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'cortextos-ecosystem-'));
    mkdirSync(join(tempRoot, 'orgs', 'testorg', 'agents', 'worker'), { recursive: true });
    const nextBin = join(tempRoot, 'dashboard', 'node_modules', 'next', 'dist', 'bin', 'next');
    mkdirSync(join(nextBin, '..'), { recursive: true });
    writeFileSync(join(tempRoot, 'dashboard', 'package.json'), '{}');
    writeFileSync(nextBin, '#!/usr/bin/env node\n');
    process.env.CTX_FRAMEWORK_ROOT = tempRoot;
    const output = join(tempRoot, 'ecosystem.smoke.config.js');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await ecosystemCommand.parseAsync([
      'node', 'cortextos', '--instance', 'windows-smoke', '--org', 'testorg', '--output', output,
      '--dashboard-host', '127.0.0.1',
    ]);

    const generated = readFileSync(output, 'utf8');
    expect(generated).toContain("name: \"cortextos-daemon-windows-smoke\"");
    expect(generated).toContain("name: \"cortextos-dashboard-windows-smoke\"");
    expect(generated).toContain(`script: ${JSON.stringify(nextBin)}`);
    expect(generated).toContain('args: ["dev","--hostname","127.0.0.1"]');
    expect(generated).toContain('interpreter: process.execPath');
    expect(generated).not.toContain("script: \"npm\"");
    expect(generated.match(/windowsHide: true/g)).toHaveLength(2);
  });
});
