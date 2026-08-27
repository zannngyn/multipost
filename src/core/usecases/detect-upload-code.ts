import { AppError } from "@/core/domain/errors";
import { DEFAULT_MEDIA_PROFILE, type MediaProfile } from "@/core/domain/media-profile";
import { isTenantId } from "@/core/domain/tenant";
import { normalizeTenantId, type TenantId } from "@/core/domain/tenant-context";
import {
  detectUploadProductCode,
  type UploadCodeDetection,
} from "@/core/domain/upload-candidate-code";
import { MAX_UPLOADS_PER_POST } from "@/core/domain/uploaded-media";
import type { CatalogConfigRepo } from "@/core/ports/drive-source";
import type { Logger } from "@/core/ports/infra";
import type { ProductRepo } from "@/core/ports/product-repo";

/**
 * E9 — đọc mã sản phẩm ra khỏi tên các file operator vừa chọn, rồi hỏi Product
 * Catalog xem mã đó có thật không.
 *
 * KHÔNG chạm một byte nào: vào chỉ có tên file (vài KB JSON), nên màn hình gọi
 * được NGAY khi operator thả file, trước cả khi tải lên.
 *
 * KHÔNG tạo Product (spec §8, §23). Không ghi Drive, không ghi Sheet. Nó chỉ
 * trả lời một câu: "mã nào, và mã đó có trong catalog không".
 *
 * KHÔNG tự chọn khi một lô có hai mã (rule nghiệp vụ 5): trả `conflict` kèm
 * danh sách để màn hình bắt người quyết. Gom nhóm đa mã thành nhiều bài là
 * việc của đợt sau (spec 2026-08-26-upload-triage-multi-code-design.md).
 */

export interface DetectUploadCodeInput {
  readonly tenantId: TenantId;
  readonly files: readonly { fileName: string }[];
}

export interface UploadFileDetection {
  readonly fileName: string;
  readonly status: "parsed" | "candidate" | "none";
  readonly productCode: string | null;
}

export type UploadCodeVerdict =
  | { readonly status: "matched"; readonly productCode: string }
  | { readonly status: "not_found"; readonly productCode: string }
  | { readonly status: "conflict"; readonly codes: readonly string[] }
  | { readonly status: "no_code" };

export interface DetectUploadCodeResult {
  readonly verdict: UploadCodeVerdict;
  readonly files: readonly UploadFileDetection[];
  /** Ghi chú tiếng Việt cho operator. Không bao giờ im lặng bỏ qua. */
  readonly warnings: readonly string[];
}

export interface DetectUploadCodeDeps {
  products: ProductRepo;
  catalogConfig?: CatalogConfigRepo;
  logger: Logger;
}

export function makeDetectUploadCode(deps: DetectUploadCodeDeps) {
  return async function detectUploadCode(
    input: DetectUploadCodeInput,
  ): Promise<DetectUploadCodeResult> {
    // --- Edge case trước (CLAUDE.md §1) ------------------------------------
    const rawTenantId = typeof input?.tenantId === "string" ? input.tenantId.trim() : "";
    const files = Array.isArray(input?.files) ? input.files : [];
    if (!isTenantId(rawTenantId) || files.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "detectUploadCode requires a tenant UUID and at least one file name",
        userMessage: "Chưa chọn file nào để nhận diện mã.",
        context: { tenant_id: rawTenantId || null, file_count: files.length },
      });
    }
    if (files.length > MAX_UPLOADS_PER_POST) {
      throw new AppError("INVALID_INPUT", {
        message: `detectUploadCode takes at most ${MAX_UPLOADS_PER_POST} file names`,
        userMessage: `Một bài chỉ nhận tối đa ${MAX_UPLOADS_PER_POST} file — hiện đang có ${files.length}.`,
        context: { file_count: files.length, max: MAX_UPLOADS_PER_POST },
      });
    }
    const tenantId = normalizeTenantId(input.tenantId);
    const log = deps.logger.child({ tenant_id: tenantId, component: "detect-upload-code" });
    const warnings: string[] = [];

    // --- Hồ sơ tên file của tenant + danh sách mã của họ ---------------------
    const profile = await readMediaProfile(deps, tenantId, log, warnings);
    const knownCodes = await readKnownCodes(deps, tenantId, log, warnings);

    // --- Đọc từng tên file ---------------------------------------------------
    const detections: UploadCodeDetection[] = files.map((file) =>
      detectUploadProductCode(file?.fileName ?? "", profile, knownCodes ? { knownCodes } : null),
    );

    const parsedCodes = uniqueCodes(detections, "parsed");
    const candidateCodes = uniqueCodes(detections, "candidate");
    // Mã đã parse LUÔN thắng candidate: parser đã chắc, candidate thì chưa.
    const codes = parsedCodes.length > 0 ? parsedCodes : candidateCodes;

    const fileView: UploadFileDetection[] = detections.map((detection) => ({
      fileName: detection.fileName,
      status: detection.status,
      productCode:
        detection.status === "parsed"
          ? detection.productCode
          : detection.status === "candidate"
            ? detection.candidateCode
            : null,
    }));

    if (codes.length === 0) {
      log.info("No product code in any uploaded file name", { file_count: files.length });
      return { verdict: { status: "no_code" }, files: fileView, warnings };
    }

    if (codes.length > 1) {
      // Không tự chọn. Một lô nhiều mã là chuyện thật (spec §19) và đợt này
      // chưa tách thành nhiều bài — nói ra để operator quyết.
      log.warn("Uploaded file names carry more than one product code", {
        reason: "MULTIPLE_CODES_IN_ONE_BATCH",
        codes,
      });
      // I3 — NOT pushed into `warnings`: `describeDetection`'s conflict `title`
      // already says this (and names the codes on the buttons below it), and
      // `DetectedCodeNotice` draws both `title` and `warnings` in the same
      // block. A second copy here would print the same sentence twice.
      return { verdict: { status: "conflict", codes }, files: fileView, warnings };
    }

    // --- Một mã duy nhất: hỏi Catalog ---------------------------------------
    const productCode = codes[0];
    const fromParser = parsedCodes.length > 0;
    const product = await deps.products.findByCode(tenantId, productCode);
    const verdict: UploadCodeVerdict = product
      ? { status: "matched", productCode }
      : { status: "not_found", productCode };

    // Một mã ĐOÁN mà catalog không có phải được nói là đoán. Tầng 1 đọc được mã
    // là chuyện chắc chắn; tầng 2 chỉ cắt ở dấu `-` đầu tiên, nên với tenant
    // khai mã chứa dấu `-` mà hồ sơ tên file đang để mặc định, "SP-001-AI (1)"
    // ra candidate "SP". Trình bày nó bằng đúng giọng của một mã đọc chắc chắn
    // là kiểu sai âm thầm rule nghiệp vụ 5 cấm.
    if (!product && !fromParser) {
      warnings.push(
        `Mã "${productCode}" là hệ thống ĐOÁN từ tên file (phần đứng trước dấu "-"), có thể không đúng — hãy kiểm tra lại trước khi dùng.`,
      );
    }

    log.info("Upload code detection finished", {
      product_code: productCode,
      verdict: verdict.status,
      from: fromParser ? "parser" : "candidate",
      file_count: files.length,
    });
    return { verdict, files: fileView, warnings };
  };
}

export type DetectUploadCode = ReturnType<typeof makeDetectUploadCode>;

// --- helpers ----------------------------------------------------------------

function uniqueCodes(
  detections: readonly UploadCodeDetection[],
  status: "parsed" | "candidate",
): string[] {
  const seen: string[] = [];
  for (const detection of detections) {
    const code =
      detection.status === "parsed" && status === "parsed"
        ? detection.productCode
        : detection.status === "candidate" && status === "candidate"
          ? detection.candidateCode
          : null;
    if (code && !seen.includes(code)) seen.push(code);
  }
  return seen.sort((a, b) => a.localeCompare(b));
}

/**
 * Hồ sơ tên file của tenant. Đọc hỏng thì DÙNG MẶC ĐỊNH và nói ra — nhận diện
 * mã là tiện ích, chặn cả màn Soạn bài vì nó là cái giá sai.
 */
async function readMediaProfile(
  deps: DetectUploadCodeDeps,
  tenantId: TenantId,
  log: Logger,
  warnings: string[],
): Promise<MediaProfile> {
  if (!deps.catalogConfig) return DEFAULT_MEDIA_PROFILE;
  try {
    const config = await deps.catalogConfig.findCatalogSource(tenantId);
    return config?.mediaProfile ?? DEFAULT_MEDIA_PROFILE;
  } catch (error) {
    log.warn("Could not read the tenant media profile; falling back to the default", {
      ...AppError.from(error, "SYNC_FAILED", { tenant_id: tenantId }).toLogObject(),
      reason: "MEDIA_PROFILE_UNREADABLE",
    });
    warnings.push("Chưa đọc được cách đặt tên file của đơn vị — đang nhận diện theo mẫu mặc định.");
    return DEFAULT_MEDIA_PROFILE;
  }
}

/** Cùng lý do: không có danh sách mã thì parser mất một lớp, không phải hỏng. */
async function readKnownCodes(
  deps: DetectUploadCodeDeps,
  tenantId: TenantId,
  log: Logger,
  warnings: string[],
): Promise<ReadonlySet<string> | null> {
  if (typeof deps.products.listCodes !== "function") return null;
  try {
    const codes = await deps.products.listCodes(tenantId);
    return codes.length > 0 ? new Set(codes) : null;
  } catch (error) {
    log.warn("Could not read the tenant product codes; the parser loses knownCodes", {
      ...AppError.from(error, "DB_ERROR", { tenant_id: tenantId }).toLogObject(),
      reason: "KNOWN_CODES_UNREADABLE",
    });
    warnings.push("Chưa đọc được danh sách mã của đơn vị — nhận diện có thể kém chính xác hơn.");
    return null;
  }
}
