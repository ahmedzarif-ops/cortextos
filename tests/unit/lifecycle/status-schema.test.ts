import Ajv from 'ajv';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectLegacyStatus } from '../../../src/lifecycle/legacy-status';
import { redactLifecycleStatus } from '../../../src/lifecycle/redact-status';
import { evaluateStatusCheck } from '../../../src/lifecycle/check-status';
import {
  LifecycleStatusCliError,
  localErrorEnvelope,
  redactedErrorEnvelope,
} from '../../../src/cli/lifecycle';

const roots: string[] = [];

function loadSchema(name: string): object {
  return JSON.parse(readFileSync(join(process.cwd(), 'schemas', name), 'utf-8'));
}

function objectPaths(value: unknown, path: Array<string | number> = []): Array<Array<string | number>> {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => objectPaths(item, [...path, index]));
  }
  const record = value as Record<string, unknown>;
  return [path, ...Object.entries(record).flatMap(([key, item]) => objectPaths(item, [...path, key]))];
}

function objectAt(root: unknown, path: Array<string | number>): Record<string, unknown> {
  let current = root as unknown;
  for (const segment of path) current = (current as Record<string | number, unknown>)[segment];
  return current as Record<string, unknown>;
}

async function fixtureSnapshot() {
  const root = mkdtempSync(join(tmpdir(), 'cortext-status-schema-'));
  roots.push(root);
  const frameworkRoot = join(root, 'framework');
  const ctxRoot = join(root, 'state');
  mkdirSync(join(ctxRoot, 'state'), { recursive: true });
  mkdirSync(frameworkRoot, { recursive: true });
  writeFileSync(
    join(frameworkRoot, 'package.json'),
    JSON.stringify({ name: 'cortextos', version: '0.1.1' }),
    'utf-8',
  );
  return collectLegacyStatus({
    instanceId: 'default',
    ctxRoot,
    frameworkRoot,
    now: new Date('2026-08-10T12:00:00.000Z'),
    probeDaemon: async () => ({ kind: 'absent' }),
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('lifecycle status JSON Schemas', () => {
  it('validates emitted local and redacted snapshots', async () => {
    const local = await fixtureSnapshot();
    const checked = { ...local, check: evaluateStatusCheck(local, 'usable@v1') };
    const redacted = redactLifecycleStatus(checked, '00000000-0000-4000-8000-000000000000');
    const ajv = new Ajv({ allErrors: true, strict: true });

    const validateLocal = ajv.compile(loadSchema('cortext.status.v1.schema.json'));
    const validateRedacted = ajv.compile(loadSchema('cortext.status.redacted.v1.schema.json'));
    expect(validateLocal(checked), JSON.stringify(validateLocal.errors)).toBe(true);
    expect(validateRedacted(redacted), JSON.stringify(validateRedacted.errors)).toBe(true);
  });

  it('rejects additional redacted properties recursively', async () => {
    const local = await fixtureSnapshot();
    const redacted = redactLifecycleStatus(local, '00000000-0000-4000-8000-000000000000');
    const validate = new Ajv({ allErrors: true, strict: true })
      .compile(loadSchema('cortext.status.redacted.v1.schema.json'));

    for (const path of objectPaths(redacted)) {
      const candidate = structuredClone(redacted) as unknown;
      objectAt(candidate, path).private_canary = 'SECRET';
      expect(validate(candidate), `accepted extra property at ${JSON.stringify(path)}`).toBe(false);
    }
  });

  it('reconstructs every redacted string surface from closed public metadata', async () => {
    const local = await fixtureSnapshot();
    const adversarial = structuredClone(local) as any;
    adversarial.manager.version = '/Users/private/manager';
    adversarial.application.version = 'private@example.com';
    adversarial.capabilities.supported = ['TOKEN_SECRET_CANARY'];
    adversarial.capabilities.unsupported = ['PRIVATE_OPERATION_CANARY'];
    adversarial.runtime.isolation.evidence_codes = ['PRIVATE_EVIDENCE_CANARY'];
    adversarial.runtime.isolation.network = 'PRIVATE_NETWORK_CANARY';
    adversarial.check = {
      policy: 'usable',
      policy_version: 'cortext.check.security-contained/v1',
      result: 'pass',
      reason_codes: ['TOKEN_SECRET_CANARY'],
    };
    adversarial.observations = [{
      code: 'PRIVATE_OBSERVATION_CANARY',
      severity: 'critical',
      domain: 'private@example.com',
      summary: '/Users/private/summary',
      recommended_operation: 'TOKEN_SECRET_CANARY',
    }];

    const redacted = redactLifecycleStatus(
      adversarial,
      '00000000-0000-4000-8000-000000000000',
    );
    const serialized = JSON.stringify(redacted);
    for (const canary of [
      '/Users/private',
      'private@example.com',
      'TOKEN_SECRET_CANARY',
      'PRIVATE_OPERATION_CANARY',
      'PRIVATE_EVIDENCE_CANARY',
      'PRIVATE_NETWORK_CANARY',
      'PRIVATE_OBSERVATION_CANARY',
    ]) expect(serialized).not.toContain(canary);
    expect(redacted.check).toBeNull();
    expect(redacted.observations).toEqual([]);

    const validate = new Ajv({ allErrors: true, strict: true })
      .compile(loadSchema('cortext.status.redacted.v1.schema.json'));
    expect(validate(redacted), JSON.stringify(validate.errors)).toBe(true);
  });

  it('rejects forged secret-bearing values on every formerly open redacted surface', async () => {
    const local = await fixtureSnapshot();
    const base = redactLifecycleStatus(local, '00000000-0000-4000-8000-000000000000');
    const validate = new Ajv({ allErrors: true, strict: true })
      .compile(loadSchema('cortext.status.redacted.v1.schema.json'));
    const mutations: Array<(candidate: any) => void> = [
      candidate => { candidate.manager.version = 'TOKEN_SECRET_CANARY'; },
      candidate => { candidate.application.version = 'private@example.com'; },
      candidate => { candidate.capabilities.supported[0] = '/Users/private/capability'; },
      candidate => { candidate.capabilities.unsupported[0] = 'TOKEN_SECRET_CANARY'; },
      candidate => { candidate.runtime.isolation.evidence_codes = ['PRIVATE_EVIDENCE_CANARY']; },
      candidate => { candidate.observations[0].code = 'PRIVATE_OBSERVATION_CANARY'; },
      candidate => { candidate.observations[0].domain = 'private@example.com'; },
      candidate => { candidate.observations[0].recommended_operation = '/Users/private/action'; },
    ];
    for (const mutate of mutations) {
      const candidate = structuredClone(base) as any;
      mutate(candidate);
      expect(validate(candidate), JSON.stringify(validate.errors)).toBe(false);
    }
  });

  it('rejects contradictory policy, version, result, and reason combinations', async () => {
    const local = await fixtureSnapshot();
    const contradictory = {
      ...local,
      check: {
        policy: 'usable',
        policy_version: 'cortext.check.security-contained/v1',
        result: 'pass',
        reason_codes: ['CORTEXT_CHECK_STATE_NOT_READABLE'],
      },
    };
    const validate = new Ajv({ allErrors: true, strict: true })
      .compile(loadSchema('cortext.status.v1.schema.json'));
    expect(validate(contradictory)).toBe(false);
  });

  it('defines v1 as a legacy-only contract instead of advertising managed evidence', async () => {
    const local = await fixtureSnapshot();
    const managedShaped = structuredClone(local) as any;
    managedShaped.capabilities.profile = 'managed_running_v1';
    managedShaped.basis.lifecycle_generation = 'generation-1';
    const validate = new Ajv({ allErrors: true, strict: true })
      .compile(loadSchema('cortext.status.v1.schema.json'));
    expect(validate(managedShaped)).toBe(false);
  });

  it('validates both closed error envelopes', () => {
    const error = new LifecycleStatusCliError(
      'CORTEXT_STATUS_INVALID_OPTION_COMBINATION', 2, 'REDACT_WITH_PATHS',
    );
    const ajv = new Ajv({ allErrors: true, strict: true });
    const validateLocal = ajv.compile(loadSchema('cortext.status.error.v1.schema.json'));
    const validateRedacted = ajv.compile(loadSchema('cortext.status.redacted.error.v1.schema.json'));

    expect(validateLocal(localErrorEnvelope(error)), JSON.stringify(validateLocal.errors)).toBe(true);
    expect(
      validateRedacted(redactedErrorEnvelope(error)),
      JSON.stringify(validateRedacted.errors),
    ).toBe(true);
  });
});
