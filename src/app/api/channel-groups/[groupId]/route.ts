import { z } from "zod";

import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { uuidField } from "@/app/api/_lib/ids";
import { readJsonBody } from "@/app/api/_lib/read-json-body";
import { requireTenantContext } from "@/app/api/_lib/require-tenant-context";
import { getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";

/**
 * E7.6 — one preset channel group: rename / change members (PUT) and delete.
 *
 * PUT, not PATCH: the usecase replaces both fields at once (name + full member
 * list), so a partial body would be a lie about what the request does.
 *
 * A group of another tenant answers exactly like a group that does not exist —
 * now 404 CHANNEL_GROUP_NOT_FOUND (Bug B5); tenant scoping is in the usecase.
 *
 * M1.3b — editor / tier M for both verbs (doc 10 §4.2).
 */

const ROUTE_PUT = "PUT /api/channel-groups/[groupId]";
const ROUTE_DELETE = "DELETE /api/channel-groups/[groupId]";

/** Mirrors MAX_CHANNELS_PER_GROUP / MAX_CHANNEL_GROUP_NAME_LENGTH in core. */
const MAX_CHANNELS_PER_GROUP = 50;
const MAX_NAME_LENGTH = 80;

const UpdateSchema = z.object({
  name: z
    .string({ error: "Nhóm kênh phải có tên." })
    .trim()
    .min(1, "Nhóm kênh phải có tên.")
    .max(MAX_NAME_LENGTH, `Tên nhóm kênh tối đa ${MAX_NAME_LENGTH} ký tự.`),
  channelIds: z
    .array(z.string().trim().min(1, "Mã kênh không hợp lệ.").max(128, "Mã kênh quá dài."))
    .min(1, "Nhóm kênh phải có ít nhất một kênh.")
    .max(MAX_CHANNELS_PER_GROUP, `Một nhóm kênh chỉ chứa tối đa ${MAX_CHANNELS_PER_GROUP} kênh.`),
});

/** A typo in the URL must be a 400, not a DB cast error (see _lib/ids). */
const GroupIdSchema = uuidField("Mã nhóm kênh không hợp lệ.");

function invalidGroupId(route: string): AppError {
  return new AppError("INVALID_INPUT", {
    message: "Invalid channel group id in the URL",
    userMessage: "Mã nhóm kênh không hợp lệ.",
    context: {
      route,
      issues: [{ path: "groupId", message: "Mã nhóm kênh không hợp lệ." }],
    },
  });
}

export const dynamic = "force-dynamic";

export async function PUT(
  request: Request,
  context: { params: Promise<{ groupId: string }> },
): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    // --- Refusals first -----------------------------------------------------
    const { ctx } = await requireTenantContext(request, {
      surface: `api:${ROUTE_PUT}`,
      tier: "M",
      minRole: "editor",
    });

    const { groupId } = await context.params;
    const parsedId = GroupIdSchema.safeParse(groupId);
    if (!parsedId.success) throw invalidGroupId(ROUTE_PUT);

    const body = await readJsonBody(request, UpdateSchema, { route: ROUTE_PUT });

    const group = await container.usecases.channelGroups.updateChannelGroup({
      tenantId: ctx.tenantId,
      groupId: parsedId.data,
      name: body.name,
      channelIds: body.channelIds,
    });

    return Response.json(group);
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE_PUT } });
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ groupId: string }> },
): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    // --- Refusals first -----------------------------------------------------
    const { ctx } = await requireTenantContext(request, {
      surface: `api:${ROUTE_DELETE}`,
      tier: "M",
      minRole: "editor",
    });

    const { groupId } = await context.params;
    const parsedId = GroupIdSchema.safeParse(groupId);
    if (!parsedId.success) throw invalidGroupId(ROUTE_DELETE);

    const result = await container.usecases.channelGroups.deleteChannelGroup({
      tenantId: ctx.tenantId,
      groupId: parsedId.data,
    });

    return Response.json(result);
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE_DELETE } });
  }
}
