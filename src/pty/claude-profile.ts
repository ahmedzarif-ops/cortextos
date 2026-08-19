import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { homedir, platform } from 'os';
import { join } from 'path';
import { atomicWriteSync } from '../utils/atomic.js';
import { stripBom } from '../utils/strip-bom.js';

function reportsAuthenticated(output: string): boolean {
  return /["']?loggedIn["']?\s*:\s*true\b/i.test(output);
}

/** Merge only non-secret first-run preferences after auth is proven ready. */
export function markAuthenticatedClaudeProfileReady(profilePath: string, authStatusOutput: string): boolean {
  if (!reportsAuthenticated(authStatusOutput)) return false;
  let profile: Record<string, unknown> = {};
  if (existsSync(profilePath)) {
    profile = JSON.parse(stripBom(readFileSync(profilePath, 'utf-8'))) as Record<string, unknown>;
  }
  if (profile.hasCompletedOnboarding === true) return false;
  profile.hasCompletedOnboarding = true;
  if (typeof profile.theme !== 'string') profile.theme = 'dark';
  atomicWriteSync(profilePath, JSON.stringify(profile, null, 2));
  return true;
}

/** Prepare an authenticated Windows profile for a non-interactive PTY launch. */
export function prepareClaudeHeadlessProfile(binary: string): void {
  if (platform() !== 'win32') return;
  const profilePath = join(homedir(), '.claude.json');
  try {
    if (existsSync(profilePath)) {
      const profile = JSON.parse(stripBom(readFileSync(profilePath, 'utf-8'))) as Record<string, unknown>;
      if (profile.hasCompletedOnboarding === true) return;
    }
    const isCmd = binary.toLowerCase().endsWith('.cmd');
    const result = isCmd
      ? spawnSync(`${binary} auth status`, [], { encoding: 'utf-8', stdio: 'pipe', timeout: 10_000, shell: true, windowsHide: true })
      : spawnSync(binary, ['auth', 'status'], { encoding: 'utf-8', stdio: 'pipe', timeout: 10_000, windowsHide: true });
    const captured = [result.stdout, result.stderr]
      .filter((value): value is string => typeof value === 'string')
      .join('\n');
    markAuthenticatedClaudeProfileReady(profilePath, captured);
  } catch {
    // Preserve Claude's normal first-run UI; AgentPTY reports the blocked state.
  }
}
