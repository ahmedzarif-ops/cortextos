/**
 * The anti-forgery core of the plan validator, extracted as a PURE function.
 *
 * WHY THIS FILE EXISTS. When the fetch-injection fixture was removed (it was
 * the same mechanism as guard blocker 1 on 9dba452), the only route by which a
 * test could reach a SUCCESSFUL usage read went with it — and this region is
 * everything that runs on success: origin check, utilization validity, the
 * plan/receipt value comparisons, and fetched_at freshness/contemporaneity.
 * Guard's adversarial pass then landed seven surviving mutants here while the
 * suite stayed green. A comment saying "this is now untested" is not coverage.
 *
 * The repair is structural, not a seam: this function TAKES THE USAGE OBJECT AS
 * AN ARGUMENT. A unit test may fabricate that argument freely, because at this
 * layer usage is an input, not a claim about the world. Nothing here decides
 * whether the usage is trustworthy — launch-trusted-usage-read.mjs does that,
 * outside any caller-controlled surface. So there is no test-only branch, no
 * env seam and no production backdoor: the parameter is honest structure.
 */
export const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;

const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
export const validIso = (value) => nonEmpty(value) && isoPattern.test(value) && Number.isFinite(Date.parse(value));

/**
 * CANONICAL COPY. This file is the single definition site for nonEmpty,
 * validIso and validateFreshTimestamp; validate-plan.mjs imports them and its
 * local duplicates are deleted.
 *
 * WHICH SIGNATURE WINS, AND WHY: the five-parameter form with an INJECTABLE
 * `nowMs`, defaulting to Date.now(). The two copies had already diverged — this
 * one took nowMs, validate-plan.mjs's read Date.now() internally — and the
 * divergence is precisely why the duplicate had to go: two validators that
 * silently stop agreeing is a worse failure than either behaviour.
 *
 * NO BEHAVIOUR CHANGE AT THE SIX EXISTING CALL SITES, and this was VERIFIED
 * rather than assumed: fleet_snapshot, spend_snapshot, restore_snapshot,
 * restore, MCP and native-cron all call it with FOUR arguments, so `nowMs`
 * falls back to Date.now() evaluated at call time — identical to the deleted
 * copy. The extra parameter buys deterministic tests; it changes nothing for
 * any caller that does not pass it.
 */
export const validateFreshTimestamp = (label, value, maxAgeMinutes, errors, nowMs = Date.now()) => {
  if (!validIso(value)) {
    errors.push(`${label} must be an absolute UTC ISO timestamp`);
    return;
  }
  const ageMs = nowMs - Date.parse(value);
  if (ageMs < -5 * 60_000 || ageMs > maxAgeMinutes * 60_000) {
    errors.push(`${label} is stale or future-dated (max ${maxAgeMinutes} minutes)`);
  }
};

/**
 * @returns {{errors: string[], canonicalRemainingPercent: number|undefined}}
 *   `errors` is APPENDED to, never thrown — the caller aggregates.
 */
export const evaluateCanonicalUsage = ({
  usage,
  plan,
  triggerReceipt,
  maxAgeMinutes,
  usageApiEndpoint,
  nowMs = Date.now(),
}) => {
  const errors = [];
  let canonicalRemainingPercent;

  if (!usage) return { errors, canonicalRemainingPercent };

  const originIsAuthenticated = usage.provider === 'anthropic'
    && usage.endpoint === usageApiEndpoint
    && usage.authentication === 'oauth-bearer'
    && usage.cached === false
    && nonEmpty(usage.account);
  if (!originIsAuthenticated) {
    errors.push('usage measurement is unauthenticated, cached, or from an unexpected origin');
  }

  const fiveHour = usage.five_hour_utilization;
  const sevenDay = usage.seven_day_utilization;
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

  if (!validIso(usage.fetched_at)) {
    errors.push('authenticated usage measurement fetched_at is missing or invalid');
  } else if (Number.isInteger(maxAgeMinutes) && maxAgeMinutes >= 1 && maxAgeMinutes <= 60) {
    validateFreshTimestamp('authenticated usage measurement fetched_at', usage.fetched_at, maxAgeMinutes, errors, nowMs);
    if (validIso(plan?.trigger?.observed_at_utc)
      && Math.abs(Date.parse(usage.fetched_at) - Date.parse(plan.trigger.observed_at_utc)) > maxAgeMinutes * 60_000) {
      errors.push('trigger.observed_at_utc is not contemporaneous with authenticated usage measurement');
    }
  }

  return { errors, canonicalRemainingPercent };
};

/**
 * The accept output. Extracted for the same reason: guard's M1 (`canary`
 * replaced) and M2 (`trigger_percent: 999`) both survived because nothing could
 * reach this block.
 */
export const buildAcceptOutput = ({
  canonicalRemainingPercent, usage, canonicalTriggerSource, triggerBinding,
  plan, binding, fleetBinding, spend, planNames, profiles, mcpReceipts, cutover,
}) => ({
  ok: true,
  trigger_percent: canonicalRemainingPercent,
  trigger_observed_at_utc: usage.fetched_at,
  trigger_source: canonicalTriggerSource,
  trigger_receipt_sha256: triggerBinding.sha256,
  restore_occurrence_utc: plan.restore.occurrence_utc,
  restore_snapshot_sha256: binding.sha256,
  fleet_snapshot_sha256: fleetBinding.sha256,
  total_expected_weekly_usd: spend.total_expected_weekly_usd,
  seats: planNames.length,
  hermes_profiles: profiles.size,
  mcp_receipts: mcpReceipts,
  native_cron_collisions: 0,
  canary: cutover.canary_seat,
  coordinator_last: cutover.coordinator_seat,
  live_changes: 0,
});
