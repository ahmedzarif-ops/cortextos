import { spawnSync } from 'child_process';

export const WINDOWS_USER_PROVIDER_ENV = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_API_KEY',
] as const;

type ProviderEnvName = typeof WINDOWS_USER_PROVIDER_ENV[number];
type UserEnvReader = (name: ProviderEnvName) => string | undefined;

function readWindowsUserEnvironment(name: ProviderEnvName): string | undefined {
  // The value is read over captured stdout and is never placed in argv, logged,
  // or written to disk. This repairs the Windows-specific case where Claude
  // intentionally removes its OAuth token from tool children even though the
  // token is safely persisted in HKCU for the same account.
  const script = `[Environment]::GetEnvironmentVariable('${name}', 'User')`;
  const result = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ], {
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: 10_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return undefined;
  const value = result.stdout.replace(/\r?\n$/, '');
  return value || undefined;
}

/**
 * Add missing provider credentials from the current Windows user's persistent
 * environment without overriding process-local or agent-specific values.
 */
export function withWindowsUserProviderEnv(
  source: NodeJS.ProcessEnv,
  hostPlatform: NodeJS.Platform = process.platform,
  readUserEnv: UserEnvReader = readWindowsUserEnvironment,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...source };
  if (hostPlatform !== 'win32') return result;

  for (const name of WINDOWS_USER_PROVIDER_ENV) {
    if (result[name]) continue;
    try {
      const value = readUserEnv(name);
      if (value) result[name] = value;
    } catch {
      // The provider will surface its normal unauthenticated state. Never turn
      // a best-effort credential lookup into a secret-bearing error message.
    }
  }
  return result;
}
