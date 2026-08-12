# AI Output Validation — Proposal (chờ duyệt)

## 1. Schema-first: AI trả cấu trúc, không trả văn tự do (nguyên tắc #4)

Mọi generation task dùng **structured output của provider** (cả OpenAI, Anthropic, Google đều hỗ trợ) với schema khai báo sẵn. Không regex-parse văn tự do.

```ts
// shared/types/generated-content.ts — schema gửi cho provider VÀ validate lại bằng zod
type GeneratedContent = {
  title: string;          // "TIÊU ĐỀ CẢM XÚC VIẾT HOA" — KHÔNG gồm tên SP (hệ thống tự ghép)
  body: string;
  hashtags: string[];     // 3–5 phần tử
  claims: Claim[];        // MỌI khẳng định factual mà AI đã dùng — bắt AI tự khai
  confidence?: number;    // 0–1, tự đánh giá — chỉ để quan sát, không dùng làm gate
};

type Claim = {
  field: 'material' | 'category' | 'season' | 'color' | 'other';
  statement: string;      // "chất liệu tơ óng"
  sourceText: string;     // đoạn trong Mô tả sản phẩm mà claim dựa vào
};
```

**Điểm thiết kế quan trọng — tên sản phẩm do hệ thống ghép:** dòng đầu caption `Tên – TIÊU ĐỀ` được lắp ở tầng domain (`buildCaption(product.name, content)`), AI chỉ sinh `title`. Loại hẳn lớp lỗi "AI viết sai tên" thay vì chỉ phát hiện nó. Validator vẫn kiểm tên trong `body` (AI có thể nhắc lại tên).

## 2. Pipeline 4 tầng — tất cả là pure function trong `core/ai/validation/`

```
NormalizedAIResponse.output
   ↓ Tầng 1 — SCHEMA (zod)
   đúng shape, đúng kiểu, hashtags.length ∈ [3,5], title/body không rỗng
   ↓ Tầng 2 — BUSINESS (rule từ brief — đã có trong plan, nay chạy trên structured data)
   • body nhắc tên SP → phải đúng product.name, không lẫn tên mẫu khác (KHÔNG tin tên file)
   • title là uppercase (chuẩn hoá tiếng Việt trước khi so)
   • không trùng >8 từ liên tiếp với caption kênh khác cùng bài  // PENDING(D1)
   ↓ Tầng 3 — CLAIM (nguyên tắc #5 — xem mục 3)
   ↓ Tầng 4 — CONTENT POLICY
   • không số dạng giá tiền  // PENDING(D2) — regex tạm: số ≥5 chữ số có ./,
   • không số tồn kho, không ghi chú sản xuất, không từ cấm (blacklist theo tenant)
   ↓
ValidationResult { pass: boolean; failures: ValidationFailure[] }  // failures đưa vào prompt khi escalate
```

## 3. Claim Validator — AI không được bịa facts (nguyên tắc #5)

Nguồn sự thật duy nhất: `CanonicalProductData` từ Product domain (whitelist đã có: Tên, Mô tả, Chủng loại, Mùa vụ + ảnh bìa). AI **không bao giờ được cho biết**: giá (4 cột), SKU nội bộ, tồn, ghi chú sản xuất, size chart nếu không thuộc whitelist — chặn từ tầng build context, không phải chỉ dặn trong prompt.

Kiểm 2 chiều:

| Chiều | Cách kiểm | Fail thì |
|---|---|---|
| **Claim khai báo** — mỗi `claims[].sourceText` phải là chuỗi con (sau chuẩn hoá) của `Mô tả sản phẩm`/`Chủng loại`/`Mùa vụ` | So khớp máy, không cần AI | Reject → escalate kèm lý do |
| **Facts lọt lưới** — quét `body` tìm pattern factual không có trong nguồn: con số + đơn vị (cm, kg, %, size), chất liệu không xuất hiện trong mô tả, từ khoá khuyến mãi/xuất xứ | Rule thuần + từ điển chất liệu | Reject → escalate |

Ví dụ đúng yêu cầu chỉ đạo: AI sinh `"giá chỉ 399.000"` trong khi Product domain không hề cấp giá → tầng 4 chặn (không giá trong caption — rule brief); AI sinh `"chất liệu lụa tơ tằm"` mà Mô tả sản phẩm không có → tầng 3 chặn vì claim không có source.

Giới hạn thừa nhận: claim validator bằng rule thuần không bắt được 100% diễn đạt lắt léo — đó là lý do có eval dataset đo **hallucination rate** (evaluation.md) và bước người duyệt vẫn bật mặc định (brief 7.6).

## 4. Kết quả validation là dữ liệu

`ValidationResult` ghi vào `ai_generation.validationResult` (prompt-versioning.md) — dashboard tính validation failure rate theo model/prompt version, làm bằng chứng cho quyết định routing.
