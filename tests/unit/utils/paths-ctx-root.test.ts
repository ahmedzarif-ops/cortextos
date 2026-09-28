import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { resolvePaths, resolveCtxRoot } from '../../../src/utils/paths';
import { logEvent } from '../../../src/bus/event';

// resolvePaths used to ignore CTX_ROOT, so `npm test` (which sets CTX_ROOT to a
// temp dir) wrote telegram_sent / heartbeat events into the LIVE event log.
describe('resolvePaths honours CTX_ROOT', () => {
  let saved: { root?: string; inst?: string };
  let temp: string;

  beforeEach(() => {
    saved = { root: process.env.CTX_ROOT, inst: process.env.CTX_INSTANCE_ID };
    temp = mkdtempSync(join(tmpdir(), 'paths-ctxroot-'));
  });
  afterEach(() => {
    if (saved.root === undefined) delete process.env.CTX_ROOT; else process.env.CTX_ROOT = saved.root;
    if (saved.inst === undefined) delete process.env.CTX_INSTANCE_ID; else process.env.CTX_INSTANCE_ID = saved.inst;
    rmSync(temp, { recursive: true, force: true });
  });

  it('uses CTX_ROOT for the environment instance', () => {
    process.env.CTX_ROOT = temp;
    delete process.env.CTX_INSTANCE_ID;
    const p = resolvePaths('test-agent', 'default', 'someorg');
    expect(p.ctxRoot).toBe(temp);
    expect(p.analyticsDir).toBe(join(temp, 'orgs', 'someorg', 'analytics'));
    expect(p.logDir).toBe(join(temp, 'logs', 'test-agent'));
  });

  it('an event logged with default paths lands under CTX_ROOT, not ~/.cortextos', () => {
    process.env.CTX_ROOT = temp;
    delete process.env.CTX_INSTANCE_ID;
    const agent = `paths-probe-${process.pid}`;
    logEvent(resolvePaths(agent, 'default', 'probeorg'), agent, 'probeorg', 'message', 'telegram_sent', 'info', {});
    expect(existsSync(join(temp, 'orgs', 'probeorg', 'analytics', 'events', agent))).toBe(true);
    expect(existsSync(join(homedir(), '.cortextos', 'default', 'orgs', 'probeorg'))).toBe(false);
  });

  it('an explicit OTHER instance still resolves under ~/.cortextos/<id>', () => {
    process.env.CTX_ROOT = temp;
    process.env.CTX_INSTANCE_ID = 'default';
    expect(resolveCtxRoot('other')).toBe(join(homedir(), '.cortextos', 'other'));
  });

  it('falls back to ~/.cortextos/<id> when CTX_ROOT is unset', () => {
    delete process.env.CTX_ROOT;
    expect(resolveCtxRoot('default')).toBe(join(homedir(), '.cortextos', 'default'));
  });

  it('an explicit ctxRoot override wins', () => {
    process.env.CTX_ROOT = temp;
    expect(resolvePaths('a', 'test', 'o', '/x/y').ctxRoot).toBe('/x/y');
  });
});
