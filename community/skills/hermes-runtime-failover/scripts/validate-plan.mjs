#!/usr/bin/env node

import { readFileSync } from 'node:fs';

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

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    console.error(`Cannot read JSON ${path}: ${error.message}`);
    process.exit(2);
  }
};

const plan = readJson(planPath);
const restore = readJson(restorePath);
const errors = [];
const profiles = new Set();
const profilePattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const reasoningLevels = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

if (plan?.trigger?.metric !== 'claude_weekly_remaining_percent') {
  errors.push('trigger.metric must be claude_weekly_remaining_percent');
}
if (plan?.trigger?.at_or_below !== 10) {
  errors.push('trigger.at_or_below must be exactly 10');
}
if (plan?.restore?.timezone !== 'America/Chicago'
  || plan?.restore?.day !== 'Sunday'
  || plan?.restore?.time !== '15:00') {
  errors.push('restore contract must be Sunday 15:00 America/Chicago');
}

const planSeats = plan?.seats && typeof plan.seats === 'object' ? plan.seats : {};
const restoreSeats = restore?.seats && typeof restore.seats === 'object' ? restore.seats : {};
const planNames = Object.keys(planSeats).sort();
const restoreNames = Object.keys(restoreSeats).sort();
if (JSON.stringify(planNames) !== JSON.stringify(restoreNames)) {
  errors.push(`seat sets differ: plan=[${planNames.join(',')}] restore=[${restoreNames.join(',')}]`);
}

for (const [seat, route] of Object.entries(planSeats)) {
  if (route.runtime === 'hermes') {
    if (!profilePattern.test(route.profile ?? '')) errors.push(`${seat}: invalid or missing profile`);
    if (route.profile === 'default' || route.profile === 'shared') errors.push(`${seat}: shared profile forbidden`);
    if (profiles.has(route.profile)) errors.push(`${seat}: duplicate profile ${route.profile}`);
    profiles.add(route.profile);
    if (typeof route.model !== 'string' || route.model.length === 0) errors.push(`${seat}: model required`);
    if (route.model?.startsWith('~')) errors.push(`${seat}: moving model alias forbidden (${route.model})`);
    if (typeof route.provider !== 'string' || route.provider.length === 0) errors.push(`${seat}: provider required`);
    if (!reasoningLevels.has(route.reasoning)) errors.push(`${seat}: invalid reasoning ${route.reasoning}`);
    if (route.cron_ownership !== 'cortextos') errors.push(`${seat}: cron_ownership must be cortextos for this fleet`);
    if (!Array.isArray(route.mcp_required)) errors.push(`${seat}: mcp_required must be an array`);
  } else if (route.runtime === 'codex-app-server') {
    if (typeof route.model !== 'string' || route.model.length === 0) errors.push(`${seat}: Codex model required`);
  } else {
    errors.push(`${seat}: unsupported failover runtime ${route.runtime}`);
  }

  const restoreRoute = restoreSeats[seat];
  if (!restoreRoute || typeof restoreRoute.runtime !== 'string') {
    errors.push(`${seat}: missing restorable runtime`);
  }
}

if (errors.length > 0) {
  console.error(JSON.stringify({ ok: false, errors }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  trigger_percent: 10,
  restore_contract: 'Sunday 15:00 America/Chicago',
  seats: planNames.length,
  hermes_profiles: profiles.size,
  live_changes: 0,
}, null, 2));

