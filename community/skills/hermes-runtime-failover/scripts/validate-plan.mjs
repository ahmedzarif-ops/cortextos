#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const valueFor = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

const planPath = valueFor('--plan');
const restorePath = valueFor('--restore');
const fleetPath = valueFor('--fleet-snapshot');
const spendPath = valueFor('--spend');
const triggerPath = valueFor('--trigger-receipt');
if (!planPath || !restorePath || !fleetPath || !spendPath || !triggerPath) {
  console.error('Usage: validate-plan.mjs --plan <plan.json> --restore <RESTORE-STATE.json> --fleet-snapshot <FLEET-SNAPSHOT.json> --spend <SPEND-ESTIMATE.json> --trigger-receipt <TRIGGER-RECEIPT.json>');
  process.exit(2);
}

const readBytes = (path) => {
  try {
    return readFileSync(path);
  } catch (error) {
    console.error(`Cannot read ${path}: ${error.message}`);
    process.exit(2);
  }
};
const readJsonBytes = (path, bytes) => {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    console.error(`Cannot read JSON ${path}: ${error.message}`);
    process.exit(2);
  }
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;
const canonicalString = (value) => nonEmpty(value) && value === value.trim();
const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const validIso = (value) => nonEmpty(value) && isoPattern.test(value) && Number.isFinite(Date.parse(value));
const shaPattern = /^[a-f0-9]{64}$/;
const fixedModelPattern = /^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/;
const profilePattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const providerPattern = /^[a-zA-Z0-9._-]+$/;
const mcpNamePattern = /^[a-zA-Z0-9._-]+$/;
const usageApiEndpoint = 'https://api.anthropic.com/api/oauth/usage';
const canonicalTriggerSource = 'cortextos-check-usage-api:anthropic-oauth';
const reasoningLevels = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const runtimes = new Set(['claude-code', 'hermes', 'codex-app-server', 'opencode']);
const isMovingModelAlias = (value) => {
  if (typeof value !== 'string') return false;
  const model = value.trim();
  return model.startsWith('~') || /(?:^|[\/._-])(latest|auto)(?:$|[\/._-])/i.test(model);
};
const validateFreshTimestamp = (label, value, maxAgeMinutes, errors) => {
  if (!validIso(value)) {
    errors.push(`${label} must be an absolute UTC ISO timestamp`);
    return;
  }
  const ageMs = Date.now() - Date.parse(value);
  if (ageMs < -5 * 60_000 || ageMs > maxAgeMinutes * 60_000) {
    errors.push(`${label} is stale or future-dated (max ${maxAgeMinutes} minutes)`);
  }
};

const planBytes = readBytes(planPath);
const restoreBytes = readBytes(restorePath);
const fleetBytes = readBytes(fleetPath);
const spendBytes = readBytes(spendPath);
const triggerBytes = readBytes(triggerPath);
const plan = readJsonBytes(planPath, planBytes);
const restore = readJsonBytes(restorePath, restoreBytes);
const fleet = readJsonBytes(fleetPath, fleetBytes);
const spend = readJsonBytes(spendPath, spendBytes);
const triggerReceipt = readJsonBytes(triggerPath, triggerBytes);
const errors = [];
const profiles = new Set();
const requiredSeats = ['chief', 'city', 'growth', 'guard', 'sentinel', 'social'].sort();
const requiredHermesSeats = ['chief', 'city', 'growth', 'sentinel', 'social'].sort();
const sameSet = (actual, expected) => JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
const canonicalAgentsRoot = nonEmpty(frameworkRoot) && isAbsolute(frameworkRoot)
  ? join(frameworkRoot, 'orgs', 'ygs-cortex-fleet', 'agents')
  : '';
const daemonHermesHome = process.env.HERMES_HOME || join(homedir(), '.hermes');
const normalizedHermesRoot = basename(dirname(daemonHermesHome)) === 'profiles'
  ? dirname(dirname(daemonHermesHome))
  : daemonHermesHome;
const canonicalProfilesRoot = join(normalizedHermesRoot, 'profiles');
const evidenceMaxAgeMinutes = plan?.evidence_max_age_minutes;

const readCanonicalUsage = () => {
  if (!nonEmpty(frameworkRoot) || !isAbsolute(frameworkRoot)) return null;
  const cliPath = join(resolve(frameworkRoot), 'dist', 'cli.js');
  if (!existsSync(cliPath)) {
    errors.push('authenticated usage measurement unavailable: canonical cortextOS CLI is missing');
    return null;
  }
  const result = spawnSync(process.execPath, [
    cliPath, 'bus', 'check-usage-api', '--json', '--force', '--no-store',
  ], {
    encoding: 'utf8',
    env: process.env,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    errors.push(`authenticated usage measurement unavailable (RC ${result.status ?? 'none'})`);
    return null;
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    errors.push('authenticated usage measurement returned invalid JSON');
    return null;
  }
};

const canonicalUsage = readCanonicalUsage();

if (!Number.isInteger(evidenceMaxAgeMinutes) || evidenceMaxAgeMinutes < 1 || evidenceMaxAgeMinutes > 1440) {
  errors.push('evidence_max_age_minutes must be an integer from 1 to 1440');
}

const triggerBinding = plan?.trigger_receipt;
if (!triggerBinding || typeof triggerBinding !== 'object') {
  errors.push('trigger_receipt binding is required');
} else {
  if (!isAbsolute(triggerBinding.path ?? '') || resolve(triggerBinding.path ?? '') !== resolve(triggerPath)) {
    errors.push('trigger_receipt.path must be absolute and match --trigger-receipt');
  }
  if (!shaPattern.test(triggerBinding.sha256 ?? '') || triggerBinding.sha256 !== sha256(triggerBytes)) {
    errors.push('trigger_receipt.sha256 does not match trigger receipt bytes');
  }
}
if (triggerReceipt?.schema_version !== 1) errors.push('trigger receipt schema_version must be 1');

const fleetBinding = plan?.fleet_snapshot;
if (!fleetBinding || typeof fleetBinding !== 'object') {
  errors.push('fleet_snapshot binding is required');
} else {
  if (!isAbsolute(fleetBinding.path ?? '') || resolve(fleetBinding.path ?? '') !== resolve(fleetPath)) {
    errors.push('fleet_snapshot.path must be absolute and match --fleet-snapshot');
  }
  if (!shaPattern.test(fleetBinding.sha256 ?? '') || fleetBinding.sha256 !== sha256(fleetBytes)) {
    errors.push('fleet_snapshot.sha256 does not match fleet snapshot bytes');
  }
  if (Number.isInteger(evidenceMaxAgeMinutes) && evidenceMaxAgeMinutes >= 1 && evidenceMaxAgeMinutes <= 1440) {
    validateFreshTimestamp('fleet_snapshot.taken_at_utc', fleetBinding.taken_at_utc, evidenceMaxAgeMinutes, errors);
  }
  if (fleetBinding.taken_at_utc !== fleet?.taken_at_utc) errors.push('fleet snapshot taken_at_utc provenance mismatch');
  if (fleetBinding.captured_from !== 'live-seat-configs' || fleet?.captured_from !== 'live-seat-configs') {
    errors.push('fleet snapshot captured_from provenance mismatch');
  }
}
if (fleet?.schema_version !== 1) errors.push('fleet snapshot schema_version must be 1');
if (fleet?.org !== 'ygs-cortex-fleet') errors.push('fleet snapshot org must be ygs-cortex-fleet');
if (!validIso(fleet?.taken_at_utc)) errors.push('fleet snapshot taken_at_utc must be an absolute UTC ISO timestamp');
if (!canonicalAgentsRoot) errors.push('CTX_FRAMEWORK_ROOT must be an absolute path to verify live fleet configs');
const fleetSeats = fleet?.seats && typeof fleet.seats === 'object' && !Array.isArray(fleet.seats) ? fleet.seats : {};
const fleetNames = Object.keys(fleetSeats).sort();
if (!sameSet(fleetNames, requiredSeats)) {
  errors.push(`fleet snapshot must contain the authoritative six-seat roster: ${requiredSeats.join(',')}`);
}
const intendedHermesSeats = Array.isArray(fleet?.intended_hermes_seats) ? fleet.intended_hermes_seats : [];
if (!sameSet(intendedHermesSeats, requiredHermesSeats)) {
  errors.push(`fleet snapshot intended_hermes_seats must be exactly: ${requiredHermesSeats.join(',')}`);
}
for (const seat of requiredSeats) {
  const route = fleetSeats[seat];
  if (!route || !runtimes.has(route.runtime)) errors.push(`${seat}: fleet snapshot runtime is invalid or missing`);
  if (!canonicalString(route?.model) || !fixedModelPattern.test(route.model) || isMovingModelAlias(route.model)) {
    errors.push(`${seat}: fleet snapshot requires a fixed model`);
  }
  if (!shaPattern.test(route?.config_sha256 ?? '')) errors.push(`${seat}: fleet snapshot config_sha256 required`);
  if (route?.runtime === 'hermes') {
    if (!profilePattern.test(route.profile ?? '') || route.profile === 'default' || route.profile === 'shared') {
      errors.push(`${seat}: fleet snapshot requires an isolated Hermes profile`);
    }
    if (!canonicalString(route.provider) || !providerPattern.test(route.provider)) {
      errors.push(`${seat}: fleet snapshot requires a canonical Hermes provider`);
    }
    if (!reasoningLevels.has(route.reasoning)) errors.push(`${seat}: fleet snapshot requires a valid Hermes reasoning pin`);
    if (!['native', 'cortextos'].includes(route.cron_ownership)) {
      errors.push(`${seat}: fleet snapshot requires valid Hermes cron ownership`);
    }
  }
  const canonicalConfigPath = canonicalAgentsRoot ? join(canonicalAgentsRoot, seat, 'config.json') : '';
  if (route?.config_path !== canonicalConfigPath) {
    errors.push(`${seat}: fleet snapshot config_path must equal canonical live config path`);
  }
  if (canonicalConfigPath && existsSync(canonicalConfigPath)) {
    const configBytes = readBytes(canonicalConfigPath);
    const config = readJsonBytes(canonicalConfigPath, configBytes);
    if (route.config_sha256 !== sha256(configBytes)) errors.push(`${seat}: fleet snapshot config hash does not match live bytes`);
    if (route.runtime !== config.runtime || route.model !== config.model) {
      errors.push(`${seat}: fleet snapshot runtime/model do not match live config bytes`);
    }
    if (route.runtime === 'hermes' && (
      route.profile !== config.hermes_profile
      || route.provider !== config.hermes_provider
      || route.reasoning !== config.hermes_reasoning
      || route.cron_ownership !== config.hermes_cron_ownership
    )) {
      errors.push(`${seat}: fleet snapshot Hermes pins do not match live config bytes`);
    }
  } else if (canonicalConfigPath) {
    errors.push(`${seat}: canonical live config is missing`);
  }
}

const spendBinding = plan?.spend_snapshot;
if (!spendBinding || typeof spendBinding !== 'object') {
  errors.push('spend_snapshot binding is required');
} else {
  if (!isAbsolute(spendBinding.path ?? '') || resolve(spendBinding.path ?? '') !== resolve(spendPath)) {
    errors.push('spend_snapshot.path must be absolute and match --spend');
  }
  if (!shaPattern.test(spendBinding.sha256 ?? '') || spendBinding.sha256 !== sha256(spendBytes)) {
    errors.push('spend_snapshot.sha256 does not match spend bytes');
  }
  if (spendBinding.generated_at_utc !== spend?.generated_at_utc) errors.push('spend snapshot generated_at_utc provenance mismatch');
  if (spendBinding.currency !== 'USD' || spend?.currency !== 'USD') errors.push('spend currency must be USD');
  if (spendBinding.total_expected_weekly_usd !== spend?.total_expected_weekly_usd) {
    errors.push('spend total provenance mismatch');
  }
  if (Number.isInteger(evidenceMaxAgeMinutes) && evidenceMaxAgeMinutes >= 1 && evidenceMaxAgeMinutes <= 1440) {
    validateFreshTimestamp('spend_snapshot.generated_at_utc', spendBinding.generated_at_utc, evidenceMaxAgeMinutes, errors);
  }
}
if (spend?.schema_version !== 1) errors.push('spend schema_version must be 1');
if (!nonEmpty(spend?.method)) errors.push('spend method is required');
const spendSeats = spend?.seats && typeof spend.seats === 'object' && !Array.isArray(spend.seats) ? spend.seats : {};
const spendNames = Object.keys(spendSeats).sort();
if (!sameSet(spendNames, requiredSeats)) errors.push('spend estimate must contain every authoritative seat exactly once');

if (plan?.live_changes !== 0) errors.push('live_changes must be exactly 0 before approval');
if (plan?.trigger?.metric !== 'claude_weekly_remaining_percent') {
  errors.push('trigger.metric must be claude_weekly_remaining_percent');
}
if (plan?.trigger?.at_or_below !== 10) errors.push('trigger.at_or_below must be exactly 10');
if (plan?.trigger?.denominator !== 'percent_remaining') errors.push('trigger.denominator must be percent_remaining');
if (plan?.trigger?.source !== canonicalTriggerSource) {
  errors.push(`trigger.source must be ${canonicalTriggerSource}`);
}
if (typeof plan?.trigger?.observed_value !== 'number'
  || !Number.isFinite(plan.trigger.observed_value)
  || plan.trigger.observed_value < 0
  || plan.trigger.observed_value > 100) {
  errors.push('trigger.observed_value must be a number from 0 to 100');
} else if (plan.trigger.observed_value > 10) {
  errors.push('trigger.observed_value is above the 10 percent failover threshold');
}
for (const field of ['metric', 'denominator', 'observed_value', 'observed_at_utc', 'source']) {
  if (plan?.trigger?.[field] !== triggerReceipt?.[field]) {
    errors.push(`trigger.${field} does not match byte-bound trigger receipt`);
  }
}
if (!validIso(plan?.trigger?.observed_at_utc)) errors.push('trigger.observed_at_utc must be an absolute UTC ISO timestamp');
const maxAgeMinutes = plan?.trigger?.max_age_minutes;
if (!Number.isInteger(maxAgeMinutes) || maxAgeMinutes < 1 || maxAgeMinutes > 60) {
  errors.push('trigger.max_age_minutes must be an integer from 1 to 60');
} else if (validIso(plan?.trigger?.observed_at_utc)) {
  const ageMs = Date.now() - Date.parse(plan.trigger.observed_at_utc);
  if (ageMs < -5 * 60_000 || ageMs > maxAgeMinutes * 60_000) {
    errors.push(`trigger observation is stale or future-dated (max ${maxAgeMinutes} minutes)`);
  }
}
let canonicalRemainingPercent;
if (canonicalUsage) {
  const originIsAuthenticated = canonicalUsage.provider === 'anthropic'
    && canonicalUsage.endpoint === usageApiEndpoint
    && canonicalUsage.authentication === 'oauth-bearer'
    && canonicalUsage.cached === false
    && nonEmpty(canonicalUsage.account);
  if (!originIsAuthenticated) {
    errors.push('usage measurement is unauthenticated, cached, or from an unexpected origin');
  }
  const fiveHour = canonicalUsage.five_hour_utilization;
  const sevenDay = canonicalUsage.seven_day_utilization;
  if (typeof fiveHour !== 'number' || !Number.isFinite(fiveHour) || fiveHour < 0 || fiveHour > 1
    || typeof sevenDay !== 'number' || !Number.isFinite(sevenDay) || sevenDay < 0 || sevenDay > 1) {
    errors.push('authenticated usage measurement is missing valid utilization fields');
  } else {
    canonicalRemainingPercent = Number(((1 - sevenDay) * 100).toFixed(6));
    if (plan?.trigger?.observed_value !== canonicalRemainingPercent) {
      errors.push('trigger.observed_value does not match authenticated usage measurement');
    }
    if (triggerReceipt?.observed_value !== canonicalRemainingPercent) {
      errors.push('trigger receipt observed_value does not match authenticated usage measurement');
    }
  }
  if (!validIso(canonicalUsage.fetched_at)) {
    errors.push('authenticated usage measurement fetched_at is missing or invalid');
  } else if (Number.isInteger(maxAgeMinutes) && maxAgeMinutes >= 1 && maxAgeMinutes <= 60) {
    validateFreshTimestamp('authenticated usage measurement fetched_at', canonicalUsage.fetched_at, maxAgeMinutes, errors);
    if (validIso(plan?.trigger?.observed_at_utc)
      && Math.abs(Date.parse(canonicalUsage.fetched_at) - Date.parse(plan.trigger.observed_at_utc)) > maxAgeMinutes * 60_000) {
      errors.push('trigger.observed_at_utc is not contemporaneous with authenticated usage measurement');
    }
  }
}

if (plan?.restore?.timezone !== 'America/Chicago'
  || plan?.restore?.day !== 'Sunday'
  || plan?.restore?.time !== '15:00') {
  errors.push('restore contract must be Sunday 15:00 America/Chicago');
}
if (!validIso(plan?.restore?.occurrence_utc)) {
  errors.push('restore.occurrence_utc must be one absolute UTC ISO occurrence');
} else {
  const localParts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(plan.restore.occurrence_utc)).map((part) => [part.type, part.value]));
  if (localParts.weekday !== 'Sunday' || localParts.hour !== '15' || localParts.minute !== '00') {
    errors.push('restore.occurrence_utc must resolve to Sunday 15:00 America/Chicago');
  }
  const restoreDelayMs = Date.parse(plan.restore.occurrence_utc) - Date.now();
  if (restoreDelayMs <= 0 || restoreDelayMs > 8 * 24 * 60 * 60_000) {
    errors.push('restore.occurrence_utc must be the next future Sunday occurrence');
  }
}

const binding = plan?.restore_snapshot;
if (!binding || typeof binding !== 'object') {
  errors.push('restore_snapshot binding is required');
} else {
  if (!isAbsolute(binding.path ?? '')) errors.push('restore_snapshot.path must be absolute');
  else if (resolve(binding.path) !== resolve(restorePath)) errors.push('restore_snapshot.path does not match --restore');
  if (!shaPattern.test(binding.sha256 ?? '')) errors.push('restore_snapshot.sha256 must be a lowercase SHA-256');
  else if (binding.sha256 !== sha256(restoreBytes)) errors.push('restore_snapshot.sha256 does not match restore bytes');
  if (Number.isInteger(evidenceMaxAgeMinutes) && evidenceMaxAgeMinutes >= 1 && evidenceMaxAgeMinutes <= 1440) {
    validateFreshTimestamp('restore_snapshot.taken_at_utc', binding.taken_at_utc, evidenceMaxAgeMinutes, errors);
  } else if (!validIso(binding.taken_at_utc)) {
    errors.push('restore_snapshot.taken_at_utc must be an absolute UTC ISO timestamp');
  }
  if (!nonEmpty(binding.reason)) errors.push('restore_snapshot.reason is required');
  if (binding.captured_from !== 'live-seat-configs') errors.push('restore_snapshot.captured_from must be live-seat-configs');
}
if (restore?.schema_version !== 1) errors.push('restore.schema_version must be 1');
if (Number.isInteger(evidenceMaxAgeMinutes) && evidenceMaxAgeMinutes >= 1 && evidenceMaxAgeMinutes <= 1440) {
  validateFreshTimestamp('restore.taken_at_utc', restore?.taken_at_utc, evidenceMaxAgeMinutes, errors);
} else if (!validIso(restore?.taken_at_utc)) {
  errors.push('restore.taken_at_utc must be an absolute UTC ISO timestamp');
}
if (!nonEmpty(restore?.reason)) errors.push('restore.reason is required');
if (restore?.captured_from !== 'live-seat-configs') errors.push('restore.captured_from must be live-seat-configs');
if (!validIso(restore?.restore_at_utc)) errors.push('restore.restore_at_utc must be an absolute UTC ISO timestamp');
if (binding?.taken_at_utc !== restore?.taken_at_utc) errors.push('restore snapshot taken_at_utc provenance mismatch');
if (binding?.reason !== restore?.reason) errors.push('restore snapshot reason provenance mismatch');
if (binding?.captured_from !== restore?.captured_from) errors.push('restore snapshot source provenance mismatch');
if (plan?.restore?.occurrence_utc !== restore?.restore_at_utc) errors.push('restore occurrence does not match snapshot');

const planSeats = plan?.seats && typeof plan.seats === 'object' && !Array.isArray(plan.seats) ? plan.seats : {};
const restoreSeats = restore?.seats && typeof restore.seats === 'object' && !Array.isArray(restore.seats) ? restore.seats : {};
const planNames = Object.keys(planSeats).sort();
const restoreNames = Object.keys(restoreSeats).sort();
if (!sameSet(planNames, requiredSeats)) errors.push('plan.seats must contain the authoritative six-seat roster exactly');
if (!sameSet(restoreNames, requiredSeats)) errors.push('restore.seats must contain the authoritative six-seat roster exactly');
if (!sameSet(planNames, fleetNames) || !sameSet(restoreNames, fleetNames)) {
  errors.push(`seat sets differ from fleet snapshot: fleet=[${fleetNames.join(',')}] plan=[${planNames.join(',')}] restore=[${restoreNames.join(',')}]`);
}

const hermesSeats = [];
const restoreProfiles = new Set();
for (const [seat, route] of Object.entries(planSeats)) {
  if (!route || typeof route !== 'object' || Array.isArray(route)) {
    errors.push(`${seat}: route must be an object`);
    continue;
  }
  if (route.runtime === 'hermes') {
    hermesSeats.push(seat);
    if (!profilePattern.test(route.profile ?? '')) errors.push(`${seat}: invalid or missing profile`);
    if (route.profile === 'default' || route.profile === 'shared') errors.push(`${seat}: shared profile forbidden`);
    if (profiles.has(route.profile)) errors.push(`${seat}: duplicate profile ${route.profile}`);
    profiles.add(route.profile);
    if (!canonicalString(route.model) || !fixedModelPattern.test(route.model)) errors.push(`${seat}: valid fixed model required`);
    if (isMovingModelAlias(route.model)) errors.push(`${seat}: moving model alias forbidden (${route.model})`);
    if (!canonicalString(route.provider) || !providerPattern.test(route.provider)) errors.push(`${seat}: valid provider required`);
    if (!reasoningLevels.has(route.reasoning)) errors.push(`${seat}: invalid reasoning ${route.reasoning}`);
    if (route.cron_ownership !== 'cortextos') errors.push(`${seat}: cron_ownership must be cortextos for this fleet`);
    if (!Array.isArray(route.mcp_required) || route.mcp_required.length === 0) {
      errors.push(`${seat}: mcp_required must be a non-empty array`);
    } else {
      const unique = new Set();
      for (const rawServer of route.mcp_required) {
        const server = typeof rawServer === 'string' ? rawServer.trim() : '';
        if (!canonicalString(rawServer) || !mcpNamePattern.test(server)) errors.push(`${seat}: invalid MCP server name`);
        if (unique.has(server)) errors.push(`${seat}: duplicate normalized MCP server ${server}`);
        unique.add(server);
      }
    }
  } else if (route.runtime === 'codex-app-server') {
    if (!canonicalString(route.model) || !fixedModelPattern.test(route.model)) errors.push(`${seat}: valid Codex model required`);
    if (isMovingModelAlias(route.model)) errors.push(`${seat}: moving model alias forbidden (${route.model})`);
  } else {
    errors.push(`${seat}: unsupported failover runtime ${route.runtime}`);
  }

  const restoreRoute = restoreSeats[seat];
  if (!restoreRoute || !runtimes.has(restoreRoute.runtime)) errors.push(`${seat}: invalid or missing restorable runtime`);
  if (!canonicalString(restoreRoute?.model) || !fixedModelPattern.test(restoreRoute.model)) errors.push(`${seat}: valid restorable model required`);
  if (isMovingModelAlias(restoreRoute?.model)) errors.push(`${seat}: moving restorable model alias forbidden (${restoreRoute.model})`);
  if (!shaPattern.test(restoreRoute?.config_sha256 ?? '')) errors.push(`${seat}: restore config_sha256 required`);
  const fleetRoute = fleetSeats[seat];
  if (!fleetRoute
    || restoreRoute?.runtime !== fleetRoute.runtime
    || restoreRoute?.model !== fleetRoute.model
    || restoreRoute?.config_sha256 !== fleetRoute.config_sha256) {
    errors.push(`${seat}: restore route must match the byte-verified live fleet snapshot`);
  }
  if (fleetRoute?.runtime === 'hermes' && (
    restoreRoute?.profile !== fleetRoute.profile
    || restoreRoute?.provider !== fleetRoute.provider
    || restoreRoute?.reasoning !== fleetRoute.reasoning
    || restoreRoute?.cron_ownership !== fleetRoute.cron_ownership
  )) {
    errors.push(`${seat}: restore Hermes pins must match the byte-verified live fleet snapshot`);
  }
  if (restoreRoute?.runtime === 'hermes') {
    if (!profilePattern.test(restoreRoute.profile ?? '') || restoreRoute.profile === 'default' || restoreRoute.profile === 'shared') {
      errors.push(`${seat}: valid isolated restorable Hermes profile required`);
    } else if (restoreProfiles.has(restoreRoute.profile)) {
      errors.push(`${seat}: duplicate restorable Hermes profile ${restoreRoute.profile}`);
    } else {
      restoreProfiles.add(restoreRoute.profile);
    }
    if (!canonicalString(restoreRoute.provider) || !providerPattern.test(restoreRoute.provider)) {
      errors.push(`${seat}: valid restorable Hermes provider required`);
    }
    if (!reasoningLevels.has(restoreRoute.reasoning)) errors.push(`${seat}: valid restorable Hermes reasoning required`);
    if (!['native', 'cortextos'].includes(restoreRoute.cron_ownership)) {
      errors.push(`${seat}: valid restorable Hermes cron ownership required`);
    }
  }

  const spendRoute = spendSeats[seat];
  if (!spendRoute || spendRoute.runtime !== route.runtime || spendRoute.model !== route.model
    || (spendRoute.provider ?? null) !== (route.provider ?? null)) {
    errors.push(`${seat}: spend estimate route does not match plan`);
  }
  if (typeof spendRoute?.expected_weekly_usd !== 'number'
    || !Number.isFinite(spendRoute.expected_weekly_usd)
    || spendRoute.expected_weekly_usd < 0) {
    errors.push(`${seat}: expected_weekly_usd must be a finite non-negative number`);
  }
}

const spendTotal = requiredSeats.reduce((total, seat) => total + (
  typeof spendSeats[seat]?.expected_weekly_usd === 'number' ? spendSeats[seat].expected_weekly_usd : 0
), 0);
if (typeof spend?.total_expected_weekly_usd !== 'number'
  || !Number.isFinite(spend.total_expected_weekly_usd)
  || Math.abs(spendTotal - spend.total_expected_weekly_usd) > 0.000001) {
  errors.push('spend total_expected_weekly_usd must equal the per-seat sum');
}

const cutover = plan?.cutover;
if (!sameSet(hermesSeats, requiredHermesSeats)) {
  errors.push(`Hermes routes must be exactly: ${requiredHermesSeats.join(',')}`);
}
const expectedOrder = intendedHermesSeats;
const validateOrder = (label, value) => {
  if (!Array.isArray(value) || value.length !== expectedOrder.length || new Set(value).size !== value.length
    || JSON.stringify([...value].sort()) !== JSON.stringify(expectedOrder)) {
    errors.push(`${label} must contain every Hermes seat exactly once`);
    return false;
  }
  return true;
};
if (!cutover || typeof cutover !== 'object') {
  errors.push('cutover contract is required');
} else {
  if (cutover.canary_seat !== 'city') errors.push('cutover.canary_seat must be city for this fleet');
  if (cutover.coordinator_seat !== 'chief') errors.push('cutover.coordinator_seat must be chief');
  if (validateOrder('cutover.order', cutover.order)) {
    if (cutover.order[0] !== cutover.canary_seat) errors.push('cutover.order must start with the canary seat');
    if (cutover.order.at(-1) !== cutover.coordinator_seat) errors.push('cutover.order must put the coordinator last');
  }
  if (validateOrder('cutover.restore_order', cutover.restore_order)) {
    if (cutover.restore_order[0] !== cutover.canary_seat) errors.push('cutover.restore_order must start with the canary seat');
    if (cutover.restore_order.at(-1) !== cutover.coordinator_seat) errors.push('cutover.restore_order must put the coordinator last');
  }
}

const mcpEvidence = plan?.mcp_evidence && typeof plan.mcp_evidence === 'object' ? plan.mcp_evidence : {};
const cronEvidence = plan?.cron_evidence && typeof plan.cron_evidence === 'object' ? plan.cron_evidence : {};
const usedTranscriptPaths = new Set();
const usedTranscriptHashes = new Set();
const usedUsagePaths = new Set();
const usedUsageHashes = new Set();
const usedInvocations = new Set();
const usedSessions = new Set();
for (const seat of hermesSeats) {
  const route = planSeats[seat];
  const proofs = mcpEvidence[seat];
  for (const rawServer of Array.isArray(route.mcp_required) ? route.mcp_required : []) {
    const server = typeof rawServer === 'string' ? rawServer.trim() : '';
    const proof = proofs?.[server];
    if (!proof || typeof proof !== 'object') {
      errors.push(`${seat}/${server}: MCP readiness proof required`);
      continue;
    }
    if (proof.profile !== route.profile) errors.push(`${seat}/${server}: MCP proof profile mismatch`);
    if (Number.isInteger(evidenceMaxAgeMinutes) && evidenceMaxAgeMinutes >= 1 && evidenceMaxAgeMinutes <= 1440) {
      validateFreshTimestamp(`${seat}/${server}: MCP tested_at_utc`, proof.tested_at_utc, evidenceMaxAgeMinutes, errors);
    } else if (!validIso(proof.tested_at_utc)) {
      errors.push(`${seat}/${server}: MCP tested_at_utc must be an absolute UTC ISO timestamp`);
    }
    if (proof.connected !== true || !Number.isInteger(proof.tools_discovered) || proof.tools_discovered < 1) {
      errors.push(`${seat}/${server}: MCP connection and discovered tools required`);
    }
    const serverToken = server.replace(/[^a-zA-Z0-9_]/g, '_');
    if (!nonEmpty(proof.tool_name) || !proof.tool_name.startsWith(`mcp__${serverToken}__`)) {
      errors.push(`${seat}/${server}: MCP tool name must be bound to required server ${server}`);
    }
    if (!nonEmpty(proof.result_marker)) errors.push(`${seat}/${server}: real MCP result marker required`);
    if (!nonEmpty(proof.invocation_id) || !nonEmpty(proof.session_id)) {
      errors.push(`${seat}/${server}: invocation_id and session_id are required`);
    }
    if (usedInvocations.has(proof.invocation_id)) errors.push(`${seat}/${server}: MCP invocation_id must be globally unique`);
    usedInvocations.add(proof.invocation_id);
    if (usedSessions.has(proof.session_id)) errors.push(`${seat}/${server}: MCP session_id must be globally unique`);
    usedSessions.add(proof.session_id);
    if (!isAbsolute(proof.transcript_file ?? '') || !existsSync(proof.transcript_file ?? '')) {
      errors.push(`${seat}/${server}: readable absolute MCP transcript_file required`);
    } else {
      const transcriptBytes = readBytes(proof.transcript_file);
      const transcriptHash = sha256(transcriptBytes);
      if (!shaPattern.test(proof.transcript_sha256 ?? '') || proof.transcript_sha256 !== transcriptHash) {
        errors.push(`${seat}/${server}: MCP transcript hash mismatch`);
      }
      if (usedTranscriptPaths.has(resolve(proof.transcript_file)) || usedTranscriptHashes.has(transcriptHash)) {
        errors.push(`${seat}/${server}: MCP transcript evidence cannot be reused across seat/server proofs`);
      }
      usedTranscriptPaths.add(resolve(proof.transcript_file));
      usedTranscriptHashes.add(transcriptHash);
      const transcript = readJsonBytes(proof.transcript_file, transcriptBytes);
      if (transcript.schema_version !== 1
        || transcript.seat !== seat
        || transcript.profile !== route.profile
        || transcript.server !== server
        || transcript.invocation_id !== proof.invocation_id
        || transcript.session_id !== proof.session_id
        || transcript.tested_at_utc !== proof.tested_at_utc
        || transcript.tool_name !== proof.tool_name
        || transcript.result_marker !== proof.result_marker
        || transcript.success !== true) {
        errors.push(`${seat}/${server}: transcript bytes are not bound to the exact seat/profile/server/invocation/effect`);
      }
    }
    if (!isAbsolute(proof.usage_file ?? '') || !existsSync(proof.usage_file ?? '')) {
      errors.push(`${seat}/${server}: readable absolute usage_file required`);
    } else {
      const usageBytes = readBytes(proof.usage_file);
      const usageHash = sha256(usageBytes);
      if (!shaPattern.test(proof.usage_sha256 ?? '') || proof.usage_sha256 !== usageHash) {
        errors.push(`${seat}/${server}: usage file hash mismatch`);
      }
      if (usedUsagePaths.has(resolve(proof.usage_file)) || usedUsageHashes.has(usageHash)) {
        errors.push(`${seat}/${server}: MCP usage evidence cannot be reused across seat/server proofs`);
      }
      usedUsagePaths.add(resolve(proof.usage_file));
      usedUsageHashes.add(usageHash);
      const usage = readJsonBytes(proof.usage_file, usageBytes);
      if (usage.schema_version !== 1
        || usage.seat !== seat
        || usage.profile !== route.profile
        || usage.server !== server
        || usage.invocation_id !== proof.invocation_id
        || usage.session_id !== proof.session_id
        || usage.tested_at_utc !== proof.tested_at_utc
        || usage.model !== route.model
        || usage.provider !== route.provider
        || usage.completed !== true
        || usage.failed !== false) {
        errors.push(`${seat}/${server}: usage receipt is not bound to the exact successful pinned invocation`);
      }
    }
  }

  const cron = cronEvidence[seat];
  if (!cron || typeof cron !== 'object') {
    errors.push(`${seat}: native cron scan evidence required`);
  } else {
    if (cron.profile !== route.profile) errors.push(`${seat}: native cron scan profile mismatch`);
    if (Number.isInteger(evidenceMaxAgeMinutes) && evidenceMaxAgeMinutes >= 1 && evidenceMaxAgeMinutes <= 1440) {
      validateFreshTimestamp(`${seat}: native cron checked_at_utc`, cron.checked_at_utc, evidenceMaxAgeMinutes, errors);
    } else if (!validIso(cron.checked_at_utc)) {
      errors.push(`${seat}: native cron checked_at_utc must be an absolute UTC ISO timestamp`);
    }
    if (cron.enabled_native_jobs !== 0) errors.push(`${seat}: enabled native Hermes crons collide with cortextOS ownership`);
    const canonicalJobsPath = join(canonicalProfilesRoot, route.profile, 'cron', 'jobs.json');
    if (cron.jobs_path !== canonicalJobsPath) {
      errors.push(`${seat}: native cron jobs_path must equal canonical profile path ${canonicalJobsPath}`);
    }
    if (existsSync(canonicalJobsPath)) {
      const jobBytes = readBytes(canonicalJobsPath);
      if (!shaPattern.test(cron.jobs_sha256 ?? '') || cron.jobs_sha256 !== sha256(jobBytes)) {
        errors.push(`${seat}: native cron jobs hash mismatch`);
      }
      try {
        const parsed = JSON.parse(jobBytes.toString('utf8').replace(/^\uFEFF/, ''));
        const active = Array.isArray(parsed.jobs)
          ? parsed.jobs.filter((job) => !job || typeof job !== 'object' || (job.enabled !== false && job.state !== 'paused')).length
          : -1;
        if (active !== 0) errors.push(`${seat}: native cron jobs file is invalid or contains enabled jobs`);
      } catch {
        errors.push(`${seat}: native cron jobs file is invalid JSON`);
      }
    } else if (cron.jobs_sha256 !== 'absent') {
      errors.push(`${seat}: absent native cron file must use jobs_sha256=absent`);
    }
  }
}

if (errors.length > 0) {
  console.error(JSON.stringify({ ok: false, errors }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  trigger_percent: canonicalRemainingPercent,
  trigger_observed_at_utc: canonicalUsage.fetched_at,
  trigger_source: canonicalTriggerSource,
  trigger_receipt_sha256: triggerBinding.sha256,
  restore_occurrence_utc: plan.restore.occurrence_utc,
  restore_snapshot_sha256: binding.sha256,
  fleet_snapshot_sha256: fleetBinding.sha256,
  total_expected_weekly_usd: spend.total_expected_weekly_usd,
  seats: planNames.length,
  hermes_profiles: profiles.size,
  mcp_receipts: hermesSeats.reduce((count, seat) => count + planSeats[seat].mcp_required.length, 0),
  native_cron_collisions: 0,
  canary: cutover.canary_seat,
  coordinator_last: cutover.coordinator_seat,
  live_changes: 0,
}, null, 2));
