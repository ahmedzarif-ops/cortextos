#!/usr/bin/env node
/**
 * cortextOS cross-platform installer
 *
 * macOS/Linux:
 *   curl -fsSL https://raw.githubusercontent.com/grandamenium/cortextos/main/install.mjs | node --input-type=module
 *
 * Windows PowerShell 5.1+ (download to a file; do not put the program in argv):
 *   $p=Join-Path ([IO.Path]::GetTempPath()) ('cortextos-install-'+[guid]::NewGuid()+'.mjs'); try { Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/grandamenium/cortextos/main/install.mjs' -OutFile $p; node $p; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } } finally { Remove-Item $p -Force -ErrorAction SilentlyContinue }
 *
 * Local test: node install.mjs
 */

import { spawnSync } from 'child_process';
import { existsSync, readdirSync, statSync, chmodSync } from 'fs';
import { join, resolve, win32 } from 'path';
import { homedir, platform } from 'os';
import { pathToFileURL } from 'url';

const R = '\x1b[0m';
const B = '\x1b[34m';
const G = '\x1b[32m';
const Y = '\x1b[33m';
const RED = '\x1b[31m';
const BOLD = '\x1b[1m';

const log = (msg) => console.log(`${B}==>${R} ${msg}`);
const ok = (msg) => console.log(`${G}  ✓${R} ${msg}`);
const warn = (msg) => console.log(`${Y}  !${R} ${msg}`);

export class InstallerCommandError extends Error {
  constructor(command, status, output = '') {
    super(`${command} failed${status === null ? '' : ` with exit code ${status}`}`);
    this.name = 'InstallerCommandError';
    this.command = command;
    this.status = status;
    this.output = output;
  }
}

export function validateBranch(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ||
      value.includes('..') || value.includes('//') || value.includes('@{') ||
      value.endsWith('/') || value.endsWith('.') || value.endsWith('.lock')) {
    throw new Error('CORTEXTOS_BRANCH must be a safe Git branch name containing only letters, digits, dot, underscore, slash, or dash.');
  }
  return value;
}

export function quotePowerShellLiteral(value) {
  const text = String(value);
  if (text.includes('\0')) throw new Error('PowerShell command arguments may not contain NUL.');
  return `'${text.replaceAll("'", "''")}'`;
}

/**
 * npm 11.16+ blocks unapproved lifecycle scripts. Claude Code's Windows
 * package materializes its native executable in postinstall, so a successful
 * global install is not usable unless that one package is explicitly trusted.
 */
export function globalInstallArgs(pkg, os) {
  const args = ['install', '-g'];
  if (os === 'win32' && pkg === '@anthropic-ai/claude-code') {
    args.push(`--allow-scripts=${pkg}`);
  }
  args.push(pkg);
  return args;
}

export function formatClaudeHandoff(
  installDir,
  os,
  env = process.env,
  architecture = process.arch,
  fileExists = existsSync,
) {
  if (os !== 'win32') return `claude ${JSON.stringify(installDir)}`;
  const native = resolveClaudeNativeFromPath(
    env.PATH || env.Path || env.path,
    architecture,
    fileExists,
  );
  if (native) {
    return `& ${quotePowerShellLiteral(native)} ${quotePowerShellLiteral(installDir)}`;
  }
  return `claude ${quotePowerShellLiteral(installDir)}`;
}

/** Build the source encoded for Windows PowerShell when invoking npm .cmd shims. */
export function buildWindowsShimAction(executable, args) {
  const literals = args.map(quotePowerShellLiteral).join(', ');
  return [
    "$ErrorActionPreference = 'Stop'",
    `$executable = ${quotePowerShellLiteral(executable)}`,
    `$arguments = @(${literals})`,
    '& $executable @arguments',
    'exit $LASTEXITCODE',
  ].join('\r\n');
}

export function resolveClaudeNativeFromPath(
  pathValue,
  architecture = process.arch,
  fileExists = existsSync,
) {
  for (const rawEntry of String(pathValue || '').split(win32.delimiter)) {
    const prefix = rawEntry.trim().replace(/^"|"$/g, '');
    if (!prefix) continue;
    const candidates = [
      win32.join(prefix, 'claude.exe'),
      win32.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
      win32.join(
        prefix,
        'node_modules',
        '@anthropic-ai',
        'claude-code',
        'node_modules',
        '@anthropic-ai',
        `claude-code-win32-${architecture === 'arm64' ? 'arm64' : 'x64'}`,
        'claude.exe',
      ),
    ];
    for (const candidate of candidates) {
      if (fileExists(candidate)) return candidate;
    }
  }
  return null;
}

function resolveOnPath(command, isWindows, env = process.env) {
  if (command.includes('/') || command.includes('\\')) return command;
  if (isWindows && command.toLowerCase() === 'claude') {
    const native = resolveClaudeNativeFromPath(env.PATH || env.Path || env.path, process.arch);
    if (native) return native;
  }
  const locator = isWindows ? 'where.exe' : 'which';
  const result = spawnSync(locator, [command], {
    encoding: 'utf8',
    stdio: 'pipe',
    env,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return null;
  const candidates = String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!isWindows) return candidates[0] || null;
  return candidates.find((candidate) => /\.(?:exe|com|cmd|bat)$/i.test(candidate)) || candidates[0] || null;
}

/**
 * Spawn without a string shell on POSIX. On Windows, only .cmd/.bat shims go
 * through a UTF-16LE EncodedCommand with a literal argument array. This is
 * supported by Windows PowerShell 5.1 and avoids cmd.exe quoting/expansion.
 */
export function createProcessRunner({ isWindows = platform() === 'win32', env = process.env } = {}) {
  function invoke(command, args = [], opts = {}, visible = false) {
    const executable = resolveOnPath(command, isWindows, opts.env || env);
    if (!executable) throw new InstallerCommandError(command, null);

    let file = executable;
    let finalArgs = [...args];
    if (isWindows && /\.(?:cmd|bat)$/i.test(executable)) {
      file = resolveOnPath('powershell.exe', true, opts.env || env) || 'powershell.exe';
      const encoded = Buffer.from(buildWindowsShimAction(executable, args), 'utf16le').toString('base64');
      finalArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];
    }

    const inherit = visible === true;
    const result = spawnSync(file, finalArgs, {
      cwd: opts.cwd,
      env: opts.env || env,
      encoding: inherit ? undefined : 'utf8',
      stdio: inherit ? 'inherit' : 'pipe',
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    if (visible === 'logged') {
      if (result.stdout) process.stdout.write(String(result.stdout));
      if (result.stderr) process.stderr.write(String(result.stderr));
    }
    if (result.error || result.status !== 0) {
      const output = inherit ? '' : `${result.stdout || ''}\n${result.stderr || ''}`;
      // Include only a simple operation token. Repository URLs, install paths,
      // and other user-provided arguments must not be echoed from exceptions.
      const operation = typeof args[0] === 'string' && /^[A-Za-z0-9._-]+$/.test(args[0]) ? ` ${args[0]}` : '';
      throw new InstallerCommandError(`${command}${operation}`, result.status, output);
    }
    return inherit ? '' : String(result.stdout || '').trim();
  }

  return {
    capture: (command, args = [], opts = {}) => invoke(command, args, opts, false),
    visible: (command, args = [], opts = {}) => invoke(command, args, opts, true),
    logged: (command, args = [], opts = {}) => invoke(command, args, opts, 'logged'),
    exists: (command) => resolveOnPath(command, isWindows, env) !== null,
  };
}

function remoteExists(runner, installDir, name) {
  try {
    runner.capture('git', ['remote', 'get-url', name], { cwd: installDir });
    return true;
  } catch {
    return false;
  }
}

function remoteIdentity(value) {
  return String(value).trim()
    .replace(/^git@([^:]+):/i, '$1/')
    .replace(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?/i, '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .toLowerCase();
}

/** Update the explicitly selected branch or throw before any build occurs. */
export function updateCheckout({ runner, installDir, repoUrl, branch }) {
  let remote;
  if (remoteExists(runner, installDir, 'upstream')) {
    const upstreamUrl = runner.capture('git', ['remote', 'get-url', 'upstream'], { cwd: installDir });
    if (remoteIdentity(upstreamUrl) !== remoteIdentity(repoUrl)) {
      throw new Error('Existing checkout upstream does not match the selected cortextOS repository.');
    }
    remote = 'upstream';
  } else if (remoteExists(runner, installDir, 'origin')) {
    const originUrl = runner.capture('git', ['remote', 'get-url', 'origin'], { cwd: installDir });
    if (remoteIdentity(originUrl) !== remoteIdentity(repoUrl)) {
      throw new Error('Existing checkout has no upstream remote and origin is not the selected cortextOS repository.');
    }
    runner.visible('git', ['remote', 'rename', 'origin', 'upstream'], { cwd: installDir });
    remote = 'upstream';
    ok('Remote migrated: canonical repository is now "upstream"');
  } else {
    throw new Error('Existing checkout has no usable upstream or origin remote.');
  }

  // Give the fetched branch an explicit remote-tracking destination. A bare
  // `git fetch <remote> <branch>` is allowed to update FETCH_HEAD only, which
  // makes first-time checkout behavior depend on the user's Git config.
  runner.visible('git', [
    'fetch', remote, `refs/heads/${branch}:refs/remotes/${remote}/${branch}`,
  ], { cwd: installDir });
  let localBranchExists = true;
  try {
    runner.capture('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: installDir });
  } catch {
    localBranchExists = false;
  }
  if (localBranchExists) {
    runner.visible('git', ['checkout', branch], { cwd: installDir });
  } else {
    runner.visible('git', ['checkout', '-b', branch, '--track', `${remote}/${branch}`], { cwd: installDir });
  }
  // Pull explicitly from the selected remote branch; never fall back to the
  // checkout's configured branch and never continue after a failed update.
  runner.visible('git', ['pull', '--ff-only', remote, branch], { cwd: installDir });
}

export function cloneCheckout({ runner, installDir, repoUrl, branch }) {
  runner.visible('git', ['clone', '--branch', branch, '--single-branch', repoUrl, installDir]);
  runner.visible('git', ['remote', 'rename', 'origin', 'upstream'], { cwd: installDir });
}

function hasAuthenticatedRuntime(runner, env) {
  if (runner.exists('claude')) {
    try {
      if (/["']?loggedIn["']?\s*:\s*true\b/i.test(runner.capture('claude', ['auth', 'status']))) return true;
    } catch { /* try another runtime */ }
  }
  if (runner.exists('codex')) {
    try {
      const status = runner.capture('codex', ['login', 'status']);
      if (/logged\s+in/i.test(status) && !/not\s+logged\s+in/i.test(status)) return true;
    } catch { /* try another runtime */ }
  }
  if (runner.exists('opencode')) {
    try {
      const count = runner.capture('opencode', ['auth', 'list']).replace(/\x1b\[[0-9;]*m/g, '').match(/\b(\d+)\s+credentials?\b/i);
      if (count && Number(count[1]) > 0) return true;
    } catch { /* no authenticated provider */ }
  }
  return Boolean(env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY);
}

function fixSpawnHelperPermissions(installDir) {
  const prebuilds = join(installDir, 'node_modules', 'node-pty', 'prebuilds');
  const buildRel = join(installDir, 'node_modules', 'node-pty', 'build', 'Release');
  let fixed = false;
  if (existsSync(prebuilds)) {
    try {
      for (const directory of readdirSync(prebuilds)) {
        const helper = join(prebuilds, directory, 'spawn-helper');
        if (existsSync(helper) && (statSync(helper).mode & 0o111) === 0) {
          chmodSync(helper, 0o755);
          fixed = true;
        }
      }
    } catch { /* npm layout may differ */ }
  }
  const builtHelper = join(buildRel, 'spawn-helper');
  if (existsSync(builtHelper)) {
    try {
      if ((statSync(builtHelper).mode & 0o111) === 0) {
        chmodSync(builtHelper, 0o755);
        fixed = true;
      }
    } catch { /* best-effort permission repair */ }
  }
  if (fixed) ok('Fixed node-pty spawn-helper permissions');
}

export function dependencyFailureGuidance(output, os) {
  const nativeFailure = /node-gyp|msbuild|visual c\+\+|cl\.exe|c\+\+ build tools|native (?:addon|module)/i.test(output);
  const pythonFailure = /(?:node-gyp|gyp).{0,100}(?:python|py\.exe)|could not find (?:any )?python/i.test(output);
  if (!nativeFailure && !pythonFailure) return [];

  const guidance = ['The dependency log indicates native compilation was attempted.'];
  if (os === 'win32') {
    if (pythonFailure) guidance.push('Install Python 3, then reopen PowerShell so py.exe/python is on PATH.');
    if (nativeFailure) {
      guidance.push('Install Microsoft Visual Studio Build Tools with the "Desktop development with C++" workload:');
      guidance.push('https://visualstudio.microsoft.com/visual-cpp-build-tools/');
    }
  } else if (os === 'darwin') {
    guidance.push('Install Xcode Command Line Tools: xcode-select --install');
  } else if (os === 'linux') {
    guidance.push('Install your distribution C/C++ toolchain (for Debian/Ubuntu: sudo apt-get install build-essential).');
  }
  return guidance;
}

function printDependencyFailureGuidance(error, os) {
  const output = error instanceof InstallerCommandError ? error.output : '';
  for (const line of dependencyFailureGuidance(output, os)) console.error(`  ${line}`);
}

export function install(options = {}) {
  const os = options.platform || platform();
  const isWindows = os === 'win32';
  const isMac = os === 'darwin';
  const isLinux = os === 'linux';
  const env = options.env || process.env;
  const repoUrl = env.CORTEXTOS_REPO || 'https://github.com/grandamenium/cortextos.git';
  const installDir = env.CORTEXTOS_DIR || join(homedir(), 'cortextos');
  const branch = validateBranch(env.CORTEXTOS_BRANCH || 'main');
  const runner = options.runner || createProcessRunner({ isWindows, env });

  console.log('');
  console.log(`${BOLD}cortextOS installer${R}`);
  console.log('Native persistent agents for Windows, macOS, and Linux');
  console.log('');

  log('Checking Node.js and npm...');
  const nodeVersion = process.version.slice(1);
  if (Number.parseInt(nodeVersion.split('.')[0], 10) < 20) {
    throw new Error(`Node.js v${nodeVersion} is too old. Install Node.js 20 or later from https://nodejs.org`);
  }
  ok(`Node.js v${nodeVersion}`);
  ok(`npm ${runner.capture('npm', ['--version'])}`);

  log('Checking git...');
  if (!runner.exists('git')) {
    if (isLinux) {
      warn('git is not installed. Attempting installation with apt-get...');
      runner.visible('sudo', ['apt-get', 'install', '-y', 'git']);
    } else if (isMac) {
      throw new Error('git is required. Run xcode-select --install, then rerun this installer.');
    } else {
      throw new Error('git is required. Install Git for Windows from https://git-scm.com/download/win or run: winget install Git.Git');
    }
  }
  ok(runner.capture('git', ['--version']));

  log('Checking Claude Code...');
  if (!runner.exists('claude')) {
    warn('Claude Code is not installed. Installing...');
    runner.visible('npm', globalInstallArgs('@anthropic-ai/claude-code', os));
  }
  if (!runner.exists('claude')) throw new Error('Claude Code installation completed but the claude command is not available on PATH.');
  try { ok(`Claude Code ${runner.capture('claude', ['--version']).split(/\r?\n/)[0]}`); }
  catch { ok('Claude Code installed'); }

  if (!hasAuthenticatedRuntime(runner, env)) {
    throw new Error('At least one agent runtime must be authenticated. Run claude login, codex login, or opencode auth login, then rerun the installer.');
  }
  ok('At least one agent runtime is authenticated');

  console.log('');
  if (existsSync(installDir)) {
    warn(`Directory ${installDir} already exists`);
    if (!existsSync(join(installDir, '.git'))) {
      throw new Error(`${installDir} exists but is not a git repository. Remove it or set CORTEXTOS_DIR to a different path.`);
    }
    log(`Updating selected branch: ${branch}...`);
    updateCheckout({ runner, installDir, repoUrl, branch });
    ok(`Updated ${branch}`);
  } else {
    log(`Cloning cortextOS (branch: ${branch}) to ${installDir}...`);
    cloneCheckout({ runner, installDir, repoUrl, branch });
    ok('Cloned and configured upstream remote');
  }

  log('Installing dependencies (this may take a minute)...');
  try {
    runner.logged('npm', ['install'], { cwd: installDir });
  } catch (error) {
    console.error(`${RED}  npm install failed.${R}`);
    printDependencyFailureGuidance(error, os);
    throw error;
  }
  ok('Dependencies installed');
  if (!isWindows) fixSpawnHelperPermissions(installDir);

  log('Building...');
  runner.visible('npm', ['run', 'build'], { cwd: installDir });
  ok('Build complete');

  if (!isWindows && existsSync(join(installDir, 'scripts', 'setup-hooks.sh'))) {
    try {
      runner.visible('bash', ['scripts/setup-hooks.sh'], { cwd: installDir });
      ok('Installed git pre-push hook (build + test gate)');
    } catch {
      warn('Could not install the optional git pre-push hook');
    }
  }

  log('Linking cortextos CLI globally...');
  try {
    runner.visible('npm', ['link'], { cwd: installDir });
  } catch {
    runner.visible('npm', ['install', '-g', '.'], { cwd: installDir });
  }
  if (!runner.exists('cortextos')) {
    throw new Error('Global CLI installation completed but cortextos is not available on PATH. Reopen the terminal and rerun the installer.');
  }
  ok('cortextos CLI available');

  log('Checking PM2 (process manager)...');
  if (!runner.exists('pm2')) runner.visible('npm', ['install', '-g', 'pm2']);
  if (!runner.exists('pm2')) throw new Error('PM2 installation completed but pm2 is not available on PATH.');
  ok(`PM2 ${runner.capture('pm2', ['--version'])}`);

  log('Running cortextos install...');
  runner.visible(process.execPath, [join(installDir, 'dist', 'cli.js'), 'install'], { cwd: installDir });
  ok('Core state installed');

  console.log('');
  console.log(`${G}${BOLD}cortextOS installed successfully!${R}`);
  console.log('');
  console.log(`${BOLD}Next steps:${R}`);
  console.log('');
  console.log(`  1. Open ${BOLD}${installDir}${R} in Claude Code:`);
  console.log(`     ${Y}${formatClaudeHandoff(installDir, os, env)}${R}`);
  console.log('');
  console.log('  2. In Claude Code, run:');
  console.log(`     ${Y}/onboarding${R}`);
  console.log('');
  console.log('  /onboarding walks through organization setup, Telegram, dashboard, and native persistence.');
}

function isDirectInvocation() {
  if (!process.argv[1]) return true; // node --input-type=module < install.mjs
  try {
    return pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  try {
    install();
  } catch (error) {
    console.error('');
    console.error(`${RED}${BOLD}cortextOS installation failed.${R}`);
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
    console.error('  The installer stopped without reporting success. Fix the error above and rerun the same command.');
    process.exitCode = 1;
  }
}
