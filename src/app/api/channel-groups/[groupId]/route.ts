import { z } from "zod";

import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { uuidField } from "@/app/api/_lib/ids";
import { readJsonBody } from "@/app/api/_lib/read-json-body";
import { getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";

/**
 * E7.6 — one preset channel group: rename / change members (PUT) and delete.
 *
 * PUT, not PATCH: the usecase replaces both fields at once (name + full member
 * list), so a partial body would be a lie about what the request does.
 *
 * A group of another tenant answers exactly like a group that does not exist
 * (INVALID_INPUT + `GROUP_NOT_FOUND`) — tenant scoping is inside the usecase.
 */

const ROUTE_PUT = "PUT /api/channel-groups/[groupId]";
const ROUTE_DELETE = "DELETE /api/channel-groups/[groupId]";

/** Mirrors MAX_CHANNELS_PER_GROUP / MAX_CHANNEL_GROUP_NAME_LENGTH in core. */
const MAX_CHANNELS_PER_GROUP = 50;
const MAX_NAME_LENGTH = 80;

const UpdateSchema = z.object({
  tenantId: z
    .string({ error: "Thiếu mã đơn vị (tenant)." })
    .trim()
    .min(1, "Thiếu mã đơn vị (tenant)."),
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

const DeleteRequestSchema = z.object({
  tenantId: z.string({ error: "Thiếu tham số tenantId." }).trim().min(1, "Thiếu tham số tenantId."),
  groupId: uuidField("Mã nhóm kênh không hợp lệ."),
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

    const { groupId } = await context.params;
    // --- Edge case first ----------------------------------------------------
    const parsedId = GroupIdSchema.safeParse(groupId);
    if (!parsedId.success) throw invalidGroupId(ROUTE_PUT);

    const body = await readJsonBody(request, UpdateSchema, { route: ROUTE_PUT });

    const group = await container.usecases.channelGroups.updateChannelGroup({
      tenantId: body.tenantId,
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

    const { groupId } = await context.params;
    const url = new URL(request.url);
    const parsed = DeleteRequestSchema.safeParse({
      tenantId: url.searchParams.get("tenantId") ?? undefined,
      groupId,
    });

    // --- Edge case first: no tenant / bad id, no delete ---------------------
    if (!parsed.success) {
      throw new AppError("INVALID_INPUT", {
        message: "Invalid request for channel group deletion",
        userMessage: "Tham số không hợp lệ. Vui lòng kiểm tra lại mã nhóm và mã đơn vị (tenant).",
        context: {
          route: ROUTE_DELETE,
          group_id: groupId,
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join(".") || "tenantId",
            message: issue.message,
          })),
        },
      });
    }

    const result = await container.usecases.channelGroups.deleteChannelGroup({
      tenantId: parsed.data.tenantId,
      groupId: parsed.data.groupId,
    });

    return Response.json(result);
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE_DELETE } });
  }
}
