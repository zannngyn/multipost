import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { readUploadForm } from "@/app/api/_lib/read-upload-form";
import { getContainer, MAX_UPLOAD_BYTES, type UploadedFile } from "@/composition/container";
import { legacyTenantIdFromRequest } from "@/composition/legacy-tenant-id";

/**
 * E9.1 — mode B intake. Thin by contract (docs/07 §3.3): parse the multipart
 * body (`_lib/read-upload-form`), hand it to `uploadMedia`, map the AppError.
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

    const form = await readUploadForm(request, ROUTE);

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
      tenantId: legacyTenantIdFromRequest(form.tenantId),
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
