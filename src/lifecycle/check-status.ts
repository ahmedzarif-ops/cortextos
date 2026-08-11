import type {
  LifecycleStatusSnapshot,
  StatusCheckPolicy,
  StatusCheckReasonCode,
  StatusCheckResult,
} from './status-types.js';

const POLICIES: readonly StatusCheckPolicy[] = [
  'usable',
  'healthy',
  'update-safe',
  'sandbox-namespace',
  'security-contained',
] as const;

const NAMESPACE_EVIDENCE = [
  'CORTEXT_ISOLATION_LIVE_ROOT_DISJOINT',
  'CORTEXT_ISOLATION_PROCESS_NAMESPACE_DISJOINT',
  'CORTEXT_ISOLATION_MANAGED_INTEGRATIONS_ROUTED',
] as const;

const CONTAINMENT_EVIDENCE = [
  ...NAMESPACE_EVIDENCE,
  'CORTEXT_ISOLATION_BOUNDARY_ENFORCED',
  'CORTEXT_ISOLATION_HOST_CREDENTIALS_UNAVAILABLE',
  'CORTEXT_ISOLATION_EGRESS_POLICY_ENFORCED',
  'CORTEXT_ISOLATION_HOST_ACCESS_CONSTRAINED',
] as const;

export class UnsupportedStatusCheckPolicyError extends Error {
  constructor() {
    super('CORTEXT_STATUS_UNSUPPORTED_CHECK_POLICY');
  }
}

export function normalizeStatusCheckPolicy(input: string): StatusCheckPolicy {
  const normalized = input.endsWith('@v1') ? input.slice(0, -3) : input;
  if (!POLICIES.includes(normalized as StatusCheckPolicy)) {
    throw new UnsupportedStatusCheckPolicyError();
  }
  return normalized as StatusCheckPolicy;
}

function hasObservation(snapshot: LifecycleStatusSnapshot, code: string): boolean {
  return snapshot.observations.some(observation => observation.code === code);
}

function hasEvidence(snapshot: LifecycleStatusSnapshot, required: readonly string[]): boolean {
  const present = new Set(snapshot.runtime.isolation.evidence_codes);
  return required.every(code => present.has(code));
}

function addReason(
  reasons: StatusCheckReasonCode[],
  failed: boolean,
  code: StatusCheckReasonCode,
): void {
  if (failed && !reasons.includes(code)) reasons.push(code);
}

function evaluateUsable(
  snapshot: LifecycleStatusSnapshot,
  reasons: StatusCheckReasonCode[],
): void {
  addReason(reasons, snapshot.snapshot_status !== 'complete', 'CORTEXT_CHECK_SNAPSHOT_INCOMPLETE');
  addReason(reasons, !snapshot.scope.resolved_instance_id, 'CORTEXT_CHECK_INSTANCE_UNRESOLVED');
  addReason(
    reasons,
    ['blocked', 'migrating', 'unknown', 'uninitialized'].includes(snapshot.overall.status),
    'CORTEXT_CHECK_OVERALL_DISALLOWED',
  );
  const readable = snapshot.state.status === 'readable'
    || (snapshot.state.status === 'missing'
      && hasObservation(snapshot, 'CORTEXT_STATUS_INSTANCE_NEVER_STARTED'));
  addReason(reasons, !readable, 'CORTEXT_CHECK_STATE_NOT_READABLE');
}

function evaluateHealthy(
  snapshot: LifecycleStatusSnapshot,
  reasons: StatusCheckReasonCode[],
): void {
  addReason(reasons, snapshot.snapshot_status !== 'complete', 'CORTEXT_CHECK_SNAPSHOT_INCOMPLETE');
  const stable = snapshot.consistency.status === 'stable'
    || (snapshot.capabilities.profile === 'legacy_bridge_v1'
      && snapshot.consistency.status === 'unsupported');
  addReason(reasons, !stable, 'CORTEXT_CHECK_CONSISTENCY_UNSTABLE');
  addReason(reasons, snapshot.overall.status !== 'healthy', 'CORTEXT_CHECK_OVERALL_DISALLOWED');
  addReason(
    reasons,
    snapshot.overall.highest_severity !== null && snapshot.overall.highest_severity !== 'info',
    'CORTEXT_CHECK_LIFECYCLE_ERROR_PRESENT',
  );
}

function managedBasisComplete(snapshot: LifecycleStatusSnapshot): boolean {
  const basis = snapshot.basis;
  return basis.instance_id !== null
    && basis.manager_version !== null
    && basis.trust_metadata_revision !== null
    && basis.compatibility_matrix_revision !== null
    && basis.lifecycle_generation !== null
    && basis.writer_epoch !== null
    && basis.selected_release_id !== null
    && basis.config_revision !== null
    && basis.observation_manifest_version !== null
    && basis.config_observation_digest !== null
    && basis.state_schema !== null
    && basis.state_layout_generation !== null
    && basis.state_control_observation_digest !== null
    && basis.component_lock_revision !== null;
}

function evaluateUpdateSafe(
  snapshot: LifecycleStatusSnapshot,
  reasons: StatusCheckReasonCode[],
): void {
  addReason(reasons, snapshot.snapshot_status !== 'complete', 'CORTEXT_CHECK_SNAPSHOT_INCOMPLETE');
  addReason(
    reasons,
    snapshot.capabilities.profile !== 'managed_stopped_v1'
      && snapshot.capabilities.profile !== 'managed_running_v1',
    'CORTEXT_CHECK_PROFILE_UNSUPPORTED',
  );
  addReason(
    reasons,
    snapshot.manager.integrity !== 'verified'
      || snapshot.manager.trust_status !== 'verified'
      || snapshot.manager.recovery_launcher_status !== 'verified',
    'CORTEXT_CHECK_MANAGER_INTEGRITY_UNVERIFIED',
  );
  addReason(reasons, snapshot.consistency.status !== 'stable', 'CORTEXT_CHECK_CONSISTENCY_UNSTABLE');
  addReason(reasons, !managedBasisComplete(snapshot), 'CORTEXT_CHECK_BASIS_INCOMPLETE');
  addReason(
    reasons,
    snapshot.device.writer_role !== 'active' || snapshot.device.lease_status !== 'held',
    'CORTEXT_CHECK_WRITER_NOT_ACTIVE',
  );
  addReason(reasons, snapshot.state.migration_status !== 'idle', 'CORTEXT_CHECK_MIGRATION_NOT_IDLE');
  addReason(reasons, snapshot.state.status !== 'readable', 'CORTEXT_CHECK_STATE_NOT_READABLE');
  addReason(reasons, snapshot.application.integrity !== 'verified', 'CORTEXT_CHECK_APPLICATION_UNVERIFIED');
  addReason(
    reasons,
    snapshot.compatibility.status !== 'compatible' && snapshot.compatibility.status !== 'warning',
    'CORTEXT_CHECK_COMPATIBILITY_UNSAFE',
  );
  addReason(
    reasons,
    snapshot.recovery.latest_checkpoint.verification !== 'passed',
    'CORTEXT_CHECK_CHECKPOINT_UNVERIFIED',
  );
  addReason(
    reasons,
    snapshot.recovery.latest_state_backup.verification !== 'passed',
    'CORTEXT_CHECK_BACKUP_UNVERIFIED',
  );
  addReason(reasons, snapshot.recovery.rollback_status !== 'ready', 'CORTEXT_CHECK_ROLLBACK_NOT_READY');
  addReason(
    reasons,
    snapshot.observations.some(observation =>
      (observation.severity === 'critical' || observation.severity === 'error')
      && ['manager', 'device', 'application', 'instance', 'state', 'recovery', 'compatibility']
        .includes(observation.domain)),
    'CORTEXT_CHECK_LIFECYCLE_ERROR_PRESENT',
  );
}

function evaluateSandboxNamespace(
  snapshot: LifecycleStatusSnapshot,
  reasons: StatusCheckReasonCode[],
  includeEvidence = true,
): void {
  addReason(reasons, snapshot.snapshot_status !== 'complete', 'CORTEXT_CHECK_SNAPSHOT_INCOMPLETE');
  addReason(reasons, snapshot.scope.target_kind !== 'sandbox', 'CORTEXT_CHECK_TARGET_NOT_SANDBOX');
  addReason(reasons, snapshot.runtime.isolation.data_roots !== 'isolated', 'CORTEXT_CHECK_ROOTS_NOT_ISOLATED');
  addReason(
    reasons,
    snapshot.runtime.isolation.process_namespace !== 'isolated',
    'CORTEXT_CHECK_PROCESSES_NOT_ISOLATED',
  );
  addReason(
    reasons,
    snapshot.runtime.isolation.managed_integrations !== 'intercepted'
      && snapshot.runtime.isolation.managed_integrations !== 'disabled',
    'CORTEXT_CHECK_INTEGRATIONS_NOT_ROUTED',
  );
  if (includeEvidence) {
    addReason(
      reasons,
      snapshot.runtime.isolation.claim !== 'cortext_namespace'
        && snapshot.runtime.isolation.claim !== 'security_contained',
      'CORTEXT_CHECK_ISOLATION_EVIDENCE_MISSING',
    );
    addReason(
      reasons,
      !hasEvidence(snapshot, NAMESPACE_EVIDENCE),
      'CORTEXT_CHECK_ISOLATION_EVIDENCE_MISSING',
    );
  }
}

function evaluateSecurityContained(
  snapshot: LifecycleStatusSnapshot,
  reasons: StatusCheckReasonCode[],
): void {
  evaluateSandboxNamespace(snapshot, reasons, false);
  addReason(
    reasons,
    snapshot.runtime.isolation.boundary !== 'container'
      && snapshot.runtime.isolation.boundary !== 'vm',
    'CORTEXT_CHECK_BOUNDARY_INSUFFICIENT',
  );
  addReason(
    reasons,
    snapshot.runtime.isolation.credentials !== 'removed'
      && snapshot.runtime.isolation.credentials !== 'scoped',
    'CORTEXT_CHECK_CREDENTIALS_EXPOSED',
  );
  addReason(
    reasons,
    snapshot.runtime.isolation.network !== 'none'
      && snapshot.runtime.isolation.network !== 'restricted',
    'CORTEXT_CHECK_NETWORK_UNCONSTRAINED',
  );
  addReason(
    reasons,
    snapshot.runtime.isolation.host_access !== 'constrained',
    'CORTEXT_CHECK_HOST_ACCESS_FULL',
  );
  addReason(
    reasons,
    snapshot.runtime.isolation.claim !== 'security_contained'
      || !hasEvidence(snapshot, CONTAINMENT_EVIDENCE),
    'CORTEXT_CHECK_ISOLATION_EVIDENCE_MISSING',
  );
}

export function evaluateStatusCheck(
  snapshot: LifecycleStatusSnapshot,
  requestedPolicy: string,
): StatusCheckResult {
  const policy = normalizeStatusCheckPolicy(requestedPolicy);
  const reasonCodes: StatusCheckReasonCode[] = [];

  if (policy === 'usable') evaluateUsable(snapshot, reasonCodes);
  else if (policy === 'healthy') evaluateHealthy(snapshot, reasonCodes);
  else if (policy === 'update-safe') evaluateUpdateSafe(snapshot, reasonCodes);
  else if (policy === 'sandbox-namespace') evaluateSandboxNamespace(snapshot, reasonCodes);
  else evaluateSecurityContained(snapshot, reasonCodes);

  return {
    policy,
    policy_version: `cortext.check.${policy}/v1`,
    result: reasonCodes.length === 0 ? 'pass' : 'fail',
    reason_codes: reasonCodes,
  };
}
