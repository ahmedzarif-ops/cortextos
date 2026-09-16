/**
 * The dispatch block is validated in bus/crons.ts, NOT only in the CLI.
 *
 * ⛔ WHY THAT PLACEMENT IS THE TEST. A check that lives only in the CLI is a check
 * that covers the operator who types the command and nobody else — the dashboard,
 * a skill, a migration and a hand-edited crons.json all bypass it. A malformed
 * dispatch that reaches disk does not fail until the cron next fires, which is at
 * 3am with nobody watching. These tests call the STORE functions directly, the way
 * every non-CLI writer does.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { CronDefinition } from '../../../src/types/index';

let tmpRoot: string;
const originalCtxRoot = process.env.CTX_ROOT;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'crons-dispatch-test-'));
  process.env.CTX_ROOT = tmpRoot;
  vi.resetModules();
});

afterEach(() => {
  if (originalCtxRoot !== undefined) process.env.CTX_ROOT = originalCtxRoot;
  else delete process.env.CTX_ROOT;
  try { rmSync(tmpRoot, { recursive: true }); } catch { /* ignore */ }
});

function baseCron(over: Partial<CronDefinition> = {}): CronDefinition {
  return {
    name: 'nightly-digest',
    prompt: 'Summarise the lanes.',
    schedule: '0 3 * * *',
    enabled: true,
    created_at: '2026-09-16T02:00:00.000Z',
    ...over,
  };
}

function cronsFile(agent = 'alice'): string {
  return join(tmpRoot, '.cortextOS', 'state', 'agents', agent, 'crons.json');
}

describe('addCron with a dispatch block', () => {
  it('stores a valid block verbatim', async () => {
    const { addCron, getCronByName } = await import('../../../src/bus/crons.js');
    addCron('alice', baseCron({ dispatch: { runtime: 'hermes', model: 'deepseek/deepseek-v4.1-flash', max_tokens: 512 } }));
    const stored = getCronByName('alice', 'nightly-digest');
    expect(stored?.dispatch).toEqual({ runtime: 'hermes', model: 'deepseek/deepseek-v4.1-flash', max_tokens: 512 });
  });

  it('a cron WITHOUT a dispatch block stores no dispatch key at all', async () => {
    const { addCron } = await import('../../../src/bus/crons.js');
    addCron('alice', baseCron());
    const raw = readFileSync(cronsFile(), 'utf-8');
    expect(raw).not.toContain('dispatch');
  });

  it('REFUSES an invalid block and writes NOTHING — the rejection is before the lock', async () => {
    const { addCron } = await import('../../../src/bus/crons.js');
    expect(() => addCron('alice', baseCron({
      dispatch: { runtime: 'claude' as never, model: 'a/b' },
    }))).toThrow(/dispatch runtime/);
    // Not "the cron is absent" — the FILE is absent. A rejected add must not
    // create the agent's crons.json as a side effect.
    expect(existsSync(cronsFile())).toBe(false);
  });

  it('REFUSES an alias model', async () => {
    const { addCron } = await import('../../../src/bus/crons.js');
    expect(() => addCron('alice', baseCron({
      dispatch: { runtime: 'hermes', model: 'deepseek/deepseek-latest' },
    }))).toThrow(/ALIAS/);
    expect(existsSync(cronsFile())).toBe(false);
  });
});

describe('updateCron with a dispatch block', () => {
  it('adds a dispatch block to an existing seat-run cron', async () => {
    const { addCron, updateCron, getCronByName } = await import('../../../src/bus/crons.js');
    addCron('alice', baseCron());
    expect(updateCron('alice', 'nightly-digest', {
      dispatch: { runtime: 'hermes', model: 'deepseek/deepseek-v4.1-flash' },
    })).toBe(true);
    expect(getCronByName('alice', 'nightly-digest')?.dispatch?.model).toBe('deepseek/deepseek-v4.1-flash');
  });

  it('REFUSES an invalid patch and leaves the stored cron untouched', async () => {
    const { addCron, updateCron, getCronByName } = await import('../../../src/bus/crons.js');
    addCron('alice', baseCron({ dispatch: { runtime: 'hermes', model: 'deepseek/deepseek-v4.1-flash' } }));
    const before = readFileSync(cronsFile(), 'utf-8');

    expect(() => updateCron('alice', 'nightly-digest', {
      dispatch: { runtime: 'hermes', model: 'x', max_tokens: -5 },
    })).toThrow(/max_tokens/);

    expect(readFileSync(cronsFile(), 'utf-8')).toBe(before);
    expect(getCronByName('alice', 'nightly-digest')?.dispatch?.model).toBe('deepseek/deepseek-v4.1-flash');
  });

  it('a patch that does NOT mention dispatch leaves an existing block alone', async () => {
    const { addCron, updateCron, getCronByName } = await import('../../../src/bus/crons.js');
    addCron('alice', baseCron({ dispatch: { runtime: 'hermes', model: 'deepseek/deepseek-v4.1-flash' } }));
    expect(updateCron('alice', 'nightly-digest', { enabled: false })).toBe(true);
    const after = getCronByName('alice', 'nightly-digest');
    expect(after?.enabled).toBe(false);
    expect(after?.dispatch?.model).toBe('deepseek/deepseek-v4.1-flash');
  });

  it('patching dispatch to undefined CLEARS it — the cron goes back to the seat', async () => {
    const { addCron, updateCron, getCronByName } = await import('../../../src/bus/crons.js');
    addCron('alice', baseCron({ dispatch: { runtime: 'hermes', model: 'deepseek/deepseek-v4.1-flash' } }));
    expect(updateCron('alice', 'nightly-digest', { dispatch: undefined })).toBe(true);
    expect(getCronByName('alice', 'nightly-digest')?.dispatch).toBeUndefined();
    // and the key is gone from disk, not merely undefined in memory
    expect(readFileSync(cronsFile(), 'utf-8')).not.toContain('dispatch');
  });
});
