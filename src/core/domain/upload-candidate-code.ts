import {
  mediaFileStem,
  normalizeProductCode,
  parseMediaFileName,
  type MediaNameContext,
  type MediaNameWarning,
} from "./media-file-name";
import type { MediaProfile } from "./media-profile";

/**
 * E9 — đọc mã sản phẩm ra khỏi TÊN FILE NGƯỜI DÙNG TẢI LÊN.
 * Thuần: chỉ import trong core/domain (docs/07 §2).
 *
 * HAI TẦNG, và thứ tự là toàn bộ ý nghĩa của file này:
 *
 *   1. `parseMediaFileName` — bộ parser đã có. Nó biết `knownCodes` của tenant,
 *      biết bóc màu và số đuôi, biết `-AI` / `-THỰC TẾ` / `-MẶT SAU` là marker
 *      chứ không phải mã, và biết mã của tenant có thể chứa dấu `-` (`SP-001`).
 *      Còn dùng được thì dùng: nó cho nhiều thông tin hơn và đã có 57 test.
 *
 *   2. Chỉ khi tầng 1 trả `NO_PRODUCT_CODE` mới tới tầng "candidate" của
 *      spec §5.1: lấy stem trước dấu `-` đầu tiên. Nó KHÔNG quyết định gì —
 *      spec §5.3: "regex chỉ tạo candidate, Product Catalog mới quyết định
 *      candidate đó có hợp lệ hay không". Việc hỏi Catalog nằm ở usecase.
 *
 * Vì sao không thay tầng 1 bằng tầng 2 cho gọn: `SP-001-AI (1).png` bị tầng 2
 * cắt thành `SP`. Tenant khai mã có dấu `-` là trường hợp profile
 * `code-in-name` đang phục vụ, và một quy tắc "cắt ở dấu `-` đầu tiên" áp
 * thẳng sẽ đọc sai mã của họ mà không ai biết.
 */

export type UploadCodeDetection =
  | {
      readonly status: "parsed";
      readonly fileName: string;
      readonly productCode: string;
      readonly color: string | null;
      readonly sequence: number | null;
      readonly warnings: readonly MediaNameWarning[];
    }
  | {
      readonly status: "candidate";
      readonly fileName: string;
      /** Đã upper + trim, sẵn sàng cho lookup. Chưa ai xác nhận nó có thật. */
      readonly candidateCode: string;
      /** Câu tiếng Việt của parser, giữ lại để màn hình nói được vì sao. */
      readonly detail: string;
    }
  | { readonly status: "none"; readonly fileName: string; readonly detail: string };

/** Dưới ngưỡng này thì candidate là rác ("A", "1"), không đáng đem đi hỏi. */
const MIN_CANDIDATE_LENGTH = 2;

export function detectUploadProductCode(
  fileName: string,
  profile?: MediaProfile | null,
  context?: MediaNameContext | null,
): UploadCodeDetection {
  // --- Edge case trước (CLAUDE.md §1) ------------------------------------
  const raw = typeof fileName === "string" ? fileName : "";
  if (raw.trim().length === 0) {
    return { status: "none", fileName: raw, detail: "Tên file trống — không đọc được mã sản phẩm." };
  }

  // --- Tầng 1: parser đã có ------------------------------------------------
  const parsed = parseMediaFileName(raw, profile, context);
  if (parsed.ok) {
    return {
      status: "parsed",
      fileName: raw,
      productCode: parsed.value.productCode,
      color: parsed.value.color,
      sequence: parsed.value.sequence,
      warnings: parsed.value.warnings,
    };
  }

  // --- Tầng 2: candidate (spec §5.1) --------------------------------------
  const stem = mediaFileStem(raw);
  const head = stem.split("-")[0] ?? "";
  const candidateCode = normalizeProductCode(head);
  if (candidateCode.length < MIN_CANDIDATE_LENGTH) {
    return { status: "none", fileName: raw, detail: parsed.detail };
  }

  return { status: "candidate", fileName: raw, candidateCode, detail: parsed.detail };
}
