import { randomUUID } from 'crypto';
import { CORTEXTOS_VERSION } from '../version.js';
import {
  LEGACY_STATUS_OBSERVATIONS,
  LEGACY_SUPPORTED_CAPABILITIES,
  LEGACY_UNSUPPORTED_CAPABILITIES,
  STATUS_CHECK_POLICIES,
  STATUS_CHECK_REASON_CODES,
  type LegacyStatusObservationCode,
} from './status-contract.js';
import type {
  CountBucket,
  LifecycleStatusSnapshot,
  RedactedLifecycleStatusSnapshot,
  StatusCheckPolicy,
  StatusCheckReasonCode,
  StatusCheckResult,
  StatusSeverity,
} from './status-types.js';

export function countBucket(value: number | null): CountBucket | null {
  if (value === null || !Number.isSafeInteger(value) || value < 0) return null;
  if (value === 0) return '0';
  if (value === 1) return '1';
  if (value <= 5) return '2-5';
  if (value <= 20) return '6-20';
  if (value <= 100) return '21-100';
  return '>100';
}

function closedValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === 'string' && allowed.includes(value as T) ? value as T : fallback;
}

function redactCheck(check: LifecycleStatusSnapshot['check']): StatusCheckResult | null {
  if (!check || !STATUS_CHECK_POLICIES.includes(check.policy as StatusCheckPolicy)) return null;
  const policy = check.policy as StatusCheckPolicy;
  if (check.policy_version !== `cortext.check.${policy}/v1`) return null;
  if (!Array.isArray(check.reason_codes)
    || check.reason_codes.some(code => !STATUS_CHECK_REASON_CODES.includes(code as StatusCheckReasonCode))
    || new Set(check.reason_codes).size !== check.reason_codes.length) return null;
  if (check.result === 'pass' && check.reason_codes.length === 0) {
    return {
      policy,
      policy_version: `cortext.check.${policy}/v1`,
      result: 'pass',
      reason_codes: [],
    } as StatusCheckResult;
  }
  if (check.result === 'fail' && check.reason_codes.length > 0) {
    return {
      policy,
      policy_version: `cortext.check.${policy}/v1`,
      result: 'fail',
      reason_codes: [...check.reason_codes] as [StatusCheckReasonCode, ...StatusCheckReasonCode[]],
    } as StatusCheckResult;
  }
  return null;
}

export function redactLifecycleStatus(
  snapshot: LifecycleStatusSnapshot,
  reportId: string = randomUUID(),
): RedactedLifecycleStatusSnapshot {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reportId)) {
    throw new Error('Invalid generated report identifier');
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(snapshot.observed_at)
    || !Number.isFinite(Date.parse(snapshot.observed_at))) {
    throw new Error('Invalid lifecycle observation timestamp');
  }
  const observations = snapshot.observations.flatMap(observation => {
    if (!Object.prototype.hasOwnProperty.call(LEGACY_STATUS_OBSERVATIONS, observation.code)) return [];
    const code = observation.code as LegacyStatusObservationCode;
    const metadata = LEGACY_STATUS_OBSERVATIONS[code];
    return [{
      code,
      severity: metadata.severity,
      domain: metadata.domain,
      recommended_operation: metadata.recommended_operation,
    }];
  });
  return {
    schema_version: 'cortext.status.redacted/v1',
    ok: true,
    report_id: reportId,
    observed_day: `${snapshot.observed_at.slice(0, 10)}Z`,
    snapshot_status: closedValue(snapshot.snapshot_status, ['complete', 'partial'], 'partial'),
    scope: {
      instance_alias: 'instance_1',
      target_kind: closedValue(snapshot.scope.target_kind, ['live', 'sandbox', 'unknown'], 'unknown'),
      layout_kind: closedValue(snapshot.scope.layout_kind, ['legacy_combined', 'unknown'], 'unknown'),
    },
    manager: {
      version: CORTEXTOS_VERSION,
      installation_status: 'legacy_bridge',
      integrity: 'unverified',
      trust_status: 'unsupported',
      recovery_launcher_status: 'unsupported',
    },
    capabilities: {
      profile: 'legacy_bridge_v1',
      supported: [...LEGACY_SUPPORTED_CAPABILITIES],
      unsupported: [...LEGACY_UNSUPPORTED_CAPABILITIES],
    },
    basis: {
      lifecycle_generation_present: false,
      writer_epoch_present: false,
      trust_metadata_present: false,
      compatibility_matrix_present: false,
      public_release_id: null,
      config_revision_alias: null,
      config_observation_digest_present: false,
      state_schema: null,
      state_layout_generation_present: false,
      state_control_observation_digest_present: false,
      component_lock_present: false,
    },
    consistency: { status: 'unsupported' },
    device: {
      identity_status: 'absent',
      device_alias: null,
      writer_role: 'unknown',
      lease_status: 'unsupported',
    },
    application: {
      version: snapshot.application.version === CORTEXTOS_VERSION ? CORTEXTOS_VERSION : null,
      public_release_id: null,
      public_source_commit: null,
      channel: null,
      integrity: 'unverified',
    },
    instance: {
      instance_alias: 'instance_1',
      config_schema: null,
      config_status: 'unknown',
      versioning: closedValue(snapshot.instance.versioning, ['git', 'unversioned', 'unknown'], 'unknown'),
      remote_status: closedValue(
        snapshot.instance.remote_status,
        ['none', 'configured_unverified', 'unknown'],
        'unknown',
      ),
      portability: 'unknown',
    },
    state: {
      schema_version: null,
      status: closedValue(snapshot.state.status, ['readable', 'missing', 'unreadable', 'unknown'], 'unknown'),
      migration_status: 'unknown',
    },
    components: {
      lock_status: 'unsupported',
      declared_count_bucket: null,
      resolved_count_bucket: null,
      drift: 'unknown',
    },
    runtime: {
      daemon_status: closedValue(
        snapshot.runtime.daemon.status,
        ['running', 'stopped', 'unresponsive', 'unknown'],
        'unknown',
      ),
      dashboard_status: 'unknown',
      agent_count_bucket: countBucket(snapshot.runtime.agents.configured),
      observed_process_count_bucket: countBucket(snapshot.runtime.agents.observed_processes),
      active_process_count_bucket: countBucket(snapshot.runtime.agents.active_processes),
      degraded_agent_count_bucket: countBucket(snapshot.runtime.agents.degraded),
      expected_missing_count_bucket: countBucket(snapshot.runtime.agents.expected_missing),
      disabled_active_count_bucket: countBucket(snapshot.runtime.agents.disabled_active),
      unregistered_active_count_bucket: countBucket(snapshot.runtime.agents.unregistered_active),
      poller_count_bucket: null,
      duplicate_poller_count_bucket: null,
      cron_count_bucket: null,
      isolation: {
        boundary: 'none',
        data_roots: 'live',
        process_namespace: 'live',
        managed_integrations: 'unknown',
        credentials: 'unknown',
        network: 'unrestricted',
        host_access: 'full',
        claim: 'none',
        evidence_codes: [],
      },
    },
    recovery: {
      checkpoint_alias: null,
      checkpoint_age_bucket: null,
      checkpoint_verification: 'unknown',
      backup_alias: null,
      backup_age_bucket: null,
      backup_verification: 'unknown',
      rollback_status: 'unknown',
    },
    updates: {
      channel: null,
      availability: 'not_checked',
      checked_age_bucket: null,
    },
    compatibility: { status: 'unknown', reason_codes: [] },
    overall: {
      status: closedValue(
        snapshot.overall.status,
        ['healthy', 'degraded', 'stopped', 'migrating', 'blocked', 'uninitialized', 'unknown'],
        'unknown',
      ),
      highest_severity: snapshot.overall.highest_severity === null
        ? null
        : closedValue<StatusSeverity>(
          snapshot.overall.highest_severity,
          ['info', 'warning', 'error', 'critical'],
          'critical',
        ),
    },
    check: redactCheck(snapshot.check),
    observations,
  };
}
