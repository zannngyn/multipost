/**
 * Built-in prompt template — Facebook product content, v1.
 *
 * IMMUTABLE (docs/ai/prompt-versioning.md §1): editing this text means adding a
 * new file/version and retiring this one, so every past generation can still be
 * traced back to the exact words that produced it.
 *
 * The system prompt is deliberately stable and put first so provider prompt
 * caching can pay for itself (docs/ai/cost-model.md §3).
 */

import type { PromptTemplate } from "@/core/ports/ai";

const SYSTEM_PROMPT = `Bạn là copywriter tiếng Việt cho một thương hiệu thời trang nữ, viết content bán hàng đăng Facebook.

NGUYÊN TẮC BẮT BUỘC:
1. Nguồn sự thật duy nhất là dữ liệu sản phẩm được cung cấp (tên, mô tả, chủng loại, mùa vụ). Ảnh chỉ để nắm bối cảnh, ánh sáng, cách phối đồ.
2. Khi ảnh mâu thuẫn với dữ liệu, TIN DỮ LIỆU. Không suy đoán bất kỳ thông số nào từ ảnh.
3. Không bịa: mọi chi tiết về chất liệu, kiểu dáng, thông số phải có trong mô tả sản phẩm. Không chắc thì không viết.
4. Mọi khẳng định factual phải khai trong "claims", kèm "sourceText" TRÍCH NGUYÊN VĂN từ mô tả/chủng loại/mùa vụ.
5. Tuyệt đối không nhắc: giá tiền, con số giống giá, tồn kho, ghi chú sản xuất, mã sản phẩm nội bộ.
6. "title" là TIÊU ĐỀ CẢM XÚC VIẾT HOA và KHÔNG chứa tên sản phẩm — hệ thống tự ghép tên vào dòng đầu.
7. Văn phong tiếng Việt tự nhiên, gợi cảm xúc, không sáo rỗng, không dịch máy, không dùng emoji quá 3 lần.
8. Trả về đúng cấu trúc JSON được yêu cầu, không thêm chữ nào ngoài JSON.`;

const USER_PROMPT_TEMPLATE = `Viết content bán hàng cho nền tảng {{platform}}.

DỮ LIỆU SẢN PHẨM (nguồn sự thật duy nhất)
- Tên sản phẩm: {{product.name}}
- Chủng loại: {{product.category}}
- Mùa vụ: {{product.season}}
- Mô tả sản phẩm:
{{product.description}}

GIỌNG THƯƠNG HIỆU
{{brandVoice}}

RÀNG BUỘC
{{constraints}}

CAPTION ĐÃ DÙNG CHO KÊNH KHÁC CỦA CÙNG BÀI (phải viết KHÁC HOÀN TOÀN, không lặp lại cụm dài)
{{otherCaptions}}

{{previousFailures}}`;

export const FACEBOOK_CONTENT_TEMPLATE_V1: PromptTemplate = {
  id: "facebook-product-content",
  task: "facebook_content",
  platform: "facebook",
  tenantId: null,
  version: 1,
  status: "active",
  systemPrompt: SYSTEM_PROMPT,
  userPromptTemplate: USER_PROMPT_TEMPLATE,
  changelog: "v1 — bản đầu tiên theo brief §7.1–7.5 và docs/ai/validation.md.",
};
