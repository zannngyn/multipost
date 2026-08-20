# M1.0 — Kiểm kê tenant propagation

> Deliverable của M1.0 (doc 09 §4). HEAD `3bcc0ad`, đo bằng grep thật 19/08/2026. Là căn cứ estimate và checklist cho M1.3a/M1.3b.

## 1. Khối lượng chốt

| Hạng mục | Số đo | Ghi chú |
|---|---|---|
| `tenantId` toàn repo | 3.780 lần / 314 file (227 non-test + 87 test) | |
| Chữ ký method port | **96** method / 32 interface | 51 DTO field là đòn bẩy — sửa DTO thì method hưởng theo |
| Input type usecase | **43** type / 36 file (704 occurrence) | |
| Call site `forTenant()` | **78** / 17 file | Đổi 2 dòng `tenant-scope.ts:27,44` → compiler chỉ đúng 78 chỗ. **13 chỗ có `?? ""` phải dọn** |
| Schema zod route phải cắt `tenantId` | **38** / 37 file | 4 file dùng chung: `prompt-route.ts` (1 schema = 4 route), `read-upload-form.ts`, 2 × `oauth-state-cookie.ts` |
| Route chưa đọc session | **26/40** | |
| Route có test | **2/40** | Không có lưới an toàn tầng route |
| Worker | 2 job có tenant trong payload (`publish-post`, `healthcheck-tenant`) | Phần nhẹ nhất |
| **File test phải sửa** | **87 file / 1.271 literal / 1.378 `it()`** | **Chi phối tổng thời gian.** Nặng nhất: `publish-post.test.ts` 107 |
| UI service | **43/43 hàm** nhận tenantId, **8–10 bản guard trùng** | + 2 hàm `*ConnectHref` sinh URL OAuth từ client |
| UI component/hook | 20 component (92 occ) · 16/20 hook (12 có tenant trong query key) | |
| `DEMO_TENANT_ID` | 13 file UI + **2 file mới ngoài scope cũ**: `app/(app)/tenant-name.ts`, `app/_auth/auth.ts` | Hai file mới thuộc M1.2/M1.4 |

## 2. Ca đặc biệt (checklist đóng — mỗi chỗ phải xử lý tường minh)

**`tenantId` là chuỗi thô ở biên — brand sai vẫn chạy đúng, compiler không cứu:**
- Payload HMAC media: `core/domain/media-url.ts:118` (phần tử #2 chuỗi ký) — tầng P, giữ nguyên, unbrand có tên.
- Khoá Redis: `adapters/queue/redis-job-progress.ts:258-263` (`mysp:progress:{tenantId}:{postJobId}`).
- Segment đường dẫn file: `adapters/media/local-blob-store.ts:57,147-155` · `local-media-cache.ts:311,469-473`.
- Khoá Map cache: `adapters/google/tenant-google-auth.ts:93-105` · `adapters/ai/prompt-store/static-prompt-store.ts:23-24`.
- `PromptTemplate.tenantId: string | null` (`ports/ai.ts:229`) — built-in dùng chung → `TenantId | null`.

**Enqueue lấy tenant từ REQUEST (phải chuyển sang `requireTenant()` để lời hứa doc 10 §5 thành thật):**
- `create-post-batch.ts:408` và `reschedule-post-job.ts:156`. (4 chỗ enqueue còn lại đã lấy từ DB row.)

**Cookie OAuth state** (2 luồng, JSON không ký, mang tenantId): `catalog/google/_lib/oauth-state-cookie.ts:28,92-95` + `channels/_lib/oauth-state-cookie.ts:26,87-90` → thay bằng state server-side theo doc 10 §6. Đây là **mini-feature**, không phải "sửa route".

**Echo `tenantId` ra response body** (UI schema phải sửa theo): `catalog/source/route.ts:91,94,130` · `catalog/sync-status/route.ts:78` · `channels/import/route.ts:57` · `channels/refresh/route.ts:45`.

## 3. Quyết định từ inventory

1. **M1.3 tách đôi:**
   - **M1.3a — brand xuống lõi (~1,75 ngày, KHÔNG đổi hành vi):** `TenantId` + đổi `tenant-scope.ts` → 51 DTO → 43 input → 78 call site → unbrand có tên ở 3 biên chuỗi thô → `systemTenantId()` + ESLint → **helper `testTenantId()` + codemod 87 file test Ở COMMIT ĐẦU TIÊN**. Route tạm cast qua MỘT hàm `legacyTenantIdFromRequest()` (1 file, có TODO) — hàm này chính là danh sách việc còn lại của M1.3b, grep được. Xanh CI, merge ngay, không giữ nhánh dài.
   - **M1.3b — cắt dây từ client (~2,25 ngày, đổi hành vi):** gỡ 38 schema, cắm `requireTenant()` vào 46 edge, xoá `legacyTenantIdFromRequest()` (hết caller = xong), OAuth state server-side + `proxy.ts` 302, bug B2–B6 doc 10, suspended-guard worker, ~10 route test cho nhóm rủi ro cao nhất (batches, captions, uploads, 2 callback, source PUT).
2. **Giai đoạn quá độ:** trong M1.3b server **bỏ qua** `tenantId` client gửi lên (lấy từ session, không báo lỗi) để UI hạ cánh riêng ở M1.4 — tránh PR ~230 file non-test + 87 test không review nổi.
3. **ESLint cấm `as TenantId`** ngoài `*.test.ts` và 3 constructor hợp lệ (`requireTenant`, `systemTenantId`, lớp platform) — không có rule này thì lớp phòng thủ #2 bị rỗng ruột bởi cast rải rác.

## 4. Estimate chốt

M1.3 = **4 ngày** (1,75 + 2,25), thay khung treo 1–2,5 ngày. Phần 1 tổng: **8,5–9,5 ngày**. Toàn lộ trình: **15,5–16,5 ngày dev ≈ 3,5 tuần lịch**.

## 5. Ba rủi ro đầu bảng

1. **Bùng nổ test** — 1.378 `it()` fail compile cùng lúc nếu không có `testTenantId()` + codemod trước khi đổi `tenant-scope.ts`; cám dỗ `as TenantId` rải rác phá lớp phòng thủ.
2. **Sai lặng lẽ ở biên chuỗi thô** (mục 2) — runtime vẫn chạy dù brand sai; xử bằng checklist đóng + hàm unbrand có tên.
3. **Route không lưới + UI phải hạ cánh cùng lúc** — xử bằng quá độ server-bỏ-qua-tenantId + 10 route test viết ngay trong M1.3b.
