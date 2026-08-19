import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { DEMO_TENANT_ID, getContainer } from "@/composition/container";

/**
 * Shop name shown next to the brand in the top bar.
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
 *
 * TODO: the active tenant is still the seeded demo id, as everywhere else in
 * the UI; this reads whichever tenant the session resolves to once that lands.
 */

/** Long enough for a healthy round-trip, short enough to be invisible. */
const READ_TIMEOUT_MS = 1_500;

const TIMED_OUT = Symbol("tenant-name-timeout");

export async function readTenantName(): Promise<string | null> {
  // Bound to the container's logger as soon as there is one: pino carries the
  // process bindings, and fallback-logger is documented as build-time-only.
  let log = fallbackLogger;

  try {
    const container = getContainer();
    log = container.logger;

    const read = container.usecases.healthcheckTenant({ tenantId: DEMO_TENANT_ID });
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
            tenant_id: DEMO_TENANT_ID,
            err: error,
          });
        });

        log.warn("Top bar tenant name timed out, rendering without it", {
          error_code: "TENANT_NAME_TIMEOUT",
          surface: "layout:(app)",
          tenant_id: DEMO_TENANT_ID,
          timeout_ms: READ_TIMEOUT_MS,
        });
        return null;
      }

      return result.name;
    } finally {
      // The read usually wins; without this every request leaves a live timer
      // and its closure behind for the rest of the window.
      timer.cancel();
    }
  } catch (error) {
    log.warn("Top bar tenant name unavailable, rendering without it", {
      surface: "layout:(app)",
      tenant_id: DEMO_TENANT_ID,
      err: error,
    });
    return null;
  }
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
