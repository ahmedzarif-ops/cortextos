import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const skillRoot = join(__dirname, '..', '..', '..', 'community', 'skills', 'hermes-runtime-failover');
const validator = join(skillRoot, 'scripts', 'validate-plan.mjs');
const examplePlan = join(skillRoot, 'references', 'ygs-routes.example.json');

describe('hermes-runtime-failover plan validator', () => {
  let tempDir: string;
  let restorePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'hermes-failover-skill-'));
    const plan = JSON.parse(readFileSync(examplePlan, 'utf8'));
    restorePath = join(tempDir, 'restore.json');
    writeFileSync(restorePath, JSON.stringify({
      restore_at: 'Sunday 15:00 America/Chicago',
      seats: Object.fromEntries(Object.keys(plan.seats).map((seat) => [
        seat, { runtime: 'claude-code', model: seat === 'chief' ? 'claude-fable-5' : 'opus' },
      ])),
    }));
  });

  afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

  const run = (planPath: string) => spawnSync(process.execPath, [
    validator, '--plan', planPath, '--restore', restorePath,
  ], { encoding: 'utf8' });

  it('accepts the explicit six-seat route and matching restore set', () => {
    const result = run(examplePlan);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true, trigger_percent: 10, seats: 6, hermes_profiles: 5, live_changes: 0,
    });
  });

  it('rejects moving aliases, duplicate profiles, and a changed threshold', () => {
    const plan = JSON.parse(readFileSync(examplePlan, 'utf8'));
    plan.trigger.at_or_below = 11;
    plan.seats.city.model = '~deepseek/deepseek-v4-flash-latest';
    plan.seats.city.profile = plan.seats.chief.profile;
    const invalidPath = join(tempDir, 'invalid-plan.json');
    writeFileSync(invalidPath, JSON.stringify(plan));

    const result = run(invalidPath);
    expect(result.status).toBe(1);
    const output = JSON.parse(result.stderr);
    expect(output.ok).toBe(false);
    expect(output.errors.join('\n')).toContain('trigger.at_or_below must be exactly 10');
    expect(output.errors.join('\n')).toContain('moving model alias forbidden');
    expect(output.errors.join('\n')).toContain('duplicate profile');
  });
});
