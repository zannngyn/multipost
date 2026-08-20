import { z } from "zod";

import { MAX_UPLOADS_PER_POST, MAX_UPLOAD_BYTES } from "@/composition/container";
import type { TenantId } from "@/composition/require-tenant";
import { AppError } from "@/core/domain/errors";

/**
 * E9.1 — the multipart half of the upload route, kept out of the handler so it
 * can be tested without standing up a container (same reasoning as
 * `_lib/http-errors`).
 *
 * Multipart, not JSON: base64 in a JSON body inflates every file by a third and
 * forces the whole album into one string before anything can be validated.
 *
 * M1.3b (doc 10 §8.12) — the `tenantId` FIELD is gone. It was the multipart
 * twin of the query/body tenant id, and a form field is exactly as forgeable as
 * either: the route now takes the tenant from `requireTenantContext`. A client
 * that still appends the field simply has it ignored (transition rule,
 * docs/11 §3.2), which is why nothing here rejects an extra part.
 */

/** Cheap guard against a body that is large in aggregate rather than per file. */
export const MAX_TOTAL_UPLOAD_BYTES = MAX_UPLOAD_BYTES * MAX_UPLOADS_PER_POST;

const FieldsSchema = z.object({
  productCode: z
    .string({ error: "Thiếu mã sản phẩm." })
    .trim()
    .min(1, "Thiếu mã sản phẩm.")
    .max(64, "Mã sản phẩm quá dài."),
  order: z.array(z.number().int().nonnegative()).max(MAX_UPLOADS_PER_POST).optional(),
});

export interface UploadForm {
  readonly productCode: string;
  /** Indexes into `parts`; index 0 is the cover. Absent = as sent. */
  readonly order?: number[];
  readonly parts: readonly File[];
  /** Sizes as declared by the transport, aligned with `parts`. */
  readonly declaredSizes: readonly number[];
}

/**
 * Parses and gates the request body. Every check here is a TRANSPORT check —
 * the authoritative business gate is `validateUpload` inside the usecase, which
 * measures the bytes actually received. This one exists so a client that lies
 * about a size cannot cost a full buffer of memory per file.
 */
export async function readUploadForm(
  request: Request,
  route: string,
  /**
   * Already authorised by the caller. Taken as a parameter purely so every
   * refusal below still carries `tenant_id` in its log context (CLAUDE.md
   * technical rule 6) — this function makes no decision with it.
   */
  tenantId: TenantId,
): Promise<UploadForm> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    throw new AppError("INVALID_INPUT", {
      message: "Upload requires a multipart/form-data body",
      userMessage: "Yêu cầu tải lên không đúng định dạng.",
      context: { route, tenant_id: tenantId, content_type: contentType || null },
    });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch (error) {
    // A truncated or malformed body: say so, rather than letting a parser
    // exception surface as a 500.
    throw AppError.from(error, "INVALID_INPUT", { route, tenant_id: tenantId, reason: "MALFORMED_MULTIPART" });
  }

  const fields = parseFields(form, route);
  const parts = form.getAll("files").filter(isFilePart);

  if (parts.length === 0) {
    throw new AppError("INVALID_INPUT", {
      message: "Upload request carried no file parts",
      userMessage: "Chưa chọn file nào để tải lên.",
      context: { route, tenant_id: tenantId },
    });
  }

  if (parts.length > MAX_UPLOADS_PER_POST) {
    throw new AppError("INVALID_INPUT", {
      message: "Upload request carried too many file parts",
      userMessage: `Một bài chỉ nhận tối đa ${MAX_UPLOADS_PER_POST} file — đang gửi ${parts.length}.`,
      context: { route, tenant_id: tenantId, count: parts.length },
    });
  }

  if (fields.order && fields.order.length !== parts.length) {
    // Caught here as well as in the domain so the operator gets a transport-
    // level message before any byte is read.
    throw new AppError("INVALID_INPUT", {
      message: "Upload order length does not match the number of file parts",
      userMessage: "Thứ tự file không khớp số file gửi lên — hãy tải lại trang và thử lại.",
      context: {
        route,
        tenant_id: tenantId,
        order_length: fields.order.length,
        parts: parts.length,
      },
    });
  }

  const declaredSizes = parts.map((part) => part.size);
  const total = declaredSizes.reduce((sum, size) => sum + size, 0);
  if (total > MAX_TOTAL_UPLOAD_BYTES) {
    throw new AppError("INVALID_INPUT", {
      message: "Upload request exceeds the total byte budget",
      userMessage:
        "Tổng dung lượng các file vượt mức cho phép — hãy bớt file hoặc giảm dung lượng.",
      context: {
        route,
        tenant_id: tenantId,
        total_bytes: total,
        max_bytes: MAX_TOTAL_UPLOAD_BYTES,
      },
    });
  }

  return { ...fields, parts, declaredSizes };
}

// --- helpers ----------------------------------------------------------------

function parseFields(form: FormData, route: string): z.infer<typeof FieldsSchema> {
  const parsed = FieldsSchema.safeParse({
    productCode: asText(form.get("productCode")),
    order: parseOrder(form.get("order"), route),
  });

  if (!parsed.success) {
    throw new AppError("INVALID_INPUT", {
      message: "Upload fields failed schema validation",
      userMessage: parsed.error.issues[0]?.message ?? "Dữ liệu tải lên không hợp lệ.",
      context: {
        route,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    });
  }

  return parsed.data;
}

/**
 * Garbled order is an error, never a silent fall back to "as sent": the album
 * we would publish would differ from the one the operator arranged, which is
 * exactly what business rule 5 bans.
 */
function parseOrder(value: FormDataEntryValue | null, route: string): number[] | undefined {
  const text = asText(value);
  if (!text) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AppError("INVALID_INPUT", {
      message: "Upload order field is not valid JSON",
      userMessage: "Thứ tự file gửi lên không đọc được — hãy tải lại trang và thử lại.",
      context: { route, reason: "ORDER_NOT_JSON" },
    });
  }

  if (!Array.isArray(parsed)) {
    throw new AppError("INVALID_INPUT", {
      message: "Upload order field is not an array",
      userMessage: "Thứ tự file gửi lên không hợp lệ — hãy tải lại trang và thử lại.",
      context: { route, reason: "ORDER_NOT_ARRAY" },
    });
  }

  return parsed as number[];
}

function asText(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

/** `File` in the web sense; a plain string part is a field, not a file. */
function isFilePart(value: FormDataEntryValue): value is File {
  return typeof value === "object" && value !== null && "arrayBuffer" in value;
}
