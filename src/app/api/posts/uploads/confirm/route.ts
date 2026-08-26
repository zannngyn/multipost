import { z } from "zod";

import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { requireTenantContext } from "@/app/api/_lib/require-tenant-context";
import { getContainer, MAX_UPLOADS_PER_POST } from "@/composition/container";

/**
 * Stage 3 of mode B: bytes already sit in MinIO, this is where they are vetted.
 *
 * A refused file comes back inside a 200 body, not an error status: the
 * operator dragged several files and needs to see WHICH one was refused while
 * keeping the ones that passed. A batch where nothing was usable is thrown by
 * the usecase and lands here as a 4xx.
 */

const ROUTE = "POST /api/posts/uploads/confirm";

const BodySchema = z.object({
  productCode: z.string().trim().min(1, "Thiếu mã sản phẩm.").max(64),
  assets: z.array(z.object({ assetId: z.string().trim().min(1).max(128) })).min(1).max(MAX_UPLOADS_PER_POST),
  order: z.array(z.number().int().nonnegative()).max(MAX_UPLOADS_PER_POST).optional(),
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

    const body = BodySchema.parse(await request.json());

    const result = await container.usecases.confirmUpload({
      tenantId: ctx.tenantId,
      productCode: body.productCode,
      assets: body.assets,
      order: body.order,
    });

    return Response.json({
      accepted: result.accepted.map((asset) => ({
        assetId: asset.driveFileId,
        fileName: asset.fileName,
        kind: asset.kind,
        sequence: asset.sequence,
        sizeBytes: asset.sizeBytes,
      })),
      rejected: result.rejected,
      warnings: result.warnings,
    });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
