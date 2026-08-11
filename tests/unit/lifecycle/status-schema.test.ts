import Ajv from 'ajv';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectLegacyStatus } from '../../../src/lifecycle/legacy-status';
import { redactLifecycleStatus } from '../../../src/lifecycle/redact-status';
import {
  LifecycleStatusCliError,
  localErrorEnvelope,
  redactedErrorEnvelope,
} from '../../../src/cli/lifecycle';

const roots: string[] = [];

function loadSchema(name: string): object {
  return JSON.parse(readFileSync(join(process.cwd(), 'schemas', name), 'utf-8'));
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
    const redacted = redactLifecycleStatus(local, '00000000-0000-4000-8000-000000000000');
    const ajv = new Ajv({ allErrors: true, strict: true });

    const validateLocal = ajv.compile(loadSchema('cortext.status.v1.schema.json'));
    const validateRedacted = ajv.compile(loadSchema('cortext.status.redacted.v1.schema.json'));
    expect(validateLocal(local), JSON.stringify(validateLocal.errors)).toBe(true);
    expect(validateRedacted(redacted), JSON.stringify(validateRedacted.errors)).toBe(true);
  });

  it('rejects additional redacted properties recursively', async () => {
    const local = await fixtureSnapshot();
    const redacted = redactLifecycleStatus(local, '00000000-0000-4000-8000-000000000000');
    const validate = new Ajv({ allErrors: true, strict: true })
      .compile(loadSchema('cortext.status.redacted.v1.schema.json'));

    const topLevel = { ...redacted, private_canary: 'SECRET' };
    const nested = { ...redacted, runtime: { ...redacted.runtime, private_canary: 'SECRET' } };
    expect(validate(topLevel)).toBe(false);
    expect(validate(nested)).toBe(false);
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
