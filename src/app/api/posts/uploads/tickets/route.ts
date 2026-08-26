import { z } from "zod";

import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { requireTenantContext } from "@/app/api/_lib/require-tenant-context";
import { getContainer, MAX_UPLOADS_PER_POST } from "@/composition/container";

/**
 * Stage 1 of the presigned-upload path. Thin by contract (docs/07 §3.3):
 * authorise, validate the body with zod, call the usecase, map the AppError.
 *
 * Does NOT receive bytes — the body is a few KB of JSON. Bytes go straight
 * browser -> MinIO at stage 2 (a separate POST to the signed URL this route
 * returns), and stage 3 (confirm-upload, Task 7) is where the real gate is:
 * it sniffs the stored bytes. Everything validated here is only the client's
 * claim.
 */

const ROUTE = "POST /api/posts/uploads/tickets";

const BodySchema = z.object({
  productCode: z.string().trim().min(1, "Thiếu mã sản phẩm.").max(64, "Mã sản phẩm quá dài."),
  files: z
    .array(
      z.object({
        fileName: z.string().trim().min(1).max(512),
        mimeType: z.string().trim().min(1).max(255),
        sizeBytes: z.number().int().nonnegative(),
      }),
    )
    .min(1, "Chưa chọn file nào.")
    .max(MAX_UPLOADS_PER_POST),
});

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;
  try {
    const container = getContainer();
    logger = container.logger;

    // --- Refusals first, before the body is touched -------------------------
    const { ctx, session } = await requireTenantContext(request, {
      surface: `api:${ROUTE}`,
      tier: "M",
      minRole: "editor",
    });

    const body = BodySchema.parse(await request.json());

    const result = await container.usecases.issueUploadTickets({
      tenantId: ctx.tenantId,
      productCode: body.productCode,
      // TenantContext carries no user id; the acting operator's account id
      // lives on the session (null for the dev bypass / accountless sessions).
      actorUserId: session.accountId ?? null,
      files: body.files,
    });

    return Response.json({
      issued: result.issued.map((item) => ({
        assetId: item.assetId,
        fileName: item.fileName,
        sourceIndex: item.sourceIndex,
        postUrl: item.postUrl,
        formFields: item.formFields,
        expiresAt: item.expiresAt.toISOString(),
      })),
      rejected: result.rejected,
    });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
