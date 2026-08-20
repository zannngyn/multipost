import { createHash } from "node:crypto";

import { z } from "zod";

import { getOperatorSession } from "@/app/_auth/session";
import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { readJsonBody } from "@/app/api/_lib/read-json-body";
import { getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";
import { legacyTenantIdFromRequest } from "@/composition/legacy-tenant-id";

/**
 * E10 — the compose screen's draft: read it back, autosave it, throw it away.
 *
 * Thin by contract (docs/07 §3.3). Everything that decides what a draft may
 * contain lives in `core/domain/post-draft.ts`: the whitelist (a payload with
 * stock/price/note/URL comes back 422 DRAFT_PAYLOAD_REJECTED), the 64 KiB cap
 * (413 DRAFT_TOO_LARGE) and the shape itself. This file only resolves WHO the
 * draft belongs to and hands the payload over untouched.
 *
 * Identity: the owner is read from the SESSION, never from the body. A draft
 * addressed by tenant alone would be tenant-SHARED, and two operators on the
 * same tenant would silently overwrite each other's work.
 *
 * "No app_user row for this e-mail" is NOT an error. It is a real state of a
 * dev/demo environment, and it answers `persisted: false` so the screen can say
 * "nháp chỉ lưu trên máy này" out loud — the one thing it must not do is look
 * like a successful save.
 */

const ROUTE_GET = "GET /api/posts/drafts";
const ROUTE_PUT = "PUT /api/posts/drafts";
const ROUTE_DELETE = "DELETE /api/posts/drafts";

/** Answered when the session e-mail matches no `app_user` row of this tenant. */
const NO_USER_REASON = "NO_USER";

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
 * `app_user.id` of the caller, or null when there is no session or no row.
 *
 * Not an authorisation check — middleware already guards `/api`. This is the
 * ownership key, and refusing to guess it is the point.
 */
async function resolveOwnerUserId(tenantId: string, route: string): Promise<string | null> {
  const session = await getOperatorSession(`api:${route}`);
  const email = session?.email?.trim() ?? "";
  if (email.length === 0) return null;

  return getContainer().usecases.findOperatorUserId(legacyTenantIdFromRequest(tenantId), email);
}

export async function GET(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    const tenantId = parseTenantQuery(request, ROUTE_GET);
    const ownerUserId = await resolveOwnerUserId(tenantId, ROUTE_GET);

    // --- Edge case first: no owner means no server-side draft, not a failure --
    if (ownerUserId === null) {
      logger.warn("Draft read without a resolvable operator", {
        route: ROUTE_GET,
        tenant_id: tenantId,
        reason: NO_USER_REASON,
      });
      // `ownerKey: null` tells the client to use its anonymous bucket instead of
      // reading whatever a named operator left on this machine.
      return Response.json({ draft: null, updatedAt: null, persisted: false, ownerKey: null });
    }

    const stored = await container.usecases.loadPostDraft({ tenantId: legacyTenantIdFromRequest(tenantId), ownerUserId });

    return Response.json({
      draft: stored?.payload ?? null,
      updatedAt: stored?.updatedAt ?? null,
      persisted: true,
      ownerKey: ownerKeyFor(tenantId, ownerUserId),
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
    const ownerUserId = await resolveOwnerUserId(body.tenantId, ROUTE_PUT);

    // --- Edge case first ----------------------------------------------------
    if (ownerUserId === null) {
      logger.warn("Draft autosave without a resolvable operator", {
        route: ROUTE_PUT,
        tenant_id: body.tenantId,
        reason: NO_USER_REASON,
      });
      // 200, not an error: nothing went wrong, the draft simply has nowhere to
      // live on the server. The screen turns this into "chỉ lưu trên máy này".
      return Response.json({ updatedAt: null, persisted: false, reason: NO_USER_REASON });
    }

    const saved = await container.usecases.savePostDraft({
      tenantId: legacyTenantIdFromRequest(body.tenantId),
      ownerUserId,
      payload: body.payload,
    });

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
    const ownerUserId = await resolveOwnerUserId(tenantId, ROUTE_DELETE);

    // No owner = no row addressed to anyone; "already gone" is the same outcome
    // the caller asked for, so it answers 204 rather than inventing a failure.
    if (ownerUserId !== null) {
      await container.usecases.discardPostDraft({ tenantId: legacyTenantIdFromRequest(tenantId), ownerUserId });
    } else {
      logger.warn("Draft discard without a resolvable operator", {
        route: ROUTE_DELETE,
        tenant_id: tenantId,
        reason: NO_USER_REASON,
      });
    }

    return new Response(null, { status: 204 });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE_DELETE } });
  }
}
