# Prompt Versioning & Generation Log — Proposal (chờ duyệt)

## 1. PromptTemplate — entity có phiên bản, immutable

Nâng cấp từ thiết kế cũ ("template lưu DB, sửa không cần deploy" — doc 02) thành entity chuẩn:

```
prompt_template
├── id                    facebook-product-content
├── task                  facebook_content
├── version               2                      (tăng dần; bản ghi immutable — sửa = tạo version mới)
├── systemPrompt          text
├── userPromptTemplate    text  (biến: {{product.name}}, {{product.description}}, {{constraints}}...)
├── modelPolicyRef        tham chiếu task trong registry (KHÔNG chứa model string)
├── status                draft | active | retired   (mỗi (task, platform, tenant) đúng 1 active)
├── changelog             vì sao tạo version này
├── tenant_id
└── createdAt / createdBy
```

- Sửa prompt = tạo version mới ở trạng thái `draft` → thử trên eval subset → `active`. Bản cũ `retired`, không xoá — mọi generation cũ vẫn trace được về đúng văn bản prompt đã dùng.
- Rollback = set `active` lại version cũ. Không hotfix đè.
- Biến bắt buộc được validate lúc lưu template: template của generation task phải chứa `{{product.name}}` và khối `{{constraints}}` — thiếu thì không cho `active`.

## 2. `ai_generation` — log mỗi lần sinh (nguyên tắc #8 + #9)

Mỗi lời gọi model (kể cả bậc escalation, kể cả fail) là MỘT dòng:

```
ai_generation
├── generationId          (nhóm các attempt của cùng một yêu cầu sinh)
├── attemptNo             1, 2, 3...
├── requestId             (trace xuyên hệ thống)
├── tenant_id
├── task                  facebook_content
├── postJobId             (nối về post_job — biết generation này phục vụ bài nào)
├── promptTemplateId + promptVersion
├── provider + model      (thực tế đã dùng, sau routing)
├── tier                  cheap | mid | top
├── fallbackUsed          bool  (đổi provider vì lỗi hạ tầng)
├── escalationFrom        attempt trước đó (null nếu attempt đầu)
├── inputHash             hash(AIContext + promptVersion) — dedupe/cache + phát hiện input trùng
├── inputTokens / outputTokens / cachedTokens
├── latencyMs
├── estimatedCost         tính từ bảng giá trong registry tại thời điểm gọi
├── success               bool (gọi API thành công)
├── validationResult      jsonb — pass/failures theo tầng
├── output                jsonb GeneratedContent (giữ để eval + debug; TTL dọn sau N ngày)
└── createdAt
```

## 3. Câu hỏi mà log này phải trả lời được (định nghĩa xong = xong)

- *"Model nào đang tạo content tốt nhất và rẻ nhất?"* → group by model: cost/generation, validation pass rate lần đầu, escalation rate.
- *"Prompt v2 tốt hơn v1 không?"* → so validation failure rate + tỉ lệ người vận hành sửa tay (join với caption_version đã có trong data model) giữa 2 version.
- *"Chi phí mỗi bài đăng thành công là bao nhiêu?"* → sum(estimatedCost theo postJobId) / count(post published) — xem `cost-model.md`.
- *"Fallback rate tăng — provider nào chập chờn?"* → fallbackUsed theo provider theo giờ.

## 4. Dashboard tối thiểu (MVP = 1 trang admin, không cần công cụ BI)

Cost/ngày theo tenant · cost/bài published · pass-rate lần đầu theo model · escalation rate · fallback rate · validation failure theo tầng · top lý do fail. Nguồn: đúng một bảng `ai_generation`, không cần hệ thống telemetry riêng ở MVP.
