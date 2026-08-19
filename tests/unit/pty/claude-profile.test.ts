import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { markAuthenticatedClaudeProfileReady } from '../../../src/pty/claude-profile';

describe('Claude headless profile readiness', () => {
  let tempDir: string | undefined;
  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('preserves profile fields and adds only non-secret onboarding preferences', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-profile-'));
    const profilePath = join(tempDir, '.claude.json');
    writeFileSync(profilePath, `\uFEFF${JSON.stringify({ custom: 'keep-me' })}`);

    expect(markAuthenticatedClaudeProfileReady(profilePath, '{"loggedIn":true,"authMethod":"oauth"}')).toBe(true);
    const profile = JSON.parse(readFileSync(profilePath, 'utf-8'));
    expect(profile).toMatchObject({ custom: 'keep-me', hasCompletedOnboarding: true, theme: 'dark' });
  });

  it('does not mutate a profile unless authentication is positively verified', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-profile-'));
    const profilePath = join(tempDir, '.claude.json');
    writeFileSync(profilePath, JSON.stringify({ custom: 'unchanged' }));
    const before = readFileSync(profilePath, 'utf-8');

    expect(markAuthenticatedClaudeProfileReady(profilePath, '{"loggedIn":false}')).toBe(false);
    expect(readFileSync(profilePath, 'utf-8')).toBe(before);
  });
});
