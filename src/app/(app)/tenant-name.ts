import { readActiveTenantCookie } from "@/app/_lib/active-tenant-cookie";
import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { getContainer } from "@/composition/container";

/**
 * Company name shown next to the brand in the top bar (M1.4).
 *
 * It reads the SESSION's company — the same overview `/api/me` serves — instead
 * of the seeded demo tenant it used to healthcheck. An operator who belongs to
 * two companies must see the one they are actually working in, and someone who
 * belongs to none must see no name at all rather than somebody else's.
 *
 * The name is decoration on the frame, not part of any screen's data, so a
 * datastore in trouble must cost the operator the label and nothing else. Two
 * separate failures can take it away, and both are handled:
 *
 *  - the read FAILS  -> logged with its cause, caller renders without the name;
 *  - the read HANGS  -> the timeout below wins the race, so a stuck pool cannot
 *    hold up the whole shell. Every screen in `(app)` waits on this call, and
 *    the layout is `force-dynamic`, so it runs on every request.
 *
 * Neither branch swallows anything (CLAUDE.md technical rule 5).
 */

/** Long enough for a healthy round-trip, short enough to be invisible. */
const READ_TIMEOUT_MS = 1_500;

const TIMED_OUT = Symbol("tenant-name-timeout");

export interface ActiveTenantLabel {
  readonly name: string | null;
  readonly plan: string | null;
}

const NO_LABEL: ActiveTenantLabel = { name: null, plan: null };

export async function readActiveTenantLabel(
  session: { email: string; isBootstrapAdmin: boolean },
  cookieHeader: string | null,
): Promise<ActiveTenantLabel> {
  // Bound to the container's logger as soon as there is one: pino carries the
  // process bindings, and fallback-logger is documented as build-time-only.
  let log = fallbackLogger;

  try {
    const container = getContainer();
    log = container.logger;

    const read = container.usecases.getOperatorOverview({
      sessionEmail: session.email,
      // From the session's env check; this layer never re-derives it.
      isBootstrapAdmin: session.isBootstrapAdmin,
      cookieTenantId: readActiveTenantCookie(cookieRequest(cookieHeader)),
    });
    const timer = timeout();

    try {
      const result = await Promise.race([read, timer.expired]);

      if (result === TIMED_OUT) {
        // The query is abandoned, not cancelled — it still settles on its own,
        // long after this render. Logging its outcome is what turns "hết giờ"
        // into an answer for "vì sao": the cause only exists on this promise.
        void read.catch((error: unknown) => {
          log.warn("Abandoned tenant name read failed after the timeout", {
            error_code: "TENANT_NAME_TIMEOUT",
            surface: "layout:(app)",
            err: error,
          });
        });

        log.warn("Top bar tenant name timed out, rendering without it", {
          error_code: "TENANT_NAME_TIMEOUT",
          surface: "layout:(app)",
          timeout_ms: READ_TIMEOUT_MS,
        });
        return NO_LABEL;
      }

      const active = result.tenants.find((tenant) => tenant.id === result.activeTenantId);
      // No membership, or several with none selected: no name is the honest
      // answer. The picker inside the shell is what says so out loud.
      if (!active) return NO_LABEL;

      return { name: active.name, plan: active.plan };
    } finally {
      // The read usually wins; without this every request leaves a live timer
      // and its closure behind for the rest of the window.
      timer.cancel();
    }
  } catch (error) {
    log.warn("Top bar tenant name unavailable, rendering without it", {
      surface: "layout:(app)",
      err: error,
    });
    return NO_LABEL;
  }
}

/**
 * `readActiveTenantCookie` takes a Request, and a layout only has the raw
 * header — this is the smallest honest adapter between the two, rather than a
 * second cookie parser that could disagree with the first one.
 */
function cookieRequest(cookieHeader: string | null): Request {
  return new Request("http://localhost/", {
    headers: cookieHeader ? { cookie: cookieHeader } : undefined,
  });
}

function timeout(): { expired: Promise<typeof TIMED_OUT>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout>;

  const expired = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), READ_TIMEOUT_MS);
    // Do not hold the process open for a label.
    timer.unref?.();
  });

  return { expired, cancel: () => clearTimeout(timer) };
}
