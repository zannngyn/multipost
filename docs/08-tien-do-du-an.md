# Tiến độ dự án

> Cập nhật lần cuối: **22/08/2026** · Nhánh đối chiếu: `dev` tại `73b74a4` (PR #34)
>
> Bản 22/08 gộp thêm **PR #34** `73b74a4` — **redesign UI wave 1 "Sổ mẫu vải"**
> (29 commit, +7.309/−1.668, **0 dòng** trong `hooks/services/schemas/api/core/adapters/worker`):
> theme token mới + theme Astryx `mysp` · IA mới (nav 5+1 nhóm/10 mục; gộp
> `/scheduled`+`/jobs`→`/posts`, `/channels/groups`→`/channels`, `/access`→`/members`,
> route cũ thành redirect giữ query) · màn Tổng quan mới · `/compose` bố cục lại ·
> DESIGN.md ghi lại từ code thật. Chi tiết ở dòng E10 và mục 5.
>
> Bản 21/08 gộp thêm **2 merge**: PR #20 `91f66ae` (`/compose` bám sát mẫu PM —
> trang đơn, modal chọn kênh/nhóm, tone caption, ảnh preview; sweep read-only chế
> độ hỗ trợ; che token/sig ở log Caddy edge) · PR #22 `58aa907` (**caption riêng
> từng kênh** — chi tiết ở dòng E10).
>
> Bản 20/08 (`42b8b9b`) gộp 4 merge trước đó: PR #16 `6f9d757` (Drive OAuth +
> access approval + nền đa tenant M0–M1.2) · PR #17 `4a2aec4` (M1.3–M1.5 — **B-8
> đóng**) · PR #18 `8b94a3a` (onboarding tự phục vụ M2.1–M2.4) · PR #19 `42b8b9b`
> (platform M3.1–M3.3 + redesign `/compose` đợt đầu).
>
> File này ghi **hiện trạng đã kiểm chứng được từ repo**, đối chiếu với WBS ở
> `03-WBS-va-estimate.md`. Mọi dòng đều phải kèm bằng chứng (đường dẫn file,
> route, bảng DB). Không ghi cảm tính, không ghi "sắp xong".

## 1. Cách đọc bảng

| Ký hiệu | Nghĩa |
|---|---|
| ✅ Có code | Artifact tồn tại trong repo, unit test liên quan xanh |
| 🟡 Một phần | Có artifact nhưng thiếu hạng mục con ghi trong WBS |
| ⬜ Chưa | Không tìm thấy artifact nào |
| ❓ Không kiểm được | Nằm ngoài repo (tài khoản nền tảng, hồ sơ duyệt) — phải hỏi người vận hành |

**Cảnh báo quan trọng:** ✅ ở đây nghĩa là *code có mặt và unit test xanh*, **không**
có nghĩa là đã chạy đúng trên dữ liệu thật. Toàn bộ epic E12 (kiểm thử & nghiệm
thu) chưa làm, và UAT với Facebook thật chưa diễn ra (mục 6). Không dùng bảng này
để báo "đã bàn giao được".

## 2. Cơ sở đối chiếu

Số liệu **đo lại 22/08/2026** trên `dev` (`73b74a4`, sau merge PR #34), kèm lệnh đo:

- `pnpm typecheck` · `pnpm lint` — sạch (exit 0)
- `pnpm depcruise` — `no dependency violations found (604 modules, 2672 dependencies cruised)`
- `pnpm exec vitest run` — **3570 test xanh / 125 skip** (3695 tổng, đo 22/08 tại `73b74a4` bởi gate PR #34) · **210 file pass / 14 file skip** trên 224 file. File skip là integration test cần DB/key thật
- `pnpm build` — exit 0, artifact thật có (`.next/BUILD_ID` sinh lúc build; direction contract `e06531fb` xuất hiện trong output build — kiểm bằng grep)
- Phân bố file test theo tầng (`find src -name '*.test.ts' -o -name '*.test.tsx'` gom theo thư mục cấp 1): core 61 · adapters 49 · app 42 · ui 56 · composition 9 · worker 5 · shared 2 = 224
- **54 API route** (`find src/app/api -name route.ts | wc -l`)
- **17 màn** (`find src/app -name page.tsx`): **15 dưới `app/(app)/`** (thêm `/posts`; 4 trang cũ `/scheduled` `/jobs` `/channels/groups` `/access` nay là redirect thuần vẫn tính là page) + `/join/[token]` và `/signin` ngoài app shell
- **22 bảng DB** (`grep -h "= pgTable(" src/adapters/db/schema/*.ts | wc -l` — đếm biểu thức khai bảng, không dính dòng import như cách đếm cũ; mỗi file schema đúng 1 bảng)
- **17 migration** (`ls drizzle/*.sql | wc -l`, mới nhất `0016_elite_landau.sql`)
- **8 service Docker** (đếm key dưới `services:` của `docker-compose.yml`: postgres · redis · migrate · web · web-demo · worker · pg-backup · caddy). Bản trước ghi 11 — chạy lại cùng phép đếm trên chính commit cũ (`git show f5afc2b:docker-compose.yml`) cũng chỉ ra 8: con số 11 là đếm sai, không phải compose đổi
- **197 commit** (`git rev-list --count origin/dev`)

## 3. Bảng tiến độ theo epic

### Phase 1 — MVP Facebook

| Epic | Trạng thái | Bằng chứng |
|---|---|---|
| E0 Khởi động & quyền truy cập | 🟡 | E0.5 service account còn nguyên (`adapters/google/service-account.ts`) nhưng project Google của nó vẫn chưa bật Sheets/Drive API (B-1). Từ PR #16 có **đường thay thế**: tenant tự kết nối Google trong app (xem E2). E0.1/E0.2 (duyệt app Facebook) ❓ không kiểm được từ repo |
| E1 Nền tảng | ✅ | `docker-compose.yml` (8 service), 22 bảng ở `adapters/db/schema/`, 17 migration, `worker/index.ts` + BullMQ, `adapters/logging/pino-logger.ts`, `core/domain/errors`. **Mới từ M1.x:** hệ auth/identity — bảng `account`/`identity`/`membership`/`invite` (migration `0013`), `oauth_state` (`0014`), `platform_access_session` + audit platform (`0015`–`0016`); phiên mang tenant qua `requireTenant()`/`requireTenantContext` với branded `TenantId` (chi tiết `docs/09`) |
| E2 Drive & Sheet | ✅ | `adapters/google/{drive-source,sheet-source,sheet-values}.google.ts`, usecase `sync-catalog.ts` + `get-sync-status.ts`, bảng `sync_run`/`media_asset`, màn `/sync`. **Mới (PR #16): Drive OAuth per-tenant** — kết nối Google ngay trong app: usecase `connect-google-drive.ts` + `browse-google-drive.ts` + `check-google-source-access.ts`, adapter `adapters/google/{google-oauth,tenant-google-auth,drive-browser.google}.ts`, repo `google-oauth-repo.drizzle.ts`, 7 route `/api/catalog/google/*` (connect · callback · connection · status · folders · spreadsheets · spreadsheets/tabs). **Lưới chống mất dữ liệu:** grant bị thu hồi được biến thành `GOOGLE_AUTH_EXPIRED` *trước khi* listing chạy — không để "Drive trả rỗng vì token chết" bị sync đọc thành "mọi file đã bị xoá" (header `tenant-google-auth.ts` ghi rõ). Tenant không bấm kết nối thì rơi về service account như cũ |
| E3 Tồn kho, chọn màu, chọn ảnh | ✅ | usecase `compose-post.ts`, bảng `product`, màn `/products`, test tầng core |
| E4 AI sinh caption | ✅ | `adapters/ai/{google,openai,registry-store,prompt-store,generation-log,cache}`, usecase `generate-captions.ts`, bảng `ai_generation` + `ai_prompt_template` + `ai_model_policy_override`, màn `/prompts`. Chạy OpenAI-only từ 15/08/2026 (B-5) |
| E5 Adapter Facebook | 🟡 | Đăng bài ✅ `adapters/meta/{graph-client,facebook-publisher,graph-error-map,fake-publisher}.ts`. E5.1 kết nối kênh: xem mục 3.2 — code xong cả hai cửa (dán token / OAuth), `META_APP_SECRET` + `TENANT_SECRETS_ENC_KEY` nay đã có trong `.env` (đo 20/08 — B-6/B-7 đã gỡ), **còn thiếu duy nhất lần chạy với Page thật = UAT** |
| E7 Điều phối đa kênh | ✅ | usecase `publish-post.ts` + `retry-post-job.ts` + `reap-post-jobs.ts`, bảng `post_job`/`post_batch`/`channel_group`, `worker/jobs/publish-post-job.ts`, màn `/channels/groups`. Từ M1.3b worker có suspended-guard (tenant bị khoá thì job không chạy) |
| E10 Giao diện (lõi) | ✅ | **15 màn dưới `app/(app)/`** (từ PR #34 thêm **`/posts`**; 4 màn `/scheduled` `/jobs` `/channels/groups` `/access` nay là redirect thuần): `/`, `/compose`, `/bulk`, `/posts`, `/scheduled`, `/jobs`, `/products`, `/sync`, `/channels`, `/channels/groups`, `/prompts`, `/batches/[batchId]`, **`/members`** (thành viên + link mời, M2.3), **`/access`** (nay là *Lịch sử duyệt* read-only, M2.4), **`/platform`** (quản trị MYSP, M3.2); ngoài shell: **`/join/[token]`** (nhận lời mời, M2.2) + `/signin`. **`/compose` redesign trung thành mẫu PM** (PR #19 đợt đầu; PR #20 bám sát mẫu: trang đơn `ComposeFocus.tsx`, modal chọn kênh/nhóm `ChannelPickerDialog.tsx`, tone caption `shared/caption-tone.ts`). **Caption riêng từng kênh** (PR #22 `58aa907`): chọn kênh TRƯỚC khối caption, công tắc "dùng riêng" là dòng đầu, một nút "Viết caption cho N trang" fan-out concurrency 3 + retry từng tab (`caption-fanout.ts`, `useCaptionFanOut.ts`), cảnh báo trùng D1 sớm trên trình duyệt (`caption-duplicate.ts` mirror `core/domain/caption.ts`, test vi phân mirror-vs-core chống drift thuật toán); editor/preview/payload cùng đọc qua một luật `caption-targets.ts` (đóng lỗ B1 editor hiện caption chung nhưng payload gửi caption riêng). **Ảnh hiện ra nơi soạn bài**: route session-backed `/api/media/preview/[driveFileId]` + usecase `get-media-preview.ts`, component `MediaThumb`/`FacebookPreview` — tầng media ký HMAC (tầng P) không mất một dòng verify nào, tái chứng minh bằng 3 ca giả mạo của M1.5. UI hết biết tenant từ M1.4: `DEMO_TENANT_ID` = 0 chỗ, query key theo `useActiveTenant()`, `TenantBoundary` + `TenantSwitcher`. **Redesign wave 1 "Sổ mẫu vải" (PR #34 `73b74a4`, 22/08):** theme token mới (`globals.css` + theme Astryx `mysp` ở `src/ui/theme/`) · nav 5+1 nhóm/10 mục (`nav-items.ts`) · 3 hub gộp `/posts` (tab Đã hẹn/Nhật ký) · `/channels` (3 tab, tên Page thay id trong nhóm) · `/members` (3 tab, `/access` thành tab Lịch sử duyệt) — 4 route cũ redirect giữ query (`posts/legacy-routes.ts` + test) · màn Tổng quan mới (`overview/OverviewScreen.tsx`: số liệu bấm được không bịa số, việc cần chú ý, chồng thẻ lô đang chạy, health-check sau disclosure) · `/compose` sticky action bar + rail bước + nhóm kênh trong dialog, xoá `compose-theme.ts` · sửa gốc lỗi mọi `<a>` mang attribute `to` không chuẩn (`shell/AppLink` + test 2 chiều) · DESIGN.md ghi lại từ code thật ("Sổ mẫu vải", ramp có 13/11/10px hợp thức). Qua 8 gate `reviewer-qa` + finish-review Impeccable (verdict ship) + final review toàn nhánh PASS. **Onboarding đổi bản chất (nhánh `feat/e10-onboarding-buffer`, 26/08):** wizard thiết lập 6 bước bị thay bằng **khảo sát hồ sơ kiểu Buffer** — 1 màn chào + 4 câu hỏi (`welcome/seller/tools/count/channels`), bước nằm trên URL `?step=`, mỗi bước lưu ngay, "Bỏ qua" ghi `null`. Chi tiết ở mục 3.3. |
| E12 Kiểm thử (rút gọn) | 🟡 | 3570 test xanh (`vitest run`, xem mục 2); 15 file integration (`find src -name '*.integration.test.ts'` — DB write path, AI gateway); 10 smoke script ở `scripts/`; negative matrix đa tenant 12/12 chạy thật qua HTTP (M1.5, docs/09 §5). **E12.3 chạy thật đầu-cuối với Facebook thật và E12.4 UAT: chưa làm** |

### Hệ đa tenant & phân quyền (ngoài WBS gốc — track riêng)

**✅ HOÀN TẤT 20/08/2026 — 15/15 milestone.** Chi tiết từng milestone (commit, ngày,
vé mang theo) ở **`docs/09-phan-quyen-da-tenant.md`**; hợp đồng phân quyền ở
`docs/10-hop-dong-phan-quyen.md`; kiểm kê propagation ở `docs/11-kiem-ke-tenant-propagation.md`.
Tóm tắt để đối chiếu:

| Phần | Nội dung | Bằng chứng chốt |
|---|---|---|
| 1 — Nền móng + vá B-8 (M0–M1.5) | Schema account/identity/membership, phiên mang tenant, branded `TenantId` xuống lõi, 36 route lấy tenant từ phiên, OAuth state server-side | B-8 đóng tại `b3df9bd` (M1.3b); negative matrix **12/12 chạy thật qua HTTP** trên dev (M1.5, 20/08) |
| 2 — Onboarding (M2.1–M2.4) | Tự tạo công ty (biên abuse 3+1/giờ), invite token 256-bit chỉ giữ hash, màn `/members`, nghỉ hưu luồng chờ-duyệt | commit `d52bfa1` + `6a93ace`; **hết whitelist env** |
| 3 — Quản trị MYSP (M3.1–M3.3) | `requirePlatformAdmin` đọc tươi, màn `/platform`, support mode server-side 1h có purpose + audit đủ cặp dưới sổ tenant đích, chỉ-đọc tier R | commit `66af1a5` + `8efc341`; N9 đóng (suspend chặn cả bootstrap admin) |

Vé còn mở đáng chú ý nhất ghi ở docs/09 §7: **Caddy access log ở edge vẫn ghi
`/join/<token>`** — phải xử trước khi phát link mời cho khách ngoài (mục 6).

### Phase 2 — TikTok + video + hẹn lịch

| Epic | Trạng thái | Bằng chứng |
|---|---|---|
| E6 Adapter TikTok | ✅ | `adapters/tiktok/{tiktok-client,tiktok-publisher,tiktok-error-map,fake-tiktok-publisher}.ts` (commit `3acbced`, Direct Post) |
| E5 phần video | ✅ | `core/ports/media-probe.ts`, `adapters/media/`, `ui/components/compose/VideoSpecCard.tsx` (commit `88da4fa`, gate thông số 2 lớp) |
| E8 Hẹn lịch | ✅ | usecase `list-scheduled-jobs.ts` · `reschedule-post-job.ts` · `cancel-scheduled-job.ts`, màn `/scheduled`, 3 route `/api/posts/scheduled/*` (commit `43a01b1`) |
| E10.5 Chạy hàng loạt | ✅ | màn `/bulk` (commit `8b3421b`) |
| E0.3 / E0.4 TikTok audit + tên miền | ❓ | Ngoài repo — phải hỏi người vận hành |

### Phase 3 — Hoàn thiện

| Epic | Trạng thái | Bằng chứng |
|---|---|---|
| E9 Chế độ B: tự tải file lên | ✅ **Code xong, chưa UAT** | Xem mục 3.1 bên dưới |
| E11 Vận hành & giám sát | 🟡 | E11.1 có màn `/jobs` + `/api/posts/jobs/[postJobId]/retry`; E11.3 có `worker/reaper-schedule.ts`. **E11.2 kênh cảnh báo và E11.4 sao lưu + thử khôi phục: chưa có** |
| E10 phần còn lại | 🟡 | Track redesign Astryx (mục 5) chưa phủ hết các màn cũ. **Nợ mới (mục 3.3):** task 11B — bảng `/platform` chưa hiện cột khảo sát và dải tổng hợp; và lỗi cấp công ty tự động không đi tiếp vào `/onboarding` ở lần mount đầu |
| E12 đầy đủ | ⬜ | Xem dòng E12 ở Phase 1 |
| E13 Bàn giao | ⬜ | Có `Dockerfile` + `docker-compose.yml`; chưa có tài liệu vận hành, chưa triển khai production, chưa đào tạo |

### 3.1 E9 — chi tiết

Nhánh `worktree-e9-upload`. `pnpm verify` exit 0 (typecheck · lint · depcruise · test · build).

| Mục | Trạng thái | Bằng chứng |
|---|---|---|
| E9.1 Kéo-thả tải lên, lưu tạm, kiểm kiểu + dung lượng | ✅ | usecase `upload-media.ts`, route `POST /api/posts/uploads`, parse ở `app/api/_lib/read-upload-form.ts`, port `core/ports/media-blob-store.ts`, adapter `adapters/media/local-blob-store.ts` |
| E9.2 Sắp xếp lại thứ tự, chỉ định ảnh bìa | ✅ | `ui/components/compose/UploadPanel.tsx` + `upload-queue.ts`. Thả file từ máy vào vùng drop; kéo từng dòng để đổi thứ tự bằng `dnd-kit`; kèm đường bàn phím (`KeyboardSensor` + nút ↑ ↓ / Đặt làm bìa) |
| E9.3 Dùng chung tồn kho / AI / đăng bài | ✅ | `compose-post.ts` thêm bộ lọc `source`; `get-media-content.ts` định tuyến theo `origin` nên file tải lên đi qua đúng cầu media ký HMAC mà Facebook dùng |
| E9.4 Dọn file tạm | ✅ | usecase `cleanup-uploads.ts`, job `worker/jobs/cleanup-uploads-job.ts`, chạy mỗi giờ, xoá byte trước rồi mới xoá row |

**Đã chạy thật đầu-cuối** (dev server + Postgres thật + file thật trên đĩa), 12/12 kiểm tra qua:

- upload 3 ảnh → 3 row `origin='upload'`, `sequence` 1/2/3 đúng thứ tự đã sắp, byte có thật trên đĩa quyền `0600`
- PDF đổi tên `.jpg` khai `image/jpeg` → **bị từ chối theo tên file**, ảnh thật cùng lô vẫn được giữ
- lô toàn file hỏng → 400, không phải 200 im lặng · trộn ảnh + video → 400 · thứ tự gửi lên hỏng → 400 · không có file → 400
- compose chế độ B trên mã hết hàng → chặn `OUT_OF_STOCK` **trước khi** đụng tới media (rule nghiệp vụ 1 vẫn đúng ở chế độ B)
- cầu media phục vụ đúng byte đã tải lên, `content-type: image/jpeg`; chữ ký giả → 401, link hết hạn → 401, tenant khác → 404

**Quyết định kiến trúc đã chốt trong lúc làm** (đều nằm sau port, đổi lại rẻ):

1. Lưu ở đĩa local qua volume Docker (`uploaddata`), sau port `MediaBlobStore`. Chuyển S3/R2 chỉ cần viết adapter mới.
2. Giữ tên cột `drive_file_id` làm định danh asset, thêm `origin` + `storage_key`. Đổi tên cột sẽ đụng 66 chỗ ở 20 file, nằm ngoài phạm vi E9.
3. Upload lần hai cho cùng một mã **thay thế** lần trước (chỉ những file chưa có post nào tham chiếu), vì `sequence` đánh lại từ 1 mỗi lần gọi.

### 3.2 E5.1 — chi tiết (kết nối Fanpage)

Merge `f5afc2b` (gồm `312e3bf` + `fb35047`). Trước đó **không có đường ghi kênh nào**:
`tenant_integration` provider `meta` luôn rỗng, nên màn Nhóm kênh từ chối mọi mã kênh
người dùng gõ vào — đó là triệu chứng đã dẫn tới việc này.

**Cập nhật 20/08:** `.env` nay đã có `TENANT_SECRETS_ENC_KEY` lẫn `META_APP_SECRET`
(B-6/B-7 gỡ — mục 4), và luồng OAuth state đã chuyển sang server-side (bảng
`oauth_state`, M1.3b) rồi bị thử giả qua HTTP trong matrix M1.5 (`STATE_MISMATCH`).
Còn lại đúng một việc: **kết nối Page với Facebook thật** — thuộc UAT, mốc 26/09 (mục 6).

| Mục | Trạng thái | Bằng chứng |
|---|---|---|
| Nhập Page bằng User Access Token | ✅ code xong, **chưa chạy với token thật** | `POST /api/channels/import` + `/refresh`, usecase `connect-facebook-channels.ts`, adapter `adapters/meta/facebook-oauth.ts` |
| Đăng nhập bằng Facebook (OAuth) | ✅ code xong, secret đã có, **chưa chạy với Facebook thật** | `/api/channels/connect` + `/callback`; state chống CSRF nay server-side ở bảng `oauth_state` (M1.3b thay cookie cũ) |
| Đổi sang token dài hạn 60 ngày | ✅ code xong, chưa chạy | `fb_exchange_token` trong `facebook-oauth.ts` |
| Quản lý nhiều Page | ✅ | `GET /api/channels`, `PUT`/`DELETE /api/channels/[channelId]`, màn `/channels`, phân trang hết `paging.next` của `/me/accounts` |
| Ghi kênh vào `tenant_integration` | ✅ **đã chạy thật** | `channel-config-repo.drizzle.ts` — đường ghi mới, có transaction + advisory lock |

**Đã chạy thật trên trình duyệt + Postgres thật** (dev server, dữ liệu Page giả, đã xoá sau khi xong):

- tạo nhóm kênh đầu-cuối → ghi đúng vào bảng `channel_group` — **đúng cái lỗi ban đầu đã hết**
- bật/tắt kênh → ghi thành công; token plaintext cũ tự được seal lại thành `enc:v1:…`,
  `tokenExpiresAt` giữ dạng trần, `spacingMs`/`maxAttempts`/`retryBackoffMs` không mất
- nhóm chứa kênh đã tắt → từ chối đúng câu *"Nhóm kênh chứa kênh đang tắt… Hãy bật kênh
  hoặc bỏ khỏi nhóm"*, **không** nói "không tồn tại"
- thiếu `TENANT_SECRETS_ENC_KEY` → banner cảnh báo hiện **trước** khi người dùng gõ gì,
  ô token + 4 nút + link Facebook đều khoá kèm lý do đọc được
- `POST /api/channels/import` với token giả → gọi Graph thật, nhận OAuthException 190,
  trả `TOKEN_EXPIRED` kèm câu tiếng Việt; không token nào lọt vào log

**Hai bug đã có sẵn trong repo, phát hiện khi review E5.1 và sửa luôn:**

1. `saveCatalogSource` (hàng `google`) mất dữ liệu khi hai người lưu cùng lúc — `SELECT … FOR UPDATE`
   không khoá được gì khi hàng chưa tồn tại. Đã vá bằng `pg_advisory_xact_lock` qua helper chung
   `adapters/db/integration-lock.ts`; đường ghi kênh mới cũng dính đúng lỗi này và vá cùng cách.
   **Cả hai đều có test integration FAIL nếu gỡ lock ra** — đã kiểm chứng bằng mutation test.
2. `postAbsolute` nhận URL thẳng từ câu trả lời của Graph (`upload_url`) trong khi request mang
   Page token ở header → câu trả lời chọn được nơi nhận token. Đã allowlist host `rupload.facebook.com`
   (so `hostname`, không so chuỗi con) và tắt `body_preview` cho đường này.

**Quyết định kiến trúc đã chốt trong lúc làm:**

1. Cả hai cửa (dán token / OAuth) chụm về **một** lõi `importChannels` — không nhân đôi logic nhập Page.
2. `channelId` sinh theo `fb-<pageId>`, ổn định và không trùng. Page ID thật nằm ở `externalId`.
3. Callback lưu **tất cả** Page về DB thay vì giữ token trong store tạm — nhờ vậy Page token
   không phải đi qua URL hay Redis. Page mới lưu `status: "active"`, Page đã có giữ nguyên status.
   *(M1.4 đã vá lỗ liên quan: đăng nhập bằng Facebook không còn auto-import Page vào tenant demo.)*
4. Giá trị đã seal mở theo **prefix `enc:v1:`**, không theo tên field; chiều seal vẫn theo tên.
   Bất đối xứng có chủ đích: giá trị ghi bằng luật đặt tên hôm qua phải mở được hôm nay.

### 3.3 E10 — Onboarding: từ wizard thiết lập sang khảo sát hồ sơ

Nhánh `feat/e10-onboarding-buffer` (task 1–10). **Đổi bản chất, không phải đổi giao diện.**

| Trước | Sau |
|---|---|
| `/onboarding` là wizard **thiết lập**: tạo công ty → nối Google → chọn nguồn → nối Facebook → nhóm kênh → mời người | `/onboarding` là **khảo sát hồ sơ**: 1 màn chào + 4 câu (nghề, công cụ đang dùng, số trang đang quản, kênh quan tâm) |
| Người dùng phải tự tạo công ty ở slide đầu | Công ty được **cấp tự động** ở lần đầu vào app (`POST /api/tenants/ensure-default` → `"Công ty của tôi"`), màn "tạo công ty" không còn xuất hiện |
| Việc nối nguồn sống trong wizard | **Việc nối nguồn quay về `SetupDock` và các route thật** — `/sync` (Google + chọn nguồn), `/data-mapping` (ánh xạ cột), `/channels` (Facebook), `/channels/groups` (nhóm), `/compose` (bài đầu) |

Chốt lại những gì đã dựng:

- Bảng **`tenant_profile`** (`tenant_id` PK, 4 cột đáp án + `completed_at`). `null` ≠ `[]`:
  `null` = chưa hỏi / đã bỏ qua, `[]` = đã trả lời "không chọn gì". Mã lưu là mã ổn định
  (`solo_seller`, `smm_tool`…), không lưu chữ tiếng Việt.
- API `GET/PATCH /api/tenants/onboarding-profile` + `POST …/complete`, chỉ `owner`/`admin`;
  bốn danh sách hằng mirror giữa `core/usecases/onboarding-profile.ts` và
  `ui/schemas/onboarding-profile.schema.ts`, khoá chống lệch bằng test của route.
- `FirstRunGate` chỉ hỏi **một** thứ để quyết định hỏi lại hay không: `completed_at`.
- Migration `0024` **backfill** mọi tenant đang tồn tại là đã xong → chỉ tenant MỚI thấy khảo sát.
- Superadmin đọc được số liệu khảo sát ở `/platform` (task 11A: `listTenants` LEFT JOIN
  `tenant_profile` + `core/domain/onboarding-survey-summary.ts`).

**Còn nợ và lỗi đã đo (task 10, đi bộ trên dev server thật):**

- **Task 11B chưa làm** — phần bảng: cột khảo sát + dải tổng hợp trên `PlatformTenantTable`.
  Dữ liệu và phép đếm đã có ở tầng dưới; màn `/platform` chưa hiển thị chúng.
- **Lỗi nhánh cấp công ty tự động (chưa sửa, ngoài phạm vi task 10).** Đo 26/08 với 7 tài
  khoản đăng ký mới: `POST /api/tenants/ensure-default` trả **201 + `set-cookie` +
  `wasCreated: true`** và tạo đúng `"Công ty của tôi"`, nhưng **lần mount đó không đi tiếp
  vào `/onboarding`** — người dùng đứng lại ở `/`. Nguyên nhân đo được:
  `useAdoptActiveTenant()` gọi `queryClient.removeQueries()` rồi `fetchQuery`, các observer
  `useMe` đang mounted không nhận query mới nên vẫn báo `tenants: []`;
  `GET /api/tenants/onboarding-profile` **không hề được gửi**, quyết định của gate kẹt ở
  `wait`. Lần vào sau (đăng nhập lại / tải lại trang) thì vào khảo sát bình thường.
  Sửa được là sửa ở `useAdoptActiveTenant` — dùng chung cho đổi công ty, tạo công ty và
  nhận lời mời — nên cần một việc riêng, không vá trong nhánh này.
- **Cơ chế `oauth-return-cookie` nay là code chết**: không màn nào truyền `?return=onboarding`
  nữa, và `resolveReturnScreen` vẫn trỏ về `?step=data` / `?step=facebook` — hai id bước
  KHÔNG còn tồn tại sau khi máy trạng thái được viết lại. Hai callback thật vẫn quay đúng
  `/sync` và `/channels?tab=pages` (đã đi bộ), nên chưa ai gặp; nhưng nhánh chết này phải
  gỡ hoặc trỏ lại trước khi có người bật lại nó.


## 4. Đang bị chặn / sổ nợ

File này là sổ sử: hàng đã xử **giữ nguyên trong bảng** với trạng thái gạch, không xoá.

| # | Vấn đề | Ảnh hưởng | Cách gỡ / đã gỡ thế nào |
|---|---|---|---|
| B-1 | **Google Sheets API chưa bật** ở project `54146412168` (`mysp-multipost-505408`) của service account | Trước đây chặn cứng đường chạy thật. **Từ PR #16 chỉ còn chặn đường service-account**: tenant kết nối Google account của chính mình qua Drive OAuth trong app (`/api/catalog/google/connect`, `tenant-google-auth.ts`) thì không đi qua project này nữa | Hoặc bật Sheets + Drive API cho project SA (tenant nào không muốn bấm kết nối vẫn cần), hoặc chấp nhận mọi tenant đều connect OAuth. UAT (mục 6) sẽ đi đường OAuth |
| B-2 | Container `mysp-postgres` chạy ở host port **5433** (tạo tay bằng `docker run`), nhưng service `postgres` trong `docker-compose.yml` **không publish port nào ra host** (đo 20/08: các key `ports:` trong compose chỉ thuộc `web`/`web-demo`/`caddy`) | `docker compose up` sạch sẽ không dựng lại được môi trường dev đang chạy; `.env` phải sửa tay | Thêm `ports: ["5433:5432"]` vào service `postgres`, cập nhật `.env.example` cho khớp |
| B-3 | 9 câu quyết định nghiệp vụ còn treo (C1, C2, C5, C3, C4, D1, D2, E1, E3 — xem `CLAUDE.md`) | Code vẫn dùng giá trị tạm — marker `// PENDING(<mã câu>)` còn trong `src/` (grep 20/08 vẫn ra ≥10 file) | PM chốt với shop |
| ~~B-4~~ | ~~E9.2 chưa có kéo-thả đổi thứ tự~~ | **Đã gỡ 15/08/2026**: PM duyệt thêm `dnd-kit`, E9.2 xong | — |
| B-5 | **Chưa có key Google AI Studio paid tier** (đo 20/08: `GOOGLE_AI_API_KEY` trong `.env` vẫn rỗng). Đã gỡ chặn 15/08/2026 bằng cách rút xuống MỘT provider (OpenAI) | Hệ thống chạy được chỉ với `OPENAI_API_KEY`. Đổi lại: **không còn provider fallback** — OpenAI timeout/rate-limit là generation fail luôn | Có key paid tier → set `GOOGLE_AI_API_KEY` + thêm lại các key `google:*` vào tiers trong YAML. Không sửa code. Xem `docs/ai/provider-strategy.md` §3.1 |
| ~~B-6~~ | ~~`TENANT_SECRETS_ENC_KEY` đang RỖNG trong `.env` → mọi đường GHI kênh fail 400~~ | **Đã gỡ (đo 20/08: key 43 ký tự base64 có trong `.env`)** — các lần chạy thật M1.5/M2/M3 đều ghi kênh, mời thành viên, tạo tenant thành công trên dev | Lưu ý cũ vẫn đúng: đổi khoá làm mọi token đã seal không mở được — đặt một lần rồi giữ |
| ~~B-7~~ | ~~Chưa có `META_APP_SECRET` → luồng OAuth Facebook chưa chạy được lần nào~~ | **Đã gỡ phần chặn (đo 20/08: `META_APP_SECRET` 32 ký tự có trong `.env`)**; OAuth state nay server-side (M1.3b) và đã bị thử giả qua HTTP trong matrix M1.5. Việc còn lại — bấm kết nối với Facebook thật — không còn là blocker cấu hình mà là hạng mục UAT | **Mốc vẫn còn hiệu lực: `data_access_expires_at` của token hiện tại ≈ 26/09/2026** — sau mốc đó phải cấp quyền lại; UAT phải xong trước đó (mục 6) |
| ~~B-8~~ | ~~Mọi route lấy `tenantId` từ client (query/body/cookie), không đối chiếu với tenant của phiên đăng nhập~~ | **ĐÃ XỬ 20/08/2026** — M1.3b (`b3df9bd`): 36 route lấy tenant từ phiên qua `requireTenantContext`, branded `TenantId` chặn compile-time, UI hết biết tenant (M1.4, `fa4ed41`). Kiểm chứng: **negative matrix M1.5 12/12 chạy thật qua HTTP** trên dev — cookie/body giả bị bỏ qua, tài nguyên tenant khác trả 404, media URL giả tenant → 401 | Chi tiết thiết kế + từng milestone: `docs/09-phan-quyen-da-tenant.md` |

## 5. Track song song: redesign UI

Không nằm trong WBS gốc. **Từ 21–22/08 track này chuyển hướng**: PM chọn thế giới thị giác
mới **"Sổ mẫu vải"** qua Impeccable (spec `superpowers/specs/2026-08-21-ui-redesign-design.md`,
plan `superpowers/plans/2026-08-21-ui-redesign-wave1.md`) — thay cho lộ trình B0–B9 cũ
(spec 2026-08-14). Mốc B9 (bridge `tailwind-theme.css`) vẫn giữ nguyên vị trí là việc tương lai.

| Giai đoạn | Trạng thái |
|---|---|
| B0 nền + shell điều hướng (track cũ) | ✅ commit `c122645` → `799b028` |
| B1 màn Sản phẩm (track cũ, pattern rows + inspector) | ✅ commit `816f3ea` |
| **Wave 1 "Sổ mẫu vải"** — theme + IA + Tổng quan + Compose | ✅ PR #34 `73b74a4` (22/08). 8 gate + finish-review ship + final PASS |
| **Wave 2** — cuốn `/bulk` `/sync` `/products` `/prompts` + ruột bảng `/posts` vào hệ; lỗ rule-5 `skipped=Y`; vòng đăng nhanh 30 mã/sáng; ~10 dòng dọn tên gọi | ⬜ Backlog đã ghi trong spec §7 + ledger wave 1. **PR #33** (redesign 15 màn trên theme neutral, làm trước khi chốt "Sổ mẫu vải") đã được PM **đóng không merge** 22/08 — bị vượt bởi #34 về thế giới thị giác lẫn IA; branch còn trên remote làm nguyên liệu wave 2 |

Ngoài lộ trình: màn **Kênh** (`/channels`) dựng thẳng trên Astryx theo pattern rows +
inspector của B1; các màn mới của lộ trình đa tenant (**`/members`, `/platform`, `/access`**)
cũng trên Astryx (grep 20/08: 15 file import `@astryxdesign` trong 3 thư mục
`ui/components/{members,platform,access}`). Màn **Nhóm kênh** (`/channels/groups`) vẫn shadcn
(grep: `ui/components/channels/ChannelGroupsScreen.tsx` không import Astryx). **`/compose`
được redesign theo mẫu PM** (đợt đầu wave M3.3, hoàn thiện + caption riêng từng kênh ở
PR #20/#22) nhưng không import Astryx trực tiếp — vẫn nằm trong diện B2–B9 khi tới lượt.

## 6. Việc tiếp theo — đề xuất

Viết lại 20/08/2026 theo hiện trạng sau 4 merge. Xếp theo thứ tự gỡ được nhiều rủi ro nhất:

1. **UAT nội bộ với Facebook thật — trước mốc 26/09/2026** (`data_access_expires_at`
   của token hiện tại). Mọi blocker cấu hình đã hết (B-6/B-7/B-8 gỡ): đăng nhập, kết
   nối Page qua OAuth hoặc dán token, compose → duyệt → đăng thật, gồm cả ca lỗi.
   Đây chính là E12.3 + E12.4 (15 tiêu chí brief mục 10) — hạng mục thiếu lớn nhất
   của cả Phase 1 lẫn Phase 2, và là lần đầu hệ thống chạm dữ liệu Facebook thật.
2. **Vé Caddy access log** (docs/09 §7): edge vẫn ghi nguyên đường dẫn `/join/<token>`
   vào access log. **Điều kiện bắt buộc trước khi phát link mời cho người ngoài** —
   filter log ở Caddy hoặc chuyển token khỏi path. Chừng nào chưa xử, link mời chỉ
   dùng nội bộ.
3. **Giai đoạn 3 của SaaS: subscription/verification.** Móc đã đặt sẵn từ M1.1
   (`tenant.plan` `internal`/`standard`, trần AI theo gói — docs/10 §8.9); billing
   cố ý để ngoài lộ trình đa tenant. Bắt đầu = hỏi PM chốt phạm vi gói + cách thu tiền.
4. **Các vé UI nhỏ mang theo từ wave M2–M3** (ghi tại milestone tương ứng trong docs/09):
   rà 7 màn còn lại hiển thị đúng chế độ support-mode chỉ-đọc · thumbnail preview ở các
   danh sách còn thiếu · dropdown tông giọng caption. Kèm các vé kỹ thuật: sweep
   `oauth_state`/invite hết hạn · `SYNC_FAILED` 500 cho "chưa cấu hình nguồn" phải thành
   409/412 (tenant mới gặp ngay ngày đầu) · Q8.5 (xoá kênh không huỷ job queued) ·
   thống nhất quy ước `minRole`.
5. **Gỡ nốt B-1/B-2** (việc vận hành, không phải code): bật API cho project service
   account nếu còn giữ đường SA; đưa port Postgres vào compose để `docker compose up`
   dựng lại được môi trường dev.
6. **E11.2 + E11.4** — kênh cảnh báo và sao lưu + thử khôi phục ("thử khôi phục
   không được bỏ" — WBS). Rồi **E13**: triển khai production, tài liệu vận hành, đào tạo.

## 7. Quy ước cập nhật file này

- Cập nhật **sau mỗi lần merge vào `dev`**, không để dồn.
- Đổi trạng thái phải kèm bằng chứng mới ở cột bằng chứng. Không có đường dẫn
  file / route / bảng thì không được đổi sang ✅.
- Chỉ được ghi ✅ cho E12.x sau khi có output lệnh chạy thật, không phải sau khi
  code xong.
- Nợ B-* đã xử: gạch tiêu đề, ghi ngày + bằng chứng, **giữ hàng lại** — bảng này là sổ sử.
- Sửa cả dòng "Cập nhật lần cuối" và commit đối chiếu ở đầu file.
