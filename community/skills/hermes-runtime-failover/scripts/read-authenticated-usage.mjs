import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export const usageApiEndpoint = 'https://api.anthropic.com/api/oauth/usage';

const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;

const loadAccessToken = (ctxRoot) => {
  if (!nonEmpty(ctxRoot) || !isAbsolute(ctxRoot)) {
    throw new Error('CTX_ROOT must be an absolute path');
  }
  const accountsPath = join(ctxRoot, 'state', 'oauth', 'accounts.json');
  if (existsSync(accountsPath)) {
    try {
      const store = JSON.parse(readFileSync(accountsPath, 'utf8'));
      const accountName = store?.active;
      const accessToken = store?.accounts?.[accountName]?.access_token;
      if (nonEmpty(accountName) && nonEmpty(accessToken)) {
        return { accountName, accessToken };
      }
    } catch {
      // Fall through to the process token, matching the canonical bus behavior.
    }
  }
  const accessToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!nonEmpty(accessToken)) {
    throw new Error('No OAuth token available');
  }
  return { accountName: 'env', accessToken };
};

const normalizeUtilization = (label, value) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Usage API response missing valid ${label}`);
  }
  const normalized = value > 1 ? value / 100 : value;
  if (normalized < 0 || normalized > 1) {
    throw new Error(`Usage API response ${label} is outside 0..1`);
  }
  return normalized;
};

export const readAuthenticatedUsage = async (ctxRoot) => {
  const fetchImpl = globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  const { accountName, accessToken } = loadAccessToken(ctxRoot);
  const response = await fetchImpl(usageApiEndpoint, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
    },
  });
  if (!response?.ok) {
    throw new Error(`Usage API returned ${response?.status ?? 'unknown status'}`);
  }
  const data = await response.json();
  const fiveHour = normalizeUtilization(
    'five_hour_utilization',
    data?.five_hour?.utilization ?? data?.five_hour_utilization ?? data?.fiveHourUtilization,
  );
  const sevenDay = normalizeUtilization(
    'seven_day_utilization',
    data?.seven_day?.utilization ?? data?.seven_day_utilization ?? data?.sevenDayUtilization,
  );
  return {
    account: accountName,
    five_hour_utilization: fiveHour,
    seven_day_utilization: sevenDay,
    cached: false,
    fetched_at: new Date().toISOString(),
    provider: 'anthropic',
    endpoint: usageApiEndpoint,
    authentication: 'oauth-bearer',
  };
};
