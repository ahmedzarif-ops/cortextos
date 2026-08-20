import { Command } from 'commander';
import { execSync, spawnSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, statSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { verifyPtySpawn } from '../platform/pty-smoke.js';
import { resolveClaudeCommand } from '../pty/claude-command.js';
import { withWindowsUserProviderEnv } from '../platform/windows-user-env.js';

export interface Check {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  message: string;
  fix?: string;
}

export interface RuntimeProbeResult {
  ok: boolean;
  stdout: string;
}

export type RuntimeProbe = (command: string, args: readonly string[]) => RuntimeProbeResult;

export function inferLegacyTemplateName(
  agentHooks: Record<string, unknown>,
  candidates: ReadonlyArray<{ name: string; hooks: Record<string, unknown> }>,
): string {
  const agentHookKeys = Object.keys(agentHooks).sort().join('\0');
  return candidates.find(({ hooks }) => Object.keys(hooks).sort().join('\0') === agentHookKeys)?.name ?? 'agent';
}

/**
 * Run a fixed diagnostic command without inheriting stdio. Windows global npm
 * commands are .cmd shims, so they must be resolved through the native shell.
 * Callers deliberately never include stdout from auth probes in user-visible
 * output: provider output can contain account metadata and must stay private.
 */
export function runRuntimeProbe(command: string, args: readonly string[]): RuntimeProbeResult {
  // These values come exclusively from the fixed table below. Keep this
  // allowlist if more probes are added; it prevents shell metacharacters from
  // ever reaching cmd.exe when resolving Windows npm .cmd shims.
  if (![command, ...args].every((part) => /^[A-Za-z0-9._/-]+$/.test(part))) {
    return { ok: false, stdout: '' };
  }
  const probeEnv = withWindowsUserProviderEnv(process.env);
  const invocation = resolveRuntimeProbeInvocation(command, args, process.platform, probeEnv);
  const result = spawnSync(invocation.file, invocation.args, {
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: 10_000,
    windowsHide: true,
    env: probeEnv,
  });
  return {
    ok: !result.error && result.status === 0,
    // Some CLI versions write status to stderr. It is still captured and only
    // interpreted in-memory; auth probe output is never displayed.
    stdout: [result.stdout, result.stderr].filter((value): value is string => typeof value === 'string').join('\n'),
  };
}

export function resolveRuntimeProbeInvocation(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  fileExists: (path: string) => boolean = existsSync,
): { file: string; args: string[] } {
  if (platform !== 'win32') return { file: command, args: [...args] };
  if (command === 'claude') {
    const resolved = resolveClaudeCommand(platform, env, fileExists);
    return { file: resolved.file, args: [...resolved.argsPrefix, ...args] };
  }
  return {
    file: env.ComSpec || env.COMSPEC || 'cmd.exe',
    args: ['/d', '/s', '/c', command, ...args],
  };
}

function singleLineVersion(output: string): string {
  const firstLine = output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/, 1)[0]?.trim();
  return firstLine ? firstLine.slice(0, 160) : 'Installed';
}

function claudeIsAuthenticated(output: string): boolean {
  return /["']?loggedIn["']?\s*:\s*true\b/i.test(output);
}

function codexIsAuthenticated(output: string): boolean {
  return !/not\s+logged\s+in/i.test(output) && /logged\s+in/i.test(output);
}

function opencodeIsAuthenticated(output: string): boolean {
  const plain = output.replace(/\x1b\[[0-9;]*m/g, '');
  const match = plain.match(/\b(\d+)\s+credentials?\b/i);
  return match !== null && Number(match[1]) > 0;
}

/** Pure, dependency-injected runtime diagnostics used by doctor and tests. */
export function getAgentRuntimeChecks(probe: RuntimeProbe = runRuntimeProbe): Check[] {
  const definitions = [
    {
      label: 'Claude Code',
      command: 'claude',
      versionArgs: ['--version'],
      authArgs: ['auth', 'status'],
      authenticated: claudeIsAuthenticated,
      installFix: 'Install Claude Code: npm install -g @anthropic-ai/claude-code',
      authFix: 'Run: claude login',
      required: true,
    },
    {
      label: 'Codex',
      command: 'codex',
      versionArgs: ['--version'],
      authArgs: ['login', 'status'],
      authenticated: codexIsAuthenticated,
      installFix: 'Install Codex: npm install -g @openai/codex',
      authFix: 'Run: codex login',
      required: false,
    },
    {
      label: 'OpenCode',
      command: 'opencode',
      versionArgs: ['--version'],
      authArgs: ['auth', 'list'],
      authenticated: opencodeIsAuthenticated,
      installFix: 'Install OpenCode from https://opencode.ai/docs',
      authFix: 'Run: opencode auth login',
      required: false,
    },
  ] as const;

  const checks: Check[] = [];
  for (const runtime of definitions) {
    const version = probe(runtime.command, runtime.versionArgs);
    checks.push({
      name: `${runtime.label} CLI`,
      status: version.ok ? 'pass' : runtime.required ? 'fail' : 'warn',
      message: version.ok ? singleLineVersion(version.stdout) : 'Not found or not executable',
      fix: version.ok ? undefined : runtime.installFix,
    });

    if (!version.ok) {
      checks.push({
        name: `${runtime.label} auth`,
        status: 'warn',
        message: 'Unavailable (CLI not executable)',
        fix: runtime.installFix,
      });
      continue;
    }

    const auth = probe(runtime.command, runtime.authArgs);
    const ready = auth.ok && runtime.authenticated(auth.stdout);
    checks.push({
      name: `${runtime.label} auth`,
      status: ready ? 'pass' : 'warn',
      message: ready ? 'Ready' : 'Not authenticated or status could not be verified',
      fix: ready ? undefined : runtime.authFix,
    });
  }
  return checks;
}

export const doctorCommand = new Command('doctor')
  .option('--instance <id>', 'Instance ID', 'default')
  .description('Diagnose common issues')
  .action(async (options: { instance: string }) => {
    console.log('\ncortextOS Doctor\n');

    const checks: Check[] = [];

    // Check Node.js version
    const nodeVersion = process.version;
    const major = parseInt(nodeVersion.slice(1).split('.')[0], 10);
    checks.push({
      name: 'Node.js version',
      status: major >= 20 ? 'pass' : 'fail',
      message: `${nodeVersion} ${major >= 20 ? '(OK)' : '(requires 20+)'}`,
      fix: major < 20 ? 'Install Node.js 20+ from https://nodejs.org' : undefined,
    });

    // Check PM2
    try {
      const pm2Version = execSync('pm2 --version', { encoding: 'utf-8' }).trim();
      checks.push({
        name: 'PM2',
        status: 'pass',
        message: `v${pm2Version}`,
      });
    } catch {
      checks.push({
        name: 'PM2',
        status: 'warn',
        message: 'Not installed',
        fix: 'Install with: npm install -g pm2',
      });
    }

    checks.push(...getAgentRuntimeChecks());

    // Check node-pty
    try {
      require('node-pty');
      checks.push({
        name: 'node-pty',
        status: 'pass',
        message: 'Native module loaded',
      });
    } catch {
      checks.push({
        name: 'node-pty',
        status: 'fail',
        message: 'Failed to load native module',
        fix: process.platform === 'win32'
          ? 'Install "Desktop development with C++" workload from Visual Studio Build Tools (https://visualstudio.microsoft.com/visual-cpp-build-tools/), then run: npm rebuild node-pty'
          : 'Install build tools: xcode-select --install (macOS) or apt install build-essential (Linux)',
      });
    }

    // Fix spawn-helper permissions (Unix only)
    if (process.platform !== 'win32') {
      const prebuildsDir = join(process.cwd(), 'node_modules', 'node-pty', 'prebuilds');
      const buildRelease = join(process.cwd(), 'node_modules', 'node-pty', 'build', 'Release');
      let permFixed = false;

      // Fix permissions on all spawn-helper binaries
      for (const dir of [prebuildsDir, buildRelease]) {
        if (!existsSync(dir)) continue;
        try {
          const entries = dir === prebuildsDir ? readdirSync(dir) : ['.'];
          for (const entry of entries) {
            const helperPath = dir === prebuildsDir
              ? join(dir, entry, 'spawn-helper')
              : join(dir, 'spawn-helper');
            if (existsSync(helperPath)) {
              const mode = statSync(helperPath).mode;
              if ((mode & 0o111) === 0) {
                chmodSync(helperPath, 0o755);
                permFixed = true;
              }
            }
          }
        } catch { /* skip */ }
      }

      if (permFixed) {
        checks.push({
          name: 'node-pty spawn-helper',
          status: 'warn',
          message: 'Permissions were missing - fixed automatically',
        });
      }
    }

    // Actual spawn test (cross-platform)
    try {
      await verifyPtySpawn();
      checks.push({
        name: 'node-pty spawn test',
        status: 'pass',
        message: 'Can spawn processes',
      });
    } catch (err) {
      checks.push({
        name: 'node-pty spawn test',
        status: 'fail',
        message: `Cannot spawn processes: ${(err as Error).message}`,
        fix: 'Try: npm rebuild node-pty',
      });
    }

    // Check state directory
    const ctxRoot = join(homedir(), '.cortextos', options.instance);
    checks.push({
      name: 'State directory',
      status: existsSync(ctxRoot) ? 'pass' : 'warn',
      message: existsSync(ctxRoot) ? ctxRoot : 'Not found',
      fix: !existsSync(ctxRoot) ? 'Run: cortextos init <org-name>' : undefined,
    });

    // ── Tunnel checks (macOS only) ──────────────────────────────────────
    if (process.platform === 'darwin') {
      // cloudflared installed?
      try {
        const cfVer = execSync('cloudflared --version', { encoding: 'utf-8', stdio: 'pipe', timeout: 5000 }).trim();
        checks.push({ name: 'cloudflared', status: 'pass', message: cfVer });
      } catch {
        checks.push({
          name: 'cloudflared',
          status: 'warn',
          message: 'Not installed',
          fix: 'Install with: brew install cloudflared',
        });
      }

      // Cloudflare auth cert
      const cfCert = join(homedir(), '.cloudflared', 'cert.pem');
      checks.push({
        name: 'Cloudflare auth',
        status: existsSync(cfCert) ? 'pass' : 'warn',
        message: existsSync(cfCert) ? 'Authenticated (cert.pem found)' : 'Not authenticated',
        fix: !existsSync(cfCert) ? 'Run: cloudflared login' : undefined,
      });

      // Tunnel exists?
      let tunnelExists = false;
      try {
        const listOut = execSync('cloudflared tunnel list --output json', {
          encoding: 'utf-8',
          stdio: 'pipe',
          timeout: 10000,
        });
        const tunnels: Array<{ name: string }> = JSON.parse(listOut);
        tunnelExists = tunnels.some((t) => t.name === 'cortextos');
      } catch { /* not authenticated or cloudflared not installed */ }
      checks.push({
        name: "Tunnel 'cortextos'",
        status: tunnelExists ? 'pass' : 'warn',
        message: tunnelExists ? 'Exists' : 'Not created',
        fix: !tunnelExists ? 'Run: cortextos tunnel start' : undefined,
      });

      // launchd service running?
      let serviceRunning = false;
      try {
        const launchctlOut = execSync('launchctl list', { encoding: 'utf-8', stdio: 'pipe' });
        serviceRunning = launchctlOut.includes('com.cortextos.tunnel');
      } catch { /* launchctl not available */ }
      checks.push({
        name: 'Tunnel service (launchd)',
        status: serviceRunning ? 'pass' : 'warn',
        message: serviceRunning ? 'Running' : 'Not running',
        fix: !serviceRunning ? 'Run: cortextos tunnel start' : undefined,
      });

      // Tunnel URL saved?
      const tunnelConfigPath = join(homedir(), '.cortextos', options.instance, 'tunnel.json');
      let tunnelUrl: string | undefined;
      try {
        const tc = JSON.parse(readFileSync(tunnelConfigPath, 'utf-8'));
        tunnelUrl = tc.tunnelUrl;
      } catch { /* no config yet */ }
      checks.push({
        name: 'Tunnel URL',
        status: tunnelUrl ? 'pass' : 'warn',
        message: tunnelUrl ?? 'Not set',
        fix: !tunnelUrl ? 'Run: cortextos tunnel start' : undefined,
      });
    }

    // Check gh CLI (needed for community publishing --contribute)
    try {
      const ghVersion = execSync('gh --version', { encoding: 'utf-8', stdio: 'pipe', timeout: 5000 }).trim().split('\n')[0];
      checks.push({ name: 'gh CLI', status: 'pass', message: ghVersion });
    } catch {
      checks.push({
        name: 'gh CLI',
        status: 'warn',
        message: 'Not installed',
        fix: 'Install with: brew install gh (macOS) or https://cli.github.com',
      });
    }

    // Check upstream git remote (needed for check-upstream and community --contribute)
    const frameworkRoot = process.cwd();
    if (existsSync(join(frameworkRoot, '.git'))) {
      try {
        execSync('git remote get-url upstream', { encoding: 'utf-8', stdio: 'pipe', cwd: frameworkRoot });
        checks.push({ name: 'upstream remote', status: 'pass', message: 'Configured' });
      } catch {
        checks.push({
          name: 'upstream remote',
          status: 'warn',
          message: 'Not configured',
          fix: 'Run: git remote add upstream <canonical-cortextos-repo-url>',
        });
      }
    }

    // Check community/catalog.json (needed for browse-catalog and install-community-item)
    const catalogPath = join(frameworkRoot, 'community', 'catalog.json');
    checks.push({
      name: 'community/catalog.json',
      status: existsSync(catalogPath) ? 'pass' : 'warn',
      message: existsSync(catalogPath) ? 'Found' : 'Not found',
      fix: !existsSync(catalogPath) ? 'Run: cortextos bus check-upstream --apply to fetch the latest catalog' : undefined,
    });

    // Check GEMINI_API_KEY for Knowledge Base (semantic search / RAG)
    const orgsDir = join(frameworkRoot, 'orgs');
    let geminiConfigured = false;
    let geminiOrgFound = false;
    if (existsSync(orgsDir)) {
      try {
        for (const org of readdirSync(orgsDir)) {
          const secretsPath = join(orgsDir, org, 'secrets.env');
          if (existsSync(secretsPath)) {
            geminiOrgFound = true;
            const content = readFileSync(secretsPath, 'utf-8');
            if (/^GEMINI_API_KEY=.+/m.test(content)) {
              geminiConfigured = true;
              break;
            }
          }
        }
      } catch { /* ignore scan errors */ }
    }
    if (geminiOrgFound) {
      checks.push({
        name: 'Knowledge Base (GEMINI_API_KEY)',
        status: geminiConfigured ? 'pass' : 'warn',
        message: geminiConfigured ? 'Configured' : 'Not set — semantic search and RAG disabled',
        fix: !geminiConfigured ? 'Add GEMINI_API_KEY to orgs/<org>/secrets.env — get a free key at https://aistudio.google.com/app/apikey' : undefined,
      });
    }

    // Template drift detection: compare every agent's .claude/settings.json
    // hook blocks against the canonical template they were created from.
    // Missing hook blocks silently disable critical features — Stop missing
    // means last_idle.flag never writes, which is exactly the 2026-05-16
    // analyst/smith production incident. This catches drift before it
    // surfaces as "agent X stopped responding."
    if (existsSync(orgsDir)) {
      const HOOK_KEYS = ['Stop', 'PreCompact', 'SessionEnd', 'PreToolUse', 'PermissionRequest', 'UserPromptSubmit'];
      const driftFindings: Array<{ agent: string; org: string; missing: string[] }> = [];

      try {
        for (const org of readdirSync(orgsDir)) {
          const agentsRoot = join(orgsDir, org, 'agents');
          if (!existsSync(agentsRoot)) continue;
          for (const agent of readdirSync(agentsRoot)) {
            const agentSettings = join(agentsRoot, agent, '.claude', 'settings.json');
            const agentConfig = join(agentsRoot, agent, 'config.json');
            if (!existsSync(agentSettings) || !existsSync(agentConfig)) continue;

            // Determine which template this agent was created from. New agents
            // always persist this field. For older agents, accept an exact hook
            // key-set match with a shipped role before falling back to 'agent'.
            let templateName = 'agent';
            let templateRecorded = false;
            try {
              const cfg = JSON.parse(readFileSync(agentConfig, 'utf-8'));
              if (typeof cfg.template === 'string') {
                templateName = cfg.template;
                templateRecorded = true;
              }
            } catch { /* ignore — use default */ }

            let agentHooks: Record<string, unknown> = {};
            try {
              agentHooks = (JSON.parse(readFileSync(agentSettings, 'utf-8')).hooks ?? {});
            } catch { continue; }

            if (!templateRecorded) {
              const candidates: Array<{ name: string; hooks: Record<string, unknown> }> = [];
              for (const candidate of ['orchestrator', 'analyst']) {
                const candidateSettings = join(frameworkRoot, 'templates', candidate, '.claude', 'settings.json');
                if (!existsSync(candidateSettings)) continue;
                try {
                  const candidateHooks = (JSON.parse(readFileSync(candidateSettings, 'utf-8')).hooks ?? {});
                  candidates.push({ name: candidate, hooks: candidateHooks });
                } catch { /* inspect the next candidate */ }
              }
              templateName = inferLegacyTemplateName(agentHooks, candidates);
            }

            const templateSettings = join(frameworkRoot, 'templates', templateName, '.claude', 'settings.json');
            if (!existsSync(templateSettings)) continue;

            let templateHooks: Record<string, unknown> = {};
            try {
              templateHooks = (JSON.parse(readFileSync(templateSettings, 'utf-8')).hooks ?? {});
            } catch { continue; }

            const missing = HOOK_KEYS.filter(k => k in templateHooks && !(k in agentHooks));
            if (missing.length > 0) {
              driftFindings.push({ agent, org, missing });
            }
          }
        }
      } catch { /* ignore scan errors */ }

      if (driftFindings.length === 0) {
        checks.push({
          name: 'Agent template drift',
          status: 'pass',
          message: 'No hook blocks missing from agent settings.json files',
        });
      } else {
        for (const finding of driftFindings) {
          checks.push({
            name: `Template drift: ${finding.org}/${finding.agent}`,
            status: 'fail',
            message: `Missing hook block(s): ${finding.missing.join(', ')}`,
            fix: `Add the missing block(s) from templates/<agent-type>/.claude/settings.json into orgs/${finding.org}/agents/${finding.agent}/.claude/settings.json`,
          });
        }
      }
    }

    // Display results
    let hasFailures = false;
    for (const check of checks) {
      const icon = check.status === 'pass' ? 'OK' : check.status === 'warn' ? 'WARN' : 'FAIL';
      const prefix = `  [${icon}]`;
      console.log(`${prefix.padEnd(10)} ${check.name}: ${check.message}`);
      if (check.fix) {
        console.log(`           Fix: ${check.fix}`);
      }
      if (check.status === 'fail') hasFailures = true;
    }

    const warnCount = checks.filter(c => c.status === 'warn').length;
    const failCount = checks.filter(c => c.status === 'fail').length;

    console.log('');
    if (failCount > 0) {
      console.log(`  ${failCount} check(s) failed. Fix the issues above and run doctor again.\n`);
      process.exit(1);
    } else if (warnCount > 0) {
      console.log(`  All critical checks passed, ${warnCount} warning(s). See above for details.\n`);
    } else {
      console.log('  All checks passed.\n');
    }
  });
