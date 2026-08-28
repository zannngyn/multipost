import { z } from "zod";

import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { readJsonBody } from "@/app/api/_lib/read-json-body";
import { requireTenantContext } from "@/app/api/_lib/require-tenant-context";
import { getContainer, MAX_UPLOADS_PER_POST } from "@/composition/container";

/**
 * E9 — "tên file này mang mã nào, và mã đó có trong catalog không?"
 * Mỏng theo hợp đồng (docs/07 §3.3): authorise → validate → usecase → map.
 *
 * KHÔNG nhận byte nào. Body chỉ là danh sách TÊN FILE, vài KB, nên màn Soạn
 * bài gọi được ngay lúc operator thả file — trước khi bất kỳ thứ gì lên mạng.
 *
 * `tenantId` không nằm trong body: lấy từ session như mọi route khác (doc 10
 * §8.12). Một client cũ còn gửi thì schema này bỏ qua.
 */

const ROUTE = "POST /api/posts/uploads/detect-code";

const BodySchema = z.object({
  files: z
    .array(z.object({ fileName: z.string().trim().min(1, "Thiếu tên file.").max(512, "Tên file quá dài.") }))
    .min(1, "Chưa chọn file nào.")
    .max(MAX_UPLOADS_PER_POST, `Một bài chỉ nhận tối đa ${MAX_UPLOADS_PER_POST} file.`),
});

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    // --- Refusals first, before the body is touched -------------------------
    const { ctx } = await requireTenantContext(request, {
      surface: `api:${ROUTE}`,
      tier: "M",
      minRole: "editor",
    });

    const body = await readJsonBody(request, BodySchema, { route: ROUTE });

    const result = await container.usecases.detectUploadCode({
      tenantId: ctx.tenantId,
      files: body.files,
    });

    return Response.json(result);
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
