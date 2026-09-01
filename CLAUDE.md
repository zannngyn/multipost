# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
| `docs/08-tien-do-du-an.md` | **Tiến độ đã kiểm chứng** theo epic + việc đang bị chặn. Đọc trước khi hỏi "làm gì tiếp", cập nhật sau mỗi lần merge vào `dev` |
| `docs/ai/` | **AI architecture ĐÃ DUYỆT** (ADR-001): gateway, registry, routing, validation, evaluation, cost |
| `sample-data/` | Dữ liệu test thật: listing 5.500 file, snapshot Sheet, 5 mã mẫu |

## Stack (đã chốt — không đổi khi chưa bàn)

Next.js App Router + TypeScript · PostgreSQL + Drizzle · BullMQ + Redis (queue; Redis kiêm cache nóng registry + rate-limit) · worker Node riêng cùng repo · Tailwind + shadcn/ui · AI Gateway đa provider, **hiện chạy MỘT provider: OpenAI** (quyết định 15/08/2026 — chưa có key Google paid tier; Google tắt nhưng adapter còn nguyên, bật lại bằng env + `config/ai-models.yaml`, không sửa code. Hệ quả: tạm không có provider fallback. Chi tiết `docs/ai/provider-strategy.md` §3.1) · Google Service Account · Docker Compose trên 1 VPS.

## Lệnh

`pnpm verify` là cổng duy nhất trước khi báo xong:
`typecheck → lint → depcruise → theme:check → theme:presets:check → test → build`.

| Việc | Lệnh |
|---|---|
| Dev web | `pnpm dev` |
| Dev worker | `pnpm worker:dev` (worker là process Node riêng, KHÔNG chạy trong Next) |
| Typecheck | `pnpm typecheck` (= `next typegen && tsc --noEmit`) |
| Lint | `pnpm lint` |
| Luật tầng | `pnpm depcruise` — vi phạm ở đây là **lỗi kiến trúc**, không phải style |
| Test toàn bộ | `pnpm test` (vitest, `environment: node`) |
| **Một file test** | `pnpm exec vitest run src/core/domain/inventory.test.ts` |
| **Một test theo tên** | `pnpm exec vitest run -t "<tên test>"` |
| Integration (cần DB thật) | `pnpm test:integration` |
| Migration | `pnpm db:generate` → `pnpm db:migrate` (`drizzle/`) · seed: `pnpm db:seed` |
| Theme | `pnpm theme:presets` sau khi sửa `src/ui/theme/mysp-theme.ts` |
| Hạ tầng local | `docker compose up -d postgres redis minio` |

**Compose 3 file:** `docker-compose.yml` là hình dạng **production** (không có MinIO, không
có proxy). `docker-compose.override.yml` được compose nạp **tự động** khi gõ `docker compose`
trần — nó thêm MinIO + Caddy cho máy dev. Production nạp `-f docker-compose.yml -f
docker-compose.prod.yml` nên không bao giờ thấy file override. Trên VPS, object storage là
MinIO dùng chung ở `/srv/minio` (`minio-server:9000` qua network `data`), edge là
Cloudflare Tunnel → Traefik.

**Theme:** `src/ui/theme/mysp.css` là artifact **sinh ra rồi commit**. Sửa `mysp-theme.ts`
mà quên build → app chạy bằng file CSS cũ; typecheck/lint/test đều không thấy.
`pnpm theme:check` build lại và so sánh, không ghi đè.

**Smoke script** (`scripts/*.ts`, chạy bằng `tsx`) ghi đè `tenant_integration` bằng
`onConflictDoUpdate` → thay cả mảng kênh. `scripts/smoke-guard.ts` chặn nếu DB có kênh
lạ. Không set `SMOKE_ALLOW_OVERWRITE=1` trừ khi cố ý.

**CI** chỉ chạy khi mở PR vào `main` (`.github/workflows/ci.yml`) — merge vào `dev`
không tốn phút Actions. `verify.yml` cố ý bỏ `pnpm build` vì Docker image build đã chạy.
Deploy (`deploy.yml`) chỉ chạy khi push `main`; CI vào VPS bằng Tailscale SSH, không có
deploy key.

## Bản đồ `src/` — 7 tầng, phụ thuộc một chiều

```
app / worker / ui  →  composition  →  adapters  →  core  ←  shared
```

| Thư mục | Vai trò | Cấm |
|---|---|---|
| `core/domain` | Type + luật thuần (inventory, caption, post-job, media-*, tenant-context) | mọi lib I/O trừ `zod` |
| `core/ports` | Interface cho mọi thứ bên ngoài (`ai`, `publisher`, `sheet-source`, `job-queue`…) | — |
| `core/usecases` | Usecase nhận dependency qua tham số, không tự tạo | import adapter |
| `adapters/*` | Cài port thật: `db` (Drizzle), `google`, `meta`, `ai`, `queue`, `media`, `auth`, `logging` | gọi ngược usecase · **import adapter khác** |
| `composition` | `container.ts` + `worker-container.ts` ráp adapter vào usecase; gate quyền (`require-tenant`, `operator-access-gate`, `require-platform-admin`) | import app/worker/ui |
| `app` | Route API mỏng + màn Next; lấy usecase từ composition | import adapter · import `@/core` ngoài `core/domain/errors` |
| `worker` | Process Node + BullMQ (`jobs/publish-post-job.ts`, reaper, heartbeat) | import Next/React/UI |
| `ui` | Component/hook/schema; gọi BE qua `ui/services/*.api.ts` | import `core`/`adapters`/`app`/`composition` · lib phía server |
| `shared` | Util thuần dùng chung FE+BE | phụ thuộc bất kỳ tầng nào |

Luật này bị **cưỡng chế hai lớp**: `eslint.config.mjs` (`no-restricted-imports`, thông báo
tiếng Việt kèm số mục doc) bắt lúc gõ code; `.dependency-cruiser.cjs` bắt thêm import vòng
và cạnh gián tiếp mà ESLint không thấy. Test và `__fixtures__` được miễn cả hai.

**Tenant id là branded type** — `systemTenantId` chỉ dùng trong `worker/` (actor=system,
doc 10 §5) · `testTenantId` chỉ trong `*.test.ts`/`__fixtures__` (doc 11 §3) ·
`signedMediaTenantId` chỉ trong `src/app/api/media/**` (doc 10 §2). ESLint chặn theo path.

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
