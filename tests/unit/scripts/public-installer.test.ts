import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { pathToFileURL } from 'url';

// Windows checkouts can materialize the executable with CRLF. Import a
// normalized test-only copy without its shebang so neither Vite nor Node has to
// parse an executable-file preamble; the real-file execution test below still
// exercises install.mjs directly.
const installerImportDir = mkdtempSync(join(tmpdir(), 'ctx-installer-import-'));
const installerImportPath = join(installerImportDir, 'install.mjs');
const installerSource = readFileSync(join(process.cwd(), 'install.mjs'), 'utf8')
  .replace(/^#![^\n]*(?:\n|$)/, '')
  .replace(/\r\n?/g, '\n');
writeFileSync(installerImportPath, installerSource, 'utf8');
const installerUrl = pathToFileURL(installerImportPath).href;
const installer = await import(/* @vite-ignore */ installerUrl);

afterAll(() => rmSync(installerImportDir, { recursive: true, force: true }));

type Call = { kind: 'capture' | 'visible' | 'logged'; command: string; args: string[]; cwd?: string };

function fakeRunner(options: {
  fail?: (call: Call) => boolean;
  commands?: Record<string, boolean>;
  upstream?: boolean;
  localBranch?: boolean;
} = {}) {
  const calls: Call[] = [];
  const available: Record<string, boolean> = {
    npm: true, git: true, claude: true, codex: false, opencode: false,
    cortextos: true, pm2: true, ...options.commands,
  };
  const invoke = (kind: Call['kind'], command: string, args: string[] = [], opts: { cwd?: string } = {}) => {
    const call = { kind, command, args, cwd: opts.cwd };
    calls.push(call);
    if (options.fail?.(call)) throw new installer.InstallerCommandError(`${command} ${args.join(' ')}`, 1, 'sanitized failure');
    const key = `${command} ${args.join(' ')}`;
    if (key === 'npm --version') return '10.9.0';
    if (key === 'git --version') return 'git version 2.50.0';
    if (key === 'claude --version') return '2.1.0';
    if (key === 'claude auth status') return '{"loggedIn":true}';
    if (key === 'pm2 --version') return '6.0.0';
    if (key === 'git remote get-url upstream') {
      if (options.upstream === false) throw new installer.InstallerCommandError(key, 2);
      return 'https://github.com/grandamenium/cortextos.git';
    }
    if (key === 'git remote get-url origin') return 'https://github.com/grandamenium/cortextos.git';
    if (key.startsWith('git show-ref') && options.localBranch === false) {
      throw new installer.InstallerCommandError(key, 1);
    }
    return '';
  };
  return {
    calls,
    exists: (command: string) => available[command] ?? true,
    capture: (command: string, args?: string[], opts?: { cwd?: string }) => invoke('capture', command, args, opts),
    visible: (command: string, args?: string[], opts?: { cwd?: string }) => invoke('visible', command, args, opts),
    logged: (command: string, args?: string[], opts?: { cwd?: string }) => invoke('logged', command, args, opts),
  };
}

describe('public cross-platform installer', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('documents a PowerShell 5.1 file bootstrap instead of putting source in argv', () => {
    const source = readFileSync(join(process.cwd(), 'install.mjs'), 'utf8');
    const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8');
    expect(source).toContain("Invoke-WebRequest -UseBasicParsing");
    expect(source).toContain('-OutFile $p; node $p;');
    expect(source).toContain('if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }');
    expect(source).not.toContain('node -e "$(irm');
    expect(readme).toContain("Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/grandamenium/cortextos/main/install.mjs' -OutFile $p");
    expect(readme).toContain('node --input-type=module');
    expect(readme).not.toContain('node -e "$(irm');
  });

  it('rejects unsafe branch refs and preserves valid selected branches', () => {
    expect(installer.validateBranch('codex/windows-dogfood-2')).toBe('codex/windows-dogfood-2');
    for (const branch of ['-option', 'feature/../main', 'feature//x', 'x@{y', 'x.lock', 'x/']) {
      expect(() => installer.validateBranch(branch)).toThrow();
    }
  });

  it('returns a failing process status without printing false success', () => {
    const result = spawnSync(process.execPath, ['install.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, CORTEXTOS_BRANCH: '-unsafe-option' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('cortextOS installation failed.');
    expect(result.stderr).toContain('stopped without reporting success');
    expect(`${result.stdout}\n${result.stderr}`).not.toContain('installed successfully');
  });

  it('quotes Windows shims and paths with spaces without shell interpolation', () => {
    const action = installer.buildWindowsShimAction(
      'C:\\Program Files\\nodejs\\npm.cmd',
      ['install', '--prefix', 'C:\\Users\\Test User\\cortext 100%'],
    );
    expect(action).toContain("$executable = 'C:\\Program Files\\nodejs\\npm.cmd'");
    expect(action).toContain("$arguments = @('install', '--prefix', 'C:\\Users\\Test User\\cortext 100%')");
    expect(action).toContain('& $executable @arguments');
    expect(installer.quotePowerShellLiteral("C:\\Users\\O'Brien\\cortext os"))
      .toBe("'C:\\Users\\O''Brien\\cortext os'");
  });

  it('offers compiler prerequisites only when dependency output proves native compilation', () => {
    expect(installer.dependencyFailureGuidance('npm ERR! network timeout', 'win32')).toEqual([]);
    expect(installer.dependencyFailureGuidance('node-gyp ERR! find VS could not find cl.exe', 'win32'))
      .toEqual(expect.arrayContaining([
        expect.stringContaining('Visual Studio Build Tools'),
        'https://visualstudio.microsoft.com/visual-cpp-build-tools/',
      ]));
    expect(installer.dependencyFailureGuidance('gyp ERR! find Python could not find any Python', 'win32'))
      .toEqual(expect.arrayContaining([expect.stringContaining('Install Python 3')]));
  });

  it('uses the selected branch for fresh clone and remote configuration', () => {
    const runner = fakeRunner();
    installer.cloneCheckout({
      runner,
      installDir: 'C:\\Users\\Test User\\cortextos',
      repoUrl: 'https://example.test/cortextos.git',
      branch: 'codex/dogfood-2',
    });
    expect(runner.calls[0]).toMatchObject({
      command: 'git',
      args: ['clone', '--branch', 'codex/dogfood-2', '--single-branch', 'https://example.test/cortextos.git', 'C:\\Users\\Test User\\cortextos'],
    });
    expect(runner.calls[1]).toMatchObject({ command: 'git', args: ['remote', 'rename', 'origin', 'upstream'] });
  });

  it('checks out and pulls only the selected branch on repeat/update', () => {
    const runner = fakeRunner({ upstream: true, localBranch: false });
    installer.updateCheckout({
      runner,
      installDir: '/tmp/cortext os',
      repoUrl: 'https://github.com/grandamenium/cortextos.git',
      branch: 'codex/dogfood-2',
    });
    const gitArgs = runner.calls.filter((call) => call.command === 'git').map((call) => call.args.join(' '));
    expect(gitArgs).toContain('fetch upstream refs/heads/codex/dogfood-2:refs/remotes/upstream/codex/dogfood-2');
    expect(gitArgs).toContain('checkout -b codex/dogfood-2 --track upstream/codex/dogfood-2');
    expect(gitArgs).toContain('pull --ff-only upstream codex/dogfood-2');
    expect(gitArgs.every((args) => !/(?:^|\s)main(?:\s|$)/.test(args))).toBe(true);
  });

  it('refuses to update an existing checkout from an unexpected upstream', () => {
    const runner = fakeRunner();
    runner.capture = vi.fn((command: string, args: string[] = [], opts: { cwd?: string } = {}) => {
      if (`${command} ${args.join(' ')}` === 'git remote get-url upstream') {
        return 'https://example.test/untrusted/repository.git';
      }
      return '';
    });

    expect(() => installer.updateCheckout({
      runner,
      installDir: '/tmp/cortextos',
      repoUrl: 'https://github.com/grandamenium/cortextos.git',
      branch: 'main',
    })).toThrow(/upstream does not match/);
    expect(runner.calls.some((call) => call.command === 'git' && call.args[0] === 'fetch')).toBe(false);
  });

  it('propagates update failure before downstream installation can run', () => {
    const runner = fakeRunner({
      fail: (call) => call.command === 'git' && call.args[0] === 'pull',
    });
    expect(() => installer.updateCheckout({
      runner,
      installDir: '/tmp/cortextos',
      repoUrl: 'https://github.com/grandamenium/cortextos.git',
      branch: 'main',
    })).toThrow(/git pull/);
    expect(runner.calls.some((call) => call.command === 'npm')).toBe(false);
  });

  it('completes the native Windows path without WSL, Bash, jq, Python, or build-tool probes', () => {
    const root = mkdtempSync(join(tmpdir(), 'installer space path-'));
    tempRoots.push(root);
    const installDir = join(root, 'cortext os');
    const runner = fakeRunner();
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));

    installer.install({
      platform: 'win32',
      env: { CORTEXTOS_DIR: installDir, CORTEXTOS_BRANCH: 'codex/dogfood-2' },
      runner,
    });

    const names = runner.calls.map((call) => call.command);
    expect(names).not.toContain('wsl');
    expect(names).not.toContain('bash');
    expect(names).not.toContain('jq');
    expect(names).not.toContain('python');
    expect(names).not.toContain('cl.exe');
    expect(logs.join('\n')).toContain('cortextOS installed successfully!');
    expect(logs.join('\n')).toContain(installer.quotePowerShellLiteral(installDir));
  });

  it.each(['darwin', 'linux'])('preserves the successful %s install pipeline', (platform) => {
    const root = mkdtempSync(join(tmpdir(), `installer-${platform}-`));
    tempRoots.push(root);
    const installDir = join(root, 'cortext os');
    const runner = fakeRunner();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    installer.install({
      platform,
      env: { CORTEXTOS_DIR: installDir, CORTEXTOS_BRANCH: 'main' },
      runner,
    });

    expect(runner.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'git', args: expect.arrayContaining(['clone', '--branch', 'main']) }),
      expect.objectContaining({ command: 'npm', args: ['install'] }),
      expect.objectContaining({ command: 'npm', args: ['run', 'build'] }),
      expect.objectContaining({ command: 'npm', args: ['link'] }),
    ]));
  });

  it.each([
    ['clone', (call: Call) => call.command === 'git' && call.args[0] === 'clone'],
    ['dependency install', (call: Call) => call.command === 'npm' && call.kind === 'logged' && call.args.join(' ') === 'install'],
    ['build', (call: Call) => call.command === 'npm' && call.args.join(' ') === 'run build'],
    ['global link and fallback', (call: Call) => call.command === 'npm' && (call.args.join(' ') === 'link' || call.args.join(' ') === 'install -g .')],
    ['core install', (call: Call) => call.args.at(-1) === 'install' && call.args.some((arg) => arg.endsWith('dist/cli.js'))],
  ])('fails closed without a success message when %s fails', (_label, shouldFail) => {
    const root = mkdtempSync(join(tmpdir(), 'installer-failure-'));
    tempRoots.push(root);
    const installDir = join(root, 'new install');
    const runner = fakeRunner({ fail: shouldFail });
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => installer.install({
      platform: 'win32',
      env: { CORTEXTOS_DIR: installDir, CORTEXTOS_BRANCH: 'main' },
      runner,
    })).toThrow();
    expect(logs.join('\n')).not.toContain('cortextOS installed successfully!');
  });

  it('fails a repeat run on pull failure and never begins npm install', () => {
    const root = mkdtempSync(join(tmpdir(), 'installer-repeat-'));
    tempRoots.push(root);
    mkdirSync(join(root, '.git'));
    const runner = fakeRunner({ fail: (call) => call.command === 'git' && call.args[0] === 'pull' });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(() => installer.install({
      platform: 'linux',
      env: { CORTEXTOS_DIR: root, CORTEXTOS_BRANCH: 'release/windows' },
      runner,
    })).toThrow(/git pull/);
    expect(runner.calls.some((call) => call.command === 'npm' && call.args[0] === 'install')).toBe(false);
  });
});
