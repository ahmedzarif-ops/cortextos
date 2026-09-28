import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveWorkerModel } from '../../../src/utils/worker-model.js';

let root: string;
const org = 'acme';
function writeCtx(body: string) {
  mkdirSync(join(root, 'orgs', org), { recursive: true });
  writeFileSync(join(root, 'orgs', org, 'context.json'), body);
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'worker-model-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('resolveWorkerModel', () => {
  it('an explicit --model wins over the org default', () => {
    writeCtx(JSON.stringify({ worker_default_model: 'claude-sonnet-5-5' }));
    expect(resolveWorkerModel('claude-opus-5-5', root, org)).toEqual({ model: 'claude-opus-5-5', source: 'flag' });
  });
  it('uses worker_default_model from the org context when no flag is given', () => {
    writeCtx(JSON.stringify({ worker_default_model: 'claude-sonnet-5-5' }));
    expect(resolveWorkerModel(undefined, root, org)).toEqual({ model: 'claude-sonnet-5-5', source: 'org' });
  });
  it('reads a BOM-prefixed context.json', () => {
    writeCtx('﻿' + JSON.stringify({ worker_default_model: 'claude-sonnet-5-5' }));
    expect(resolveWorkerModel(undefined, root, org).model).toBe('claude-sonnet-5-5');
  });
  it('falls back to the machine default, and says so, when the org sets nothing', () => {
    writeCtx(JSON.stringify({ name: 'acme' }));
    expect(resolveWorkerModel(undefined, root, org)).toEqual({ model: undefined, source: 'machine-default' });
  });
  it('treats a blank flag or blank org value as unset', () => {
    writeCtx(JSON.stringify({ worker_default_model: '   ' }));
    expect(resolveWorkerModel('  ', root, org)).toEqual({ model: undefined, source: 'machine-default' });
  });
  it('survives a malformed or missing context.json', () => {
    writeCtx('{not json');
    expect(resolveWorkerModel(undefined, root, org).source).toBe('machine-default');
    expect(resolveWorkerModel(undefined, join(root, 'nope'), org).source).toBe('machine-default');
  });
});
