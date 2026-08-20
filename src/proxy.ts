import NextAuth from "next-auth";
import {
  NextResponse,
  type NextFetchEvent,
  type NextProxy,
  type NextRequest,
} from "next/server";

import { buildBaseAuthConfig } from "@/app/_auth/auth.config";
import { isDevFakeSessionEnabled, warnDevFakeSession } from "@/app/_auth/dev-session";
import { isPublicPath } from "@/app/_lib/public-paths";
import { redactSensitivePath } from "@/app/_lib/redact-path";
import { safeReturnUrl } from "@/app/_auth/return-url";
import { AppError } from "@/core/domain/errors";

/**
 * Session decoding only — no providers needed to read a JWT cookie.
 *
 * Built on first request, not at import time: `buildBaseAuthConfig()` reads env
 * through zod and throws when it is incomplete, and `next build` must not need
 * Google credentials. The config OBJECT (not the lazy factory) is passed on
 * purpose: with a factory, `auth(handler)` returns a Promise of a middleware
 * instead of a middleware (see next-auth/lib/index.js `initAuth`).
 */
let cachedGuard: NextProxy | null = null;

function getGuard(): NextProxy {
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
      // Redacted: `/join/<token>` reaches this deny path for every signed-out
      // invitee, and the token is a bearer (see _lib/redact-path). The
      // browser's returnUrl below keeps the full path — only the log loses it.
      path: redactSensitivePath(request.nextUrl.pathname),
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
/**
 * The two OAuth callbacks are API paths the BROWSER navigates to top-level
 * (doc 10 §3, option (a)): a session that expired during the consent screen
 * must land the operator back on the screen they started from — with a reason
 * — not on a white page showing 401 JSON. Deliberately NOT public prefixes:
 * the guard still runs, only the refusal shape changes.
 */
const CALLBACK_RETURN_SCREENS: Record<string, string> = {
  "/api/catalog/google/callback": "/sync?google=error&reason=SESSION_EXPIRED",
  "/api/channels/callback": "/channels?connect=error&reason=SESSION_EXPIRED",
};

function deny(request: NextRequest): NextResponse {
  const error = new AppError("UNAUTHORIZED", {
    // Same redaction as logDenied: AppError.context is log material.
    context: { path: redactSensitivePath(request.nextUrl.pathname) },
  });

  const callbackScreen = CALLBACK_RETURN_SCREENS[request.nextUrl.pathname];
  if (callbackScreen) {
    logDenied(request, "redirect");
    return NextResponse.redirect(new URL(callbackScreen, request.nextUrl.origin));
  }

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

export default async function proxy(
  request: NextRequest,
  event: NextFetchEvent,
): Promise<NextResponse | Response> {
  const { pathname } = request.nextUrl;

  if (isPublicPath(pathname)) return NextResponse.next();

  // Dev bypass: checked before Auth.js runs, so a developer can exercise the
  // protected routes without Google credentials (see _auth/dev-session.ts).
  if (isDevFakeSessionEnabled()) {
    // Redacted for the same reason as logDenied: this line fires for every
    // request under the bypass, /join/<token> included.
    warnDevFakeSession({ surface: "middleware", path: redactSensitivePath(pathname) });
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
