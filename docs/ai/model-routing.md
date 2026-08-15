# Model Routing — Proposal (chờ duyệt)

## 1. Nguyên tắc

- **Không hardcode model trong business code.** Chuỗi `"gpt-..."`/`"claude-..."` chỉ được xuất hiện ở: registry (YAML/DB) và test. ESLint rule chặn pattern này ngoài `adapters/ai/**` và `config/**`.
- **Task là đơn vị routing**, không phải request lẻ. Mỗi loại việc AI là một `AITask` có policy riêng.
- **Mặc định model rẻ đủ năng lực; flagship chỉ qua escalation.** Hệ thống high-volume — mỗi bài × mỗi kênh là một generation.

## 2. Registry — nguồn sự thật về model

File `config/ai-models.yaml` trong repo (review qua PR như code) + bảng `ai_model_policy_override` theo tenant (đổi nóng không cần deploy):

> ⚠️ **Snapshot dưới đây KHÔNG còn khớp registry đang chạy.** Quyết định owner
> 15/08/2026 rút xuống một provider duy nhất (OpenAI) vì chưa có key Google paid
> tier — xem `provider-strategy.md` §3.1. Ví dụ này giữ nguyên vì nó minh hoạ
> *hình dạng* file và luật "fallback phải khác provider"; đọc
> `config/ai-models.yaml` để biết tiers thật.

```yaml
# config/ai-models.yaml — cập nhật theo quyết định 12/08: Google primary (paid tier),
# OpenAI fallback hạ tầng. Model cụ thể trong tier vẫn chốt sau benchmark (evaluation.md).
tiers:
  cheap:
    - google:gemini-3.5-flash-lite    # primary — $0.30/$2.50
    - openai:gpt-5-mini               # fallback hạ tầng, khác provider — $0.25/$2
  mid:
    - google:gemini-3.6-flash         # $1.50/$7.50
    - openai:gpt-5.4-mini
  top:
    - google:gemini-3.1-pro           # $2/$12
    - openai:gpt-5

tasks:
  product_understanding:        # đọc ảnh bìa + metadata → mô tả ngữ cảnh
    vision: single
    primary: cheap
    escalate: [mid]
    maxEscalations: 1

  facebook_content:             # sinh caption Facebook
    vision: single
    primary: cheap
    escalate: [mid, top]
    maxEscalations: 2

  caption_dedupe_check:         # so trùng caption giữa kênh (nếu cần LLM; ưu tiên thuật toán thuần)
    vision: none
    primary: cheap
    escalate: []

  difficult_content:            # ảnh mờ/sản phẩm mơ hồ — do classifier hoặc người vận hành gắn cờ
    vision: single
    primary: mid
    escalate: [top]
    maxEscalations: 1
```

- Task trỏ tới **tier**, tier trỏ tới danh sách `provider:model` theo thứ tự ưu tiên — đổi model = sửa 1 dòng YAML, không đụng business code (nguyên tắc #2).
- Phần tử thứ 2 trở đi trong một tier = provider fallback (lỗi hạ tầng). `escalate:` = bậc nâng khi validation fail (lỗi chất lượng). Hai đường tách bạch — xem `provider-strategy.md` mục 4.

## 3. Pipeline routing

```
ContentGenerationRequest
   ↓
Task policy (registry)
   ↓
[tier: cheap] model đầu tiên khả dụng
   ↓ structured output
Validation pipeline (validation.md)
   ├── PASS → xong (ghi log: tier=cheap, escalations=0)
   └── FAIL (business/claim/policy)
          ↓ prompt kèm feedback: "lần trước fail vì <lý do validator>"
       [tier: mid] → validate lại
          ├── PASS → xong (log escalations=1 + lý do)
          └── FAIL → [tier: top] → validate
                 └── FAIL → trạng thái cần người xử lý, KHÔNG đăng
```

Kỳ vọng vận hành (giả thuyết, đo lại bằng dashboard): ~90% pass ở cheap tier; escalation rate là chỉ số sức khoẻ — tăng đột biến nghĩa là prompt hỏng hoặc dữ liệu đầu vào xấu, không phải lý do để nâng primary tier vĩnh viễn khi chưa xem số.

## 4. Task classifier (nhẹ, không phải ML ngày 1)

`difficult_content` được gắn cờ bằng rule thuần trước, model sau:
- Rule thuần (MVP): mã thiếu `Mô tả sản phẩm` ngắn hơn N ký tự · chỉ có ảnh `-AI` không có ảnh thật · người vận hành tick "khó".
- Sau này nếu cần: classifier chạy trên cheap model. Không xây ML pipeline khi chưa có số liệu.

## 5. Cấm

- Business usecase truyền `model:` vào request — chỉ được truyền `task:`.
- Nâng tier primary trong YAML "cho yên tâm" mà không có số benchmark đính kèm PR.
- Bỏ qua validation để đỡ tốn escalation (validator là hàng rào cuối trước khi đăng công khai).
