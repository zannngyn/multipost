import { z } from "zod";

import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { readJsonBody } from "@/app/api/_lib/read-json-body";
import { requireTenantContext } from "@/app/api/_lib/require-tenant-context";
import { getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";

/**
 * E5.1 — one connected channel: switch it on/off (PUT) or drop it (DELETE).
 *
 * PUT, not PATCH: the body carries the whole new state of the only mutable
 * field, and the UI's http client speaks GET/POST/PUT/DELETE.
 *
 * Turning a channel OFF is the safe way to stop posting to a Page without
 * losing its token; DELETE removes it from the picker entirely. Neither touches
 * post jobs that already exist — they carry their own copy of the channel id.
 *
 * The actor comes from the SESSION, never from the body: a caller must not be
 * able to write someone else's name into the audit trail.
 *
 * M1.3b — admin / tier S for BOTH verbs (doc 10 §4.2). DELETE drops a stored
 * Page token; PUT re-opens (or shuts) a door to a real Page, and an operator
 * whose membership was revoked a second ago must not be able to open one.
 */

const ROUTE_PUT = "PUT /api/channels/[channelId]";
const ROUTE_DELETE = "DELETE /api/channels/[channelId]";
const MAX_CHANNEL_ID = 128;

const UpdateSchema = z.object({
  status: z.enum(["active", "disabled"], { error: "Trạng thái kênh chỉ nhận bật hoặc tắt." }),
});

const ChannelIdSchema = z
  .string()
  .trim()
  .min(1, "Mã kênh không hợp lệ.")
  .max(MAX_CHANNEL_ID, "Mã kênh không hợp lệ.");

function invalidChannelId(route: string): AppError {
  return new AppError("INVALID_INPUT", {
    message: "Invalid channel id in the URL",
    userMessage: "Mã kênh không hợp lệ.",
    context: { route, issues: [{ path: "channelId", message: "Mã kênh không hợp lệ." }] },
  });
}

export const dynamic = "force-dynamic";

export async function PUT(
  request: Request,
  context: { params: Promise<{ channelId: string }> },
): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    // --- Refusals first ------------------------------------------------------
    const { ctx, session } = await requireTenantContext(request, {
      surface: `api:${ROUTE_PUT}`,
      tier: "S",
      minRole: "admin",
    });

    const { channelId } = await context.params;
    const parsedId = ChannelIdSchema.safeParse(decodeURIComponent(channelId ?? ""));
    if (!parsedId.success) throw invalidChannelId(ROUTE_PUT);

    const body = await readJsonBody(request, UpdateSchema, { route: ROUTE_PUT });

    const channel = await container.usecases.channels.setChannelStatus({
      tenantId: ctx.tenantId,
      channelId: parsedId.data,
      status: body.status,
      actorEmail: session.email,
    });

    return Response.json({ channelId: channel.channelId, status: channel.status });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE_PUT } });
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ channelId: string }> },
): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    // --- Refusals first ------------------------------------------------------
    const { ctx, session } = await requireTenantContext(request, {
      surface: `api:${ROUTE_DELETE}`,
      tier: "S",
      minRole: "admin",
    });

    const { channelId } = await context.params;
    const parsedId = ChannelIdSchema.safeParse(decodeURIComponent(channelId ?? ""));
    if (!parsedId.success) throw invalidChannelId(ROUTE_DELETE);

    const result = await container.usecases.channels.removeChannel({
      tenantId: ctx.tenantId,
      channelId: parsedId.data,
      actorEmail: session.email,
    });

    return Response.json(result);
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE_DELETE } });
  }
}
