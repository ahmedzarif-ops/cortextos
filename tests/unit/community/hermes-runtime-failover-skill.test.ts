import { createHash } from 'crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const skillRoot = join(__dirname, '..', '..', '..', 'community', 'skills', 'hermes-runtime-failover');
const validator = join(skillRoot, 'scripts', 'validate-plan.mjs');
const examplePlan = join(skillRoot, 'references', 'ygs-routes.example.json');
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const nextSunday1500Chicago = () => {
  const candidate = new Date(Date.now() + 60_000);
  candidate.setUTCSeconds(0, 0);
  for (let minute = 0; minute < 8 * 24 * 60; minute += 1) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago', weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(candidate).map((part) => [part.type, part.value]));
    if (parts.weekday === 'Sunday' && parts.hour === '15' && parts.minute === '00') return candidate.toISOString();
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }
  throw new Error('could not resolve next Sunday 15:00 America/Chicago');
};

describe('hermes-runtime-failover plan validator', () => {
  let tempDir: string;
  let restorePath: string;
  let planPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'hermes-failover-skill-'));
    const plan = JSON.parse(readFileSync(examplePlan, 'utf8'));
    const now = new Date().toISOString();
    plan.trigger.observed_at_utc = now;
    plan.trigger.source = 'oauth-usage-primary-receipt';
    plan.restore.occurrence_utc = nextSunday1500Chicago();
    plan.live_changes = 0;

    const restore = {
      schema_version: 1,
      taken_at_utc: now,
      reason: 'pre-cutover live config capture',
      captured_from: 'live-seat-configs',
      restore_at_utc: plan.restore.occurrence_utc,
      seats: Object.fromEntries(Object.keys(plan.seats).map((seat) => [
        seat,
        {
          runtime: 'codex-app-server',
          model: 'gpt-5-codex',
          config_sha256: hash(`config:${seat}`),
        },
      ])),
    };
    restorePath = join(tempDir, 'restore.json');
    const restoreBytes = JSON.stringify(restore, null, 2) + '\n';
    writeFileSync(restorePath, restoreBytes);
    plan.restore_snapshot = {
      path: restorePath,
      sha256: hash(restoreBytes),
      taken_at_utc: restore.taken_at_utc,
      reason: restore.reason,
      captured_from: restore.captured_from,
    };

    plan.mcp_evidence = {};
    plan.cron_evidence = {};
    for (const [seat, route] of Object.entries<any>(plan.seats)) {
      if (route.runtime !== 'hermes') continue;
      const usagePath = join(tempDir, `${seat}-usage.json`);
      const usageBytes = JSON.stringify({
        model: route.model,
        provider: route.provider,
        completed: true,
        failed: false,
      }, null, 2) + '\n';
      writeFileSync(usagePath, usageBytes);
      const transcriptPath = join(tempDir, `${seat}-mcp-transcript.txt`);
      const transcriptBytes = 'tool=mcp__context7__resolve_library_id\nresult=/colinhacks/zod\n';
      writeFileSync(transcriptPath, transcriptBytes);
      plan.mcp_evidence[seat] = {
        context7: {
          profile: route.profile,
          tested_at_utc: now,
          connected: true,
          tools_discovered: 2,
          tool_name: 'mcp__context7__resolve_library_id',
          result_marker: '/colinhacks/zod',
          transcript_file: transcriptPath,
          transcript_sha256: hash(transcriptBytes),
          usage_file: usagePath,
          usage_sha256: hash(usageBytes),
        },
      };
      const jobsPath = join(tempDir, `${seat}-jobs.json`);
      const jobsBytes = JSON.stringify({ jobs: [] }) + '\n';
      writeFileSync(jobsPath, jobsBytes);
      plan.cron_evidence[seat] = {
        profile: route.profile,
        checked_at_utc: now,
        enabled_native_jobs: 0,
        jobs_path: jobsPath,
        jobs_sha256: hash(jobsBytes),
      };
    }

    planPath = join(tempDir, 'plan.json');
    writeFileSync(planPath, JSON.stringify(plan, null, 2) + '\n');
  });

  afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

  const run = (candidatePlan = planPath) => spawnSync(process.execPath, [
    validator, '--plan', candidatePlan, '--restore', restorePath,
  ], { encoding: 'utf8' });

  it('accepts a fully bound route, restore snapshot, MCP proof, cron scan, and ordered canary', () => {
    const result = run();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      trigger_percent: 9,
      seats: 6,
      hermes_profiles: 5,
      mcp_receipts: 5,
      native_cron_collisions: 0,
      canary: 'city',
      coordinator_last: 'chief',
      live_changes: 0,
    });
  });

  it('rejects fail-open trigger, restore, routing, MCP, cron, and ordering data together', () => {
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    const restore = JSON.parse(readFileSync(restorePath, 'utf8'));
    plan.trigger.denominator = '';
    plan.trigger.observed_at_utc = '2020-01-01T00:00:00Z';
    plan.restore_snapshot.sha256 = '0'.repeat(64);
    plan.seats.city.model = '   ';
    plan.seats.city.provider = '   ';
    plan.seats.city.mcp_required = [''];
    plan.cutover.order = ['chief', 'city', 'growth', 'social', 'sentinel'];
    plan.cutover.restore_order = ['city', 'growth'];
    delete plan.mcp_evidence.growth.context7.result_marker;
    plan.cron_evidence.social.enabled_native_jobs = 1;
    restore.seats.city.runtime = 'garbage-runtime';
    restore.seats.city.model = null;
    delete restore.taken_at_utc;
    delete restore.reason;
    delete restore.restore_at_utc;
    writeFileSync(restorePath, JSON.stringify(restore));
    const invalidPath = join(tempDir, 'invalid-plan.json');
    writeFileSync(invalidPath, JSON.stringify(plan));

    const result = run(invalidPath);
    expect(result.status).toBe(1);
    const errors = JSON.parse(result.stderr).errors.join('\n');
    expect(errors).toContain('trigger.denominator');
    expect(errors).toContain('trigger observation is stale');
    expect(errors).toContain('restore_snapshot.sha256 does not match');
    expect(errors).toContain('city: valid fixed model required');
    expect(errors).toContain('city: valid provider required');
    expect(errors).toContain('city: invalid MCP server name');
    expect(errors).toContain('growth/context7: real MCP result marker required');
    expect(errors).toContain('social: enabled native Hermes crons collide');
    expect(errors).toContain('city: invalid or missing restorable runtime');
    expect(errors).toContain('city: valid restorable model required');
    expect(errors).toContain('cutover.order must start with the canary seat');
    expect(errors).toContain('cutover.restore_order must contain every Hermes seat exactly once');
  });

  it('rejects tampered MCP usage and native-cron artifacts', () => {
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    writeFileSync(plan.mcp_evidence.city.context7.usage_file, JSON.stringify({
      model: 'wrong/model', provider: 'nous', completed: true, failed: false,
    }));
    writeFileSync(plan.mcp_evidence.city.context7.transcript_file, 'no MCP effect here\n');
    writeFileSync(plan.cron_evidence.city.jobs_path, JSON.stringify({ jobs: [{ enabled: true }] }));
    const invalidPath = join(tempDir, 'tampered-artifacts.json');
    writeFileSync(invalidPath, JSON.stringify(plan));

    const result = run(invalidPath);
    expect(result.status).toBe(1);
    const errors = JSON.parse(result.stderr).errors.join('\n');
    expect(errors).toContain('city/context7: usage file hash mismatch');
    expect(errors).toContain('city/context7: usage receipt does not prove the pinned successful route');
    expect(errors).toContain('city/context7: MCP transcript hash mismatch');
    expect(errors).toContain('city/context7: transcript does not contain the required tool and result effect');
    expect(errors).toContain('city: native cron jobs hash mismatch');
    expect(errors).toContain('city: native cron jobs file is invalid or contains enabled jobs');
  });

  it('rejects moving aliases, duplicate profiles, and a changed threshold', () => {
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    plan.trigger.at_or_below = 11;
    plan.seats.city.model = '~deepseek/deepseek-v4-flash-latest';
    plan.seats.guard.model = 'gpt-5-codex-latest';
    plan.seats.city.profile = plan.seats.chief.profile;
    const invalidPath = join(tempDir, 'invalid-routes.json');
    writeFileSync(invalidPath, JSON.stringify(plan));

    const result = run(invalidPath);
    expect(result.status).toBe(1);
    const errors = JSON.parse(result.stderr).errors.join('\n');
    expect(errors).toContain('trigger.at_or_below must be exactly 10');
    expect(errors).toContain('valid fixed model required');
    expect(errors).toContain('moving model alias forbidden');
    expect(errors).toContain('duplicate profile');
  });

  it('rejects stale readiness evidence, a past restore, and incomplete Hermes restore pins', () => {
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    const restore = JSON.parse(readFileSync(restorePath, 'utf8'));
    const stale = '2020-01-01T00:00:00Z';
    plan.restore.occurrence_utc = '2020-08-30T20:00:00Z';
    plan.restore_snapshot.taken_at_utc = stale;
    plan.mcp_evidence.city.context7.tested_at_utc = stale;
    plan.cron_evidence.city.checked_at_utc = stale;
    restore.restore_at_utc = plan.restore.occurrence_utc;
    restore.taken_at_utc = stale;
    restore.seats.city = {
      runtime: 'hermes',
      model: 'deepseek/deepseek-v4-flash',
      config_sha256: hash('config:city'),
    };
    writeFileSync(restorePath, JSON.stringify(restore));
    plan.restore_snapshot.sha256 = hash(readFileSync(restorePath));
    const invalidPath = join(tempDir, 'stale-evidence.json');
    writeFileSync(invalidPath, JSON.stringify(plan));

    const result = run(invalidPath);
    expect(result.status).toBe(1);
    const errors = JSON.parse(result.stderr).errors.join('\n');
    expect(errors).toContain('restore.occurrence_utc must be the next future Sunday occurrence');
    expect(errors).toContain('restore_snapshot.taken_at_utc is stale');
    expect(errors).toContain('city/context7: MCP tested_at_utc is stale');
    expect(errors).toContain('city: native cron checked_at_utc is stale');
    expect(errors).toContain('city: valid isolated restorable Hermes profile required');
    expect(errors).toContain('city: valid restorable Hermes provider required');
    expect(errors).toContain('city: valid restorable Hermes reasoning required');
    expect(errors).toContain('city: valid restorable Hermes cron ownership required');
  });
});
