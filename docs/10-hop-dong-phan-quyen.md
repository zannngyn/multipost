# Hợp đồng phân quyền (M0)

> Trạng thái: **bản nháp chờ PM duyệt** — 19/08/2026. Là văn bản mà M1.1→M3.3 đối chiếu (doc 09 §4).
> Nguồn: phân tích code thật của 40 file route (48 route×method) bởi 3 agent domain (data-pipeline, fb-publisher, caption-ai) + orchestrator; đã qua gate reviewer-qa. Mục 8 là các quyết định chờ PM, mỗi câu có đề xuất sẵn — chốt "theo đề xuất" hoặc ghi đè từng dòng. **Vai trò/tầng trong ma trận §4 là ĐỀ XUẤT thống nhất với §8** — PM ghi đè §8 thì sửa ma trận theo.

## 1. Thang vai trò & ranh giới

**Trong tenant** (từ `membership.role`): `viewer < editor < admin < owner`

| Vai trò | Ranh giới một câu |
|---|---|
| viewer | Xem — không tạo ra thay đổi hay chi phí nào |
| editor | Làm **nội dung**: soạn, compose, upload, sinh caption, đăng/hẹn/huỷ bài, chạy sync |
| admin | Làm **cấu hình + credential của tenant**: kênh, token, nguồn dữ liệu, prompt, thành viên, invite |
| owner | **Vòng đời tenant**: đổi tên, chuyển quyền, mời tới admin/owner. *(Xoá tenant: chưa có route trong 3 phần — muốn xoá thì super_admin suspend rồi xử lý tay; thêm khi có billing)* |

**Nền tảng** (từ `account.platform_role`): `support < super_admin`
- `support`: vào tenant qua support session (§3.5 doc 09) — **chỉ đọc** trong tenant (đề xuất, Q8.1).
- `super_admin`: + tạo/khoá tenant, quản platform_role.

**Ngoài mô hình**: `system` (worker, không phiên — mục 5) · `external` (fetcher của Meta — tầng P).

## 2. Bốn tầng kiểm quyền

| Tầng | Tiêu chí | Cách kiểm |
|---|---|---|
| **S** | Hậu quả **không hoàn tác được**, chạm credential, **hoặc dùng credential của tenant gọi API bên thứ ba**: đăng bài, tiêu tiền AI, token, đổi nguồn, duyệt Drive bằng token tenant, đổi cấu hình toàn tenant, thành viên/invite, platform op | membership đọc **DB tươi**, không cache |
| **M** | Ghi hoàn tác được: draft, compose, upload, nhóm kênh, tạo prompt nháp | cache ≤60s + so `membership.version` |
| **R** | Đọc | cache ≤60s |
| **P** | Public bearer — **duy nhất** `/api/media/[driveFileId]`: HMAC là quyền, không có phiên | chữ ký + `findByDriveFileId(tenantId, assetId)` scope tenant |

Tiêu chí phân tầng là *"hậu quả có hoàn tác được không"* — chạm credential và dùng-credential-gọi-bên-thứ-ba là hai trường hợp phổ biến nhất của tiêu chí đó. Tầng S ở state chưa-có-membership (`/api/tenants` POST, `/join`): "đọc DB tươi" nghĩa là kiểm account + biên abuse/token tươi, không có membership để kiểm. Ràng buộc tầng P: route public `/api/*` mới phải qua review kiến trúc; link chỉ do server mint; `tenantId` trong query của nó là claim trong payload ký, **không** tính là "tenantId từ client" theo nghĩa B-8; một error code cho mọi lý do từ chối.

**Ngoại lệ phải nói to:** link media đã ký **sống tới hết TTL (mặc định 6h, trần 24h)** bất kể revoke/suspend/disconnect. Xem Q8.6.

## 3. Error semantics

| Mã | Nghĩa duy nhất |
|---|---|
| 401 `UNAUTHORIZED` | Không có phiên. **Không dùng cho lỗi token bên thứ ba** (xem Bug B4) |
| 404 `*_NOT_FOUND` | Tài nguyên/tenant mà actor không có membership — hành xử như không tồn tại |
| 403 `FORBIDDEN` | Có membership nhưng thiếu vai trò |
| 409 `TENANT_NOT_SELECTED` | Có phiên, chưa chọn tenant (state NoMembership/chưa chọn) — UI hiện picker. *Code chưa tồn tại, tạo ở M1.2* |
| 302 + `?reason=` | *(Mở rộng so với doc 09 §3.3)* Route mà trình duyệt đang điều hướng top-level (`callback`, `/join`): lỗi redirect kèm reason, không trả JSON. Riêng `connect` **giữ JSON** cho lỗi — operator còn đang ở màn gốc, JSON đọc được (hành vi có chủ đích hiện tại, giữ nguyên) |

**Ràng buộc `src/proxy.ts` (phải xử lý ở M1.3):** hai route `callback` nằm sau guard phiên; phiên hết hạn giữa lúc consent → `proxy.ts:87-89` trả **401 JSON trước khi handler chạy** → "mọi lối ra 302" không tự nhiên mà có. M1.3 chọn một trong hai: (a) thêm 2 path callback vào nhánh redirect của `deny()` (đá về màn gốc kèm `?reason=SESSION_EXPIRED`), hoặc (b) đưa callback vào `PUBLIC_PREFIXES` và tự kiểm phiên trong handler. Đề xuất (a) — không mở rộng bề mặt public.

**Route ↔ state machine (doc 09 §3.8):** mọi route tenant-scoped (§4.1–4.3) phục vụ state `Member(active tenant)` — trừ `/api/media` (tầng P, không phiên, ngoài state machine); `/api/me*` phục vụ mọi account có phiên (kể cả NoMembership); `/join` phục vụ account có phiên; `/api/platform/*` phục vụ PlatformAdmin; route tenant-scoped trong support mode phục vụ `SupportMode(tenant, ≤1h)` theo Q8.1.

404 cho "không có nguồn cấu hình" (`state:"not_configured"` trả 200) khác 404 cho "không có membership" — hai nghĩa không được trộn.

## 4. Ma trận route

Chú thích: vai trò là **tối thiểu**; mọi route tenant-scoped lấy tenant từ `requireTenant()`, không từ client. `(Q…)` = chờ PM ở mục 8.

### 4.1 Dữ liệu — catalog + Google + media (data-pipeline)

| Route | Method | Vai trò | Tầng | Ghi chú |
|---|---|---|---|---|
| `/api/catalog/products` | GET | viewer (Q8.3) | R | UI bỏ cursor khi đổi tenant |
| `/api/catalog/source` | GET | viewer (Q8.3) | R | `not_configured` = 200 |
| `/api/catalog/source` | PUT | admin | S | Đổi nguồn → sync sau xoá stale |
| `/api/catalog/sync` | POST | editor (Q8.2) | S | Credential + ghi đè hàng loạt; giữ `SYNC_SOURCE_EMPTY` 409. *Bất đối xứng có chủ đích với picker (admin): sync chỉ chạy trong nguồn ĐÃ cấu hình, picker duyệt tự do toàn Drive công ty vượt ra ngoài nguồn* |
| `/api/catalog/sync-status` | GET | viewer | R | |
| `/api/catalog/google/connect` | GET | admin | S | State server-side, mục 6 |
| `/api/catalog/google/callback` | GET | admin | S | Kiểm lại quyền phiên hiện tại; mọi lối ra 302 |
| `/api/catalog/google/status` | GET | viewer (Q8.3) | R | Field-level: viewer chỉ thấy `state`; `email` + `scopes` + `sourceAccess` chi tiết trả cho **admin+** (cùng nguyên tắc `secretsConfigured`) |
| `/api/catalog/google/folders` | GET | admin | S (Q8.2) | Đọc bằng credential, ra ngoài app — cặp với PUT /source |
| `/api/catalog/google/spreadsheets` | GET | admin | S (Q8.2) | Quét cả Drive khi không `parentId` |
| `/api/catalog/google/spreadsheets/tabs` | GET | admin | S (Q8.2) | |
| `/api/catalog/google/connection` | DELETE | admin | S | Idempotent |
| `/api/tenants/health` | GET | viewer | R | Hiện là oracle dò tenant — hết sau M1.3 (Q8.7) |
| `/api/media/[driveFileId]` | GET | — | **P** | Actor = external; mục 2 |

### 4.2 Đăng bài + kênh (fb-publisher)

| Route | Method | Vai trò | Tầng | Ghi chú |
|---|---|---|---|---|
| `/api/posts/batches` | POST | editor (Q8.4) | S | Đăng thật; hiện `createdBy=null` — Bug B6 |
| `/api/posts/batches/[batchId]` | GET | viewer | R | `BATCH_NOT_FOUND` 400→404 (Bug B5) |
| `/api/posts/compose` | POST | editor | M | |
| `/api/posts/uploads` | POST | editor | M | `tenantId` multipart bỏ ở M1.3 |
| `/api/posts/drafts` | GET | editor | R | **Chỉ chính chủ** — admin/owner không đọc nháp người khác |
| `/api/posts/drafts` | PUT/POST/DELETE | editor | M | Chỉ chính chủ; owner resolve qua account, không qua email (M1.1) |
| `/api/posts/jobs` | GET | viewer | R | |
| `/api/posts/jobs/[postJobId]/retry` | POST | editor (Q8.4) | S | |
| `/api/posts/scheduled` | GET | viewer | R | |
| `/api/posts/scheduled/.../cancel` | POST | editor (Q8.4) | S | |
| `/api/posts/scheduled/.../reschedule` | POST | editor (Q8.4) | S | 503 `QUEUE_ERROR` = đã đổi giờ, chưa enqueue |
| `/api/posts/worker-health` | GET | viewer | R | `workersOnline` → boolean cho tenant; số thật chỉ platform (Q8.3) |
| `/api/channels` | GET | viewer | R | `secretsConfigured` chỉ trả cho admin+ (Q8.3) |
| `/api/channels/[channelId]` | PUT | admin | S | Bật/tắt kênh |
| `/api/channels/[channelId]` | DELETE | admin | S | Job queued của kênh: Q8.5 |
| `/api/channels/connect` | GET | admin | S | State server-side, mục 6 |
| `/api/channels/callback` | GET | admin | S | Kiểm lại quyền phiên tại callback |
| `/api/channels/import` | POST | admin | S | Token thô trong body |
| `/api/channels/refresh` | POST | admin | S | |
| `/api/channel-groups` | GET / POST | viewer / editor | R / M | `GROUP_NOT_FOUND` 400→404 (Bug B5) |
| `/api/channel-groups/[groupId]` | PUT / DELETE | editor | M | |

### 4.3 AI (caption-ai)

| Route | Method | Vai trò | Tầng | Ghi chú |
|---|---|---|---|---|
| `/api/posts/captions` | POST | editor | **S** | Tiêu tiền không hoàn tác; trần/ngày chưa cắm dây (Bug B1) |
| `/api/prompts` | GET | **editor** | R | Trả toàn văn systemPrompt → editor+ (Q8.3) |
| `/api/prompts` | POST | admin (Q8.2) | S | Có cờ `activate` → đồng hạng activate; editor gửi `activate:true` → 403, không âm thầm bỏ cờ |
| `/api/prompts/active` | GET | **editor** | R | Cũng trả toàn văn systemPrompt (`manage-prompt-templates.ts:173`) → **cùng mức với `/api/prompts`**, nếu không hạn chế ở trên vô nghĩa. Built-in cho tenant mới là hành vi đúng |
| `/api/prompts/versions/[v]/activate` | POST | admin | S | `PROMPT_NOT_FOUND` 500→404 (Bug B3) |

### 4.4 Auth + nền tảng (orchestrator)

| Route | Method | Vai trò | Tầng | Ghi chú |
|---|---|---|---|---|
| `/api/auth/[...nextauth]`, `/api/health` | * | public | — | |
| `/api/access-requests` (+`/decide`) | GET / POST | admin | R / S | Nghỉ hưu ở M2.4, thành lịch sử read-only |
| `/api/me` *(mới, M1.2)* | GET | mọi account có phiên | — | Hợp lệ cả state NoMembership |
| `/api/me/active-tenant` *(mới, M1.2)* | POST | account có membership ở tenant đích | S (đọc tươi) | Sai → 404 `TENANT_NOT_FOUND` |
| `/api/platform/tenants*` *(M3.2)* | * | super_admin | S | Nhận target tenantId + audit |
| `/api/platform/tenant-sessions` *(M3.3)* | POST | support | S | Mở support mode; audit kèm purpose |
| `/join/[token]` *(M2.2)* | GET | account có phiên | S | Điều hướng top-level → lỗi bằng 302 + reason |
| `/api/tenants` *(mới, M2.1)* | POST | account có phiên | S | Tạo công ty (self-service, biên abuse §3.7 doc 09) → creator thành owner |
| `/api/tenants/current` *(M2.1/M3.2)* | PUT | **owner** | S | Đổi tên/slug; suspend chỉ platform super_admin |
| `/api/invites` *(M2.2)* | GET / POST | admin / admin (**chỉ mời tới editor/viewer**); mời tới admin+owner: **owner** | R / S | Thang chống escalation §3.6 doc 09, đủ 3 bậc |
| `/api/invites/[id]` *(M2.2)* | DELETE | admin | S | Thu hồi link |
| `/api/members` *(M2.3)* | GET | admin | R | Danh sách thành viên |
| `/api/members/[id]` *(M2.3)* | PUT / DELETE | admin (**không nâng ai lên admin/owner, không đổi/gỡ owner — các việc đó: owner**) | S | Cùng thang với invite — sửa vai trò trực tiếp không được đi vòng qua thang §3.6; bump `membership.version` |

## 5. Actor = system (worker — không phiên, không membership)

> **Khai ghi đè doc 09 §3.3** ("Worker không đổi"): cơ chế phân giải tenant của worker đúng là không đổi, nhưng M0 áp thêm 3 ràng buộc mới lên worker (actor_kind ở M1.1, suspended-guard ở M1.3, authorize-tại-enqueue) — estimate M1.1/M1.3 của doc 09 phải hiểu là ĐÃ gồm các việc này.

**Nguyên tắc:** `tenantId` của system luôn đến từ **một hàng đã lưu** (payload job, `post_job.tenant_id`, claim trong chữ ký) — không bao giờ từ request. Branded `TenantId` có constructor thứ ba `systemTenantId(row, {component})`, chỉ export cho composition của worker; chặn import bằng ESLint `no-restricted-imports` dạng `paths` + `importNames` (chặn một symbol — khác dạng `patterns` theo thư mục mà doc 07 §5 minh hoạ).

Danh sách đóng (thêm mục = sửa hợp đồng): `publish-post` (đăng, ký lại URL media, đọc bytes) · `reap-post-jobs` (cross-tenant) · `reconcile-scheduled-posts` (cross-tenant) · `cleanup-uploads` + `cleanup-media-cache` (cross-tenant, xoá bytes) · `healthcheck-tenant` · `markConnectionExpired`/`sourceAccess` (ghi vào hàng credential, actor=system) · *(tương lai E5)* job tự refresh Page token.

**Ba ràng buộc:**
1. `audit_log` thêm `actor_kind ∈ {user, system, platform_support, external}` + `system_component` — hiện hàng của reaper và của "người không tra được" trông y hệt (M1.1).
2. **`tenant.status='suspended'` phải chặn cả worker**: `publish-post` kiểm trước lời gọi Graph — nếu không, tenant bị khoá vẫn đăng bài đã hẹn (M1.3).
3. Sync chuyển sang BullMQ sau này: authorize tại **enqueue**, handler không giả định có phiên.

## 6. OAuth state — chuẩn chung cho cả 2 luồng (Google + Facebook)

Cookie state hiện là JSON **không ký** mang `tenantId`, callback tin nguyên văn — chính là lỗ B-8 nặng nhất (ghi credential vào tenant bất kỳ). Chuẩn mới (M1.3):

1. `/connect`: `requireTenant()` + role ≥ admin (S, DB tươi) → ghi bản ghi state **phía server** `{nonce_hash, tenant_id, account_id, purpose, expires_at 10', used_at?}` (Postgres hoặc Redis TTL — sẵn trong stack). Cookie chỉ mang **nonce opaque**.
2. `/callback`: nonce → nạp hàng (chưa dùng, chưa hạn) → tenant/account lấy **từ hàng**, không từ cookie/query/active-tenant (người dùng có thể đổi công ty ở tab khác trong lúc consent — tenant ràng buộc tại thời điểm START) → **kiểm lại role ≥ admin của phiên hiện tại, DB tươi** (state chứng minh "cùng trình duyệt", không chứng minh "vẫn còn quyền") → đánh dấu `used_at` trước khi gọi API ngoài. Lệch bất kỳ → 302 `?reason=STATE_MISMATCH`.

## 7. Bug lộ ra trong M0 (sửa trong M1.3 trừ khi ghi khác)

| # | Bug | Sửa |
|---|---|---|
| B1 | `dailyCostPerTenantUsd` khai báo/parse/merge nhưng **không chỗ nào đọc để chặn** — số lượt gọi AI vô hạn | Cắm dây trần/ngày (Q8.9) |
| B2 | `postJobId` trong body captions không kiểm thuộc tenant | Verify → 404, hoặc server tự gắn |
| B3 | `PROMPT_NOT_FOUND` map 500 cho cả "built-in thiếu" (đúng) lẫn "activate version không tồn tại" (phải 404) | Tách mã |
| B4 | `TOKEN_EXPIRED` (Page token Meta) map HTTP 401 → sau M1.2 UI sẽ đá operator về màn đăng nhập vì token Facebook hết hạn | Đổi 409 (cùng nhóm `GOOGLE_AUTH_EXPIRED`) |
| B5 | `BATCH_NOT_FOUND`, `GROUP_NOT_FOUND` trả 400 `INVALID_INPUT` | Thêm code 404 riêng, đồng bộ ui-web |
| B6 | `POST /api/posts/batches` không đọc session → hành động hệ trọng nhất có `createdBy=null` | Actor từ session |
| B7 | `/api/posts/worker-health` + mọi route GET tenant-scoped **trừ** `/api/posts/drafts` (owner từ session) và `/api/access-requests` (có role guard): ai đăng nhập cũng đọc được tenant bất kỳ | Chính là B-8, M1.3 |

## 8. Quyết định chờ PM — mỗi dòng có đề xuất, chốt "theo đề xuất" hoặc ghi đè

| # | Câu hỏi | Đề xuất |
|---|---|---|
| **8.1** | Platform `support` vào tenant được làm gì? (gộp M0-AI-4, R11, P10 — cả 3 agent cùng hỏi) | **Chỉ đọc (tầng R)** — không đăng bài, không tiêu tiền AI, không sync, không đụng credential của khách. Thao tác ghi do người của tenant làm |
| **8.2** | Tầng cho: sync (P2), 3 route picker Drive (P3), `POST /prompts` (M0-AI-2), captions (M0-AI-1) | **Tất cả S** như ma trận trên. Sync = editor (thao tác thường ngày); picker = admin (cặp với đổi nguồn); prompts POST = admin trọn gói (không tách cờ activate) |
| **8.3** | Viewer thấy gì: tồn kho + lỗi sync (P1), toàn văn prompt (M0-AI-3), email Google + id nguồn (P4), `secretsConfigured` (R4), số worker (R3) | Viewer thấy **tồn kho, lỗi sync, trạng thái kết nối (chỉ `state`)**; **toàn văn prompt = editor+ (cả `/prompts` lẫn `/prompts/active` — ma trận §4.3 đã ghi theo)**; email Google + scope + `secretsConfigured` + số worker thật = **admin+**/platform |
| **8.4** | Ai bấm đăng? (R1) Hẹn lịch có khác đăng ngay? (R2) | **editor đăng được cả hai** — shop 2 người là khách điển hình; muốn cổng duyệt thì thêm cờ tenant `require_admin_approval` ở Phase sau, không làm bây giờ |
| **8.5** | Xoá kênh còn job `queued` (R5) | **(b)** tự `cancelled` job queued của kênh trong cùng transaction — đúng rule "không im lặng" |
| **8.6** | Link media ký sống qua revoke/suspend tới 24h (P7, P8) | Chấp nhận cho revoke membership (link do server mint, Meta là người dùng); **suspend tenant thì phải giết** → thêm `media_key_epoch` bump khi suspend/disconnect, làm ở M3.2 khi có nút suspend |
| **8.7** | Số phận `/api/tenants/health` (P6) | Giữ, viewer, tenant từ context — hết vai trò oracle sau M1.3 |
| **8.8** | Nháp người bị gỡ membership (R6) | **(c)** xoá khi `membership.status='removed'` — không mở API đọc nháp người khác |
| **8.9** | Trần AI (M0-AI-5, M0-AI-8, P12) | Trần/ngày mặc định **$5/tenant/ngày** (hằng env), admin+ không tự nâng trong Phase này; thêm cột actor vào `ai_generation` ở M1.1 (đang không ghi ai bấm); rate-limit sync + captions để vé riêng |
| **8.10** | Tên error code (P9) | Dùng `FORBIDDEN` mới cho thiếu vai trò (403); `ACCESS_FORBIDDEN` giữ cho màn access cũ tới khi nghỉ hưu; tạo `TENANT_NOT_SELECTED` (409), `TENANT_NOT_FOUND` (404) |
| **8.11** | Backfill `ACCESS_REGISTRY_TENANT_ID` (P11) | M1.1: mỗi hàng `access_request.approved` → `account` + `identity` + `membership(tenant demo)`; registry ngừng là đường authorize sau M1.2, chỉ còn lịch sử |
| **8.12** | Cửa sổ multipart uploads (R10) | `read-upload-form.ts` thuộc M1.3 (fb-publisher sở hữu, ui-web phối hợp field) |

---

*Sau khi PM chốt mục 8: tích M0 ở doc 09, cập nhật ma trận theo quyết định cuối, rồi vào M1.0 (inventory) + M1.1 (schema).*
