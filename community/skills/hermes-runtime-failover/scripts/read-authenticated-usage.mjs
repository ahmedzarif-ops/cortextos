/**
 * Authenticated usage reader.
 *
 * ⚠ THIS MODULE IS NOT A TRUST BOUNDARY. It runs INSIDE the trusted child
 * created by launch-trusted-usage-read.mjs, which is what removes inherited
 * execution controls. Importing and calling this directly from a
 * caller-controlled process reproduces guard blocker 1 on 9dba452: a
 * `NODE_OPTIONS=--import` preload replaces `globalThis.fetch` before this file
 * captures it, and forged usage comes back wearing this reader's own
 * trusted-looking provider/endpoint/authentication labels.
 *
 * Consequences that follow, and why:
 *  - It reports the account it ACTUALLY used and makes no provenance claim.
 *    The boundary compares that against the canonical expected account; a label
 *    this file writes about itself is not evidence (guard criterion 2).
 *  - Every failure leaves as a fixed code, never a message (criterion 3).
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { UsageError } from './usage-error-codes.mjs';

export const usageApiEndpoint = 'https://api.anthropic.com/api/oauth/usage';
export const usageApiHeaders = Object.freeze({ betaHeader: 'anthropic-beta', betaValue: 'oauth-2025-04-20' });
export const DEFAULT_TIMEOUT_MS = 15_000;

const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;

/**
 * A token must be usable as an HTTP header value. A raw CR/LF or non-latin1
 * byte throws inside header construction, and on 9dba452 that thrown message
 * contained the token itself. Reject it here, by shape, before it is ever
 * interpolated.
 */
const isHeaderSafe = (value) => nonEmpty(value) && /^[\x21-\x7E]+$/.test(value);

/**
 * ACCOUNT PRECEDENCE, fixed and asserted by test: the on-disk active account
 * under the canonical root wins; the environment token is the fallback and is
 * reported as the reserved name 'env' so it can never impersonate a named one.
 */
const loadAccessToken = (ctxRoot, envToken) => {
  if (!nonEmpty(ctxRoot) || !isAbsolute(ctxRoot)) throw new UsageError('E_ROOT_INVALID');

  const accountsPath = join(ctxRoot, 'state', 'oauth', 'accounts.json');
  if (existsSync(accountsPath)) {
    try {
      const store = JSON.parse(readFileSync(accountsPath, 'utf8'));
      const accountName = store?.active;
      const accessToken = store?.accounts?.[accountName]?.access_token;
      if (nonEmpty(accountName) && nonEmpty(accessToken)) {
        if (!isHeaderSafe(accessToken)) throw new UsageError('E_TOKEN_UNUSABLE');
        return { accountName, accessToken };
      }
    } catch (err) {
      if (err instanceof UsageError) throw err;
      // Unreadable/!JSON store: fall through to the env token. No detail kept.
    }
  }

  if (!nonEmpty(envToken)) throw new UsageError('E_TOKEN_MISSING');
  if (!isHeaderSafe(envToken)) throw new UsageError('E_TOKEN_UNUSABLE');
  return { accountName: 'env', accessToken: envToken };
};

const normalizeUtilization = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new UsageError('E_RESPONSE_SHAPE');
  const normalized = value > 1 ? value / 100 : value;
  if (normalized < 0 || normalized > 1) throw new UsageError('E_RANGE');
  return normalized;
};

export const readAuthenticatedUsage = async (ctxRoot, options = {}) => {
  const {
    envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  if (typeof fetchImpl !== 'function') throw new UsageError('E_NETWORK');
  const { accountName, accessToken } = loadAccessToken(ctxRoot, envToken);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(usageApiEndpoint, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        [usageApiHeaders.betaHeader]: usageApiHeaders.betaValue,
      },
    });
  } catch (err) {
    // An abort and a transport failure are different facts; keep them distinct.
    throw new UsageError(err?.name === 'AbortError' || controller.signal.aborted ? 'E_TIMEOUT' : 'E_NETWORK');
  } finally {
    clearTimeout(timer);
  }

  if (!response?.ok) throw new UsageError('E_HTTP_STATUS');

  let data;
  try {
    data = await response.json();
  } catch {
    // Node's JSON error quotes the offending body prefix. Never propagate it.
    throw new UsageError('E_RESPONSE_PARSE');
  }

  const fiveHour = normalizeUtilization(
    data?.five_hour?.utilization ?? data?.five_hour_utilization ?? data?.fiveHourUtilization,
  );
  const sevenDay = normalizeUtilization(
    data?.seven_day?.utilization ?? data?.seven_day_utilization ?? data?.sevenDayUtilization,
  );

  return {
    account_used: accountName,   // OBSERVED, not asserted. The boundary judges it.
    five_hour_utilization: fiveHour,
    seven_day_utilization: sevenDay,
    fetched_at: new Date().toISOString(),
  };
};
