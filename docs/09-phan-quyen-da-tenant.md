# Phân quyền đa tenant — thiết kế & lộ trình

> Trạng thái: **đã sửa theo review kiến trúc 19/08/2026 — CHỜ CHỐT, chưa bắt đầu code.**
> Cập nhật file này sau mỗi milestone: tích `[x]`, ghi ngày + commit vào cuối dòng. Đọc kèm `docs/08` mục B-8 (nợ bảo mật gốc).

## 1. Vấn đề

- **40/40 route API** nhận `tenantId` từ client (query/body/cookie/form), không route nào đối chiếu với phiên đăng nhập → operator đã đăng nhập đổi UUID là đọc/ghi được dữ liệu tenant khác (nợ B-8, `docs/08:153`). Đã có Page access token thật nằm sau các route này.
- Phiên đăng nhập (`OperatorSession`) không mang tenant; 13 file UI đóng đinh `DEMO_TENANT_ID`, 3 màn bắt người dùng tự gõ UUID.
- Thêm người dùng phải whitelist email/Facebook ID vào env rồi restart container.

## 2. Quyết định đã chốt

| # | Câu hỏi | Quyết định |
|---|---|---|
| Q1 | Một người thuộc mấy công ty? | **1 người ≤ N công ty** |
| Q2 | Người mới vào công ty bằng gì? | **Link mời** có hạn, gắn vai trò; không whitelist env |
| Q3 | Admin MYSP làm gì với dữ liệu tenant khách? | **Quản trị vỏ ngoài + support mode có audit từng lần vào** |
| Q4 | Ai tạo được công ty? | **Self-service**, kèm biên chống abuse (mục 3.7) |
| Q5 | Server biết request thuộc tenant nào? | **Cookie chỉ là selector; membership trong DB là authorization** — route tenant-scoped không bao giờ nhận `tenantId` từ client |

Các nguyên tắc giữ nguyên sau review: không nhét tenant/role vào JWT · membership là nguồn quyền duy nhất trong tenant · invite thay whitelist env · `access_request` chuyển thành lịch sử read-only · audit mọi lần platform admin vào tenant.

## 3. Thiết kế cốt lõi *(bản sửa sau review — 7 mục Must-fix đã xử lý)*

### 3.1 Identity model: tách người khỏi cách đăng nhập

`provider_account_id` là identity ổn định; email chỉ là thuộc tính. Không bao giờ auto-link hai provider qua email trùng nhau.

```
account            -- một CON NGƯỜI (không có tenant_id — ngoại lệ thứ 2 sau bảng tenant)
  id, status ('active'|'suspended'),
  platform_role null | 'support' | 'super_admin',      -- mục 3.5
  display_name?, timestamps

identity           -- một CÁCH ĐĂNG NHẬP của người đó
  id, account_id FK, provider ('google'|'facebook'), provider_account_id,
  session_email (unique — khoá tra từ JWT email, giữ quy tắc fb-<id>@facebook.local),
  email?, timestamps
  UNIQUE (provider, provider_account_id)

membership         -- authorization: người ↔ công ty ↔ vai trò
  id, tenant_id FK, account_id FK, role user_role,
  status ('active'|'removed'), version int NOT NULL default 1,
  invited_by_account_id?, timestamps
  UNIQUE (tenant_id, account_id)
```

- Đăng nhập Google và Facebook của cùng một người tạo **2 account riêng** cho tới khi có account-linking tường minh (ngoài phạm vi 3 phần này — schema đã sẵn: link = chuyển `identity.account_id`).
- Phân giải phiên: JWT email → `identity.session_email` → `account` → memberships.

### 3.2 Ba vai của ba bảng, invariant enforce ở DB

**`account` = identity · `membership` = authorization · `app_user` = domain actor** (chủ thể audit/draft trong tenant, giữ nguyên mọi FK hiện có).

- `app_user` thêm cột `account_id FK` + `UNIQUE (tenant_id, account_id)` — invariant *membership active 1:1 app_user* do **DB giữ**, không phải "code đảm bảo".
- Tạo/đổi role membership và upsert `app_user` chạy **cùng một transaction** (đúng mẫu `access-request-repo.decide` hiện có).

### 3.3 Phân giải tenant mỗi request

```
Cookie `mysp_active_tenant` (httpOnly, SameSite=Lax) — CHỈ LÀ GỢI Ý
  ↓
getOperatorSession() [Node] → identity → account
  ↓
requireTenant(session, cookie) → TenantContext { tenantId: TenantId, role, membershipVersion }
```

- **`TenantId` là branded type**, chỉ `requireTenant()` (và lớp platform, mục 3.5) tạo ra được. Port/usecase/repo đổi chữ ký nhận `TenantId` thay `string` → compile-time chặn việc đút chuỗi từ request vào `forTenant()`. Đây là lớp 2 của phòng thủ; lớp 1 là `requireTenant`. RLS Postgres ghi nhận là mục **đánh giá** defense-in-depth, không nằm trong 3 phần.
- Không có cookie → tenant duy nhất của account, hoặc `409 TENANT_NOT_SELECTED` (UI hiện picker).
- Cookie trỏ tenant không có membership active → **`404 TENANT_NOT_FOUND`** — không tiết lộ tenant tồn tại. Semantics thống nhất: *mọi tài nguyên thuộc tenant mà actor không có membership đều hành xử như không tồn tại (404)*; `403 FORBIDDEN` chỉ dùng khi có membership nhưng thiếu vai trò.
- Đổi công ty = `POST /api/me/active-tenant` (kiểm membership rồi set cookie). `GET /api/me` trả account + danh sách công ty.
- Middleware edge giữ nguyên vai trò "có JWT hợp lệ", không đọc DB. Worker không đổi (lấy tenant từ hàng DB hoặc cố ý cross-tenant).

### 3.4 Authorization cache phân tầng + membership version

Một rule 60s cho mọi API là sai với hệ đã cầm Page access token thật. Phân tầng (danh sách chốt tại M0):

| Tầng | Áp dụng | Cách kiểm |
|---|---|---|
| **R — đọc** | GET danh sách/chi tiết | cache (account, tenant) TTL ≤60s |
| **M — ghi thường** | compose, draft, sửa nhóm kênh… | cache ≤60s + so `membership.version` |
| **S — nhạy cảm** | credential/token (connect, import, refresh, disconnect), đăng bài (batches, retry, cancel, reschedule), quản lý thành viên/invite, đổi nguồn dữ liệu, mọi platform op | **đọc DB tươi, không cache** |

- `membership.version` tăng khi revoke/đổi role → invalidate hoạt động **xuyên tiến trình** (web + worker), thứ mà `invalidateAll()` in-memory không làm được. Revoke có hiệu lực: tầng S ngay lập tức, tầng R/M ≤ TTL.

### 3.5 Platform admin: role, không phải boolean; support mode là session server-side

- `account.platform_role`: `'support'` được **vào tenant** (support mode) nhưng không được tạo/khoá tenant, không đụng platform_role của ai; `'super_admin'` được tất cả. Bootstrap từ `AUTH_BOOTSTRAP_ADMINS` lần đầu, sau đó quản trong DB.
- **Support mode** — không nhét vào JWT, không dùng cookie ngữ nghĩa:

```
POST /api/platform/tenant-sessions { tenantId, purpose }
  → hàng platform_access_session { id, account_id, tenant_id, purpose,
      expires_at (1h), revoked_at?, created_at }
  → cookie chỉ chứa opaque session id
  → audit `platform.entered_tenant` (kèm purpose) ngay lúc tạo
```

- Mỗi request: normal mode đi đường membership; support mode đi đường `platform_access_session` (kiểm hạn + revoke, đọc DB tươi — tầng S). Ràng buộc enforce ở server: trong support mode **không** tạo/sửa platform_role, **không** mở support mode lồng sang tenant khác, **không** tự gia hạn. UI hiện banner "đang hỗ trợ tenant X" + nút thoát.
- **Phân biệt API:** tenant-scoped business API không nhận `tenantId` từ client; **platform API được nhận target tenantId** (`/api/platform/tenants/:id/...`) sau `requirePlatformAdmin()` + validate + audit.

### 3.6 Invite — invariant

- **Single-use mặc định**: `max_uses` default 1, `used_count`; dùng xong/quá hạn/revoked → từ chối. Mỗi lần dùng ghi audit.
- Người đã có membership active bấm link → **no-op có thông báo**, không tạo bản ghi trùng (UNIQUE đã chặn tầng DB).
- **Chống escalation**: vai trò của invite do server đối chiếu với vai trò người tạo — owner mời tới owner; admin mời tới editor/viewer; editor/viewer không tạo được invite. Client không bao giờ quyết định role được chấp nhận.
- Token: random ≥128 bit, DB chỉ giữ `token_hash`.

### 3.7 Self-service — biên chống abuse

`tenant.created_by_account_id` + rate limit: mỗi account tối đa **3 tenant**, tối đa 1 tenant/giờ (hằng cấu hình được). `tenant.status='suspended'` chặn toàn bộ thành viên (tầng S thấy ngay). **`tenant.plan`** (`'internal'` | `'standard'`, mở rộng sau — quyết định PM 19/08, doc 10 §8.9): mọi giới hạn tiêu dùng (trần AI/ngày, quota) treo theo plan; tenant MYSP là `internal` không trần. Billing/thanh toán ngoài phạm vi nhưng invariant plan đặt từ M1.1.

### 3.8 State machine của actor

```
Anonymous ──login──▶ NoMembership ──create/join──▶ Member(1 tenant: auto-active)
                          │                              │ switch
                          ▼                              ▼
                    màn "Tạo hoặc tham gia"        Member(active tenant)
PlatformAdmin ──POST tenant-sessions──▶ SupportMode(tenant, ≤1h) ──exit/expire──▶ PlatformAdmin
```

Mọi màn UI và mọi route phải xác định mình phục vụ state nào; "đăng nhập rồi mà API 409" chỉ hợp lệ ở state NoMembership/chưa chọn.

## 4. Lộ trình — 3 phần *(estimate sửa sau review; M1.3 chốt lại sau M1.0)*

Ước lượng theo ngày dev thuần (flow agent team + gate). **Tổng ~15,5–16,5 ngày ≈ 3,5 tuần lịch** *(cập nhật sau M1.0 — phần test 87 file là cấu phần chi phối)*.

### Phần 1 — Hợp đồng + nền móng + vá B-8 *(≈ 8,5–9,5 ngày — cập nhật sau M1.0)*

- [x] **M0** Threat model + hợp đồng phân quyền → **`docs/10-hop-dong-phan-quyen.md`** — gate reviewer-qa PASS, PM duyệt 19/08/2026 (12 quyết định mục 8, điều chỉnh 8.9: trần theo gói, MYSP không trần) — *commit 2a06319* ✅
- [x] **M1.0** Inventory tenant propagation → **`docs/11-kiem-ke-tenant-propagation.md`** — 96 chữ ký port, 78 call site `forTenant`, 38 schema route, **87 file test/1.378 test case**; chốt M1.3 = 4 ngày tách đôi a/b — *19/08/2026* ✅
- [ ] **M1.1** Schema `account` + `identity` + `membership`(+version) + `app_user.account_id` (UNIQUE tenant+account) + `invite` (tạo trước, chưa dùng) + `tenant.slug/created_by/plan` + cột actor cho `ai_generation` + `audit_log.actor_kind` (doc 10 §5); migration + backfill từ `access_request`/`app_user` (integration test trên dump dev); seed cập nhật (tenant MYSP plan `internal`) — *1 ngày* —
- [ ] **M1.2** Phiên + `requireTenant()` trả branded `TenantId`, cookie active-tenant, cache 3 tầng + `membership.version`, `GET /api/me`, `POST /api/me/active-tenant` — *1 ngày* —
- [ ] **M1.3a** Brand `TenantId` xuống lõi, KHÔNG đổi hành vi: `tenant-scope.ts` → 51 DTO port → 43 input usecase → 78 call site; unbrand có tên ở 3 biên chuỗi thô (Redis key, FS path, HMAC); `systemTenantId()` + ESLint cấm `as TenantId`; **helper `testTenantId()` + codemod 87 file test ở commit đầu**; route tạm cast qua MỘT hàm `legacyTenantIdFromRequest()` — *1,75 ngày* (chi tiết docs/11 §3) —
- [ ] **M1.3b** Cắt dây từ client, đổi hành vi: gỡ 38 schema, `requireTenant()` vào 46 edge, xoá `legacyTenantIdFromRequest()`, OAuth state server-side + `proxy.ts` 302, bug B2–B6 doc 10, suspended-guard worker, ~10 route test nhóm rủi ro cao. **Quá độ: server bỏ qua `tenantId` client gửi (không lỗi) cho tới M1.4** — *2,25 ngày* —
- [ ] **M1.4** UI: gỡ `DEMO_TENANT_ID` khỏi 13 file, xoá 3 ô nhập UUID, services bỏ tham số tenantId (query key lấy từ `useActiveTenant()`), top bar tên công ty thật, màn NoMembership tạm — *1 ngày* —
- [ ] **M1.5** Gate + **negative test matrix** (mục 5) chạy thật trên dev với ≥2 account, ≥2 tenant, có account thuộc CẢ HAI tenant — *1 ngày* —

### Phần 2 — Onboarding tự phục vụ *(≈ 3,5 ngày)*

- [ ] **M2.1** Tạo công ty (state NoMembership → owner) + biên abuse 3.7 — *0,5 ngày* —
- [ ] **M2.2** Invite đủ invariant 3.6: sinh/thu hồi/hết hạn, trang `/join/<token>`, audit mỗi lần dùng — *1,5 ngày* —
- [ ] **M2.3** Bộ chuyển công ty + màn "Thành viên" (đổi vai trò, gỡ — gỡ bump version nên tầng S mất quyền ngay) — *1 ngày* —
- [ ] **M2.4** Nghỉ hưu luồng chờ-duyệt; `/access` thành read-only lịch sử; dọn ngữ nghĩa env — *0,5 ngày* —

### Phần 3 — Quản trị MYSP *(≈ 3,5 ngày)*

- [ ] **M3.1** `platform_role` (support/super_admin) + `requirePlatformAdmin(minRole)`; bootstrap từ env một lần rồi quản trong DB (đóng luôn nợ N9 — nút Chặn vô hiệu với bootstrap) — *1 ngày* —
- [ ] **M3.2** Màn quản trị nền tảng: danh sách/tạo/khoá tenant (chỉ super_admin) — *1 ngày* —
- [ ] **M3.3** Support mode bằng `platform_access_session` đúng mục 3.5 (opaque cookie, ràng buộc, banner, audit) — *1,5 ngày* —

### Nợ cũ tự khỏi ở đâu

27 route thiếu session check → M1.3 (`requireTenant` gọi session bên trong) · N9 bootstrap không chặn được → M3.1 · 3 bản sao `DEMO_TENANT_ID` + 6 bản `requireTenantId` phía UI → M1.4. Ngoài phạm vi: RLS (chỉ đánh giá), account-linking UI, billing, guard sụt giảm theo tỉ lệ cho sync (vé riêng của E2).

## 5. Gate của M1.5 — negative test matrix (bắt buộc, thay cho grep)

Với account A ∈ X, B ∈ Y, **C ∈ cả X và Y** (C active = X):

```
A GET  tài nguyên X                     → 200
A GET  tài nguyên Y                     → 404 (không phải 403 — không tiết lộ)
A POST body giả mạo tenant Y            → tenantId trong body bị BỎ QUA, ghi vào X
A PATCH/DELETE tài nguyên Y             → 404
A đổi active-tenant sang Y              → 404 TENANT_NOT_FOUND
C tạo dữ liệu khi active=X              → nằm ở X, KHÔNG rơi vào "membership đầu tiên"
C switch sang Y rồi GET                 → chỉ thấy dữ liệu Y
OAuth callback với state giả tenant Y   → từ chối
Signed media URL của X đem sang Y       → từ chối
Revoke C khỏi X → thao tác tầng S       → chặn NGAY; tầng R → chặn ≤60s
Support mode: sửa platform_role         → từ chối
Grep "tenantId từ request" = 0          → chỉ là điều kiện phụ, không phải bằng chứng
```

## 6. Rủi ro chính

| Rủi ro | Đối phó |
|---|---|
| Identity model sai → đập schema khi thêm linking/SSO | Đã tách account/identity từ đầu; không auto-link qua email |
| Backfill sai → người đang dùng bị văng | M1.1 test trên dump dev; giữ `access_request` nguyên để đối chiếu |
| Sót 1 trong 40 route | Branded `TenantId` chặn compile-time + matrix M1.5 chạy thật |
| Revoke trễ do cache | Tầng S không cache; version xuyên tiến trình; TTL chỉ còn ảnh hưởng tầng R/M |
| Support mode bị lạm dụng | Session server-side có hạn + purpose + audit; ràng buộc không-tự-nâng-quyền enforce ở server |
| JWT stateless (bẫy CLAUDE.md) | JWT chỉ mang danh tính; mọi quyền đọc từ DB |

## 7. Theo dõi tổng

| Phần | Milestone | Ước lượng | Trạng thái |
|---|---|---|---|
| 1 — Hợp đồng + nền móng | M0 → M1.5 | 8,5–9,5 ngày | 🟨 M0 ✅ · M1.0 ✅ (19/08) · kế tiếp M1.1 |
| 2 — Onboarding | M2.1 → M2.4 | 3,5 ngày | ⬜ chưa bắt đầu |
| 3 — Quản trị MYSP | M3.1 → M3.3 | 3,5 ngày | ⬜ chưa bắt đầu |

## 8. Lịch sử review

- 19/08/2026 — PM review bản đầu: 7 must-fix (identity model, platform role, support session, cache tầng, invariant app_user, threat model trước, negative tests) + 5 nên-sửa (invite invariant, abuse boundary, phân biệt platform API, state machine, estimate M1.3). Tất cả đã đưa vào bản này.
