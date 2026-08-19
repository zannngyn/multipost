# Phân quyền đa tenant — thiết kế & lộ trình

> Trạng thái: **thiết kế đã duyệt, chưa bắt đầu code**. Cập nhật file này sau mỗi milestone: tích `[x]`, ghi ngày + commit vào cột ghi chú. Đọc kèm `docs/08` mục B-8 (nợ bảo mật gốc).

## 1. Vấn đề

- **40/40 route API** nhận `tenantId` từ client (query/body/cookie/form), không route nào đối chiếu với phiên đăng nhập → operator đã đăng nhập đổi UUID là đọc/ghi được dữ liệu tenant khác (nợ B-8, `docs/08:153`). Đã có Page access token thật nằm sau các route này.
- Phiên đăng nhập (`OperatorSession`) **không mang tenant nào**; 13 file UI đóng đinh `DEMO_TENANT_ID`, 3 màn bắt người dùng tự gõ UUID.
- Thêm người dùng phải whitelist email/Facebook ID vào env rồi restart container.

## 2. Quyết định đã chốt (19/08/2026, PM duyệt)

| # | Câu hỏi | Quyết định |
|---|---|---|
| Q1 | Một người thuộc mấy công ty? | **1 người ≤ N công ty** (kiểu Slack/Notion) |
| Q2 | Người mới vào công ty bằng gì? | **Link mời** có hạn, gắn sẵn vai trò; không whitelist env |
| Q3 | Admin MYSP được làm gì với dữ liệu tenant khách? | **Quản trị vỏ ngoài + "vào" tenant khi cần, mỗi lần vào ghi audit** |
| Q4 | Ai tạo được công ty? | **Ai đăng ký cũng tạo được** (self-service, tự thành owner) |
| Q5 | Server biết request thuộc tenant nào bằng gì? | **Phương án A**: cookie tenant-đang-chọn + đối chiếu membership qua DB mỗi request (cache 60s, theo mẫu `operator-access-gate`). Route không bao giờ nhận `tenantId` từ client. |

Hệ quả của Q4: luồng chờ-duyệt (`access_request`) hết vai trò với người thường — người lạ tự tạo công ty riêng hoặc vào bằng link mời. Whitelist env chỉ còn nghĩa "chỉ định admin MYSP".

## 3. Thiết kế cốt lõi

### 3.1 Schema mới

```
account          -- danh tính TOÀN CỤC, không có tenant_id (ngoại lệ thứ 2 sau bảng tenant)
  id, provider ('google'|'facebook'), provider_account_id,
  session_email (unique), email?, display_name?, is_platform_admin bool default false,
  status ('active'|'suspended'), timestamps
  UNIQUE (provider, provider_account_id)

membership       -- người ↔ công ty ↔ vai trò
  id, tenant_id FK, account_id FK, role user_role,
  status ('active'|'removed'), invited_by_account_id?, timestamps
  UNIQUE (tenant_id, account_id)

invite           -- link mời (Phần 2)
  id, tenant_id FK, token_hash unique, role, expires_at,
  created_by_account_id, used_by_account_id?, used_at?, revoked_at?, timestamps
```

- `app_user` giữ nguyên làm chủ thể audit/draft trong tenant; mỗi membership active đảm bảo có hàng `app_user` tương ứng (đồng bộ khi tạo/đổi role — giữ mọi FK hiện có nguyên vẹn).
- `access_request` giữ lại chỉ để đọc lịch sử, ngừng ghi ở Phần 2. Backfill: mỗi hàng `approved` → 1 `account` + 1 `membership` vào tenant demo.
- `tenant` thêm cột `slug` (unique, để sau này lên URL-based nếu muốn) + `created_by_account_id`.

### 3.2 Phân giải tenant mỗi request (phương án A)

```
Cookie `mysp_active_tenant` (httpOnly, SameSite=Lax) chỉ là "gợi ý"
  ↓
getOperatorSession() [Node] → account theo session_email
  ↓
requireTenant(session, cookie):
  membership(account, cookie.tenant) active?  → TenantContext { tenantId, role }
  không có cookie → tenant duy nhất của account, hoặc 409 TENANT_NOT_SELECTED
  không có membership → 403 TENANT_FORBIDDEN (không tiết lộ tenant tồn tại hay không)
  cache 60s theo (account, tenant); mọi thay đổi membership gọi invalidate
```

- **Route không nhận `tenantId` từ client nữa** — cả query, body, form, lẫn cookie OAuth state. Đổi công ty = `POST /api/me/active-tenant` (kiểm membership rồi set cookie).
- Middleware edge giữ nguyên vai trò "có cookie JWT hợp lệ" — không đọc DB (ràng buộc đã ghi ở `auth.config.ts:8-11`).
- Worker không đổi: đã lấy tenant từ hàng DB hoặc cố ý cross-tenant (khảo sát C11).
- Vai trò: giữ enum `owner/admin/editor/viewer` hiện có; `is_platform_admin` nằm ở `account`, tách khỏi vai trò trong tenant.

### 3.3 Nguyên tắc không đổi

Luật phụ thuộc một chiều (docs/07) · mọi bảng nghiệp vụ vẫn qua `forTenant()` · audit trong cùng transaction với thay đổi · fail closed khi DB lỗi · lỗi có mã, tiếng Việt cho người vận hành.

## 4. Lộ trình — 3 phần, 12 milestone

Ước lượng theo **ngày dev thuần** (flow agent team + gate reviewer-qa như hiện tại). Tổng ~9 ngày dev ≈ 2 tuần lịch có đệm review.

### Phần 1 — Nền móng + vá lỗ B-8 *(≈ 3,5 ngày — xong phần này là hết rò rỉ chéo tenant)*

- [ ] **M1.1** Schema `account` + `membership` + `tenant.slug`, migration + backfill từ `access_request`/`app_user`, cập nhật seed (`dev@localhost` có account + membership demo) — *0,5 ngày* —
- [ ] **M1.2** Phiên mang tenant: `getOperatorSession` phân giải account, cookie `mysp_active_tenant`, `requireTenant()` + cache 60s + invalidate, `POST /api/me/active-tenant`, `GET /api/me` (danh sách công ty của tôi) — *0,5 ngày* —
- [ ] **M1.3** Sửa **40 route**: bỏ nhận `tenantId` từ client, thay bằng `requireTenant()`; bỏ `tenantId` khỏi 2 cookie OAuth state; route media ký HMAC giữ nguyên cơ chế riêng — *1 ngày* —
- [ ] **M1.4** UI: gỡ `DEMO_TENANT_ID` khỏi 13 file, xoá 3 ô nhập "Mã đơn vị", services bỏ tham số `tenantId` (query key lấy tenant từ hook `useActiveTenant()`), top bar hiện tên công ty thật — *1 ngày* —
- [ ] **M1.5** Gate reviewer-qa + kiểm chứng e2e trên dev: 2 account ở 2 tenant không thấy dữ liệu của nhau (test xuyên tenant là test khoá của phần này) — *0,5 ngày* —

### Phần 2 — Onboarding tự phục vụ *(≈ 3 ngày — hết cảnh whitelist tay)*

- [ ] **M2.1** Tạo công ty: đăng nhập lần đầu không có membership → màn "Tạo công ty của bạn" (tên + slug), tự thành owner — *0,5 ngày* —
- [ ] **M2.2** Link mời: bảng `invite`, sinh/thu hồi/hết hạn (7 ngày), trang `/join/<token>`: đăng nhập Google/FB → thành membership đúng vai trò; token hash trong DB, audit mọi lần dùng — *1 ngày* —
- [ ] **M2.3** Bộ chuyển công ty trên top bar + màn "Thành viên" (danh sách, đổi vai trò, gỡ khỏi công ty — gỡ có hiệu lực ≤60s nhờ invalidate) — *1 ngày* —
- [ ] **M2.4** Nghỉ hưu luồng chờ-duyệt cho người thường: signin-gate cho mọi người đăng nhập (registry chỉ còn chặn `suspended`), màn `/access` chuyển thành read-only lịch sử, dọn ngữ nghĩa env (`AUTH_ALLOWED_DOMAINS` giữ làm bộ lọc tuỳ chọn) — *0,5 ngày* —

### Phần 3 — Quản trị MYSP *(≈ 2,5 ngày)*

- [ ] **M3.1** `account.is_platform_admin` + guard `requirePlatformAdmin()`; nguồn khởi tạo từ `AUTH_BOOTSTRAP_ADMINS` (env chỉ còn để bootstrap, sau đó quản trong DB) — *0,5 ngày* —
- [ ] **M3.2** Màn quản trị nền tảng: danh sách tenant (tên, số thành viên, trạng thái), tạo/khoá (`suspended` chặn toàn bộ thành viên tenant đó ≤60s) — *1 ngày* —
- [ ] **M3.3** "Vào tenant" có audit: platform admin chọn tenant → nhận TenantContext tạm (vai trò admin, TTL 1 giờ), **mỗi lần vào ghi `audit_log` (`platform.entered_tenant`)**, banner trên UI báo đang ở chế độ hỗ trợ — *1 ngày* —

### Việc treo có chủ ý (không nằm trong 3 phần)

- 27 route thiếu `getOperatorSession` → **tự khỏi ở M1.3**: `requireTenant()` gọi session bên trong, route nào cũng phải đi qua.
- Nút "Chặn" vô hiệu với bootstrap admin (N9) → tự khỏi ở M3.1 khi bootstrap chuyển vào DB.
- Guard sụt giảm theo tỉ lệ cho sync (R1/R2 của gate Drive) · rate-limit invite · billing — vé riêng, ngoài phạm vi.

## 5. Rủi ro chính

| Rủi ro | Đối phó |
|---|---|
| Backfill sai → người đang dùng bị văng | M1.1 có integration test trên bản dump dev; giữ `access_request` nguyên để đối chiếu |
| 40 route sửa hàng loạt, sót 1 route là còn lỗ | M1.5 gate bắt buộc grep "tenantId từ request" = 0 kết quả + test xuyên tenant |
| JWT stateless (bẫy đã ghi CLAUDE.md) | Không nhét tenant/role vào JWT; mọi quyền đọc lại từ DB qua cache 60s |
| Cookie tenant bị giả | Cookie chỉ là gợi ý — không có membership thật thì 403; không tin cookie |
| Đổi định danh giữa chừng (email ↔ fb-*@facebook.local) | `account` giữ nguyên quy tắc session_email hiện có, không đổi thêm lần nữa |

## 6. Theo dõi tổng

| Phần | Milestone | Ước lượng | Trạng thái |
|---|---|---|---|
| 1 — Nền móng | M1.1 → M1.5 | 3,5 ngày | ⬜ chưa bắt đầu |
| 2 — Onboarding | M2.1 → M2.4 | 3 ngày | ⬜ chưa bắt đầu |
| 3 — Quản trị MYSP | M3.1 → M3.3 | 2,5 ngày | ⬜ chưa bắt đầu |
