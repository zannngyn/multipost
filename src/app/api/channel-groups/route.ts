import { z } from "zod";

import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { readJsonBody } from "@/app/api/_lib/read-json-body";
import { getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";

/**
 * E7.6 — preset channel groups: list + create.
 * Thin by contract (docs/07 §3.3); every business rule (name required, at least
 * one channel, membership must exist in `tenant_integration`) lives in the
 * usecase and comes back as INVALID_INPUT with a Vietnamese sentence.
 */

const ROUTE_GET = "GET /api/channel-groups";
const ROUTE_POST = "POST /api/channel-groups";

/** Mirrors MAX_CHANNELS_PER_GROUP / MAX_CHANNEL_GROUP_NAME_LENGTH in core. */
const MAX_CHANNELS_PER_GROUP = 50;
const MAX_NAME_LENGTH = 80;

const QuerySchema = z.object({
  tenantId: z.string({ error: "Thiếu tham số tenantId." }).trim().min(1, "Thiếu tham số tenantId."),
});

const CreateSchema = z.object({
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

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    const url = new URL(request.url);
    const parsed = QuerySchema.safeParse({
      tenantId: url.searchParams.get("tenantId") ?? undefined,
    });

    // --- Edge case first ----------------------------------------------------
    if (!parsed.success) {
      throw new AppError("INVALID_INPUT", {
        message: "Invalid query string for channel groups",
        userMessage: "Tham số không hợp lệ. Vui lòng kiểm tra lại mã đơn vị (tenant).",
        context: {
          route: ROUTE_GET,
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join(".") || "tenantId",
            message: issue.message,
          })),
        },
      });
    }

    const groups = await container.usecases.channelGroups.listChannelGroups({
      tenantId: parsed.data.tenantId,
    });

    return Response.json({ tenantId: parsed.data.tenantId, groups });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE_GET } });
  }
}

export async function POST(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    const body = await readJsonBody(request, CreateSchema, { route: ROUTE_POST });
    const group = await container.usecases.channelGroups.createChannelGroup({
      tenantId: body.tenantId,
      name: body.name,
      channelIds: body.channelIds,
    });

    return Response.json(group, { status: 201 });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE_POST } });
  }
}
