import NextAuth from "next-auth";
import {
  NextResponse,
  type NextFetchEvent,
  type NextMiddleware,
  type NextRequest,
} from "next/server";

import { buildBaseAuthConfig } from "@/app/_auth/auth.config";
import { isDevFakeSessionEnabled, warnDevFakeSession } from "@/app/_auth/dev-session";
import { safeReturnUrl } from "@/app/_auth/return-url";
import { AppError } from "@/core/domain/errors";

/**
 * Route guard. Blocks *before* anything renders (web-auth-session rule 2) —
 * never in a `useEffect`, which would ship private markup first.
 *
 * Runs on the Node.js runtime: `loadAuthConfig()` reads `process.env` through a
 * zod schema (dynamic property access), and the Edge bundler only inlines env
 * vars it can see statically. On Edge the secret would silently be `undefined`
 * in a production build. Node runtime = real `process.env`, no surprises.
 */
export const runtime = "nodejs";

/** Everything else requires a session. Prefix match, plus their sub-paths. */
const PUBLIC_PREFIXES = [
  "/signin", // the door itself — must stay outside the guard, or redirect loop
  "/api/auth", // Auth.js flow endpoints
  "/api/health", // liveness probe for Docker/Caddy, called without a session
] as const;

/**
 * Session decoding only — no providers needed to read a JWT cookie.
 *
 * Built on first request, not at import time: `buildBaseAuthConfig()` reads env
 * through zod and throws when it is incomplete, and `next build` must not need
 * Google credentials. The config OBJECT (not the lazy factory) is passed on
 * purpose: with a factory, `auth(handler)` returns a Promise of a middleware
 * instead of a middleware (see next-auth/lib/index.js `initAuth`).
 */
let cachedGuard: NextMiddleware | null = null;

function getGuard(): NextMiddleware {
  if (cachedGuard) return cachedGuard;

  const { auth: withSession } = NextAuth(buildBaseAuthConfig());
  // The second parameter is what tells TypeScript to pick the middleware
  // overload of `auth()` rather than the route-handler one; it is unused here.
  cachedGuard = withSession((request, _event: NextFetchEvent) => {
    // `request.auth` is the decoded JWT session, or null.
    if (request.auth?.user) return NextResponse.next();
    return deny(request);
  });

  return cachedGuard;
}

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function logDenied(request: NextRequest, kind: "json" | "redirect"): void {
  console.warn(
    JSON.stringify({
      level: "warn",
      time: new Date().toISOString(),
      message: "Request blocked: no valid session",
      error_code: "UNAUTHORIZED",
      path: request.nextUrl.pathname,
      method: request.method,
      response: kind,
    }),
  );
}

/**
 * API -> 401 JSON in the shared `{code, message}` shape (same as
 * `mapAppErrorToHttp`, which cannot be reused here: importing the container
 * would drag Postgres into the middleware bundle).
 * Page -> redirect to /signin carrying returnUrl so the operator lands back
 * on the page they asked for.
 */
function deny(request: NextRequest): NextResponse {
  const error = new AppError("UNAUTHORIZED", {
    context: { path: request.nextUrl.pathname },
  });

  if (isApiPath(request.nextUrl.pathname)) {
    logDenied(request, "json");
    return NextResponse.json({ code: error.code, message: error.userMessage }, { status: 401 });
  }

  logDenied(request, "redirect");
  const target = request.nextUrl.clone();
  target.pathname = "/signin";
  target.search = "";
  target.searchParams.set(
    "returnUrl",
    safeReturnUrl(`${request.nextUrl.pathname}${request.nextUrl.search}`),
  );
  return NextResponse.redirect(target);
}

export default async function middleware(
  request: NextRequest,
  event: NextFetchEvent,
): Promise<NextResponse | Response> {
  const { pathname } = request.nextUrl;

  if (isPublicPath(pathname)) return NextResponse.next();

  // Dev bypass: checked before Auth.js runs, so a developer can exercise the
  // protected routes without Google credentials (see _auth/dev-session.ts).
  if (isDevFakeSessionEnabled()) {
    warnDevFakeSession({ surface: "middleware", path: pathname });
    return NextResponse.next();
  }

  const response = await getGuard()(request, event);
  return response ?? NextResponse.next();
}

export const config = {
  // Static assets and image optimisation never carry a session; matching them
  // would only burn CPU. Everything else — pages and API — goes through.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
