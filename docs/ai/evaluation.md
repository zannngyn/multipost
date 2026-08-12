# Evaluation Dataset & Benchmark — Proposal (chờ duyệt)

## 1. Nguyên tắc

Không chọn model bằng cảm tính (nguyên tắc #10, #13). Mọi quyết định routing — kể cả "GPT-5.4 mini làm primary" đang đề xuất — chỉ chốt sau khi chạy benchmark trên **dữ liệu thật của MYSP**.

Lợi thế có sẵn: khảo sát 12/08 đã cho chúng ta danh sách 5.497 file thật + snapshot Sheet (`sample-data/`) — không phải bịa dataset.

## 2. Cấu trúc dataset

```
evaluation/
├── products/           # 100–500 sản phẩm thật từ Sheet (bắt đầu 100, mở rộng dần)
│   └── {code}.json     # CanonicalProductData đúng dạng AI sẽ nhận (sau whitelist)
├── images/             # ảnh bìa thật của từng mã (ưu tiên có cả ca -AI và -THỰC TẾ)
├── expected_content/   # 20–30 caption "chuẩn vàng" do shop viết/duyệt (xin từ stakeholder — câu D8)
└── test_cases/         # ca có chủ đích:
    ├── normal/         #   mô tả đầy đủ, ảnh rõ — kỳ vọng pass ở cheap tier
    ├── sparse/         #   Mô tả sản phẩm ngắn/trống (15 mã thật đã biết từ doc 05)
    ├── ai_image_only/  #   mã chỉ có ảnh -AI, không có ảnh thật
    ├── trap_facts/     #   mô tả có bẫy: chứa số (size, %) — đo hallucination + claim validator
    └── name_confusion/ #   ca tên file chứa tên mẫu khác (MG0SV6055-PIERA)
```

Phân tầng lấy mẫu theo phân bố thật (doc 05): đủ chủng loại, đủ ca nhiều màu/một màu, đủ ca mô tả dài/ngắn.

## 3. Chấm điểm — 8 tiêu chí

| Tiêu chí | Cách đo | Loại |
|---|---|---|
| Product accuracy | Claim validator pass + đối chiếu tay mẫu 10% | Máy + người |
| Hallucination | test_cases/trap_facts: % output chứa fact không có nguồn | Máy |
| Brand compliance | So voice với expected_content; rubric 1–5 | Người (shop) chấm blind |
| Vietnamese quality | Rubric 1–5: tự nhiên, không dịch máy, đúng chính tả | Người chấm blind |
| Formatting | Schema pass rate lần đầu + đúng cấu trúc caption | Máy |
| Marketing quality | Rubric 1–5 do shop chấm blind (không biết model nào) | Người |
| Latency | p50/p95 ms | Máy |
| Cost | $/generation thực đo từ usage | Máy |

Chấm người: blind A/B — người chấm thấy caption, không thấy tên model. Tối thiểu 2 người chấm/caption cho 3 tiêu chí rubric.

## 4. Quy trình benchmark

```
1. Chốt dataset v1 (100 mã + test cases)     ← chặn bởi: expected_content cần shop cung cấp
2. Chạy N model ứng viên × cùng prompt version × cùng dataset
   Ứng viên đợt 1 (theo quyết định Google-primary 12/08): Gemini 3.5 Flash-Lite · Gemini 3.6 Flash · GPT-5 mini (cheap tier)
                   + Gemini 3.1 Pro · GPT-5.4 mini (mid/escalation). Chạy trên PAID tier (data policy).
3. Máy chấm tự động → lọc; người chấm blind phần rubric
4. Bảng kết quả 8 tiêu chí → chọn: primary cheap, fallback cùng tier, bậc escalation
5. Ghi kết quả vào PR sửa config/ai-models.yaml — số liệu đính kèm quyết định
```

Chi phí benchmark ước tính: 5 model × 100 sản phẩm × ~2K token/lượt — dưới $20. Không phải lý do để bỏ qua.

## 5. Evaluation là việc lặp lại, không phải một lần

- Chạy lại khi: đổi prompt version chính, provider ra model mới đáng giá, hoặc escalation rate production lệch >2× so với benchmark.
- Production chính là eval liên tục: `ai_generation` + tỉ lệ người vận hành sửa tay caption là ground truth rẻ nhất — dashboard đối chiếu số benchmark vs số thật hằng tuần.
- Dataset nằm trong repo (trừ ảnh — trỏ file ID), version bằng git.

## 6. WBS

Hạng mục mới **E4.9 — Evaluation dataset + benchmark run đợt 1: 2 MD** (dựng dataset 1 MD nhờ sample-data có sẵn; chạy + tổng hợp + chấm 1 MD, chưa tính thời gian chờ shop chấm rubric).
