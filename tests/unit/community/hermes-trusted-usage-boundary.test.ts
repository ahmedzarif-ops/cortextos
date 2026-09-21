/**
 * Controls for the repaired Hermes trusted usage boundary.
 *
 * Written against guard's acceptance criteria for a successor to 9dba452
 * (report sha 873733e4…). Every test here is offline: no test performs a real
 * network call, and every secret is a dummy sentinel.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import {
  launchTrustedUsageRead,
  computeModuleDigests,
  PINNED_MODULES,
} from '../../../community/skills/hermes-runtime-failover/scripts/launch-trusted-usage-read.mjs';
import {
  readAuthenticatedUsage,
  usageApiEndpoint,
  usageApiHeaders,
} from '../../../community/skills/hermes-runtime-failover/scripts/read-authenticated-usage.mjs';

const SCRIPTS = join(
  dirname(fileURLToPath(import.meta.url)), '..', '..', '..',
  'community', 'skills', 'hermes-runtime-failover', 'scripts',
);

const TOKEN_SENTINEL = 'TOP_SECRET_TOKEN_a1b2c3';
const BODY_SENTINEL = 'TOP_SECRET_RESPONSE_BODY_d4e5f6';

const tmpRoots: string[] = [];
const makeRoot = (accounts?: unknown) => {
  const root = mkdtempSync(join(tmpdir(), 'hermes-boundary-'));
  tmpRoots.push(root);
  if (accounts !== undefined) {
    mkdirSync(join(root, 'state', 'oauth'), { recursive: true });
    writeFileSync(join(root, 'state', 'oauth', 'accounts.json'),
      typeof accounts === 'string' ? accounts : JSON.stringify(accounts));
  }
  return root;
};
afterAll(() => { for (const r of tmpRoots) rmSync(r, { recursive: true, force: true }); });

const listTree = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      out.push(`${p}:${e.isDirectory() ? 'd' : statSync(p).size}`);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
};

// ---------------------------------------------------------------------------
// CRITERION 1 — the preload boundary. This is guard's blocker 1.
// ---------------------------------------------------------------------------

describe('trusted launch boundary vs caller-controlled preload', () => {
  const preloadDir = mkdtempSync(join(tmpdir(), 'hermes-preload-'));
  tmpRoots.push(preloadDir);
  const preloadPath = join(preloadDir, 'forge-fetch.mjs');
  const markerPath = join(preloadDir, 'preload-executed.marker');
  writeFileSync(preloadPath, `
    import { writeFileSync as w } from 'node:fs';
    // TRIPWIRE: if this file ever executes inside the trusted child, it leaves
    // proof. Asserting the ABSENCE of this marker is a direct observation that
    // the preload did not run — strictly better than inferring it from the
    // absence of forged data, which a network failure could also explain.
    w(${JSON.stringify(markerPath)}, 'executed');
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ five_hour: { utilization: 0.01 }, seven_day: { utilization: 0.99 } }),
    });
  `);

  it('POSITIVE CONTROL: the preload really can forge usage in an unprotected in-process read', async () => {
    // Proves the attack works and this harness can detect it. Without this, a
    // green on the next test could mean "boundary holds" OR "attack is inert".
    const root = makeRoot(undefined);
    const forged = async () => ({
      ok: true, status: 200,
      json: async () => ({ five_hour: { utilization: 0.01 }, seven_day: { utilization: 0.99 } }),
    });
    const usage = await readAuthenticatedUsage(root, {
      envToken: 'dummy-token', fetchImpl: forged as never,
    });
    expect(usage.seven_day_utilization).toBe(0.99);
  });

  it('the preload NEVER executes inside the trusted child, and no socket is opened', () => {
    // GUARD FINDING 3: the previous version of this test passed a header-safe
    // 'dummy-token', so the clean child ran the REAL fetch and reached
    // api.anthropic.com on every suite run. Blanking the token alone would stop
    // the socket but would also stop the test proving anything, because the read
    // would fail at E_TOKEN_MISSING for reasons unrelated to the preload.
    //
    // The marker keeps BOTH properties: no credential means no socket, and the
    // tripwire still detects an inherited NODE_OPTIONS, because the preload
    // writes its marker at import time — before any token is ever consulted.
    const root = makeRoot(undefined);
    if (existsSync(markerPath)) rmSync(markerPath);
    const prev = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = `--import ${JSON.stringify(preloadPath)}`;
    try {
      const result = launchTrustedUsageRead({
        canonicalRoot: root,
        expectedAccount: 'env',
        expectedDigests: computeModuleDigests(SCRIPTS),
        token: '',            // no credential -> no outbound socket, ever
        timeoutMs: 4000,
      });
      expect(existsSync(markerPath)).toBe(false);   // the load-bearing assertion
      expect(result.ok).toBe(false);
      expect((result as { code: string }).code).toBe('E_TOKEN_MISSING');
      // E_HTTP_STATUS or E_NETWORK would both mean a socket was attempted.
      expect((result as { code: string }).code).not.toBe('E_HTTP_STATUS');
      expect((result as { code: string }).code).not.toBe('E_NETWORK');
    } finally {
      if (prev === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = prev;
    }
  });

  it('builds the child environment from empty — no NODE_* control can be inherited', () => {
    const root = makeRoot(undefined);
    const prev = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = `--import ${JSON.stringify(preloadPath)}`;
    process.env.NODE_PATH = '/tmp/evil';
    try {
      let capturedEnv: Record<string, string> | undefined;
      launchTrustedUsageRead({
        canonicalRoot: root,
        expectedAccount: 'env',
        expectedDigests: computeModuleDigests(SCRIPTS),
        token: 'dummy-token',
        spawnImpl: ((_exe: string, _args: string[], o: { env: Record<string, string> }) => {
          capturedEnv = o.env;
          return { stdout: JSON.stringify({ ok: false, code: 'E_NETWORK' }), error: null };
        }) as never,
      });
      const keys = Object.keys(capturedEnv ?? {});
      expect(keys).toEqual(['CLAUDE_CODE_OAUTH_TOKEN']);
      expect(keys.some((k) => k.startsWith('NODE_'))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = prev;
      delete process.env.NODE_PATH;
    }
  });

  it('refuses to spawn when a pinned module digest does not match', () => {
    const root = makeRoot(undefined);
    const bad = { ...computeModuleDigests(SCRIPTS), 'read-authenticated-usage.mjs': '0'.repeat(64) };
    const result = launchTrustedUsageRead({
      canonicalRoot: root, expectedAccount: 'env', expectedDigests: bad, token: 'dummy-token',
      spawnImpl: (() => { throw new Error('must not spawn'); }) as never,
    });
    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('E_READER_DIGEST');
  });

  it('attests the executable and every pinned module', () => {
    const root = makeRoot(undefined);
    const result = launchTrustedUsageRead({
      canonicalRoot: root, expectedAccount: 'env',
      expectedDigests: computeModuleDigests(SCRIPTS), token: 'dummy-token',
      spawnImpl: (() => ({ stdout: JSON.stringify({ ok: false, code: 'E_NETWORK' }), error: null })) as never,
    });
    expect(result.attestation.executable).toBe(process.execPath);
    expect(result.attestation.executable_sha256).toMatch(/^[0-9a-f]{64}$/);
    for (const m of PINNED_MODULES) expect(result.attestation.modules[m]).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// CRITERION 2 — provenance is judged at the boundary, not self-reported.
// ---------------------------------------------------------------------------

describe('account binding', () => {
  const okChild = (account: string) => (() => ({
    stdout: JSON.stringify({
      ok: true,
      usage: { account_used: account, five_hour_utilization: 0.1, seven_day_utilization: 0.2, fetched_at: 'x' },
    }),
    error: null,
  })) as never;

  it('rejects a read whose account is not the canonical expected one', () => {
    const result = launchTrustedUsageRead({
      canonicalRoot: makeRoot(undefined), expectedAccount: 'fleet-canonical',
      expectedDigests: computeModuleDigests(SCRIPTS), token: 'dummy-token',
      spawnImpl: okChild('someone-elses-account'),
    });
    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('E_ACCOUNT_MISMATCH');
  });

  it('accepts the canonical account and states provenance from the BOUNDARY', () => {
    const result = launchTrustedUsageRead({
      canonicalRoot: makeRoot(undefined), expectedAccount: 'fleet-canonical',
      expectedDigests: computeModuleDigests(SCRIPTS), token: 'dummy-token',
      spawnImpl: okChild('fleet-canonical'),
    });
    expect(result.ok).toBe(true);
    expect((result as { usage: Record<string, unknown> }).usage.account).toBe('fleet-canonical');
    expect((result as { usage: Record<string, unknown> }).usage.provider).toBe('anthropic');
  });

  it('on-disk active account takes precedence over the env token', async () => {
    const root = makeRoot({ active: 'disk-account', accounts: { 'disk-account': { access_token: 'disk-tok' } } });
    let seenAuth = '';
    await readAuthenticatedUsage(root, {
      envToken: 'env-tok',
      fetchImpl: (async (_u: string, i: { headers: Record<string, string> }) => {
        seenAuth = i.headers.Authorization;
        return { ok: true, status: 200, json: async () => ({ five_hour: { utilization: 0.1 }, seven_day: { utilization: 0.2 } }) };
      }) as never,
    });
    expect(seenAuth).toBe('Bearer disk-tok');
  });

  it('reports the reserved name "env" when falling back, so it cannot impersonate a named account', async () => {
    const usage = await readAuthenticatedUsage(makeRoot(undefined), {
      envToken: 'env-tok',
      fetchImpl: (async () => ({ ok: true, status: 200, json: async () => ({ five_hour: { utilization: 0.1 }, seven_day: { utilization: 0.2 } }) })) as never,
    });
    expect(usage.account_used).toBe('env');
  });
});

// ---------------------------------------------------------------------------
// CRITERIA 3 + 4 — fixed codes, and secrets never leave.
// ---------------------------------------------------------------------------

describe('non-disclosure of secret-bearing input', () => {
  it('a header-unsafe token yields a CODE and never echoes the token', async () => {
    const root = makeRoot(undefined);
    let thrown: unknown;
    try {
      await readAuthenticatedUsage(root, {
        envToken: `${TOKEN_SENTINEL}\nX-Injected: 1`,
        fetchImpl: (async () => ({ ok: true, status: 200, json: async () => ({}) })) as never,
      });
    } catch (err) { thrown = err; }
    expect((thrown as { code: string }).code).toBe('E_TOKEN_UNUSABLE');
    const serialised = `${String(thrown)}${JSON.stringify(thrown, Object.getOwnPropertyNames(thrown as object))}`;
    expect(serialised).not.toContain(TOKEN_SENTINEL);
  });

  it('an invalid JSON body yields a CODE and never echoes the body', async () => {
    let thrown: unknown;
    try {
      await readAuthenticatedUsage(makeRoot(undefined), {
        envToken: 'dummy-token',
        fetchImpl: (async () => ({
          ok: true, status: 200,
          json: async () => { throw new SyntaxError(`Unexpected token in JSON: ${BODY_SENTINEL}`); },
        })) as never,
      });
    } catch (err) { thrown = err; }
    expect((thrown as { code: string }).code).toBe('E_RESPONSE_PARSE');
    const serialised = `${String(thrown)}${JSON.stringify(thrown, Object.getOwnPropertyNames(thrown as object))}`;
    expect(serialised).not.toContain(BODY_SENTINEL);
  });

  it('END-TO-END: neither sentinel reaches child stdout or stderr', () => {
    const root = makeRoot(undefined);
    const child = spawnSync(process.execPath, [join(SCRIPTS, 'run-usage-read.mjs'), root], {
      env: { CLAUDE_CODE_OAUTH_TOKEN: `${TOKEN_SENTINEL}\nbad` },
      encoding: 'utf8', timeout: 10_000,
    });
    expect(child.stdout ?? '').not.toContain(TOKEN_SENTINEL);
    expect(child.stderr ?? '').toBe('');           // the stderr path guard's leak travelled is closed
    expect(JSON.parse((child.stdout ?? '').trim()).code).toBe('E_TOKEN_UNUSABLE');
  });
});

// ---------------------------------------------------------------------------
// CRITERION 5 — direct reader controls.
// ---------------------------------------------------------------------------

describe('reader controls', () => {
  const okBody = { five_hour: { utilization: 0.1 }, seven_day: { utilization: 0.2 } };

  it('requests the exact URL and headers', async () => {
    let url = ''; let headers: Record<string, string> = {};
    await readAuthenticatedUsage(makeRoot(undefined), {
      envToken: 'dummy-token',
      fetchImpl: (async (u: string, i: { headers: Record<string, string> }) => {
        url = u; headers = i.headers;
        return { ok: true, status: 200, json: async () => okBody };
      }) as never,
    });
    expect(url).toBe(usageApiEndpoint);
    expect(headers.Authorization).toBe('Bearer dummy-token');
    expect(headers[usageApiHeaders.betaHeader]).toBe(usageApiHeaders.betaValue);
  });

  it.each([
    ['non-2xx', { ok: false, status: 500, json: async () => ({}) }, 'E_HTTP_STATUS'],
    ['missing utilization', { ok: true, status: 200, json: async () => ({}) }, 'E_RESPONSE_SHAPE'],
    // NOTE the normalisation boundary: any value >1 is read as a PERCENTAGE
    // and divided by 100, so `3` means 3% and is legitimately in range. The
    // range guard can therefore only fire above 100 or below 0 — asserting it
    // with `3` would have passed for the wrong reason.
    ['above 100 percent', { ok: true, status: 200, json: async () => ({ five_hour: { utilization: 150 }, seven_day: { utilization: 0.2 } }) }, 'E_RANGE'],
    ['negative', { ok: true, status: 200, json: async () => ({ five_hour: { utilization: -0.5 }, seven_day: { utilization: 0.2 } }) }, 'E_RANGE'],
    ['non-numeric', { ok: true, status: 200, json: async () => ({ five_hour: { utilization: '0.5' }, seven_day: { utilization: 0.2 } }) }, 'E_RESPONSE_SHAPE'],
  ])('maps %s to a fixed code', async (_label, response, code) => {
    await expect(readAuthenticatedUsage(makeRoot(undefined), {
      envToken: 'dummy-token', fetchImpl: (async () => response) as never,
    })).rejects.toMatchObject({ code });
  });

  it('maps an absent token to E_TOKEN_MISSING', async () => {
    await expect(readAuthenticatedUsage(makeRoot(undefined), {
      envToken: '', fetchImpl: (async () => ({ ok: true, status: 200, json: async () => okBody })) as never,
    })).rejects.toMatchObject({ code: 'E_TOKEN_MISSING' });
  });

  it('maps a non-absolute root to E_ROOT_INVALID', async () => {
    await expect(readAuthenticatedUsage('relative/path', {
      envToken: 'dummy-token', fetchImpl: (async () => ({ ok: true, status: 200, json: async () => okBody })) as never,
    })).rejects.toMatchObject({ code: 'E_ROOT_INVALID' });
  });

  it('maps an abort to E_TIMEOUT, distinct from E_NETWORK', async () => {
    await expect(readAuthenticatedUsage(makeRoot(undefined), {
      envToken: 'dummy-token', timeoutMs: 5,
      fetchImpl: ((_u: string, i: { signal: AbortSignal }) => new Promise((_res, rej) => {
        i.signal.addEventListener('abort', () => {
          const e = new Error('aborted'); e.name = 'AbortError'; rej(e);
        });
      })) as never,
    })).rejects.toMatchObject({ code: 'E_TIMEOUT' });
  });

  it('maps a transport failure to E_NETWORK', async () => {
    await expect(readAuthenticatedUsage(makeRoot(undefined), {
      envToken: 'dummy-token',
      fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as never,
    })).rejects.toMatchObject({ code: 'E_NETWORK' });
  });

  it('writes nothing under the root', async () => {
    const root = makeRoot({ active: 'a', accounts: { a: { access_token: 'tok' } } });
    const before = listTree(root);
    await readAuthenticatedUsage(root, {
      envToken: 'dummy-token',
      fetchImpl: (async () => ({ ok: true, status: 200, json: async () => okBody })) as never,
    });
    expect(listTree(root)).toEqual(before);
  });

  // ---- criterion 2 fail-open, guard finding 2 ------------------------------
  //
  // These exist because the FIX was shipped untested: 82/82 stayed green with
  // the E_ACCOUNT_UNBOUND guard deleted. A repair with no test is a repair on
  // trust, and guard's re-review said so.

  it.each([
    ['undefined', undefined],
    ['empty string', ''],
    ['whitespace only', '   '],
    ['non-string: number', 42 as unknown],
    ['non-string: null', null as unknown],
    ['non-string: object', {} as unknown],
  ])('refuses an unbound expectedAccount (%s)', (_label, account) => {
    const result = launchTrustedUsageRead({
      canonicalRoot: makeRoot(undefined),
      expectedAccount: account as string,
      expectedDigests: computeModuleDigests(SCRIPTS),
      token: 'dummy-token',
      // Must be refused BEFORE the child is created: the bare `!==` further
      // down would read `undefined !== undefined` as false and stamp the full
      // trusted label set on an unbound read.
      spawnImpl: (() => { throw new Error('must not spawn on an unbound account'); }) as never,
    });
    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('E_ACCOUNT_UNBOUND');
  });

  it('distinguishes UNBOUND from MISMATCH — a config error is not an attack', () => {
    const unbound = launchTrustedUsageRead({
      canonicalRoot: makeRoot(undefined), expectedAccount: '',
      expectedDigests: computeModuleDigests(SCRIPTS), token: 'dummy-token',
      spawnImpl: (() => { throw new Error('must not spawn'); }) as never,
    });
    const mismatch = launchTrustedUsageRead({
      canonicalRoot: makeRoot(undefined), expectedAccount: 'fleet-canonical',
      expectedDigests: computeModuleDigests(SCRIPTS), token: 'dummy-token',
      spawnImpl: (() => ({
        stdout: JSON.stringify({ ok: true, usage: { account_used: 'someone-else', five_hour_utilization: 0.1, seven_day_utilization: 0.2, fetched_at: 'x' } }),
        error: null,
      })) as never,
    });
    expect((unbound as { code: string }).code).toBe('E_ACCOUNT_UNBOUND');
    expect((mismatch as { code: string }).code).toBe('E_ACCOUNT_MISMATCH');
    expect((unbound as { code: string }).code).not.toBe((mismatch as { code: string }).code);
  });

});
