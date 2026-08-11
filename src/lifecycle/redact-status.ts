import { randomUUID } from 'crypto';
import type {
  CountBucket,
  LifecycleStatusSnapshot,
  RedactedLifecycleStatusSnapshot,
} from './status-types.js';

export function countBucket(value: number | null): CountBucket | null {
  if (value === null) return null;
  if (value === 0) return '0';
  if (value === 1) return '1';
  if (value <= 5) return '2-5';
  if (value <= 20) return '6-20';
  if (value <= 100) return '21-100';
  return '>100';
}

export function redactLifecycleStatus(
  snapshot: LifecycleStatusSnapshot,
  reportId: string = randomUUID(),
): RedactedLifecycleStatusSnapshot {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reportId)) {
    throw new Error('Invalid generated report identifier');
  }
  const { profile: _profile, ...isolation } = snapshot.runtime.isolation;
  return {
    schema_version: 'cortext.status.redacted/v1',
    ok: true,
    report_id: reportId,
    observed_day: `${snapshot.observed_at.slice(0, 10)}Z`,
    snapshot_status: snapshot.snapshot_status,
    scope: {
      instance_alias: 'instance_1',
      target_kind: snapshot.scope.target_kind,
      layout_kind: snapshot.scope.layout_kind,
    },
    manager: {
      version: snapshot.manager.version,
      installation_status: 'legacy_bridge',
      integrity: 'unverified',
      trust_status: 'unsupported',
      recovery_launcher_status: 'unsupported',
    },
    capabilities: {
      profile: 'legacy_bridge_v1',
      supported: [...snapshot.capabilities.supported],
      unsupported: [...snapshot.capabilities.unsupported],
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
      version: snapshot.application.version,
      public_release_id: null,
      public_source_commit: null,
      channel: null,
      integrity: 'unverified',
    },
    instance: {
      instance_alias: 'instance_1',
      config_schema: null,
      config_status: 'unknown',
      versioning: snapshot.instance.versioning,
      remote_status: snapshot.instance.remote_status,
      portability: 'unknown',
    },
    state: {
      schema_version: null,
      status: snapshot.state.status,
      migration_status: 'unknown',
    },
    components: {
      lock_status: 'unsupported',
      declared_count_bucket: null,
      resolved_count_bucket: null,
      drift: 'unknown',
    },
    runtime: {
      daemon_status: snapshot.runtime.daemon.status,
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
      isolation,
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
      status: snapshot.overall.status,
      highest_severity: snapshot.overall.highest_severity,
    },
    check: snapshot.check ? {
      policy: snapshot.check.policy,
      policy_version: snapshot.check.policy_version,
      result: snapshot.check.result,
      reason_codes: [...snapshot.check.reason_codes],
    } : null,
    observations: snapshot.observations.map(observation => ({
      code: observation.code,
      severity: observation.severity,
      domain: observation.domain,
      recommended_operation: observation.recommended_operation,
    })),
  };
}
