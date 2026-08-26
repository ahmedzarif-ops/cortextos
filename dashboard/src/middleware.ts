// cortextOS Dashboard - Auth middleware
// Checks for next-auth session cookie; redirects to /login if missing.
// Cannot import auth.ts directly because it chains to better-sqlite3,
// which is not available in the Edge Runtime.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { jwtVerify } from 'jose';
import { getToken } from 'next-auth/jwt';

// Allowed CORS origins - localhost dev + configured deployment URL + mobile app
// Built once at module load: env-derived origins are validated via `new URL()`,
// malformed values are dropped with a warning, and wildcards are explicitly rejected.
function buildAllowedOrigins(): string[] {
  const staticOrigins = ['http://localhost:3000', 'http://localhost:3001'];
  const envCandidates: Array<[string, string | undefined]> = [
    ['NEXTAUTH_URL', process.env.NEXTAUTH_URL],
    ['DASHBOARD_URL', process.env.DASHBOARD_URL],
    ['MOBILE_APP_ORIGIN', process.env.MOBILE_APP_ORIGIN],
  ];

  const validated: string[] = [];
  for (const [name, raw] of envCandidates) {
    if (!raw) continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed === '*') {
      console.warn(
        `[middleware] Ignoring wildcard CORS origin from ${name}; wildcards are not allowed.`,
      );
      continue;
    }
    try {
      validated.push(new URL(trimmed).origin);
    } catch {
      console.warn(
        `[middleware] Ignoring malformed CORS origin from ${name}: ${JSON.stringify(raw)}`,
      );
    }
  }

  return Array.from(new Set([...staticOrigins, ...validated]));
}

const ALLOWED_ORIGINS: string[] = buildAllowedOrigins();

function getAllowedOrigin(requestOrigin: string | null): string | null {
  if (requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin)) return requestOrigin;
  return null;
}


// GAP: /login was frameable by ANY origin. Measured 2026-08-26 on the running dev
// server: GET /login returned 200 with NO X-Frame-Options. The cause was
// structural, not a missing line — the security headers were set ONLY on the
// final authenticated success path, so every OTHER way out of this function
// returned a response without them: the public-path early return (/login,
// /api/auth, /_next, the icon paths, /api/workflows/health), the unauthenticated
// redirect to /login, the 401 for API routes, the two 500 misconfiguration
// responses, and the OPTIONS preflight. A login page any site can frame is a
// clickjacking and credential-harvesting surface, and it was reached by one of
// the paths that skipped the headers.
//
// PRE-EXISTING ON MAIN — not introduced by the agent-city branch.
//
// ⚠ THE SHAPE IS THE LESSON: headers applied at ONE exit protect only the
// requests that leave through it. Setting them at the LAST return looks
// complete while covering the fewest paths — the authenticated success case is
// the one that needed them least. Every `return` below now goes through these
// helpers; adding a new early return without them re-opens exactly this hole.
function applySecurityHeaders(response: NextResponse, pathname: string): NextResponse {
  // The Agent City scene bundle is framed by /city, a first-party page on this
  // same origin. DENY blocks even same-origin framing, so that one path relaxes
  // to SAMEORIGIN — which still refuses every other site, which is what this
  // header is here to do. Everything else stays DENY.
  //
  // The bundle it refers to is GENERATED, not committed: it is produced by
  // orgs/<org>/agents/city/build/build-internal.mjs into dashboard/public/agent-city/,
  // which is gitignored because the build bakes live fleet state into it. So a
  // fresh clone will NOT contain the directory this relaxation exists for, and
  // /city renders an explicit "not built" state until someone runs that build.
  // Said out loud because this comment justifies a WEAKENED control: a reviewer
  // who goes looking for the bundle, does not find it, and concludes the
  // relaxation is unjustified or vestigial would be wrong both ways, and one of
  // those wrong turns removes a header exemption that a real first-party page
  // depends on.
  response.headers.set(
    'X-Frame-Options',
    pathname.startsWith('/agent-city/') ? 'SAMEORIGIN' : 'DENY',
  );
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'no-referrer');
  if (process.env.NODE_ENV === 'production') {
    response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  return response;
}

// Every response leaving this middleware goes through here: CORS and security
// headers together, so the two cannot drift apart per-path again.
function withCommonHeaders(
  response: NextResponse,
  pathname: string,
  corsOrigin: string,
): NextResponse {
  response.headers.set('Access-Control-Allow-Origin', corsOrigin);
  response.headers.set('Vary', 'Origin');
  return applySecurityHeaders(response, pathname);
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const requestOrigin = request.headers.get('origin');
  const corsOrigin = getAllowedOrigin(requestOrigin) ?? 'null';

  // Handle CORS preflight requests
  if (request.method === 'OPTIONS') {
    const preflight = new NextResponse(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
      },
    });
    return withCommonHeaders(preflight, pathname, corsOrigin);
  }

  // Allow public paths
  // Security (H7): SSE endpoints require ?token=<jwt> auth — removed from public whitelist
  // GAP-0034: /api/workflows/health is an unauthenticated health probe — must be
  // reachable from monitoring contexts (load balancers, watcher crons, external
  // watchdogs) without requiring a session cookie. Auth-gating defeats the purpose.
  if (
    pathname.startsWith('/login') ||
    pathname.startsWith('/api/auth') ||
    pathname.startsWith('/_next') ||
    pathname === '/favicon.ico' ||
    /* App Router serves the app icon from src/app/icon.svg at /icon.svg — NOT at
       /favicon.ico. Excluding only favicon.ico auth-gated the real icon, so an
       unauthenticated page load fired GET /icon.svg -> 307 /login?callbackUrl=
       %2Ficon.svg, a second competing document request that left the login page
       stuck on "Loading…" (React never finished hydrating, so the csrf effect
       never ran and the submit button stayed disabled through refreshes).
       Only visible when there is no session cookie, which is why it looked like
       a phone/LAN-only bug: the Mac browser was already logged in.
       Verified 2026-08-26 with controls — favicon.ico and _next chunks were 200
       while icon.svg was 307. */
    pathname === '/icon.svg' ||
    pathname === '/apple-icon.png' ||
    pathname === '/apple-touch-icon.png' ||
    pathname === '/manifest.json' ||
    pathname === '/api/workflows/health'
  ) {
    return withCommonHeaders(NextResponse.next(), pathname, corsOrigin);
  }

  // GAP-0030: Verify the NextAuth session token. Previous implementation only
  // checked `request.cookies.has('authjs.session-token')` — a name-only presence
  // check that any attacker could satisfy with `Cookie: authjs.session-token=anything`.
  // Behavioral exploit was confirmed 2026-05-16T11:30Z: fake-value cookie returned
  // 200 OK on `/api/approvals`. Replaced with `getToken` which decodes and
  // verifies the NextAuth JWE using AUTH_SECRET — only sessions actually
  // issued by `lib/auth.ts` pass.
  const authSecretForSession = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  let hasSession = false;
  if (authSecretForSession) {
    try {
      const token = await getToken({
        req: request,
        secret: authSecretForSession,
        // NextAuth v5 auto-detects the cookie name based on secureCookie;
        // we rely on that default so this works in both dev (`authjs.session-token`)
        // and prod (`__Secure-authjs.session-token`).
      });
      hasSession = !!token;
    } catch {
      hasSession = false;
    }
  } else {
    // No secret configured — refuse rather than silently allow. Same posture
    // as the Bearer-token branch below.
    console.error(
      '[middleware] CRITICAL: AUTH_SECRET/NEXTAUTH_SECRET is unset. Refusing all requests until configured.',
      { pathname, method: request.method },
    );
    const res = NextResponse.json(
      { error: 'Server misconfiguration: auth secret not configured' },
      { status: 500 },
    );
    return withCommonHeaders(res, pathname, corsOrigin);
  }

  // Check for Bearer token (mobile app)
  const authHeader = request.headers.get('Authorization');
  let hasBearerToken = false;

  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    if (token.length > 0) {
      // Security (H6): Verify JWT signature — presence-only check bypassed by any string.
      const authSecret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
      if (!authSecret) {
        console.error(
          '[middleware] CRITICAL: Bearer token presented but AUTH_SECRET/NEXTAUTH_SECRET is unset. Refusing request.',
          { pathname, method: request.method },
        );
        const res = NextResponse.json(
          { error: 'Server misconfiguration: auth secret not configured' },
          { status: 500 },
        );
        return withCommonHeaders(res, pathname, corsOrigin);
      }
      try {
        const secret = new TextEncoder().encode(authSecret);
        await jwtVerify(token, secret);
        hasBearerToken = true;
      } catch {
        hasBearerToken = false;
      }
    }
  }

  if (!hasSession && !hasBearerToken) {
    // For API routes, return 401 instead of redirect
    if (pathname.startsWith('/api/')) {
      const res = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      return withCommonHeaders(res, pathname, corsOrigin);
    }
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('callbackUrl', pathname);
    // This redirect previously carried NO headers at all — not even CORS.
    return withCommonHeaders(NextResponse.redirect(loginUrl), pathname, corsOrigin);
  }

  return withCommonHeaders(NextResponse.next(), pathname, corsOrigin);
}

export const config = {
  matcher: [
    // Match all routes except static files
    // Keep in sync with the public-path list above — icon.svg is the App Router
    // app icon and must not be auth-gated (see the note there).
    '/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png|apple-touch-icon.png|manifest.json).*)',
  ],
};
