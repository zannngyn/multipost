import { loadAppOrigin } from "@/composition/config";
import type { ErrorLogger } from "@/app/api/_lib/http-errors";

/**
 * Which origin an OAuth callback may send the browser back to.
 *
 * NOT `new URL(request.url).origin`. Behind the tunnel + proxy the internal hop
 * arrives with whatever Host the proxy passed on, and on this deployment that
 * is the container's own bind — so a callback that redirected to
 * `${request.origin}/sync` sent the operator to `https://0.0.0.0:3000/sync`
 * and the browser answered ERR_SSL_PROTOCOL_ERROR. The Drive credential had
 * been stored correctly a moment earlier; only the last hop was wrong, which is
 * the worst shape for this bug — the work succeeded and the operator sees a
 * broken browser page.
 *
 * `AUTH_URL` is the canonical public origin and every environment already sets
 * it for the OAuth callbacks themselves (`loadAppOrigin`, composition/config).
 *
 * Falling back to the request origin is deliberate: this runs on the ONLY exit
 * these routes have, so a deployment that somehow lacks AUTH_URL must still get
 * a redirect rather than a 500 on top of whatever else went wrong. The fallback
 * is logged with an error code, because it means the next redirect may be wrong
 * in exactly the way described above.
 */
export function resolveRedirectOrigin(
  current: URL,
  logger: ErrorLogger,
  route: string,
): string {
  try {
    return loadAppOrigin();
  } catch (error) {
    logger.warn("AUTH_URL unusable — falling back to the request origin for the redirect", {
      route,
      error_code: "APP_ORIGIN_UNAVAILABLE",
      request_origin: current.origin,
      err: error,
    });
    return current.origin;
  }
}
