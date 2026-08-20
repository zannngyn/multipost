import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { readUploadForm } from "@/app/api/_lib/read-upload-form";
import { requireTenantContext } from "@/app/api/_lib/require-tenant-context";
import { getContainer, MAX_UPLOAD_BYTES, type UploadedFile } from "@/composition/container";

/**
 * E9.1 — mode B intake. Thin by contract (docs/07 §3.3): authorise, parse the
 * multipart body (`_lib/read-upload-form`), hand it to `uploadMedia`, map the
 * AppError.
 *
 * M1.3b — editor / tier M (doc 10 §4.2), and the authorisation happens BEFORE a
 * single byte is read: this route writes files into the tenant's storage, so an
 * unauthorised caller must not even get to spend our memory on their body.
 * The old `tenantId` multipart FIELD is gone (doc 10 §8.12).
 *
 * A refused file comes back in the body of a 200, not as an error status: the
 * operator dragged several files and needs to see WHICH one was refused while
 * keeping the ones that were accepted. A call where nothing was usable throws
 * inside the usecase and lands here as a 4xx.
 */

const ROUTE = "POST /api/posts/uploads";

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

    const form = await readUploadForm(request, ROUTE, ctx.tenantId);

    const files: UploadedFile[] = [];
    for (const [index, part] of form.parts.entries()) {
      // Do not buffer a part the gate will refuse anyway. The usecase still
      // sees it — with its declared size — and reports it by name.
      const bytes =
        form.declaredSizes[index] > MAX_UPLOAD_BYTES
          ? new Uint8Array(0)
          : new Uint8Array(await part.arrayBuffer());
      files.push({ fileName: part.name, mimeType: part.type, bytes });
    }

    const result = await container.usecases.uploadMedia({
      tenantId: ctx.tenantId,
      productCode: form.productCode,
      files,
      order: form.order,
      declaredSizes: form.declaredSizes,
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
    });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
