import { createHash } from 'crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
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
  let fleetPath: string;
  let spendPath: string;
  let planPath: string;
  let hermesRoot: string;
  let frameworkRoot: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'hermes-failover-skill-'));
    const plan = JSON.parse(readFileSync(examplePlan, 'utf8'));
    const now = new Date().toISOString();
    plan.trigger.observed_at_utc = now;
    plan.trigger.source = 'oauth-usage-primary-receipt';
    plan.restore.occurrence_utc = nextSunday1500Chicago();
    plan.live_changes = 0;
    hermesRoot = join(tempDir, 'hermes-root');
    frameworkRoot = join(tempDir, 'framework-root');

    const liveConfigs = Object.fromEntries(Object.keys(plan.seats).map((seat) => {
      const configPath = join(frameworkRoot, 'orgs', 'ygs-cortex-fleet', 'agents', seat, 'config.json');
      const config = { runtime: 'codex-app-server', model: 'gpt-5-codex' };
      const configBytes = JSON.stringify(config, null, 2) + '\n';
      mkdirSync(join(frameworkRoot, 'orgs', 'ygs-cortex-fleet', 'agents', seat), { recursive: true });
      writeFileSync(configPath, configBytes);
      return [seat, { path: configPath, bytes: configBytes }];
    }));

    const fleet = {
      schema_version: 1,
      org: 'ygs-cortex-fleet',
      taken_at_utc: now,
      captured_from: 'live-seat-configs',
      intended_hermes_seats: ['chief', 'city', 'growth', 'sentinel', 'social'],
      seats: Object.fromEntries(Object.keys(plan.seats).map((seat) => [
        seat,
        {
          runtime: 'codex-app-server',
          model: 'gpt-5-codex',
          config_path: liveConfigs[seat].path,
          config_sha256: hash(liveConfigs[seat].bytes),
        },
      ])),
    };
    fleetPath = join(tempDir, 'fleet-snapshot.json');
    const fleetBytes = JSON.stringify(fleet, null, 2) + '\n';
    writeFileSync(fleetPath, fleetBytes);
    plan.fleet_snapshot = {
      path: fleetPath,
      sha256: hash(fleetBytes),
      taken_at_utc: now,
      captured_from: fleet.captured_from,
    };

    const spendSeats = Object.fromEntries(Object.entries<any>(plan.seats).map(([seat, route], index) => [
      seat,
      {
        runtime: route.runtime,
        model: route.model,
        provider: route.provider ?? null,
        expected_weekly_usd: index + 0.25,
      },
    ]));
    const totalExpected = Object.values<any>(spendSeats)
      .reduce((total, seat) => total + seat.expected_weekly_usd, 0);
    const spend = {
      schema_version: 1,
      generated_at_utc: now,
      currency: 'USD',
      method: 'measured tokens multiplied by pinned model prices',
      seats: spendSeats,
      total_expected_weekly_usd: totalExpected,
    };
    spendPath = join(tempDir, 'spend-estimate.json');
    const spendBytes = JSON.stringify(spend, null, 2) + '\n';
    writeFileSync(spendPath, spendBytes);
    plan.spend_snapshot = {
      path: spendPath,
      sha256: hash(spendBytes),
      generated_at_utc: now,
      currency: 'USD',
      total_expected_weekly_usd: totalExpected,
    };

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
          config_sha256: hash(liveConfigs[seat].bytes),
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
      const invocationId = `${seat}-context7-invocation`;
      const sessionId = `${seat}-profile-session`;
      const usageBytes = JSON.stringify({
        schema_version: 1,
        seat,
        profile: route.profile,
        server: 'context7',
        invocation_id: invocationId,
        session_id: sessionId,
        tested_at_utc: now,
        model: route.model,
        provider: route.provider,
        completed: true,
        failed: false,
      }, null, 2) + '\n';
      writeFileSync(usagePath, usageBytes);
      const transcriptPath = join(tempDir, `${seat}-mcp-transcript.json`);
      const transcriptBytes = JSON.stringify({
        schema_version: 1,
        seat,
        profile: route.profile,
        server: 'context7',
        invocation_id: invocationId,
        session_id: sessionId,
        tested_at_utc: now,
        tool_name: 'mcp__context7__resolve_library_id',
        result_marker: '/colinhacks/zod',
        success: true,
      }, null, 2) + '\n';
      writeFileSync(transcriptPath, transcriptBytes);
      plan.mcp_evidence[seat] = {
        context7: {
          profile: route.profile,
          tested_at_utc: now,
          connected: true,
          tools_discovered: 2,
          invocation_id: invocationId,
          session_id: sessionId,
          tool_name: 'mcp__context7__resolve_library_id',
          result_marker: '/colinhacks/zod',
          transcript_file: transcriptPath,
          transcript_sha256: hash(transcriptBytes),
          usage_file: usagePath,
          usage_sha256: hash(usageBytes),
        },
      };
      const jobsPath = join(hermesRoot, 'profiles', route.profile, 'cron', 'jobs.json');
      mkdirSync(join(hermesRoot, 'profiles', route.profile, 'cron'), { recursive: true });
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
    '--fleet-snapshot', fleetPath, '--spend', spendPath,
  ], {
    encoding: 'utf8',
    env: { ...process.env, HERMES_HOME: hermesRoot, CTX_FRAMEWORK_ROOT: frameworkRoot },
  });

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
    const usage = JSON.parse(readFileSync(plan.mcp_evidence.city.context7.usage_file, 'utf8'));
    usage.model = 'wrong/model';
    writeFileSync(plan.mcp_evidence.city.context7.usage_file, JSON.stringify(usage));
    const transcript = JSON.parse(readFileSync(plan.mcp_evidence.city.context7.transcript_file, 'utf8'));
    transcript.result_marker = 'wrong-result';
    writeFileSync(plan.mcp_evidence.city.context7.transcript_file, JSON.stringify(transcript));
    writeFileSync(plan.cron_evidence.city.jobs_path, JSON.stringify({ jobs: [{ enabled: true }] }));
    const invalidPath = join(tempDir, 'tampered-artifacts.json');
    writeFileSync(invalidPath, JSON.stringify(plan));

    const result = run(invalidPath);
    expect(result.status).toBe(1);
    const errors = JSON.parse(result.stderr).errors.join('\n');
    expect(errors).toContain('city/context7: usage file hash mismatch');
    expect(errors).toContain('city/context7: usage receipt is not bound to the exact successful pinned invocation');
    expect(errors).toContain('city/context7: MCP transcript hash mismatch');
    expect(errors).toContain('city/context7: transcript bytes are not bound to the exact seat/profile/server/invocation/effect');
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

  it('rejects a complete-looking plan with no byte-bound spend estimate', () => {
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    delete plan.spend_snapshot;
    const invalidPath = join(tempDir, 'no-spend.json');
    writeFileSync(invalidPath, JSON.stringify(plan));
    const result = run(invalidPath);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr).errors.join('\n')).toContain('spend_snapshot binding is required');
  });

  it('rejects guard omitted consistently from plan and restore', () => {
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    const restore = JSON.parse(readFileSync(restorePath, 'utf8'));
    delete plan.seats.guard;
    delete restore.seats.guard;
    writeFileSync(restorePath, JSON.stringify(restore));
    plan.restore_snapshot.sha256 = hash(readFileSync(restorePath));
    const invalidPath = join(tempDir, 'omit-guard.json');
    writeFileSync(invalidPath, JSON.stringify(plan));
    const result = run(invalidPath);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr).errors.join('\n')).toContain('authoritative six-seat roster');
  });

  it('rejects sentinel omitted from plan, restore, evidence, and both orders', () => {
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    const restore = JSON.parse(readFileSync(restorePath, 'utf8'));
    delete plan.seats.sentinel;
    delete restore.seats.sentinel;
    delete plan.mcp_evidence.sentinel;
    delete plan.cron_evidence.sentinel;
    plan.cutover.order = plan.cutover.order.filter((seat: string) => seat !== 'sentinel');
    plan.cutover.restore_order = plan.cutover.restore_order.filter((seat: string) => seat !== 'sentinel');
    writeFileSync(restorePath, JSON.stringify(restore));
    plan.restore_snapshot.sha256 = hash(readFileSync(restorePath));
    const invalidPath = join(tempDir, 'omit-sentinel.json');
    writeFileSync(invalidPath, JSON.stringify(plan));
    const result = run(invalidPath);
    expect(result.status).toBe(1);
    const errors = JSON.parse(result.stderr).errors.join('\n');
    expect(errors).toContain('authoritative six-seat roster');
    expect(errors).toContain('Hermes routes must be exactly');
    expect(errors).toContain('cutover.order must contain every Hermes seat exactly once');
  });

  it('rejects a fleet snapshot that is not bound to canonical live config bytes', () => {
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    const fleet = JSON.parse(readFileSync(fleetPath, 'utf8'));
    fleet.seats.city.config_path = join(tempDir, 'decoy-config.json');
    fleet.seats.city.config_sha256 = hash('fabricated-live-config');
    writeFileSync(fleetPath, JSON.stringify(fleet));
    plan.fleet_snapshot.sha256 = hash(readFileSync(fleetPath));
    const invalidPath = join(tempDir, 'fake-fleet-snapshot.json');
    writeFileSync(invalidPath, JSON.stringify(plan));
    const result = run(invalidPath);
    expect(result.status).toBe(1);
    const errors = JSON.parse(result.stderr).errors.join('\n');
    expect(errors).toContain('fleet snapshot config_path must equal canonical live config path');
    expect(errors).toContain('fleet snapshot config hash does not match live bytes');
  });

  it('rejects duplicate MCP invocation and session identities even with unique files', () => {
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    const chief = plan.mcp_evidence.chief.context7;
    const growth = plan.mcp_evidence.growth.context7;
    growth.invocation_id = chief.invocation_id;
    growth.session_id = chief.session_id;
    for (const key of ['transcript', 'usage']) {
      const fileKey = `${key}_file`;
      const hashKey = `${key}_sha256`;
      const receipt = JSON.parse(readFileSync(growth[fileKey], 'utf8'));
      receipt.invocation_id = chief.invocation_id;
      receipt.session_id = chief.session_id;
      writeFileSync(growth[fileKey], JSON.stringify(receipt));
      growth[hashKey] = hash(readFileSync(growth[fileKey]));
    }
    const invalidPath = join(tempDir, 'duplicate-mcp-identity.json');
    writeFileSync(invalidPath, JSON.stringify(plan));
    const result = run(invalidPath);
    expect(result.status).toBe(1);
    const errors = JSON.parse(result.stderr).errors.join('\n');
    expect(errors).toContain('MCP invocation_id must be globally unique');
    expect(errors).toContain('MCP session_id must be globally unique');
  });

  it('rejects MCP transcript and usage reuse across profiles', () => {
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    const chief = plan.mcp_evidence.chief.context7;
    const growth = plan.mcp_evidence.growth.context7;
    growth.transcript_file = chief.transcript_file;
    growth.transcript_sha256 = chief.transcript_sha256;
    growth.usage_file = chief.usage_file;
    growth.usage_sha256 = chief.usage_sha256;
    const invalidPath = join(tempDir, 'reuse-mcp.json');
    writeFileSync(invalidPath, JSON.stringify(plan));
    const result = run(invalidPath);
    expect(result.status).toBe(1);
    const errors = JSON.parse(result.stderr).errors.join('\n');
    expect(errors).toContain('MCP transcript evidence cannot be reused');
    expect(errors).toContain('MCP usage evidence cannot be reused');
    expect(errors).toContain('transcript bytes are not bound to the exact seat/profile/server');
    expect(errors).toContain('usage receipt is not bound to the exact successful pinned invocation');
  });

  it('rejects a required context7 proof using a fake non-context7 tool', () => {
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    const proof = plan.mcp_evidence.city.context7;
    proof.tool_name = 'mcp__not_context7__fake';
    const transcript = JSON.parse(readFileSync(proof.transcript_file, 'utf8'));
    transcript.tool_name = proof.tool_name;
    writeFileSync(proof.transcript_file, JSON.stringify(transcript));
    proof.transcript_sha256 = hash(readFileSync(proof.transcript_file));
    const invalidPath = join(tempDir, 'wrong-mcp-server.json');
    writeFileSync(invalidPath, JSON.stringify(plan));
    const result = run(invalidPath);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr).errors.join('\n'))
      .toContain('MCP tool name must be bound to required server context7');
  });

  it('rejects a decoy cron receipt when the canonical profile jobs file is active', () => {
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    const canonicalPath = plan.cron_evidence.city.jobs_path;
    writeFileSync(canonicalPath, JSON.stringify({ jobs: [{ id: 'native', enabled: true }] }));
    const decoyPath = join(tempDir, 'decoy-jobs.json');
    const decoyBytes = JSON.stringify({ jobs: [] });
    writeFileSync(decoyPath, decoyBytes);
    plan.cron_evidence.city.jobs_path = decoyPath;
    plan.cron_evidence.city.jobs_sha256 = hash(decoyBytes);
    const invalidPath = join(tempDir, 'decoy-cron.json');
    writeFileSync(invalidPath, JSON.stringify(plan));
    const result = run(invalidPath);
    expect(result.status).toBe(1);
    const errors = JSON.parse(result.stderr).errors.join('\n');
    expect(errors).toContain('native cron jobs_path must equal canonical profile path');
    expect(errors).toContain('native cron jobs file is invalid or contains enabled jobs');
  });
});
