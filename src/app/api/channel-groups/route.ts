import { z } from "zod";

import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { readJsonBody } from "@/app/api/_lib/read-json-body";
import { requireTenantContext } from "@/app/api/_lib/require-tenant-context";
import { getContainer } from "@/composition/container";

/**
 * E7.6 — preset channel groups: list + create.
 * Thin by contract (docs/07 §3.3); every business rule (name required, at least
 * one channel, membership must exist in `tenant_integration`) lives in the
 * usecase and comes back as INVALID_INPUT with a Vietnamese sentence.
 *
 * M1.3b — viewer to list, editor to create; tier R / M (doc 10 §4.2). A group
 * is a PRESET: it decides nothing on its own, because the batch names its
 * channels explicitly, so it does not earn tier S.
 */

const ROUTE_GET = "GET /api/channel-groups";
const ROUTE_POST = "POST /api/channel-groups";

/** Mirrors MAX_CHANNELS_PER_GROUP / MAX_CHANNEL_GROUP_NAME_LENGTH in core. */
const MAX_CHANNELS_PER_GROUP = 50;
const MAX_NAME_LENGTH = 80;

const CreateSchema = z.object({
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

    // --- Refusals first -----------------------------------------------------
    const { ctx } = await requireTenantContext(request, {
      surface: `api:${ROUTE_GET}`,
      tier: "R",
    });

    const groups = await container.usecases.channelGroups.listChannelGroups({
      tenantId: ctx.tenantId,
    });

    return Response.json({ tenantId: ctx.tenantId, groups });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE_GET } });
  }
}

export async function POST(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    // --- Refusals first -----------------------------------------------------
    const { ctx } = await requireTenantContext(request, {
      surface: `api:${ROUTE_POST}`,
      tier: "M",
      minRole: "editor",
    });

    const body = await readJsonBody(request, CreateSchema, { route: ROUTE_POST });
    const group = await container.usecases.channelGroups.createChannelGroup({
      tenantId: ctx.tenantId,
      name: body.name,
      channelIds: body.channelIds,
    });

    return Response.json(group, { status: 201 });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE_POST } });
  }
}
