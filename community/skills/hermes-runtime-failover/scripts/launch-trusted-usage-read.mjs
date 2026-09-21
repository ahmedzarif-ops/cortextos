/**
 * TRUSTED LAUNCH BOUNDARY for the authenticated usage read.
 *
 * Guard's BLOCK on 9dba452 turned on one fact: the reader captured
 * `globalThis.fetch` inside a process whose execution controls the CALLER had
 * already set. A `NODE_OPTIONS=--import` preload replaced fetch before the
 * reader ran, and forged usage came back wearing the reader's own
 * provider/endpoint/authentication labels. Sanitising from inside is too late —
 * by then the preload has executed.
 *
 * So the boundary is a PROCESS boundary, and it is crossed in this order:
 *
 *   1. VERIFY BYTES  — every module the child will load is hashed and compared
 *      against a pinned digest before anything is spawned.
 *   2. BUILD ENV FROM EMPTY — the child's environment is constructed from `{}`
 *      with an explicit ALLOWLIST. Nothing is copied from process.env, so no
 *      inherited execution control (NODE_OPTIONS, NODE_PATH, loaders, …) can
 *      survive. A denylist would have to predict every such variable; an
 *      allowlist does not.
 *   3. SPAWN CLEAN   — a fresh process.execPath child, whose bytes are also
 *      attested, running only the verified runner.
 *   4. JUDGE PROVENANCE HERE — the child reports which account it USED; this
 *      boundary compares that to the canonical expected account. A label the
 *      child writes about itself is never accepted as provenance.
 *
 * Nothing in this file is a claim the child makes about itself.
 *
 * ⚠ THE ASSUMPTION THIS BOUNDARY RESTS ON, STATED SO IT CAN BE ARGUED WITH.
 *
 * The PARENT PROCESS IS TRUSTED. This file removes inherited execution controls
 * from the CHILD; it cannot defend against a parent that was already
 * compromised before it ran. Concretely, all of the following defeat it and are
 * OUT OF SCOPE by construction, not by oversight:
 *   - a preload in the PARENT that patches spawnSync, createHash or readFileSync
 *     before this module is imported;
 *   - anything able to rewrite these module files between the digest check and
 *     the spawn (a TOCTOU window this file does not close);
 *   - anything able to replace the node binary at process.execPath.
 *
 * What the boundary DOES buy is the specific property guard's blocker 1 named:
 * a caller who controls only the INVOCATION — env, NODE_OPTIONS, loaders — can
 * no longer forge a usage measurement that arrives wearing trusted labels.
 * That was the reachable attack. Anyone who can patch the parent's own
 * primitives already has the machine, and a stronger claim here would be
 * theatre.
 *
 * If the invocation surface ever becomes MORE hostile than that — an untrusted
 * caller running this module in-process — this boundary is not sufficient and
 * the read must move behind a genuine privilege separation.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { usageApiEndpoint } from './read-authenticated-usage.mjs';
import { UsageError, isPublicCode } from './usage-error-codes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Modules the child loads, pinned by digest. Regenerate deliberately with
 * `node launch-trusted-usage-read.mjs --print-digests` and freeze into the
 * manifest — never auto-heal a mismatch, which would defeat the check.
 */
export const PINNED_MODULES = ['run-usage-read.mjs', 'read-authenticated-usage.mjs', 'usage-error-codes.mjs'];

const sha256File = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

export const computeModuleDigests = (dir = HERE) =>
  Object.fromEntries(PINNED_MODULES.map((name) => [name, sha256File(join(dir, name))]));

/**
 * The child's entire environment. Built from {} — see step 2 above.
 * PATH is deliberately absent: the child spawns nothing.
 */
const buildChildEnv = ({ token, timeoutMs }) => {
  const env = Object.create(null);
  if (typeof token === 'string' && token.length > 0) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  if (Number.isFinite(timeoutMs)) env.USAGE_TIMEOUT_MS = String(timeoutMs);
  return env;
};

/**
 * @param {object} opts
 * @param {string} opts.canonicalRoot     absolute CTX_ROOT the fleet expects
 * @param {string} opts.expectedAccount   canonical account name that must match
 * @param {Record<string,string>} opts.expectedDigests  pinned module digests
 * @param {string} [opts.token]           credential, passed explicitly
 * @returns {{ok:true, usage:object, attestation:object}|{ok:false, code:string, attestation:object}}
 */
export const launchTrustedUsageRead = (opts) => {
  const { canonicalRoot, expectedAccount, expectedDigests, token, timeoutMs, spawnImpl = spawnSync } = opts ?? {};

  const executable = process.execPath;
  let attestation = { executable, executable_sha256: null, modules: null, env_allowlist: null };

  try {
    if (typeof canonicalRoot !== 'string' || !isAbsolute(canonicalRoot)) throw new UsageError('E_ROOT_INVALID');

    // GUARD FINDING 2 — criterion 2 was FAIL-OPEN here. `expectedAccount` was
    // never validated and the comparison below is a bare `!==`, so omitting it
    // made the check `undefined !== undefined` — false — and the boundary
    // stamped its full trusted label set on an unbound read, with `account`
    // silently ABSENT rather than wrong. It failed closed only by accident,
    // because the real reader always populates account_used. A guard that holds
    // by coincidence in another module is not a guard. Its own code, too, so an
    // unconfigured deployment is never misdiagnosed as an attack.
    if (typeof expectedAccount !== 'string' || expectedAccount.trim().length === 0) {
      throw new UsageError('E_ACCOUNT_UNBOUND');
    }

    // 1. VERIFY BYTES before anything is created.
    const actual = computeModuleDigests();
    attestation.modules = actual;
    for (const name of PINNED_MODULES) {
      const want = expectedDigests?.[name];
      if (typeof want !== 'string' || want.length !== 64 || want !== actual[name]) {
        throw new UsageError('E_READER_DIGEST');
      }
    }
    attestation.executable_sha256 = sha256File(executable);

    // 2 + 3. Clean env, fresh child.
    const env = buildChildEnv({ token, timeoutMs });
    attestation.env_allowlist = Object.keys(env).sort();

    const child = spawnImpl(executable, [join(HERE, 'run-usage-read.mjs'), canonicalRoot], {
      env,
      encoding: 'utf8',
      timeout: Number.isFinite(timeoutMs) ? timeoutMs + 5_000 : 20_000,
      maxBuffer: 1 << 20,
    });

    if (child.error || typeof child.stdout !== 'string') throw new UsageError('E_LAUNCH');

    let parsed;
    try {
      parsed = JSON.parse(child.stdout.trim().split('\n').pop() ?? '');
    } catch {
      throw new UsageError('E_CHILD_OUTPUT');
    }

    if (parsed?.ok !== true) {
      throw new UsageError(isPublicCode(parsed?.code) ? parsed.code : 'E_CHILD_OUTPUT');
    }

    // 4. PROVENANCE IS JUDGED HERE, not reported by the child.
    if (parsed.usage?.account_used !== expectedAccount) throw new UsageError('E_ACCOUNT_MISMATCH');

    return {
      ok: true,
      usage: {
        five_hour_utilization: parsed.usage.five_hour_utilization,
        seven_day_utilization: parsed.usage.seven_day_utilization,
        fetched_at: parsed.usage.fetched_at,
        // Stated by the BOUNDARY on the strength of the checks above.
        account: expectedAccount,
        // The endpoint is stated by the BOUNDARY, on the strength of having
        // pinned the reader's bytes — the child never asserts it.
        endpoint: usageApiEndpoint,
        provider: 'anthropic',
        authentication: 'oauth-bearer',
        cached: false,
      },
      attestation,
    };
  } catch (err) {
    return { ok: false, code: err instanceof UsageError ? err.code : 'E_INTERNAL', attestation };
  }
};

if (process.argv[2] === '--print-digests') {
  process.stdout.write(`${JSON.stringify(computeModuleDigests(), null, 2)}\n`);
}
