import { createHash } from "node:crypto";

import { z } from "zod";

import { getOperatorSession } from "@/app/_auth/session";
import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { readJsonBody } from "@/app/api/_lib/read-json-body";
import { getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";

/**
 * E10 — the compose screen's draft: read it back, autosave it, throw it away.
 *
 * Thin by contract (docs/07 §3.3). Everything that decides what a draft may
 * contain lives in `core/domain/post-draft.ts`: the whitelist (a payload with
 * stock/price/note/URL comes back 422 DRAFT_PAYLOAD_REJECTED), the 64 KiB cap
 * (413 DRAFT_TOO_LARGE) and the shape itself.
 *
 * WHO the draft belongs to is core's decision too: the usecases take the session
 * e-mail and answer `persisted: false` when it matches no `app_user` row. This
 * file passes the e-mail down and turns the answer into HTTP — it does not look
 * an operator up, and it no longer repeats the "no app_user" branch in three
 * handlers where nothing would test it.
 *
 * Identity comes from the SESSION, never from the body. A draft addressed by
 * tenant alone would be tenant-SHARED, and two operators on the same tenant
 * would silently overwrite each other's work.
 *
 * Two answers that look alike and are NOT:
 *  - `persisted: true` with `draft: null` — this operator HAS server-side
 *    storage and there is nothing in it yet. Autosave will create the row.
 *  - `persisted: false` — no operator row to address, so nothing can live on the
 *    server at all, and the screen must say "chỉ lưu trên máy này".
 * Collapsing the two turns a working autosave into a silent local-only one.
 */

const ROUTE_GET = "GET /api/posts/drafts";
const ROUTE_PUT = "PUT /api/posts/drafts";
const ROUTE_DELETE = "DELETE /api/posts/drafts";

/**
 * Owner key handed to the browser so its `localStorage` buffer can be scoped to
 * the SAME (tenant, owner) pair the DB indexes on.
 *
 * A hash, not the id: `app_user.id` is an internal identifier and there is no
 * reason for it to sit in a key any script on the page can read. It is salted
 * with the tenant, so the same operator on two tenants gets two buckets, and
 * truncated to 16 hex chars — long enough that two operators never collide,
 * short enough to keep the key readable while debugging.
 */
function ownerKeyFor(tenantId: string, ownerUserId: string): string {
  return createHash("sha256").update(`${tenantId}:${ownerUserId}`).digest("hex").slice(0, 16);
}

const TenantQuerySchema = z.object({
  tenantId: z.string({ error: "Thiếu tham số tenantId." }).trim().min(1, "Thiếu tham số tenantId."),
});

const SaveSchema = z
  .object({
    tenantId: z
      .string({ error: "Thiếu mã đơn vị (tenant)." })
      .trim()
      .min(1, "Thiếu mã đơn vị (tenant)."),
    /**
     * Deliberately `unknown`: the draft shape is core's business, and validating
     * it twice with two slightly different schemas is how the two drift apart.
     * The usecase rejects a bad payload with a code this route already maps.
     */
    payload: z.unknown(),
  })
  .refine((body) => body.payload !== undefined, {
    message: "Thiếu nội dung nháp.",
    path: ["payload"],
  });

export const dynamic = "force-dynamic";

function parseTenantQuery(request: Request, route: string): string {
  const url = new URL(request.url);
  const parsed = TenantQuerySchema.safeParse({
    tenantId: url.searchParams.get("tenantId") ?? undefined,
  });

  if (!parsed.success) {
    throw new AppError("INVALID_INPUT", {
      message: `Invalid query string for ${route}`,
      userMessage: "Tham số không hợp lệ. Vui lòng kiểm tra lại mã đơn vị (tenant).",
      context: {
        route,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join(".") || "tenantId",
          message: issue.message,
        })),
      },
    });
  }

  return parsed.data.tenantId;
}

/**
 * E-mail of the caller, or null when there is no session.
 *
 * Not an authorisation check — middleware already guards `/api`. It is the only
 * half of the ownership question this layer knows about; the usecases turn it
 * into an `app_user.id`, or answer `persisted: false` because they cannot.
 */
async function resolveOwnerEmail(route: string): Promise<string | null> {
  const session = await getOperatorSession(`api:${route}`);
  const email = session?.email?.trim() ?? "";
  return email.length > 0 ? email : null;
}

export async function GET(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    const tenantId = parseTenantQuery(request, ROUTE_GET);
    const result = await container.usecases.loadPostDraft({
      tenantId,
      ownerEmail: await resolveOwnerEmail(ROUTE_GET),
    });

    // --- Edge case first: no owner means no server-side draft, not a failure --
    // `ownerKey: null` tells the client to use its anonymous bucket instead of
    // reading whatever a named operator left on this machine. The usecase has
    // already logged the reason.
    if (!result.persisted) {
      return Response.json({ draft: null, updatedAt: null, persisted: false, ownerKey: null });
    }

    // `draft: null` on this branch means "storage exists and is empty", which is
    // why `persisted` stays true: autosave must keep writing to the server.
    return Response.json({
      draft: result.draft?.payload ?? null,
      updatedAt: result.draft?.updatedAt ?? null,
      persisted: true,
      ownerKey: ownerKeyFor(tenantId, result.ownerUserId),
    });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE_GET } });
  }
}

export async function PUT(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    // `readJsonBody` parses the body itself, so a `text/plain` beacon body is
    // read exactly like an `application/json` one.
    const body = await readJsonBody(request, SaveSchema, { route: ROUTE_PUT });
    const saved = await container.usecases.savePostDraft({
      tenantId: body.tenantId,
      ownerEmail: await resolveOwnerEmail(ROUTE_PUT),
      payload: body.payload,
    });

    // --- Edge case first ----------------------------------------------------
    // 200, not an error: nothing went wrong, the draft simply has nowhere to
    // live on the server. The screen turns this into "chỉ lưu trên máy này",
    // and `reason` is the usecase's own word for it, not a string invented here.
    if (!saved.persisted) {
      return Response.json({ updatedAt: null, persisted: false, reason: saved.reason });
    }

    return Response.json({ updatedAt: saved.updatedAt, persisted: true });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE_PUT } });
  }
}

/**
 * `navigator.sendBeacon` can only send POST, and it is the only way to flush a
 * draft while the tab is closing. Same handler, same idempotent upsert — a
 * second identical call writes the same row again and changes nothing.
 */
export const POST = PUT;

export async function DELETE(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    const tenantId = parseTenantQuery(request, ROUTE_DELETE);

    // No owner = no row addressed to anyone, and "already gone" is exactly the
    // outcome the caller asked for — so both branches answer 204 instead of
    // inventing a failure. The usecase logs which of the two happened, and a
    // DB failure still throws and becomes a real error response below.
    await container.usecases.discardPostDraft({
      tenantId,
      ownerEmail: await resolveOwnerEmail(ROUTE_DELETE),
    });

    return new Response(null, { status: 204 });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE_DELETE } });
  }
}
