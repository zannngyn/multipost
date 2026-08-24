import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { requireTenantContext } from "@/app/api/_lib/require-tenant-context";
import { getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";

/**
 * Onboarding phase 3 — the tenant hands us their product table as a CSV, for a
 * customer whose data is too dirty to sync or who has no Google Workspace at
 * all. Thin by contract (docs/07 §3.3): authorise, parse the multipart body,
 * hand the bytes to `uploadCatalogFile`, map the AppError.
 *
 * WHAT THIS ROUTE DELIBERATELY DOES NOT DO:
 *  - it does not judge the file. The usecase reads it through the SAME adapter
 *    the next sync will use, BEFORE storing a byte, so an .xlsx, a non-UTF-8
 *    export or a header-only file is refused while the operator is still looking
 *    at the screen — with the adapter's own Vietnamese sentence naming the fix.
 *    A second opinion here could only drift from that one;
 *  - it does not sync. Uploading a table is not importing it: the catalog still
 *    describes the previous source until somebody runs a sync, and the screen
 *    is the one that says so.
 *
 * Multipart, not JSON: base64 inflates a 5 MB price list by a third and forces
 * the whole thing into one string before anything can be validated.
 *
 * Auth (doc 10 §4.1): admin, tier S — the same as `PUT /api/catalog/source` and
 * for the same reason. This REPLACES the tenant's product source, and the next
 * sync deletes whatever no longer belongs to it. The membership is read fresh,
 * and the check happens before a single byte of the body is touched.
 */

const ROUTE = "POST /api/catalog/file";

/** Multipart field names. One file, one optional separator override. */
const FILE_FIELD = "file";
const DELIMITER_FIELD = "delimiter";

/**
 * Transport ceiling only — the authoritative cap is `MAX_CATALOG_TEXT_BYTES`
 * inside the usecase, which measures the bytes actually received. This exists so
 * a client declaring a huge file cannot cost us the buffer first. Deliberately a
 * touch above the domain's 5 MB: this must never be the thing that refuses a
 * borderline file, or the operator would get a transport message where the
 * domain has a better one.
 */
const MAX_DECLARED_BYTES = 8 * 1024 * 1024;

/** Longest separator override a caller may send ("\t", ";", "|", ","). */
const MAX_DELIMITER_LENGTH = 4;

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    // --- Refusals first, before the body is touched (CLAUDE.md rule 1) -----
    const { ctx, session } = await requireTenantContext(request, {
      surface: `api:${ROUTE}`,
      tier: "S",
      minRole: "admin",
    });

    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("multipart/form-data")) {
      throw new AppError("INVALID_INPUT", {
        message: "Catalog file upload requires a multipart/form-data body",
        userMessage: "Yêu cầu tải file lên không đúng định dạng.",
        context: { route: ROUTE, tenant_id: ctx.tenantId, content_type: contentType || null },
      });
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch (error) {
      // A truncated or malformed body: say so, rather than letting a parser
      // exception surface as a 500 nobody can act on.
      throw AppError.from(error, "INVALID_INPUT", {
        route: ROUTE,
        tenant_id: ctx.tenantId,
        reason: "MALFORMED_MULTIPART",
      });
    }

    const part = form.get(FILE_FIELD);
    if (!isFilePart(part)) {
      throw new AppError("INVALID_INPUT", {
        message: `Catalog file upload carried no '${FILE_FIELD}' part`,
        userMessage: "Chưa chọn file nào để tải lên.",
        context: { route: ROUTE, tenant_id: ctx.tenantId, reason: "CATALOG_FILE_MISSING" },
      });
    }

    if (part.size > MAX_DECLARED_BYTES) {
      throw new AppError("INVALID_INPUT", {
        message: "Catalog file upload exceeds the transport byte budget",
        userMessage: `File này nặng ${formatMb(part.size)} MB, vượt mức cho phép — xoá bớt cột/dòng không cần rồi xuất lại.`,
        context: {
          route: ROUTE,
          tenant_id: ctx.tenantId,
          reason: "CATALOG_FILE_TOO_LARGE",
          declared_bytes: part.size,
          max_bytes: MAX_DECLARED_BYTES,
        },
      });
    }

    const delimiter = readDelimiter(form.get(DELIMITER_FIELD), ctx.tenantId);

    const result = await container.usecases.uploadCatalogFile({
      tenantId: ctx.tenantId,
      fileName: part.name,
      // A HINT only, and the usecase treats it as one: the bytes decide, so an
      // .xlsx renamed to .csv is still caught.
      contentType: part.type.length > 0 ? part.type : null,
      bytes: new Uint8Array(await part.arrayBuffer()),
      ...(delimiter === null ? {} : { delimiter }),
      // From the SESSION, never from the body — a caller must not be able to
      // write somebody else's name into the audit trail.
      actorEmail: session.email,
    });

    return Response.json(result);
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}

// --- helpers ----------------------------------------------------------------

/** `File` in the web sense; a plain string part is a field, not a file. */
function isFilePart(value: FormDataEntryValue | null): value is File {
  return typeof value === "object" && value !== null && "arrayBuffer" in value;
}

/**
 * The separator the operator overrode, or null to let the reader detect it.
 *
 * An oversized value is REFUSED rather than trimmed to fit: a caller sending
 * four-plus characters means something this route does not understand, and
 * silently reading the first few would pick a separator nobody asked for.
 */
function readDelimiter(value: FormDataEntryValue | null, tenantId: string): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (value.length > MAX_DELIMITER_LENGTH) {
    throw new AppError("INVALID_INPUT", {
      message: "Catalog file upload carried an unusable delimiter override",
      userMessage: "Ký tự ngăn cách cột không hợp lệ — bỏ trống để hệ thống tự nhận diện.",
      context: {
        route: ROUTE,
        tenant_id: tenantId,
        reason: "CATALOG_FILE_DELIMITER_INVALID",
        length: value.length,
      },
    });
  }
  return value;
}

/** Vietnamese decimal comma, like every other size the operator reads. */
function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1).replace(".", ",");
}
