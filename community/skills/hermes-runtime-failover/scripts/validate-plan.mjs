#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

const args = process.argv.slice(2);
const valueFor = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

const planPath = valueFor('--plan');
const restorePath = valueFor('--restore');
if (!planPath || !restorePath) {
  console.error('Usage: validate-plan.mjs --plan <plan.json> --restore <RESTORE-STATE.json>');
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
const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const validIso = (value) => nonEmpty(value) && isoPattern.test(value) && Number.isFinite(Date.parse(value));
const shaPattern = /^[a-f0-9]{64}$/;
const fixedModelPattern = /^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/;
const profilePattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const providerPattern = /^[a-zA-Z0-9._-]+$/;
const mcpNamePattern = /^[a-zA-Z0-9._-]+$/;
const reasoningLevels = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const runtimes = new Set(['claude-code', 'hermes', 'codex-app-server', 'opencode']);
const isMovingModelAlias = (value) => typeof value === 'string'
  && (value.startsWith('~') || /(?:^|[\/._-])(latest|auto)(?:$|[\/._-])/i.test(value));
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
const plan = readJsonBytes(planPath, planBytes);
const restore = readJsonBytes(restorePath, restoreBytes);
const errors = [];
const profiles = new Set();
const evidenceMaxAgeMinutes = plan?.evidence_max_age_minutes;

if (!Number.isInteger(evidenceMaxAgeMinutes) || evidenceMaxAgeMinutes < 1 || evidenceMaxAgeMinutes > 1440) {
  errors.push('evidence_max_age_minutes must be an integer from 1 to 1440');
}

if (plan?.live_changes !== 0) errors.push('live_changes must be exactly 0 before approval');
if (plan?.trigger?.metric !== 'claude_weekly_remaining_percent') {
  errors.push('trigger.metric must be claude_weekly_remaining_percent');
}
if (plan?.trigger?.at_or_below !== 10) errors.push('trigger.at_or_below must be exactly 10');
if (plan?.trigger?.denominator !== 'percent_remaining') errors.push('trigger.denominator must be percent_remaining');
if (!nonEmpty(plan?.trigger?.source)) errors.push('trigger.source is required');
if (typeof plan?.trigger?.observed_value !== 'number'
  || !Number.isFinite(plan.trigger.observed_value)
  || plan.trigger.observed_value < 0
  || plan.trigger.observed_value > 100) {
  errors.push('trigger.observed_value must be a number from 0 to 100');
} else if (plan.trigger.observed_value > 10) {
  errors.push('trigger.observed_value is above the 10 percent failover threshold');
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
  if (!nonEmpty(binding.captured_from)) errors.push('restore_snapshot.captured_from is required');
}
if (restore?.schema_version !== 1) errors.push('restore.schema_version must be 1');
if (Number.isInteger(evidenceMaxAgeMinutes) && evidenceMaxAgeMinutes >= 1 && evidenceMaxAgeMinutes <= 1440) {
  validateFreshTimestamp('restore.taken_at_utc', restore?.taken_at_utc, evidenceMaxAgeMinutes, errors);
} else if (!validIso(restore?.taken_at_utc)) {
  errors.push('restore.taken_at_utc must be an absolute UTC ISO timestamp');
}
if (!nonEmpty(restore?.reason)) errors.push('restore.reason is required');
if (!nonEmpty(restore?.captured_from)) errors.push('restore.captured_from is required');
if (!validIso(restore?.restore_at_utc)) errors.push('restore.restore_at_utc must be an absolute UTC ISO timestamp');
if (binding?.taken_at_utc !== restore?.taken_at_utc) errors.push('restore snapshot taken_at_utc provenance mismatch');
if (binding?.reason !== restore?.reason) errors.push('restore snapshot reason provenance mismatch');
if (binding?.captured_from !== restore?.captured_from) errors.push('restore snapshot source provenance mismatch');
if (plan?.restore?.occurrence_utc !== restore?.restore_at_utc) errors.push('restore occurrence does not match snapshot');

const planSeats = plan?.seats && typeof plan.seats === 'object' && !Array.isArray(plan.seats) ? plan.seats : {};
const restoreSeats = restore?.seats && typeof restore.seats === 'object' && !Array.isArray(restore.seats) ? restore.seats : {};
const planNames = Object.keys(planSeats).sort();
const restoreNames = Object.keys(restoreSeats).sort();
if (planNames.length === 0) errors.push('plan.seats must not be empty');
if (JSON.stringify(planNames) !== JSON.stringify(restoreNames)) {
  errors.push(`seat sets differ: plan=[${planNames.join(',')}] restore=[${restoreNames.join(',')}]`);
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
    if (!nonEmpty(route.model) || !fixedModelPattern.test(route.model.trim())) errors.push(`${seat}: valid fixed model required`);
    if (isMovingModelAlias(route.model)) errors.push(`${seat}: moving model alias forbidden (${route.model})`);
    if (!nonEmpty(route.provider) || !providerPattern.test(route.provider.trim())) errors.push(`${seat}: valid provider required`);
    if (!reasoningLevels.has(route.reasoning)) errors.push(`${seat}: invalid reasoning ${route.reasoning}`);
    if (route.cron_ownership !== 'cortextos') errors.push(`${seat}: cron_ownership must be cortextos for this fleet`);
    if (!Array.isArray(route.mcp_required) || route.mcp_required.length === 0) {
      errors.push(`${seat}: mcp_required must be a non-empty array`);
    } else {
      const unique = new Set();
      for (const server of route.mcp_required) {
        if (!nonEmpty(server) || !mcpNamePattern.test(server.trim())) errors.push(`${seat}: invalid MCP server name`);
        if (unique.has(server)) errors.push(`${seat}: duplicate MCP server ${server}`);
        unique.add(server);
      }
    }
  } else if (route.runtime === 'codex-app-server') {
    if (!nonEmpty(route.model) || !fixedModelPattern.test(route.model.trim())) errors.push(`${seat}: valid Codex model required`);
    if (isMovingModelAlias(route.model)) errors.push(`${seat}: moving model alias forbidden (${route.model})`);
  } else {
    errors.push(`${seat}: unsupported failover runtime ${route.runtime}`);
  }

  const restoreRoute = restoreSeats[seat];
  if (!restoreRoute || !runtimes.has(restoreRoute.runtime)) errors.push(`${seat}: invalid or missing restorable runtime`);
  if (!nonEmpty(restoreRoute?.model) || !fixedModelPattern.test(restoreRoute.model.trim())) errors.push(`${seat}: valid restorable model required`);
  if (isMovingModelAlias(restoreRoute?.model)) errors.push(`${seat}: moving restorable model alias forbidden (${restoreRoute.model})`);
  if (!shaPattern.test(restoreRoute?.config_sha256 ?? '')) errors.push(`${seat}: restore config_sha256 required`);
  if (restoreRoute?.runtime === 'hermes') {
    if (!profilePattern.test(restoreRoute.profile ?? '') || restoreRoute.profile === 'default' || restoreRoute.profile === 'shared') {
      errors.push(`${seat}: valid isolated restorable Hermes profile required`);
    } else if (restoreProfiles.has(restoreRoute.profile)) {
      errors.push(`${seat}: duplicate restorable Hermes profile ${restoreRoute.profile}`);
    } else {
      restoreProfiles.add(restoreRoute.profile);
    }
    if (!nonEmpty(restoreRoute.provider) || !providerPattern.test(restoreRoute.provider.trim())) {
      errors.push(`${seat}: valid restorable Hermes provider required`);
    }
    if (!reasoningLevels.has(restoreRoute.reasoning)) errors.push(`${seat}: valid restorable Hermes reasoning required`);
    if (!['native', 'cortextos'].includes(restoreRoute.cron_ownership)) {
      errors.push(`${seat}: valid restorable Hermes cron ownership required`);
    }
  }
}

const cutover = plan?.cutover;
const expectedOrder = [...hermesSeats].sort();
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
for (const seat of hermesSeats) {
  const route = planSeats[seat];
  const proofs = mcpEvidence[seat];
  for (const server of Array.isArray(route.mcp_required) ? route.mcp_required : []) {
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
    if (!nonEmpty(proof.tool_name) || !proof.tool_name.startsWith('mcp__')) errors.push(`${seat}/${server}: real MCP tool name required`);
    if (!nonEmpty(proof.result_marker)) errors.push(`${seat}/${server}: real MCP result marker required`);
    if (!isAbsolute(proof.transcript_file ?? '') || !existsSync(proof.transcript_file ?? '')) {
      errors.push(`${seat}/${server}: readable absolute MCP transcript_file required`);
    } else {
      const transcriptBytes = readBytes(proof.transcript_file);
      if (!shaPattern.test(proof.transcript_sha256 ?? '') || proof.transcript_sha256 !== sha256(transcriptBytes)) {
        errors.push(`${seat}/${server}: MCP transcript hash mismatch`);
      }
      const transcript = transcriptBytes.toString('utf8');
      if (!nonEmpty(proof.tool_name) || !nonEmpty(proof.result_marker)
        || !transcript.includes(proof.tool_name) || !transcript.includes(proof.result_marker)) {
        errors.push(`${seat}/${server}: transcript does not contain the required tool and result effect`);
      }
    }
    if (!isAbsolute(proof.usage_file ?? '') || !existsSync(proof.usage_file ?? '')) {
      errors.push(`${seat}/${server}: readable absolute usage_file required`);
    } else {
      const usageBytes = readBytes(proof.usage_file);
      if (!shaPattern.test(proof.usage_sha256 ?? '') || proof.usage_sha256 !== sha256(usageBytes)) {
        errors.push(`${seat}/${server}: usage file hash mismatch`);
      }
      const usage = readJsonBytes(proof.usage_file, usageBytes);
      if (usage.model !== route.model || usage.provider !== route.provider || usage.completed !== true || usage.failed !== false) {
        errors.push(`${seat}/${server}: usage receipt does not prove the pinned successful route`);
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
    if (!isAbsolute(cron.jobs_path ?? '')) errors.push(`${seat}: native cron jobs_path must be absolute`);
    else if (existsSync(cron.jobs_path)) {
      const jobBytes = readBytes(cron.jobs_path);
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
  trigger_percent: plan.trigger.observed_value,
  trigger_observed_at_utc: plan.trigger.observed_at_utc,
  restore_occurrence_utc: plan.restore.occurrence_utc,
  restore_snapshot_sha256: binding.sha256,
  seats: planNames.length,
  hermes_profiles: profiles.size,
  mcp_receipts: hermesSeats.reduce((count, seat) => count + planSeats[seat].mcp_required.length, 0),
  native_cron_collisions: 0,
  canary: cutover.canary_seat,
  coordinator_last: cutover.coordinator_seat,
  live_changes: 0,
}, null, 2));
