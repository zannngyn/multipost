# Xem trước ảnh tải lên + tự nhận diện mã sản phẩm — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Operator thả ảnh vào màn Soạn bài thì thấy ngay ảnh thu nhỏ, và hệ thống tự đọc mã sản phẩm từ tên file điền vào ô mã — không resolve được thì có nút Đồng bộ lại / Nhập mã đã prefill.

**Architecture:** Thêm một tầng nhận diện thuần (`detectUploadProductCode`) đặt TRÊN `parseMediaFileName` đang có: parser cũ chạy trước và giữ nguyên hành vi; chỉ khi nó trả `NO_PRODUCT_CODE` mới rơi xuống tầng "candidate" lấy stem trước dấu `-` đầu tiên. Một usecase mới gom kết quả của cả lô rồi hỏi Product Catalog; một route mỏng phơi ra; UI dùng kết quả đó để prefill ô mã. Không đụng `compose-post.ts`, không đụng contract `confirm-upload`, không đụng queue/worker/publish.

**Tech Stack:** Next.js App Router · TypeScript · Drizzle/Postgres · zod v4 · vitest · React Hook Form · TanStack Query · Tailwind + shadcn/ui

**Spec:** `docs/superpowers/specs/audit-compose-generate.md` (27/08/2026)
**Spec liên quan (chồng lấn, ĐỢT SAU):** `docs/superpowers/specs/2026-08-26-upload-triage-multi-code-design.md`

---

## Global Constraints

- **Nhánh:** `feat/upload-preview-detect-code`, worktree `.claude/worktrees/e9-upload-preview-detect`, cắt từ `origin/dev` (`dd0a9c0`).
- **Quy ước test của `dev`:** file test nằm **cạnh source** (`foo.ts` → `foo.test.ts`), KHÔNG dùng `__tests__/`. Nhánh chore chuyển sang `__tests__/` chưa merge — không theo nhánh đó.
- **Luật phụ thuộc một chiều** (CLAUDE.md §7): `app/ui/worker → composition → adapters → core`. `core/domain` không import gì ngoài `core/domain`. `app/` chỉ được import `core/domain/errors`.
- **Edge case trước, happy path sau** (CLAUDE.md §1). Guard clause + early return.
- **Validate tại mọi biên** (CLAUDE.md §2): route parse body bằng zod; dữ liệu ngoài không tin.
- **Cấm nuốt lỗi** (CLAUDE.md §5): mọi `catch` phải log có context + rethrow, hoặc chuyển trạng thái kèm lý do.
- **Message:** code/comment/log tiếng Anh; `userMessage` tiếng Việt.
- **Không thêm dependency mới.** Không có `sharp`/`jimp` — mọi việc dựng ảnh thu nhỏ làm ở trình duyệt bằng `URL.createObjectURL`.
- **Không đụng:** `core/usecases/compose-post.ts`, `core/usecases/publish-post.ts`, `core/usecases/confirm-upload.ts` (contract), `core/domain/post-job.ts`, `src/worker/**`, `src/adapters/meta/**`, `src/adapters/queue/**`.
- **Giới hạn đã có, giữ nguyên:** `MAX_UPLOADS_PER_POST = 10`, `MAX_UPLOAD_BYTES = 25MB`, `MAX_UPLOAD_FILES = 10` (UI).
- **Lệnh kiểm chứng:** `pnpm exec vitest run <path>` · `pnpm exec tsc --noEmit` · `pnpm lint`.

## Quyết định PM đã chốt (27/08/2026)

| Câu | Chốt |
|---|---|
| Parser | Parser A (`parseMediaFileName`) chạy trước; chỉ khi `NO_PRODUCT_CODE` mới dùng tầng candidate "trước dấu `-` đầu tiên" |
| Vision caption (spec §10) | **Bỏ khỏi phạm vi.** Caption giữ nguyên: sinh từ 4 trường text của sản phẩm |
| `source=drive\|upload` (spec §13) | **Giữ nguyên.** Không refactor `compose-post` |
| Đa mã một lô (spec §6, §19) | **Đợt sau.** Đợt này vẫn 1 lô = 1 mã |
| Data model §17 (`detected/resolved_product_code`, `upload_session`) | **Đợt sau.** Đợt này không migration DB |
| Cách thực thi | Giao agent domain + gate `reviewer-qa` (CLAUDE.md) |

## Tiêu chí nghiệm thu của ĐỢT NÀY

Trích từ spec §25, chỉ các dòng thuộc phạm vi đợt 1:

- [ ] Upload `BG0SQ6083-AI (1).png` → detect `BG0SQ6083`
- [ ] Upload nhiều file cùng mã → cùng một mã, không hỏi lại
- [ ] Product chưa tồn tại → **không** tạo Product
- [ ] Product chưa tồn tại → có nút `Đồng bộ lại dữ liệu`
- [ ] Product chưa tồn tại → có nút `Nhập mã BG0SQ9999` (prefill)
- [ ] Không có code → `Đồng bộ lại` / `Nhập mã sản phẩm`
- [ ] User không phải tự gõ lại mã hệ thống vừa nhận diện
- [ ] Upload không ghi vào Drive, không ghi vào Sheet
- [ ] Xem được ảnh thu nhỏ ngay khi chọn file, và sau khi tải lên xong
- [ ] Nhiều mã trong một lô → **nói rõ ra**, không tự chọn một mã (rule nghiệp vụ 5)

Ngoài phạm vi đợt này (ghi để không ai tưởng thiếu): caption vision, gom nhóm đa mã thành nhiều bài, `upload_session`, cột resolution, retention policy.

## File Structure

| File | Trách nhiệm | Tác vụ |
|---|---|---|
| `src/core/domain/upload-candidate-code.ts` *(mới)* | Thuần: một tên file → mã đã parse / candidate / không có | T1 |
| `src/core/domain/upload-candidate-code.test.ts` *(mới)* | Test T1 | T1 |
| `src/core/domain/media-file-name.ts` *(sửa)* | Thêm export `mediaFileStem()` — bỏ đuôi + chuẩn hoá khoảng trắng | T1 |
| `src/core/ports/product-repo.ts` *(sửa)* | Thêm `listCodes?()` (tuỳ chọn) | T2 |
| `src/adapters/db/product-repo.drizzle.ts` *(sửa)* | Hiện thực `listCodes` | T2 |
| `src/core/usecases/detect-upload-code.ts` *(mới)* | Gom cả lô: parse → gom mã → hỏi Catalog → một verdict | T3 |
| `src/core/usecases/detect-upload-code.test.ts` *(mới)* | Test T3 | T3 |
| `src/composition/container.ts` *(sửa)* | Wire usecase | T3 |
| `src/app/api/posts/uploads/detect-code/route.ts` *(mới)* | Route mỏng, tier M / editor | T4 |
| `src/app/api/posts/uploads/detect-code/route.test.ts` *(mới)* | Test T4 | T4 |
| `src/ui/schemas/compose.schema.ts` *(sửa)* | Schema response detect | T5 |
| `src/ui/services/upload.api.ts` *(sửa)* | Client `detectUploadCode()` | T5 |
| `src/ui/components/compose/upload-queue.ts` *(sửa)* | `previewUrlsFor()` + `revokePreviewUrls()` | T6 |
| `src/ui/components/compose/upload-queue.test.ts` *(sửa)* | Test T6 | T6 |
| `src/ui/components/compose/UploadPanel.tsx` *(sửa)* | Ảnh thu nhỏ trước và sau khi tải lên | T6, T8 |
| `src/ui/components/compose/detected-code.ts` *(mới)* | Thuần: verdict → tiêu đề + danh sách nút | T7 |
| `src/ui/components/compose/detected-code.test.ts` *(mới)* | Test T7 (thuần, không cần DOM) | T7 |
| `src/ui/components/compose/DetectedCodeNotice.tsx` *(mới)* | Vẽ những gì `detected-code.ts` quyết | T7 |
| `src/ui/components/compose/detected-code-notice-render.test.tsx` *(mới)* | Test render, `renderToStaticMarkup` | T7 |
| `src/ui/hooks/useComposeWizard.ts` *(sửa)* | Gọi detect, giữ `detection` + `uploadedAssets` | T7, T8 |
| `src/ui/components/compose/ComposeFocus.tsx` *(sửa)* | Gắn `DetectedCodeNotice` vào Step 2 | T7 |

## Phân công agent (CLAUDE.md)

| Tác vụ | Agent |
|---|---|
| T1 · T2 · T3 · T4 | `data-pipeline` (sở hữu parser tên file, `core/domain/{product,media}`, `adapters/db`) |
| T5 · T6 · T7 · T8 | `ui-web` (sở hữu `src/ui/**`, `src/app/(app)/**`) |
| Gate sau mỗi tác vụ | `reviewer-qa` — PASS mới được sang tác vụ kế |

---

## Task 1: Tầng nhận diện mã thuần

**Files:**
- Create: `src/core/domain/upload-candidate-code.ts`
- Create: `src/core/domain/upload-candidate-code.test.ts`
- Modify: `src/core/domain/media-file-name.ts` (thêm export `mediaFileStem`)

**Interfaces:**
- Consumes: `parseMediaFileName(raw, profile?, context?)`, `normalizeProductCode(value)`, `type MediaNameWarning`, `type MediaNameContext`, `type MediaProfile` — đều đã có.
- Produces:
  ```ts
  export type UploadCodeDetection =
    | { readonly status: "parsed"; readonly fileName: string; readonly productCode: string;
        readonly color: string | null; readonly sequence: number | null;
        readonly warnings: readonly MediaNameWarning[] }
    | { readonly status: "candidate"; readonly fileName: string; readonly candidateCode: string;
        readonly detail: string }
    | { readonly status: "none"; readonly fileName: string; readonly detail: string };

  export function detectUploadProductCode(
    fileName: string,
    profile?: MediaProfile | null,
    context?: MediaNameContext | null,
  ): UploadCodeDetection;

  export function mediaFileStem(raw: string): string; // từ media-file-name.ts
  ```

- [ ] **Step 1: Thêm `mediaFileStem` vào `media-file-name.ts`**

Đặt ngay dưới `splitExtension` (khoảng dòng 312). Additive — không đổi hành vi hàm nào đang có.

```ts
/**
 * Tên file đã chuẩn hoá khoảng trắng và bỏ phần đuôi — phần "stem" mà tầng
 * candidate của upload (core/domain/upload-candidate-code) cần.
 *
 * Dùng chung `normalizeWhitespace` + `splitExtension` với parser chính, để hai
 * bên không thể lệch nhau về "đuôi file là gì" (`.jpg`, `JPG` dính liền,
 * `.2025` bị nhầm là đuôi).
 */
export function mediaFileStem(raw: string): string {
  if (typeof raw !== "string") return "";
  return splitExtension(normalizeWhitespace(raw)).base.trim();
}
```

- [ ] **Step 2: Viết test thất bại cho `detectUploadProductCode`**

Tạo `src/core/domain/upload-candidate-code.test.ts`. Các case dưới đây lấy từ spec §5.1, §9, §20, cộng hai case bảo vệ (mã có dấu `-`, tên rỗng).

```ts
import { describe, expect, it } from "vitest";

import { detectUploadProductCode } from "./upload-candidate-code";

describe("detectUploadProductCode", () => {
  it("reads the code, colour and sequence when the name follows the convention", () => {
    const result = detectUploadProductCode("BG0SQ6083-XANH THAN (2).jpg");
    expect(result).toMatchObject({
      status: "parsed",
      productCode: "BG0SQ6083",
      color: "XANH THAN",
      sequence: 2,
    });
  });

  it("keeps -AI as a marker, never part of the code (spec 5.2)", () => {
    const result = detectUploadProductCode("BG0SQ6083-AI (5).png");
    expect(result).toMatchObject({ status: "parsed", productCode: "BG0SQ6083", sequence: 5 });
  });

  it("reads a code written with spaces around the dash", () => {
    expect(detectUploadProductCode("BG0SQ6083 - AI (5).png")).toMatchObject({
      status: "parsed",
      productCode: "BG0SQ6083",
    });
  });

  it("reads a bare code with no suffix at all", () => {
    expect(detectUploadProductCode("BG0SQ6083.png")).toMatchObject({
      status: "parsed",
      productCode: "BG0SQ6083",
    });
  });

  it("falls back to the stem before the first dash when the parser finds no code", () => {
    // XYZ9999 does not match the internal code shape, so the parser refuses it.
    // The candidate layer still offers it, so the screen can prefill the input.
    const result = detectUploadProductCode("XYZ9999-AI.png");
    expect(result).toMatchObject({ status: "candidate", candidateCode: "XYZ9999" });
  });

  it("offers the whole stem as a candidate when the name holds no dash", () => {
    expect(detectUploadProductCode("IMG_8821.png")).toMatchObject({
      status: "candidate",
      candidateCode: "IMG_8821",
    });
  });

  it("uppercases and trims a candidate so the catalog lookup is case-insensitive", () => {
    expect(detectUploadProductCode("  xyz9999 - ai.png")).toMatchObject({
      status: "candidate",
      candidateCode: "XYZ9999",
    });
  });

  it("returns none for a name with nothing usable in it", () => {
    expect(detectUploadProductCode("   .png")).toMatchObject({ status: "none" });
    expect(detectUploadProductCode("")).toMatchObject({ status: "none" });
  });

  it("reads a tenant code containing a dash through knownCodes, never cutting it", () => {
    const result = detectUploadProductCode(
      "SP-001-AI (1).png",
      { kind: "code-in-name" },
      { knownCodes: new Set(["SP-001"]) },
    );
    expect(result).toMatchObject({ status: "parsed", productCode: "SP-001" });
  });

  it("never throws on a malformed input", () => {
    expect(() => detectUploadProductCode(undefined as unknown as string)).not.toThrow();
  });
});
```

- [ ] **Step 3: Chạy test, xác nhận FAIL**

Run: `pnpm exec vitest run src/core/domain/upload-candidate-code.test.ts`
Expected: FAIL — `Failed to resolve import "./upload-candidate-code"`.

- [ ] **Step 4: Viết `upload-candidate-code.ts`**

```ts
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
```

- [ ] **Step 5: Chạy test, xác nhận PASS**

Run: `pnpm exec vitest run src/core/domain/upload-candidate-code.test.ts src/core/domain/media-file-name.test.ts src/core/domain/media-file-name.profile.test.ts`
Expected: PASS toàn bộ — kể cả 57 test cũ của `media-file-name`, chứng minh `mediaFileStem` không đổi hành vi nào.

- [ ] **Step 6: Commit**

```bash
git add src/core/domain/upload-candidate-code.ts src/core/domain/upload-candidate-code.test.ts src/core/domain/media-file-name.ts
git commit -m "feat(upload): detect a product code from an uploaded file name

Two tiers: the existing parseMediaFileName first (it knows the tenant's
knownCodes, colours, sequence markers and codes containing a dash), then a
candidate layer that takes the stem before the first dash. The candidate
decides nothing — the catalog lookup does.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `ProductRepo.listCodes`

**Files:**
- Modify: `src/core/ports/product-repo.ts`
- Modify: `src/adapters/db/product-repo.drizzle.ts`

**Interfaces:**
- Consumes: `forTenant`, `wrapDbError`, `products` (schema) — đã có trong file adapter.
- Produces: `ProductRepo.listCodes?(tenantId: TenantId): Promise<readonly string[]>`

Vì sao **tuỳ chọn** (`?`): cùng khuôn với `saveManual` mà `compose-post.ts` đang dùng — một container chưa wire vẫn chạy được, và usecase ở T3 chỉ truyền `knownCodes` khi có. Không có nó thì profile `code-in-name` rơi về hình dạng mã nội bộ, đúng hành vi hôm nay chứ không tệ hơn.

- [ ] **Step 1: Thêm khai báo vào port**

Trong `src/core/ports/product-repo.ts`, thêm vào interface `ProductRepo`, ngay sau `countAll` (dòng 61):

```ts
  /**
   * Mọi mã sản phẩm của tenant, để parser tên file nhận ra mã có hình dạng
   * riêng của khách (`SP-001`, `AB.12`) — thứ `PRODUCT_CODE_PATTERN` không thể
   * đoán ra. Hôm nay chỉ `sync-catalog` dựng tập này trong bộ nhớ; đây là
   * đường đọc lại.
   *
   * TUỲ CHỌN: một tiến trình chưa wire vẫn chạy, chỉ là parser mất lớp
   * knownCodes — đúng hành vi trước khi có method này, không phải hỏng.
   */
  listCodes?(tenantId: TenantId): Promise<readonly string[]>;
```

- [ ] **Step 2: Viết test thất bại**

Thêm vào cuối `src/adapters/db/product-repo.drizzle.test.ts` nếu file đã có; nếu chưa có thì bỏ qua bước này và kiểm chứng bằng integration test ở Step 5 — KHÔNG dựng một suite mock DB mới chỉ cho một câu SELECT.

Kiểm tra trước:

```bash
ls src/adapters/db/product-repo.drizzle.test.ts 2>/dev/null || echo "chưa có unit test cho repo này"
```

- [ ] **Step 3: Hiện thực `listCodes`**

Thêm vào `src/adapters/db/product-repo.drizzle.ts` ngay sau `countAll` (dòng 400). Theo đúng khuôn `countAll`: `forTenant` → `scope.where` → `wrapDbError`.

```ts
  async listCodes(tenantId: TenantId): Promise<readonly string[]> {
    const scope = forTenant(this.db, tenantId);
    try {
      const rows = await scope.db
        .selectDistinct({ code: products.code })
        .from(products)
        .where(scope.where(products));
      return rows
        .map((row) => (typeof row.code === "string" ? row.code.trim() : ""))
        .filter((code) => code.length > 0);
    } catch (error) {
      throw wrapDbError(error, {
        tenant_id: scope.tenantId,
        field: "tenantId",
        operation: "product.listCodes",
      });
    }
  }
```

- [ ] **Step 4: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 5: Chạy test hồi quy của tầng adapter**

Run: `pnpm exec vitest run src/adapters/db`
Expected: PASS, không suite nào đỏ thêm.

- [ ] **Step 6: Commit**

```bash
git add src/core/ports/product-repo.ts src/adapters/db/product-repo.drizzle.ts
git commit -m "feat(catalog): read back every product code of a tenant

The file-name parser needs the tenant's own code list to recognise a shape
PRODUCT_CODE_PATTERN cannot guess. Optional on the port, like saveManual: a
process without it keeps today's behaviour instead of breaking.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Usecase `detectUploadCode`

**Files:**
- Create: `src/core/usecases/detect-upload-code.ts`
- Create: `src/core/usecases/detect-upload-code.test.ts`
- Modify: `src/composition/container.ts`

**Interfaces:**
- Consumes: `detectUploadProductCode` (T1), `ProductRepo.findByCode` + `ProductRepo.listCodes?` (T2), `CatalogConfigRepo.findCatalogSource(tenantId)` → `{ mediaProfile?: MediaProfile }`, `DEFAULT_MEDIA_PROFILE`, `isTenantId`, `normalizeTenantId`, `AppError`, `Logger`.
- Produces:
  ```ts
  export type UploadCodeVerdict =
    | { readonly status: "matched"; readonly productCode: string }
    | { readonly status: "not_found"; readonly productCode: string }
    | { readonly status: "conflict"; readonly codes: readonly string[] }
    | { readonly status: "no_code" };

  export interface DetectUploadCodeResult {
    readonly verdict: UploadCodeVerdict;
    readonly files: readonly UploadFileDetection[];
    readonly warnings: readonly string[];
  }

  export interface UploadFileDetection {
    readonly fileName: string;
    readonly status: "parsed" | "candidate" | "none";
    readonly productCode: string | null;
  }

  export function makeDetectUploadCode(deps: DetectUploadCodeDeps): DetectUploadCode;
  export type DetectUploadCode = ReturnType<typeof makeDetectUploadCode>;
  ```

**Luật gom một verdict cho cả lô (đợt 1 = 1 lô 1 mã):**

1. Mã ở tầng `parsed` **luôn thắng** mã ở tầng `candidate`. Parser đã chắc chắn; candidate thì chưa.
2. Trong cùng một tầng, nếu có **nhiều hơn một mã khác nhau** → `conflict`, kèm danh sách mã. **Không tự chọn** (rule nghiệp vụ 5) — màn hình bắt operator chọn.
3. Một mã duy nhất → hỏi `findByCode` → `matched` hoặc `not_found`.
4. Không file nào cho ra mã → `no_code`.

**Bổ sung sau review T1 (phán quyết của orchestrator, bắt buộc):** khi mã thắng cuộc đến từ **tầng candidate** *và* Catalog trả `not_found`, phải đẩy thêm một câu vào `warnings` nói rõ mã này là **đoán từ tên file**, có thể sai. Lý do: parser tầng 1 đọc được mã là chuyện chắc chắn; tầng 2 cắt ở dấu `-` đầu tiên, nên với một tenant khai mã chứa dấu `-` mà hồ sơ tên file lại đang để mặc định, `SP-001-AI (1).png` sẽ ra candidate `SP`. Trình bày một mã đoán bằng đúng giọng văn của một mã đọc chắc chắn là kiểu sai âm thầm mà rule nghiệp vụ 5 cấm. Không đổi contract của T4/T5/T7 — `warnings` đã có sẵn đường ra màn hình.

- [ ] **Step 1: Viết test thất bại**

```ts
import { describe, expect, it, vi } from "vitest";

import { makeDetectUploadCode } from "./detect-upload-code";

const TENANT = "11111111-1111-4111-8111-111111111111";

function makeDeps(overrides: Partial<Parameters<typeof makeDetectUploadCode>[0]> = {}) {
  const logger = {
    child: vi.fn(() => logger),
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  } as unknown as Parameters<typeof makeDetectUploadCode>[0]["logger"];
  return {
    products: { findByCode: vi.fn(async () => null) } as never,
    catalogConfig: { findCatalogSource: vi.fn(async () => null) } as never,
    logger,
    ...overrides,
  };
}

describe("detectUploadCode", () => {
  it("matches when every file parses to the same code and the catalog has it", async () => {
    const products = {
      findByCode: vi.fn(async () => ({ content: { code: "BG0SQ6083" } })),
      listCodes: vi.fn(async () => ["BG0SQ6083"]),
    } as never;
    const detect = makeDetectUploadCode(makeDeps({ products }));

    const result = await detect({
      tenantId: TENANT,
      files: [{ fileName: "BG0SQ6083-AI (1).png" }, { fileName: "BG0SQ6083-AI (2).png" }],
    });

    expect(result.verdict).toEqual({ status: "matched", productCode: "BG0SQ6083" });
  });

  it("reports not_found without ever creating a product (spec 8)", async () => {
    const findByCode = vi.fn(async () => null);
    const detect = makeDetectUploadCode(makeDeps({ products: { findByCode } as never }));

    const result = await detect({ tenantId: TENANT, files: [{ fileName: "BG0SQ6083-AI (1).png" }] });

    expect(result.verdict).toEqual({ status: "not_found", productCode: "BG0SQ6083" });
    expect(findByCode).toHaveBeenCalledTimes(1);
  });

  it("offers a candidate the parser refused, so the screen can prefill it", async () => {
    const detect = makeDetectUploadCode(makeDeps());
    const result = await detect({ tenantId: TENANT, files: [{ fileName: "XYZ9999-AI.png" }] });
    expect(result.verdict).toEqual({ status: "not_found", productCode: "XYZ9999" });
  });

  it("says out loud that an unmatched candidate code was GUESSED from the file name", async () => {
    const detect = makeDetectUploadCode(makeDeps());
    const result = await detect({ tenantId: TENANT, files: [{ fileName: "XYZ9999-AI.png" }] });
    expect(result.warnings.join(" ")).toMatch(/đoán/i);
  });

  it("does not call a PARSED code a guess", async () => {
    const detect = makeDetectUploadCode(makeDeps());
    // The parser reads this one confidently; it simply is not in the catalog.
    const result = await detect({ tenantId: TENANT, files: [{ fileName: "BG0SQ6083-AI (1).png" }] });
    expect(result.verdict).toEqual({ status: "not_found", productCode: "BG0SQ6083" });
    expect(result.warnings.join(" ")).not.toMatch(/đoán/i);
  });

  it("answers no_code when nothing usable is in any name", async () => {
    const detect = makeDetectUploadCode(makeDeps());
    const result = await detect({ tenantId: TENANT, files: [{ fileName: "  .png" }] });
    expect(result.verdict).toEqual({ status: "no_code" });
  });

  it("never picks one of two different codes on its own (business rule 5)", async () => {
    const detect = makeDetectUploadCode(makeDeps());
    const result = await detect({
      tenantId: TENANT,
      files: [{ fileName: "BG0SQ6083-AI (1).png" }, { fileName: "BG0SQ6084-AI (1).png" }],
    });
    expect(result.verdict).toEqual({ status: "conflict", codes: ["BG0SQ6083", "BG0SQ6084"] });
  });

  it("prefers a parsed code over a candidate one", async () => {
    const products = { findByCode: vi.fn(async () => ({ content: { code: "BG0SQ6083" } })) } as never;
    const detect = makeDetectUploadCode(makeDeps({ products }));
    const result = await detect({
      tenantId: TENANT,
      files: [{ fileName: "BG0SQ6083-AI (1).png" }, { fileName: "IMG_8821.png" }],
    });
    expect(result.verdict).toEqual({ status: "matched", productCode: "BG0SQ6083" });
  });

  it("refuses a malformed call instead of guessing", async () => {
    const detect = makeDetectUploadCode(makeDeps());
    await expect(detect({ tenantId: "not-a-uuid", files: [] })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("keeps working when the catalog config cannot be read", async () => {
    const catalogConfig = {
      findCatalogSource: vi.fn(async () => { throw new Error("boom"); }),
    } as never;
    const detect = makeDetectUploadCode(makeDeps({ catalogConfig }));
    const result = await detect({ tenantId: TENANT, files: [{ fileName: "BG0SQ6083-AI (1).png" }] });
    expect(result.verdict.status).toBe("not_found");
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận FAIL**

Run: `pnpm exec vitest run src/core/usecases/detect-upload-code.test.ts`
Expected: FAIL — không resolve được `./detect-upload-code`.

- [ ] **Step 3: Viết usecase**

```ts
import { AppError } from "@/core/domain/errors";
import { DEFAULT_MEDIA_PROFILE, type MediaProfile } from "@/core/domain/media-profile";
import { isTenantId } from "@/core/domain/tenant";
import { normalizeTenantId, type TenantId } from "@/core/domain/tenant-context";
import {
  detectUploadProductCode,
  type UploadCodeDetection,
} from "@/core/domain/upload-candidate-code";
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

/** Cùng trần với một bài (MAX_UPLOADS_PER_POST) — đợt này 1 lô = 1 bài. */
const MAX_FILES = 10;

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
    if (files.length > MAX_FILES) {
      throw new AppError("INVALID_INPUT", {
        message: `detectUploadCode takes at most ${MAX_FILES} file names`,
        userMessage: `Một bài chỉ nhận tối đa ${MAX_FILES} file — hiện đang có ${files.length}.`,
        context: { file_count: files.length, max: MAX_FILES },
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
      warnings.push(
        `Các file đang mang ${codes.length} mã khác nhau (${codes.join(", ")}) — hãy chọn mã cho bài này, hoặc tách ra tải lên từng mã.`,
      );
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
```

- [ ] **Step 4: Chạy test, xác nhận PASS**

Run: `pnpm exec vitest run src/core/usecases/detect-upload-code.test.ts`
Expected: PASS 10/10.

- [ ] **Step 5: Wire vào container**

Trong `src/composition/container.ts`:

1. import: `import { makeDetectUploadCode, type DetectUploadCode } from "@/core/usecases/detect-upload-code";`
2. Thêm vào interface `Usecases`, cạnh `confirmUpload` (dòng 280): `detectUploadCode: DetectUploadCode;`
3. Thêm vào object dựng usecase, cạnh `confirmUpload` (dòng 1117):

```ts
    detectUploadCode: makeDetectUploadCode({
      products: deps.products,
      catalogConfig: deps.catalogConfig,
      logger: deps.logger,
    }),
```

Đọc đúng tên biến deps đang dùng ở hai dòng bên cạnh (`makeComposePost` dòng 1091 truyền `products`/`catalogConfig` gì thì theo y hệt) — KHÔNG đoán.

- [ ] **Step 6: Typecheck + test hồi quy**

Run: `pnpm exec tsc --noEmit && pnpm exec vitest run src/core src/composition`
Expected: exit 0, không suite nào đỏ thêm.

- [ ] **Step 7: Commit**

```bash
git add src/core/usecases/detect-upload-code.ts src/core/usecases/detect-upload-code.test.ts src/composition/container.ts
git commit -m "feat(upload): resolve a detected product code against the catalog

Names only, no bytes: the screen can call this the moment files are dropped.
It never creates a product, and it refuses to pick between two codes in one
batch — that is the operator's call (business rule 5).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Route `POST /api/posts/uploads/detect-code`

**Files:**
- Create: `src/app/api/posts/uploads/detect-code/route.ts`
- Create: `src/app/api/posts/uploads/detect-code/route.test.ts`

**Interfaces:**
- Consumes: `getContainer()`, `requireTenantContext`, `readJsonBody`, `mapAppErrorToHttp`, `fallbackLogger`, `container.usecases.detectUploadCode` (T3).
- Produces: response JSON `{ verdict, files, warnings }` — hình dạng khớp `DetectUploadCodeResult`.

Tier **M**, role **editor** — cùng chuẩn với `POST /api/posts/uploads/tickets`: không chạm credential, không ghi gì, nhưng đọc catalog nội bộ của tenant nên viewer không có việc ở đây.

- [ ] **Step 1: Viết test thất bại**

Đọc `src/app/api/posts/uploads/tickets/route.test.ts` nếu có để theo đúng khuôn mock; nếu chưa có, theo khuôn của `src/app/api/posts/drafts/route.test.ts` (đã tồn tại trên `dev`).

```ts
import { describe, expect, it, vi } from "vitest";

const detectUploadCode = vi.fn();
const requireTenantContext = vi.fn();

vi.mock("@/composition/container", () => ({
  getContainer: () => ({
    logger: { child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    usecases: { detectUploadCode },
  }),
}));
vi.mock("@/app/api/_lib/require-tenant-context", () => ({ requireTenantContext }));

const TENANT = "11111111-1111-4111-8111-111111111111";

function post(body: unknown): Request {
  return new Request("http://localhost/api/posts/uploads/detect-code", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/posts/uploads/detect-code", () => {
  it("authorises as editor at tier M before reading the body", async () => {
    requireTenantContext.mockResolvedValue({ ctx: { tenantId: TENANT }, session: { email: "a@b.c" } });
    detectUploadCode.mockResolvedValue({ verdict: { status: "no_code" }, files: [], warnings: [] });
    const { POST } = await import("./route");

    await POST(post({ files: [{ fileName: "x.png" }] }));

    expect(requireTenantContext).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tier: "M", minRole: "editor" }),
    );
  });

  it("passes the tenant from the session, never from the body", async () => {
    requireTenantContext.mockResolvedValue({ ctx: { tenantId: TENANT }, session: { email: "a@b.c" } });
    detectUploadCode.mockResolvedValue({
      verdict: { status: "matched", productCode: "BG0SQ6083" }, files: [], warnings: [],
    });
    const { POST } = await import("./route");

    const response = await POST(post({ tenantId: "22222222-2222-4222-8222-222222222222", files: [{ fileName: "BG0SQ6083-AI (1).png" }] }));

    expect(response.status).toBe(200);
    expect(detectUploadCode).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT }),
    );
  });

  it("rejects an empty file list with 400", async () => {
    requireTenantContext.mockResolvedValue({ ctx: { tenantId: TENANT }, session: { email: "a@b.c" } });
    const { POST } = await import("./route");

    const response = await POST(post({ files: [] }));

    expect(response.status).toBe(400);
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận FAIL**

Run: `pnpm exec vitest run src/app/api/posts/uploads/detect-code/route.test.ts`
Expected: FAIL — không resolve được `./route`.

- [ ] **Step 3: Viết route**

```ts
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
```

Kiểm tra trước khi viết: `MAX_UPLOADS_PER_POST` có được re-export từ `@/composition/container` không (route `tickets` và `confirm` đang import từ đó — xác nhận lại bằng `grep -n "MAX_UPLOADS_PER_POST" src/composition/container.ts`).

- [ ] **Step 4: Chạy test, xác nhận PASS**

Run: `pnpm exec vitest run src/app/api/posts/uploads/detect-code/route.test.ts`
Expected: PASS 3/3.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/posts/uploads/detect-code
git commit -m "feat(api): expose upload product-code detection

Names only, a few KB of JSON — the compose screen calls it the moment files
are dropped, before any byte leaves the browser.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Client API + schema

**Files:**
- Modify: `src/ui/schemas/compose.schema.ts`
- Modify: `src/ui/services/upload.api.ts`

**Interfaces:**
- Consumes: `apiRequest` (đã có trong `upload.api.ts`), route T4.
- Produces:
  ```ts
  export const DetectCodeResponseSchema: z.ZodType<DetectCodeResponse>;
  export type DetectCodeResponse = {
    verdict:
      | { status: "matched"; productCode: string }
      | { status: "not_found"; productCode: string }
      | { status: "conflict"; codes: string[] }
      | { status: "no_code" };
    files: { fileName: string; status: "parsed" | "candidate" | "none"; productCode: string | null }[];
    warnings: string[];
  };
  export function detectUploadCode(
    params: { files: readonly { fileName: string }[] },
    signal?: AbortSignal,
  ): Promise<DetectCodeResponse>;
  ```

- [ ] **Step 1: Thêm schema vào `compose.schema.ts`**

Đặt ngay sau `UploadResponseSchema` (dòng ~91).

```ts
/** E9 — trả lời của `POST /api/posts/uploads/detect-code`. */
export const DetectCodeVerdictSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("matched"), productCode: z.string() }),
  z.object({ status: z.literal("not_found"), productCode: z.string() }),
  z.object({ status: z.literal("conflict"), codes: z.array(z.string()) }),
  z.object({ status: z.literal("no_code") }),
]);

export const DetectCodeResponseSchema = z.object({
  verdict: DetectCodeVerdictSchema,
  files: z.array(
    z.object({
      fileName: z.string(),
      status: z.enum(["parsed", "candidate", "none"]),
      productCode: z.string().nullable(),
    }),
  ),
  warnings: z.array(z.string()),
});

export type DetectCodeVerdict = z.infer<typeof DetectCodeVerdictSchema>;
export type DetectCodeResponse = z.infer<typeof DetectCodeResponseSchema>;
```

- [ ] **Step 2: Thêm hàm gọi vào `upload.api.ts`**

Theo đúng khuôn `requestUploadTickets` (dòng 65) — đọc nó trước rồi copy đúng các tuỳ chọn `apiRequest` đang dùng.

```ts
/**
 * Hỏi máy chủ tên file này mang mã nào. Gọi được ngay khi operator thả file:
 * request chỉ mang TÊN, không mang byte nào.
 */
export async function detectUploadCode(
  params: { files: readonly { fileName: string }[] },
  signal?: AbortSignal,
): Promise<DetectCodeResponse> {
  return apiRequest("/api/posts/uploads/detect-code", {
    method: "POST",
    body: { files: params.files.map((file) => ({ fileName: file.fileName })) },
    schema: DetectCodeResponseSchema,
    signal,
    malformedMessage:
      "Kết quả nhận diện mã không đúng định dạng. Hãy báo quản trị viên kiểm tra máy chủ.",
  });
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/ui/schemas/compose.schema.ts src/ui/services/upload.api.ts
git commit -m "feat(ui): client for upload product-code detection

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Ảnh thu nhỏ trong hàng chờ

**Files:**
- Modify: `src/ui/components/compose/upload-queue.ts`
- Modify: `src/ui/components/compose/upload-queue.test.ts`
- Modify: `src/ui/components/compose/UploadPanel.tsx`

**Interfaces:**
- Consumes: `QueuedFile` (đã có).
- Produces: `export function isPreviewable(file: File): boolean;`

**Skill FE bắt buộc đọc trước khi code** (CLAUDE.md): `~/.claude/skills/SKILL-MAP.md` → dòng `web-file-upload`; cộng nhóm 1 luôn kèm mọi màn hình: `component-reuse`, `accessibility`, `feedback-states`, `design-tokens`.

Vì sao dùng `URL.createObjectURL` chứ không gọi máy chủ: file đang nằm trong RAM trình duyệt, dựng ảnh xem trước tốn **0 byte mạng** và hiện ngay lập tức. `revokeObjectURL` là bắt buộc — không gọi thì mỗi lần chọn lại file là một lần rò bộ nhớ.

- [ ] **Step 1: Viết test thất bại cho `isPreviewable`**

Thêm vào `src/ui/components/compose/upload-queue.test.ts`:

```ts
import { isPreviewable } from "./upload-queue";

describe("isPreviewable", () => {
  it("says yes to the image types the album accepts", () => {
    expect(isPreviewable(new File([""], "a.png", { type: "image/png" }))).toBe(true);
    expect(isPreviewable(new File([""], "a.jpg", { type: "image/jpeg" }))).toBe(true);
    expect(isPreviewable(new File([""], "a.webp", { type: "image/webp" }))).toBe(true);
  });

  it("says no to a video — there is no still to show", () => {
    expect(isPreviewable(new File([""], "a.mp4", { type: "video/mp4" }))).toBe(false);
  });

  it("says no rather than throwing on a file with no type", () => {
    expect(isPreviewable(new File([""], "a"))).toBe(false);
    expect(isPreviewable(undefined as unknown as File)).toBe(false);
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận FAIL**

Run: `pnpm exec vitest run src/ui/components/compose/upload-queue.test.ts`
Expected: FAIL — `isPreviewable is not a function`.

- [ ] **Step 3: Thêm `isPreviewable` vào `upload-queue.ts`**

```ts
/**
 * Ảnh thì dựng được ô xem trước từ chính File trong RAM; video thì không —
 * lấy khung hình đầu của clip cần <video> + canvas, và đó là việc của Phase 2.
 * Trả `false` thay vì ném: bên gọi là một component đang render.
 */
export function isPreviewable(file: File): boolean {
  const type = typeof file?.type === "string" ? file.type.toLowerCase() : "";
  return type.startsWith("image/");
}
```

- [ ] **Step 4: Chạy test, xác nhận PASS**

Run: `pnpm exec vitest run src/ui/components/compose/upload-queue.test.ts`
Expected: PASS.

- [ ] **Step 5: Gắn ô xem trước vào `UploadPanel`**

Trong `UploadPanel.tsx`:

1. Thêm import: `import { useEffect, useId, useMemo, useState } from "react";` và `isPreviewable` từ `upload-queue`.
2. Dựng map url, huỷ khi hàng chờ đổi:

```tsx
  /**
   * Một object URL cho mỗi file ảnh đang chờ. Dựng theo `queue` và HUỶ ở
   * cleanup: không revoke thì mỗi lần chọn lại file là một lần rò bộ nhớ,
   * và người ta chọn lại nhiều lần.
   */
  const previews = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of queue) {
      if (isPreviewable(item.file)) map.set(item.id, URL.createObjectURL(item.file));
    }
    return map;
  }, [queue]);

  useEffect(() => {
    return () => {
      for (const url of previews.values()) URL.revokeObjectURL(url);
    };
  }, [previews]);
```

3. Đổi `renderContent` của `AlbumArranger` (dòng 196–201) để có ô ảnh. Ô ảnh là `aria-hidden` vì tên file đã nằm ngay bên cạnh — đọc hai lần là nhiễu cho trình đọc màn hình (`accessibility` §ảnh trang trí):

```tsx
        renderContent={(item) => (
          <div className="flex min-w-0 items-center gap-3">
            <div className="bg-muted relative h-12 w-12 shrink-0 overflow-hidden rounded">
              {previews.get(item.id) ? (
                <img
                  src={previews.get(item.id)}
                  alt=""
                  aria-hidden="true"
                  className="h-full w-full object-cover"
                />
              ) : (
                <span className="text-muted-foreground flex h-full w-full items-center justify-center text-[10px]">
                  {isPreviewable(item.file) ? "…" : "Video"}
                </span>
              )}
            </div>
            <div className="min-w-0">
              <span className="block truncate text-sm">{item.file.name}</span>
              <span className="text-muted-foreground text-xs">{formatBytes(item.file.size)}</span>
            </div>
          </div>
        )}
```

Ràng buộc: **không `style={{}}`, không giá trị cứng** — mọi màu/khoảng cách đi qua utility gắn token (`bg-muted`, `text-muted-foreground`, `rounded`, thang spacing). Ô ảnh có kích thước cố định để danh sách không nhảy khi ảnh tải xong (CLS = 0).

- [ ] **Step 6: Xem thật bằng dev server**

```bash
PORT=3111 pnpm dev
```

Mở `http://localhost:3111/compose`, chọn "Nguồn ảnh → Tự tải lên", thả 3 ảnh + 1 video. Kiểm: ảnh hiện ô xem trước, video hiện chữ "Video", kéo đổi thứ tự thì ảnh đi theo đúng dòng.
Nhớ: lưu `$!` rồi `kill "$PID"`, **không** `pkill -f next`.

- [ ] **Step 7: Commit**

```bash
git add src/ui/components/compose/upload-queue.ts src/ui/components/compose/upload-queue.test.ts src/ui/components/compose/UploadPanel.tsx
git commit -m "feat(compose): show a thumbnail for every image waiting to upload

Built from the File already in memory, so it costs zero bytes on the wire and
appears instantly. Object URLs are revoked on cleanup.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Thông báo mã đã nhận diện + nút hành động

**Files:**
- Create: `src/ui/components/compose/detected-code.ts`
- Create: `src/ui/components/compose/detected-code.test.ts`
- Create: `src/ui/components/compose/DetectedCodeNotice.tsx`
- Create: `src/ui/components/compose/detected-code-notice-render.test.tsx`
- Modify: `src/ui/hooks/useComposeWizard.ts`
- Modify: `src/ui/components/compose/ComposeFocus.tsx`

**KIỂM CHỨNG ĐÃ LÀM SẴN — đọc trước khi viết test:** repo **không có** `@testing-library/react`, không có `jsdom`, không có `happy-dom`. Test component ở đây dùng `renderToStaticMarkup` của `react-dom/server` (xem `src/ui/components/compose/resolved-product-line-render.test.tsx`), tức **không bấm được nút**. Không thêm dependency (CLAUDE.md).

Hệ quả về thiết kế, và nó làm code tốt hơn chứ không phải chống chế: quyết định "verdict này hiện tiêu đề gì, có những nút nào, mỗi nút mang mã nào" tách ra một **hàm thuần** `describeDetection()`. Hàm đó test được đầy đủ không cần DOM — kể cả yêu cầu cốt lõi §8.2 (mã đã detect phải nằm sẵn trên nút). Component chỉ vẽ lại thứ hàm đó trả về, và test render chỉ cần chứng minh nó vẽ đúng.

**Interfaces:**
- Consumes: `DetectCodeVerdict` (T5), `detectUploadCode` (T5), `Button` từ `@/ui/components/ui/button`.
- Produces:
  ```ts
  // detected-code.ts
  export type DetectedCodeActionKind = "use-code" | "sync" | "pick-code";
  export interface DetectedCodeAction {
    readonly kind: DetectedCodeActionKind;
    readonly label: string;
    /** Mã đi kèm nút. "" = mở ô nhập trống. Đây là chỗ §8.2 được bảo đảm. */
    readonly code: string;
    readonly variant: "primary" | "outline";
  }
  export interface DetectedCodeView {
    readonly title: string;
    readonly actions: readonly DetectedCodeAction[];
  }
  export function describeDetection(verdict: DetectCodeVerdict): DetectedCodeView;

  // DetectedCodeNotice.tsx
  export interface DetectedCodeNoticeProps {
    verdict: DetectCodeVerdict | null;
    warnings: readonly string[];
    onAction: (action: DetectedCodeAction) => void;
    isPending: boolean;
  }
  export function DetectedCodeNotice(props: DetectedCodeNoticeProps): JSX.Element | null;
  ```

Bốn trạng thái, đúng spec §7–§9:

| verdict | Hiện gì |
|---|---|
| `matched` | "Đã nhận diện mã: **BG0SQ6083**" + nút `Dùng mã này` |
| `not_found` | "Không tìm thấy sản phẩm BG0SQ9999" + `Đồng bộ lại dữ liệu` + `Nhập mã BG0SQ9999` |
| `conflict` | "Các file đang mang N mã khác nhau" + một nút cho mỗi mã |
| `no_code` | "Không nhận diện được mã sản phẩm" + `Đồng bộ lại dữ liệu` + `Nhập mã sản phẩm` |

Điểm cốt lõi của spec §8.2: **nút phải prefill mã đã detect**, operator không phải gõ lại. Đó là thứ `describeDetection` khoá lại bằng test.

- [ ] **Step 1: Viết test thất bại cho `describeDetection` (thuần)**

Tạo `src/ui/components/compose/detected-code.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { describeDetection } from "./detected-code";

describe("describeDetection", () => {
  it("names the matched code and offers to use it", () => {
    const view = describeDetection({ status: "matched", productCode: "BG0SQ6083" });
    expect(view.title).toContain("BG0SQ6083");
    expect(view.actions).toEqual([
      { kind: "use-code", label: "Dùng mã này", code: "BG0SQ6083", variant: "primary" },
    ]);
  });

  it("carries the detected code ON the manual button, so nobody retypes it (spec 8.2)", () => {
    const view = describeDetection({ status: "not_found", productCode: "BG0SQ9999" });
    const manual = view.actions.find((action) => action.kind === "use-code");
    expect(manual).toMatchObject({ label: "Nhập mã BG0SQ9999", code: "BG0SQ9999" });
  });

  it("offers a sync action when the product is not in the catalog", () => {
    const view = describeDetection({ status: "not_found", productCode: "BG0SQ9999" });
    expect(view.actions.some((action) => action.kind === "sync")).toBe(true);
    expect(view.title).toContain("BG0SQ9999");
  });

  it("offers one button per code on a conflict and picks none itself", () => {
    const view = describeDetection({ status: "conflict", codes: ["BG0SQ6083", "BG0SQ6084"] });
    const picks = view.actions.filter((action) => action.kind === "pick-code");
    expect(picks.map((action) => action.code)).toEqual(["BG0SQ6083", "BG0SQ6084"]);
    expect(view.actions.some((action) => action.kind === "use-code")).toBe(false);
  });

  it("offers sync and a BLANK manual entry when no code was found", () => {
    const view = describeDetection({ status: "no_code" });
    expect(view.title).toMatch(/không nhận diện được mã/i);
    expect(view.actions).toEqual([
      { kind: "sync", label: "Đồng bộ lại dữ liệu", code: "", variant: "outline" },
      { kind: "use-code", label: "Nhập mã sản phẩm", code: "", variant: "primary" },
    ]);
  });

  it("never returns an empty action list — a notice with no way out is a dead end", () => {
    const verdicts = [
      { status: "matched", productCode: "A" },
      { status: "not_found", productCode: "A" },
      { status: "conflict", codes: ["A", "B"] },
      { status: "no_code" },
    ] as const;
    for (const verdict of verdicts) {
      expect(describeDetection(verdict).actions.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận FAIL**

Run: `pnpm exec vitest run src/ui/components/compose/detected-code.test.ts`
Expected: FAIL — không resolve được `./detected-code`.

- [ ] **Step 3: Viết `detected-code.ts`**

```ts
import type { DetectCodeVerdict } from "@/ui/schemas/compose.schema";

/**
 * E9 — verdict nhận diện mã thành thứ màn hình vẽ được: một câu tiêu đề và
 * danh sách nút.
 *
 * Tách khỏi JSX vì đây mới là phần có luật: §8.2 nói operator KHÔNG phải gõ
 * lại cái mã hệ thống vừa đọc ra, và cách duy nhất bảo đảm điều đó là mã luôn
 * đi kèm nút (`action.code`). Ở đây nó test được không cần DOM — dự án không
 * có testing-library, và cũng không cần.
 */

export type DetectedCodeActionKind = "use-code" | "sync" | "pick-code";

export interface DetectedCodeAction {
  readonly kind: DetectedCodeActionKind;
  readonly label: string;
  /** Mã đi kèm nút. "" = mở ô nhập trống. */
  readonly code: string;
  readonly variant: "primary" | "outline";
}

export interface DetectedCodeView {
  readonly title: string;
  readonly actions: readonly DetectedCodeAction[];
}

const SYNC_ACTION: DetectedCodeAction = {
  kind: "sync",
  label: "Đồng bộ lại dữ liệu",
  code: "",
  variant: "outline",
};

export function describeDetection(verdict: DetectCodeVerdict): DetectedCodeView {
  switch (verdict.status) {
    case "matched":
      return {
        title: `Đã nhận diện mã: ${verdict.productCode}`,
        actions: [
          { kind: "use-code", label: "Dùng mã này", code: verdict.productCode, variant: "primary" },
        ],
      };

    case "not_found":
      return {
        title: `Không tìm thấy sản phẩm ${verdict.productCode} trong dữ liệu đã đồng bộ.`,
        actions: [
          SYNC_ACTION,
          {
            kind: "use-code",
            // Mã nằm TRONG nhãn nút: operator đọc là biết mình sắp dùng mã nào.
            label: `Nhập mã ${verdict.productCode}`,
            code: verdict.productCode,
            variant: "primary",
          },
        ],
      };

    case "conflict":
      return {
        title: `Các file đang mang ${verdict.codes.length} mã khác nhau. Chọn mã cho bài này, hoặc tách ra tải lên từng mã.`,
        // Không có nút "dùng mã này": hệ thống không chọn hộ (rule nghiệp vụ 5).
        actions: verdict.codes.map((code) => ({
          kind: "pick-code" as const,
          label: code,
          code,
          variant: "outline" as const,
        })),
      };

    case "no_code":
    default:
      return {
        title: "Không nhận diện được mã sản phẩm từ tên file.",
        actions: [
          SYNC_ACTION,
          { kind: "use-code", label: "Nhập mã sản phẩm", code: "", variant: "primary" },
        ],
      };
  }
}
```

- [ ] **Step 3b: Chạy test, xác nhận PASS**

Run: `pnpm exec vitest run src/ui/components/compose/detected-code.test.ts`
Expected: PASS 6/6.

- [ ] **Step 3c: Test render, theo đúng khuôn của repo**

Tạo `src/ui/components/compose/detected-code-notice-render.test.tsx` — dùng `renderToStaticMarkup`, y như `resolved-product-line-render.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DetectedCodeNotice } from "./DetectedCodeNotice";

const noop = () => {};

describe("DetectedCodeNotice", () => {
  it("draws nothing before a verdict exists", () => {
    const html = renderToStaticMarkup(
      <DetectedCodeNotice verdict={null} warnings={[]} onAction={noop} isPending={false} />,
    );
    expect(html).toBe("");
  });

  it("prints the detected code inside the manual button", () => {
    const html = renderToStaticMarkup(
      <DetectedCodeNotice
        verdict={{ status: "not_found", productCode: "BG0SQ9999" }}
        warnings={[]}
        onAction={noop}
        isPending={false}
      />,
    );
    expect(html).toContain("Nhập mã BG0SQ9999");
    expect(html).toContain("Đồng bộ lại dữ liệu");
  });

  it("draws one button per code on a conflict", () => {
    const html = renderToStaticMarkup(
      <DetectedCodeNotice
        verdict={{ status: "conflict", codes: ["BG0SQ6083", "BG0SQ6084"] }}
        warnings={[]}
        onAction={noop}
        isPending={false}
      />,
    );
    expect(html).toContain("BG0SQ6083");
    expect(html).toContain("BG0SQ6084");
  });

  it("shows every warning — nothing is dropped silently (business rule 5)", () => {
    const html = renderToStaticMarkup(
      <DetectedCodeNotice
        verdict={{ status: "no_code" }}
        warnings={["Chưa đọc được danh sách mã của đơn vị."]}
        onAction={noop}
        isPending={false}
      />,
    );
    expect(html).toContain("Chưa đọc được danh sách mã của đơn vị.");
  });

  it("announces itself politely — the verdict arrives after a request", () => {
    const html = renderToStaticMarkup(
      <DetectedCodeNotice
        verdict={{ status: "matched", productCode: "BG0SQ6083" }}
        warnings={[]}
        onAction={noop}
        isPending={false}
      />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });
});
```

- [ ] **Step 3d: Chạy, xác nhận FAIL rồi mới viết component**

Run: `pnpm exec vitest run src/ui/components/compose/detected-code-notice-render.test.tsx`
Expected: FAIL — không resolve được `./DetectedCodeNotice`.

- [ ] **Step 3: Viết component**

Đọc `~/.claude/skills/SKILL-MAP.md` dòng `web-feedback-states` trước. Dùng lại `Button` đang có; không dựng nút mới. Vùng này là `role="status"` `aria-live="polite"` — kết quả nhận diện tới sau một request và phải được đọc lên.

```tsx
"use client";

import {
  describeDetection,
  type DetectedCodeAction,
} from "@/ui/components/compose/detected-code";
import { Button } from "@/ui/components/ui/button";
import type { DetectCodeVerdict } from "@/ui/schemas/compose.schema";

/**
 * E9 — "hệ thống đọc được mã gì từ tên file bạn vừa thả".
 *
 * Chỉ vẽ. Mọi quyết định — tiêu đề nào, nút nào, nút mang mã gì — nằm ở
 * `describeDetection`, nơi test bắt được mà không cần DOM.
 */
export interface DetectedCodeNoticeProps {
  verdict: DetectCodeVerdict | null;
  warnings: readonly string[];
  onAction: (action: DetectedCodeAction) => void;
  isPending: boolean;
}

export function DetectedCodeNotice(props: DetectedCodeNoticeProps) {
  // Chưa hỏi thì không nói gì — một ô rỗng có viền là nhiễu.
  if (!props.verdict) return null;
  const view = describeDetection(props.verdict);

  return (
    <div
      role="status"
      aria-live="polite"
      className="border-border bg-card space-y-3 rounded-lg border p-3"
    >
      <p className="text-sm">{view.title}</p>

      <div className="flex flex-wrap gap-2">
        {view.actions.map((action) => (
          <Button
            key={`${action.kind}:${action.code}:${action.label}`}
            type="button"
            size="sm"
            variant={action.variant === "outline" ? "outline" : "default"}
            disabled={props.isPending}
            onClick={() => props.onAction(action)}
          >
            {action.label}
          </Button>
        ))}
      </div>

      {props.warnings.length > 0 ? (
        <ul className="text-muted-foreground space-y-1 text-xs">
          {props.warnings.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
```

Kiểm tra trước khi viết: `Button` nhận `variant` nào (`grep -n "variant" src/ui/components/ui/button.tsx`) — nếu không có `"default"` thì dùng đúng tên biến thể mặc định của repo, không đoán.

- [ ] **Step 4: Chạy test, xác nhận PASS**

Run: `pnpm exec vitest run src/ui/components/compose/detected-code.test.ts src/ui/components/compose/detected-code-notice-render.test.tsx`
Expected: PASS 6/6 và 5/5.

- [ ] **Step 5: Gọi detect trong `useComposeWizard`**

Thêm sau khối `upload` (dòng ~194). Chạy khi `uploadQueue` đổi và có file — trước khi tải lên, đúng ý spec §4.1 ("không bắt buộc nhập Product Code trước").

```ts
  const [detection, setDetection] = useState<DetectCodeResponse | null>(null);

  const detect = useMutation<DetectCodeResponse, ApiError, readonly QueuedFile[]>({
    mutationFn: (files) => detectUploadCode({ files: files.map((item) => ({ fileName: item.file.name })) }),
    retry: false,
    onSuccess: (result) => setDetection(result),
    // Nhận diện hỏng KHÔNG được chặn màn Soạn bài: operator vẫn gõ mã tay được.
    // Vẫn phải thấy được (rule 5), nên lỗi đi vào `detect.error` cho màn hình.
    onError: () => setDetection(null),
  });
```

Và trong `setUploadQueue` (hoặc một `useEffect` theo `uploadQueue`): khi hàng chờ từ rỗng thành có file, gọi `detect.mutate(uploadQueue)`. Khi hàng chờ rỗng thì `setDetection(null)`.

Xuất thêm ở object trả về của hook: `detection`, `detect`, `applyDetectedCode(code: string)` — hàm này gọi `form.setValue("productCode", code, { shouldDirty: true })` rồi `void submitProductStep()` khi `code` khác rỗng.

- [ ] **Step 6: Gắn vào `ComposeFocus`**

Trong nhánh `source === "upload"` (`ComposeFocus.tsx:539–559`), đặt `<DetectedCodeNotice>` **ngay dưới** `<UploadPanel>`:

```tsx
                <DetectedCodeNotice
                  verdict={wizard.detection?.verdict ?? null}
                  warnings={wizard.detection?.warnings ?? []}
                  isPending={wizard.detect.isPending || compose.isPending}
                  onAction={(action) => {
                    if (action.kind === "sync") {
                      router.push("/sync");
                      return;
                    }
                    // "use-code" và "pick-code" cùng một việc: điền mã vào ô mã
                    // rồi tra. `code` rỗng ở "Nhập mã sản phẩm" chỉ đưa con trỏ
                    // về ô nhập, không tra gì.
                    wizard.applyDetectedCode(action.code);
                  }}
                />
```

Kiểm chứng đã làm sẵn: màn Đồng bộ là `/sync` (`src/app/(app)/sync/page.tsx` tồn tại). Còn phải tự kiểm: `router` đã có trong `ComposeFocus` chưa — chưa thì thêm `import { useRouter } from "next/navigation"` và `const router = useRouter();`.

- [ ] **Step 7: Typecheck + lint + toàn bộ test**

Run: `pnpm exec tsc --noEmit && pnpm lint && pnpm exec vitest run`
Expected: exit 0 cả ba.

- [ ] **Step 8: Xem thật**

```bash
PORT=3111 pnpm dev
```

Bốn trường hợp phải xem tận mắt:
1. Thả `BG0SQ6083-AI (1).png` với mã có trong catalog → "Đã nhận diện mã: BG0SQ6083" + `Dùng mã này`.
2. Thả `BG0SQ9999-AI.png` → "Không tìm thấy sản phẩm BG0SQ9999" + `Đồng bộ lại` + `Nhập mã BG0SQ9999`; bấm nút thứ hai thì ô mã tự điền `BG0SQ9999`.
3. Thả `IMG_8821.png` → "Không nhận diện được mã sản phẩm".
4. Thả `BG0SQ6083-AI (1).png` + `BG0SQ6084-AI (1).png` → hiện hai nút mã, không tự chọn.

Chụp màn hình cả bốn, đính vào PR.

- [ ] **Step 9: Commit**

```bash
git add src/ui/components/compose/detected-code.ts src/ui/components/compose/detected-code.test.ts src/ui/components/compose/DetectedCodeNotice.tsx src/ui/components/compose/detected-code-notice-render.test.tsx src/ui/hooks/useComposeWizard.ts src/ui/components/compose/ComposeFocus.tsx
git commit -m "feat(compose): tell the operator which code the file names carry

Four verdicts, and in every one the detected code is already on the button —
nobody retypes what the system just read (spec 8.2). Two codes in one batch
are both offered; the system picks neither.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Ảnh thu nhỏ SAU khi tải lên

**Files:**
- Modify: `src/ui/hooks/useComposeWizard.ts`
- Modify: `src/ui/components/compose/UploadPanel.tsx`

**Interfaces:**
- Consumes: `MediaThumb` (đã có), `UploadResponse.accepted` (đã có).
- Produces: `ComposeWizard.uploadedAssets: readonly MediaAsset[]`

Vấn đề đang có: `upload.onSuccess` xoá sạch `uploadQueue`, nên object URL bị huỷ và **màn hình không còn ảnh nào** — chỉ còn dòng chữ "Đã lưu N file cho bài này" (`UploadPanel.tsx:230–235`). Đây đúng là chỗ bạn nói "chỉ cần xem preview ảnh khi đã được upload lên".

Ảnh sau khi tải lên lấy từ máy chủ qua `MediaThumb` → `/api/media/preview/<assetId>`, route này đã nhận id dạng `upload_<hex>`.

- [ ] **Step 1: Giữ `accepted` lại trong hook**

Trong `useComposeWizard.ts`, `upload.onSuccess` hiện có `setUploadedCount(result.accepted.length)`. Thêm ngay cạnh:

```ts
      setUploadedAssets(result.accepted);
```

và khai báo `const [uploadedAssets, setUploadedAssets] = useState<MediaAsset[]>([]);`. Xuất `uploadedAssets` ở object trả về. `resetWizard` phải `setUploadedAssets([])`.

- [ ] **Step 2: Nhận prop và vẽ**

`UploadPanel` thêm prop `uploadedAssets: readonly MediaAsset[]`. Đặt khối này ngay trên khối "Đã lưu N file" (dòng ~230):

```tsx
      {props.uploadedAssets.length > 0 && !props.isUploading ? (
        <ul className="flex flex-wrap gap-2" aria-label="File đã lưu cho bài này">
          {props.uploadedAssets.map((asset) => (
            <li key={asset.driveFileId} className="w-16">
              <div className="bg-muted relative h-16 w-16 overflow-hidden rounded">
                <MediaThumb asset={asset} alt="" />
              </div>
              <span className="text-muted-foreground mt-1 block truncate text-[10px]">
                {asset.fileName}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
```

`MediaThumb` đã tự lo ba trạng thái loading / ready / failed, nên không thêm trạng thái mới ở đây (`component-reuse`).

- [ ] **Step 3: Typecheck + test**

Run: `pnpm exec tsc --noEmit && pnpm exec vitest run src/ui`
Expected: exit 0.

- [ ] **Step 4: Xem thật**

`PORT=3111 pnpm dev` → thả 3 ảnh → bấm "Tải 3 file lên" → sau khi xong phải thấy **3 ô ảnh** cộng dòng "Đã lưu 3 file cho bài này". Chụp màn hình.

- [ ] **Step 5: Commit**

```bash
git add src/ui/hooks/useComposeWizard.ts src/ui/components/compose/UploadPanel.tsx
git commit -m "feat(compose): keep showing the album after the upload finishes

The queue is cleared on success, which took every thumbnail with it and left
only a sentence. The stored files are drawn from the preview route instead.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Cổng kiểm chứng cuối + PR

**Files:** không sửa file nào.

- [ ] **Step 1: Chạy đủ bộ kiểm chứng, dán output thật**

```bash
pnpm exec tsc --noEmit
pnpm lint
pnpm exec vitest run
pnpm build
ls -la .next/BUILD_ID
```

`pnpm build` exit 0 **chưa đủ** — phải thấy artifact thật (CLAUDE.md). Nếu build không ra gì: `rm -rf .next tsconfig.tsbuildinfo` rồi build lại.

- [ ] **Step 2: Đối chiếu tiêu chí nghiệm thu**

Đi lại từng dòng ở "Tiêu chí nghiệm thu của ĐỢT NÀY" đầu file, tick từng cái kèm bằng chứng (tên test hoặc ảnh chụp). Dòng nào không đạt thì ghi rõ vì sao — **không** tick khống.

- [ ] **Step 3: Gate `reviewer-qa`**

Giao `reviewer-qa` review toàn bộ diff + chạy lại lệnh verify. Yêu cầu soi kỹ CLAUDE.md §1, §2, §4, §5, §7. FAIL → agent domain sửa → gate lại. Không có ngoại lệ.

- [ ] **Step 4: Mở PR nháp về `dev`**

```bash
git push -u origin feat/upload-preview-detect-code
gh pr create --draft --base dev \
  --title "feat(compose): xem trước ảnh tải lên và tự nhận diện mã sản phẩm" \
  --body "..."
```

Thân PR phải có: phạm vi đã làm, phần **cố ý bỏ** (vision §10, đa mã §6/§19, data model §17, retention §12) kèm lý do, ảnh chụp 4 trường hợp ở Task 7 Step 8, và output thật của 4 lệnh ở Step 1.

Theo quy ước đã lưu: agent review + comment + undraft, PM là người merge.

- [ ] **Step 5: Cập nhật tiến độ**

Ghi một mục vào `docs/08-tien-do-du-an.md` cho E9: đã có nhận diện mã từ tên file + xem trước ảnh; còn nợ gom nhóm đa mã và caption vision.

---

## Self-Review

**Spec coverage (chỉ tính phạm vi đợt 1 PM đã chốt):**

| Mục spec | Tác vụ | Ghi chú |
|---|---|---|
| §4.1 entry point không bắt nhập mã trước | T7 | detect chạy khi thả file |
| §5.1 mã = trước dấu `-` | T1 | tầng candidate |
| §5.2 `-AI` không thuộc mã | T1 | parser A đã đúng sẵn, có test |
| §5.3 parser chỉ tạo candidate, catalog quyết | T1 + T3 | tách đúng hai tầng |
| §7 Case A — product tồn tại | T3 `matched` + T7 | album vẫn là ảnh upload (không đụng compose) |
| §8 Case B — detect được, không tồn tại | T3 `not_found` + T7 | không tạo Product |
| §8.1 nút Đồng bộ lại | T7 | |
| §8.2 nút Nhập mã prefill | T7 | có test riêng |
| §9 Case C — không detect được | T3 `no_code` + T7 | |
| §11 upload không thành Product Media | — | đã đúng sẵn: `origin='upload'`, không đụng |
| §13 album là danh sách explicit | — | đã đúng sẵn: `wizard.album` |
| §18 5 upload + 10 Drive → 5 | — | đã đúng sẵn: `compose-post.ts:325` lọc theo `origin` |
| §19 nhiều mã | T3 `conflict` | đợt này **báo ra**, chưa tách nhiều bài |
| §23 không tạo Product / không ghi Drive / Sheet | T3 | usecase chỉ đọc |
| Xem trước ảnh (PM bổ sung 27/08) | T6 + T8 | |
| §10 vision caption | — | **PM bỏ khỏi phạm vi** |
| §6 gom nhóm đa mã → nhiều bài | — | **đợt sau** |
| §12 retention · §17 data model | — | **đợt sau** |
| §22D tách composeFromProduct/Upload | — | **PM chốt giữ `source`** |

**Placeholder scan:** không còn "TBD"/"tương tự Task N"/"thêm validation phù hợp".

Bốn tiền đề đã được kiểm chứng khi viết plan, agent **không phải** tra lại:

| Tiền đề | Kết quả | Chứng cứ |
|---|---|---|
| `MAX_UPLOADS_PER_POST` re-export từ container | **Có** | `src/composition/container.ts:1444` |
| `@testing-library/react` / jsdom | **Không có.** Test component dùng `renderToStaticMarkup` | `package.json`; `resolved-product-line-render.test.tsx:1` |
| Màn Đồng bộ ở `/sync` | **Có** | `src/app/(app)/sync/page.tsx` |
| Quy ước test của `dev` | Cạnh source, **không** `__tests__/` | `ls src/core/domain` |

Hai chỗ agent vẫn phải tự tra vì phụ thuộc file sẽ sửa: tên biến deps trong `container.ts` (T3 Step 5) và danh sách `variant` của `Button` (T7 Step 3). Kèm lệnh cụ thể tại chỗ. Không được đoán.

**Type consistency:** `UploadCodeDetection` (T1) → `UploadFileDetection` + `UploadCodeVerdict` (T3) → `DetectCodeResponseSchema` (T5) → `DetectedCodeNoticeProps.verdict` (T7). Bốn tầng cùng một tập `status`: `parsed | candidate | none` cho từng file, `matched | not_found | conflict | no_code` cho cả lô. `productCode` là `string` ở `matched`/`not_found`, không có ở `conflict`/`no_code` — `discriminatedUnion` ở T5 ép đúng chuyện đó.
