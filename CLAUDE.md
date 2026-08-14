# MYSP — Công cụ đăng bài tự động (Facebook + TikTok, AI viết caption)

Dự án nội bộ, SaaS-ready. Phase hiện tại: **Phase 1 — MVP Facebook** (TikTok/video/hẹn lịch = Phase 2, chế độ tự tải lên = Phase 3).

## Tài liệu nguồn — đọc trước khi làm việc lớn

| File | Nội dung |
|---|---|
| `docs/Yeu-cau-tinh-nang-Dang-bai-tu-dong (1).md` | Brief gốc — nguồn chân lý về nghiệp vụ |
| `docs/02-dinh-huong-cong-nghe.md` | Stack, kiến trúc, data model, thứ tự nghiệp vụ, rủi ro |
| `docs/03-WBS-va-estimate.md` | Epic E0–E13, phase, estimate |
| `docs/05-data-profile.md` | Hiện trạng dữ liệu thật (Drive/Sheet) — đọc trước khi viết parser |
| `docs/06-doi-chieu-brief-vs-plan.md` | Ma trận truy vết brief ↔ plan |
| `docs/07-kien-truc-clean-architecture.md` | **Kiến trúc bắt buộc**: cấu trúc thư mục, luật phụ thuộc một chiều, khuôn port/usecase, FE 4 lớp |
| `docs/ai/` | **AI architecture ĐÃ DUYỆT** (ADR-001): gateway, registry, routing, validation, evaluation, cost |
| `sample-data/` | Dữ liệu test thật: listing 5.500 file, snapshot Sheet, 5 mã mẫu |

## Stack (đã chốt — không đổi khi chưa bàn)

Next.js App Router + TypeScript · PostgreSQL + Drizzle · BullMQ + Redis (queue; Redis kiêm cache nóng registry + rate-limit) · worker Node riêng cùng repo · Tailwind + shadcn/ui · AI Gateway đa provider (Google/Gemini paid-tier primary + OpenAI fallback, registry YAML+DB — `docs/ai/`, ADR-001) · Google Service Account · Docker Compose trên 1 VPS.

## Flow agent team — BẮT BUỘC

Session chính đóng vai **PM/orchestrator**: chia task theo epic, giao đúng agent domain, tổng hợp kết quả. Không tự implement phần thuộc domain của agent khi agent đó dùng được.

| Agent | Domain | Epic |
|---|---|---|
| `data-pipeline` | Drive/Sheet sync, parser, chuẩn hoá màu, tồn kho, chọn ảnh | E2, E3 |
| `caption-ai` | Client Anthropic, prompt template, validator caption | E4 |
| `fb-publisher` | Graph API, post_job, fan-out đa kênh, khoá trùng, worker | E5, E7 |
| `ui-web` | Toàn bộ giao diện Next.js | E10 |
| `reviewer-qa` | Gate: review diff + chạy verify. Chỉ đọc, không sửa | mọi task |

**Model:** orchestrator (session chính) chạy **Fable 5** (`/model` đã set mặc định); cả 5 agent domain chạy **Opus 5** (`model: opus` trong frontmatter). Không hạ model agent để tiết kiệm khi chưa bàn.

**Gate bắt buộc:** mọi task code chỉ được báo "xong" sau khi `reviewer-qa` trả **PASS** (review diff + output lệnh verify thật). FAIL → agent domain sửa → gate lại. Không có ngoại lệ, kể cả task nhỏ.

**Ranh giới domain:** agent chỉ sửa code trong domain mình. Cần thay đổi chéo domain → báo orchestrator điều phối, không tự sửa xuyên biên.

## Chuẩn kỹ thuật — mọi agent phải theo khi viết code

1. **Edge case TRƯỚC, happy path SAU.** Với mỗi hàm/luồng: liệt kê và xử lý các nhánh lỗi trước (đầu vào rỗng/sai kiểu, dữ liệu thiếu, API ngoài lỗi/timeout/rate-limit, trạng thái không mong đợi), viết test cho edge case trước, rồi mới code nhánh đúng. Guard clause + early return, không lồng if sâu.
2. **Validate tại mọi biên.** API route (schema-validate request bằng zod), payload job worker (validate trước khi xử lý), và đặc biệt dữ liệu ngoài (Sheet, Drive, Graph API response) — không tin dữ liệu ngoài, parse qua schema rồi mới dùng. Fail validation → lỗi có mã, không âm thầm dùng giá trị mặc định.
3. **Typed error:** một lớp `AppError` chung (`code`, `message` tiếng Anh, `userMessage` tiếng Việt, `context`, `cause`). Lỗi nghiệp vụ (hết hàng, validator fail, token hết hạn) là error code cụ thể, không phải string tự do.
4. **Global error handling:**
   - Web: error boundary cho UI + middleware bắt lỗi chung cho API route (trả về shape lỗi thống nhất `{code, message}`).
   - Worker: handler lỗi cấp job (job fail → ghi trạng thái + log, không làm sập worker) + `unhandledRejection`/`uncaughtException` cấp process (log rồi thoát sạch để Docker restart).
5. **Cấm nuốt lỗi.** Mọi `catch` phải làm ít nhất một trong: log có context + rethrow, hoặc chuyển trạng thái entity kèm lý do. `catch {}` rỗng hoặc chỉ `console.log` là lỗi review tự động FAIL.
6. **Log có cấu trúc, chi tiết:** mỗi log entry kèm `tenant_id`, `job_id`/`batch_id`, mã sản phẩm, kênh, error code, stack khi là lỗi. Log tiếng Anh; message cho người vận hành tiếng Việt. Nhánh lỗi nghiệp vụ (chặn tồn kho, validator fail, đăng lỗi) log đủ để trả lời "vì sao bài này không lên" mà không cần debug.
7. **Luật phụ thuộc MỘT CHIỀU** (chi tiết + ma trận import: doc 07): `app/worker/ui → composition → adapters → core`. `core/` không import lib I/O hay lớp ngoài; UI không xuyên xuống DB; adapter không gọi ngược usecase; usecase nhận dependency qua tham số, không tự tạo. Cưỡng chế bằng ESLint no-restricted-imports + dependency-cruiser (dựng trong E1).
8. `reviewer-qa` kiểm các mục 1–7 trong mọi lần review; vi phạm mục 2, 4, 5, 7 là FAIL.

## Rule nghiệp vụ cốt lõi (mọi agent phải giữ)

1. **Thứ tự bất biến:** tra Sheet → kiểm tồn kho → gom media → (video: check thông số) → gọi AI → validator → người duyệt → đăng giãn cách. Tồn kho đứng trước AI — vi phạm là lỗi thiết kế.
2. **Whitelist vào prompt/caption:** chỉ Tên sản phẩm, Mô tả, Chủng loại, Mùa vụ + ảnh. Tồn, Lưu ý, 4 cột giá — không bao giờ. Chặn ở tầng dữ liệu.
3. **Kiểm tồn 2 lần:** lúc soạn và ngay trước khi gọi API đăng (cả đăng ngay). Tồn=0 / Lưu ý="HẾT HÀNG" / ô trống / không phải số → chặn.
4. **Khoá chống đăng trùng** `(batch, mã, màu, kênh, định_dạng)` trước mọi lời gọi API đăng.
5. **Không im lặng bỏ qua** bất kỳ lỗi nào — file sai chuẩn, số đuôi thiếu, validator fail, đăng lỗi đều phải hiện ra được.
6. **`post_job` = 1 bài × 1 kênh**; một kênh lỗi không dừng kênh khác.
7. **Tenant:** mọi bảng có `tenant_id`, query qua helper scope; config trong `tenant_integration`, không hardcode.
8. **AI (ADR-001):** SDK AI chỉ được import trong `adapters/ai/**`; chuỗi model chỉ tồn tại trong `config/ai-models.yaml`/registry — business code chỉ truyền `task`. Structured output bắt buộc; validation 4 tầng trước khi dùng; Google AI Studio bắt buộc PAID tier với dữ liệu thật; vision chỉ gửi 1 ảnh bìa.

## Quyết định đang treo (không tự quyết — hỏi PM)

C1/C2/C5 (hành vi chọn ảnh theo số đuôi) · C3/C4 (gộp màu) · D1 (ngưỡng đo caption khác nhau — tạm: không trùng >8 từ liên tiếp) · D2 (regex giá tiền — tạm: số ≥5 chữ số có `.`/`,`) · E1 (giãn cách giữa kênh hay giữa bài) · E3 (kênh cảnh báo) · 9 câu mới ở doc 05 mục 7. Gặp chỗ phụ thuộc các câu này: dùng giá trị tạm đã ghi, đánh dấu `// PENDING(<mã câu>)` trong code.

<!-- ASTRYX:START -->
Astryx v0.4.0 · 156 components
CLI: run every command as `pnpm exec astryx <cmd>` (shown below as `astryx ...`).

SETUP (once, in your app entry e.g. main.tsx) — without these, components render unstyled:
  import "@astryxdesign/core/reset.css";
  import "@astryxdesign/core/astryx.css";

WORKFLOW — discover, don't guess. Before writing UI:
1. `astryx build "<idea>"` — START HERE: returns a kit (closest [page] + [block]s + [component]s). No args = full playbook.
2. `astryx template <name> [--skeleton]` — scaffold the [page]/[block]s it named, or study their layout. Templates are reference code.
3. `astryx component <Name>` — props + examples for every component you use.

RULES:
- No <div> — components do all layout/spacing, page frame included.
- Frame first: read `astryx docs layout` before writing any page or screen — page frame, region widths, breakpoint behavior.
- Dense data = rows (Table, List/Item), never Card-wrapped list items; Card is for standalone widgets. Status = StatusDot/Token; Badge = counts only.
- Custom styling: component props first; else Tailwind utilities backed by tokens (bg-surface, text-primary, rounded-lg) via tailwind-theme.css. No raw hex/px.
- Tokens for every value (`astryx docs tokens`). Brand/accent via `astryx theme` — never override --color-* in :root.
- SELF-CHECK before you finish: re-read the file and replace any style={{…}}, raw <div>/<span> layout, imported .css/@apply, or hardcoded/arbitrary value (e.g. bg-[#fff], p-[13px]) with the component or a token-backed utility. If unsure a component/prop exists, run `astryx component <Name>` / `astryx search "<thing>"`; don't hand-roll CSS.

MORE CLI:
  search "<query>"   find any component / hook / doc / template / block
  component --list   156 components by category
  template --list    page + block recipes
  docs <topic>       color, elevation, icons, illustrations, internationalization, layout, migration, motion, principles, shape, spacing, styling, theme, tokens, typography
  swizzle <Name>     eject component source for deep customization
  upgrade --apply    run after any @astryxdesign/core bump
<!-- ASTRYX:END -->
