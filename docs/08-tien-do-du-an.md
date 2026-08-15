# Tiến độ dự án

> Cập nhật lần cuối: **15/08/2026** · Nhánh đối chiếu: `dev` tại `f5afc2b`, sau khi hoà E5.1 (kết nối Fanpage)
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
thu) chưa làm, và đường chạy thật đang bị chặn (mục 4). Không dùng bảng này để
báo "đã bàn giao được".

## 2. Cơ sở đối chiếu

Số liệu lấy lúc cập nhật, chạy trên `dev` sau merge E5.1:

- `pnpm typecheck` · `pnpm lint` · `pnpm depcruise` — sạch (358 module, 0 vi phạm luật phụ thuộc)
- `pnpm test` — **1573 test xanh / 20 skip**, 86 file test
- `pnpm build` — `✓ Compiled successfully`
- Phân bố file test theo tầng: core 39 · adapters 26 · ui 12 · worker 3 · composition 3 · app 3
- 29 API route · 11 màn hình · 13 bảng DB · 7 migration · 11 service trong Docker Compose
- 51 commit toàn lịch sử

Số bảng DB ghi **13** (đếm bằng `grep -c pgTable` trên `adapters/db/schema/`), sửa lại
con số 14 ở bản trước — E5.1 không thêm bảng nào, chênh lệch là do bản trước đếm sai.

## 3. Bảng tiến độ theo epic

### Phase 1 — MVP Facebook

| Epic | Trạng thái | Bằng chứng |
|---|---|---|
| E0 Khởi động & quyền truy cập | 🟡 | E0.5 có `adapters/google/service-account.ts` nhưng **đang hỏng** (mục 4). E0.1/E0.2 (duyệt app Facebook) ❓ không kiểm được từ repo |
| E1 Nền tảng | ✅ | `docker-compose.yml` (11 service), 14 schema ở `adapters/db/schema/`, 6 migration, `worker/index.ts` + BullMQ, `adapters/logging/pino-logger.ts`, `core/domain/errors` |
| E2 Drive & Sheet | ✅ | `adapters/google/{drive-source,sheet-source,sheet-values}.google.ts`, usecase `sync-catalog.ts` + `get-sync-status.ts`, bảng `sync-run`/`media-asset`, màn `/sync` |
| E3 Tồn kho, chọn màu, chọn ảnh | ✅ | usecase `compose-post.ts`, bảng `product`, màn `/products`, 33 test tầng core |
| E4 AI sinh caption | ✅ | `adapters/ai/{google,openai,registry-store,prompt-store,generation-log,cache}`, usecase `generate-captions.ts`, bảng `ai-generation` + `ai-prompt-template` + `ai-model-policy-override`, màn `/prompts`. Chạy OpenAI-only từ 15/08/2026 (B-5); prompt `facebook-product-content` đang ở **v2** |
| E5 Adapter Facebook | 🟡 | Đăng bài ✅ `adapters/meta/{graph-client,facebook-publisher,graph-error-map,fake-publisher}.ts`. **E5.1 kết nối kênh: xem mục 3.2** — nhập Page bằng User Access Token ✅ code xong, luồng OAuth ✅ code xong nhưng **chưa chạy được lần nào** (B-7) |
| E7 Điều phối đa kênh | ✅ | usecase `publish-post.ts` + `retry-post-job.ts` + `reap-post-jobs.ts`, bảng `post-job`/`post-batch`/`channel-group`, `worker/jobs/publish-post-job.ts`, màn `/channels/groups`. E7.6 nhóm kênh nay chọn từ Page đã kết nối, không còn gõ tay mã kênh; nhóm chỉ nhận kênh đang bật |
| E10 Giao diện (lõi) | ✅ | 11 màn dưới `app/(app)/`: `/`, `/compose`, `/bulk`, `/scheduled`, `/jobs`, `/products`, `/sync`, `/channels`, `/channels/groups`, `/prompts`, `/batches/[batchId]`. `/channels` nay là màn **Kênh** (Fanpage đã kết nối), nhóm kênh dời sang `/channels/groups` |
| E12 Kiểm thử (rút gọn) | 🟡 | 1475 unit test ✅; integration test chỉ 2 file (`ai-gateway`, `db-errors`); 8 smoke script ở `scripts/`. **E12.3 chạy thật đầu-cuối và E12.4 UAT: chưa làm** |

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
| E10 phần còn lại | 🟡 | Đang có track redesign Astryx riêng (mục 5) |
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

| Mục | Trạng thái | Bằng chứng |
|---|---|---|
| Nhập Page bằng User Access Token | ✅ code xong, **chưa chạy với token thật** | `POST /api/channels/import` + `/refresh`, usecase `connect-facebook-channels.ts`, adapter `adapters/meta/facebook-oauth.ts` |
| Đăng nhập bằng Facebook (OAuth) | ✅ code xong, **chưa chạy lần nào** (B-7) | `/api/channels/connect` + `/callback`, state chống CSRF ở `app/api/channels/_lib/oauth-state-cookie.ts` |
| Đổi sang token dài hạn 60 ngày | ✅ code xong, chưa chạy (cần App Secret) | `fb_exchange_token` trong `facebook-oauth.ts` |
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
4. Giá trị đã seal mở theo **prefix `enc:v1:`**, không theo tên field; chiều seal vẫn theo tên.
   Bất đối xứng có chủ đích: giá trị ghi bằng luật đặt tên hôm qua phải mở được hôm nay.

## 4. Đang bị chặn

| # | Vấn đề | Ảnh hưởng | Cách gỡ |
|---|---|---|---|
| B-1 | **Google Sheets API chưa bật** ở project `54146412168` (`mysp-multipost-505408`). Lỗi `SHEET_ERROR` khi đồng bộ | Chặn E0.5, và chặn cứng E12.3/E12.4 — không chạy được đầu-cuối trên dữ liệu thật | Bật Sheets API **và** Drive API trong Google Cloud Console, chờ vài phút, đồng bộ lại. Sau đó kiểm service account đã được share folder Drive + sheet "Hàng thiết kế 2026" |
| B-2 | Container `mysp-postgres` chạy ở host port **5433** (tạo tay bằng `docker run`), nhưng service `postgres` trong `docker-compose.yml` **không publish port nào ra host** | `docker compose up` sạch sẽ không dựng lại được môi trường dev đang chạy; `.env` phải sửa tay | Thêm `ports: ["5433:5432"]` vào service `postgres`, cập nhật `.env.example` cho khớp |
| B-3 | 9 câu quyết định nghiệp vụ còn treo (C1, C2, C5, C3, C4, D1, D2, E1, E3 — xem `CLAUDE.md`) | Code đang dùng giá trị tạm, đánh dấu `// PENDING(<mã câu>)` | PM chốt với shop |
| ~~B-4~~ | ~~E9.2 chưa có kéo-thả đổi thứ tự~~ | **Đã gỡ 15/08/2026**: PM duyệt thêm `dnd-kit`, E9.2 xong | — |
| B-6 | **`TENANT_SECRETS_ENC_KEY` đang RỖNG trong `.env`.** Đường ĐỌC kênh vẫn chạy bình thường (chỉ chạm khoá khi gặp giá trị đã seal), nhưng mọi đường GHI fail 400 | Không lưu được kênh nào → không đăng bài được. Cùng lớp lỗi này còn che một ca tệ hơn: khoá **sai giá trị** cũng đọc trót lọt cho tới hàng seal đầu tiên | `openssl rand -base64 32` rồi đặt vào `.env`. Đổi khoá sau này làm mọi token đã lưu không mở được — đặt một lần rồi giữ. Từ E5.1 đã có banner cảnh báo trước trên màn `/channels` thay vì để chết lúc bấm nút |
| B-7 | **Chưa có `META_APP_SECRET`.** App `ĐĂNG_BAI` (`1640548543911378`) là của người vận hành nên secret lấy được ở Settings → Basic, không phải xin duyệt | Luồng OAuth chưa chạy được lần nào — route từ chối có kiểm soát, gọi tên đúng biến còn thiếu. Đường dán User Access Token vẫn dùng được bình thường | Lấy App Secret → `.env`; khai `http://localhost:3000/api/channels/callback` vào Facebook Login → Settings → Valid OAuth Redirect URIs. **Mốc cần gấp: `data_access_expires_at` của token hiện tại ≈ 26/09/2026** — sau mốc đó phải cấp quyền lại, và OAuth là cách duy nhất khỏi dán tay định kỳ |
| B-8 | **Mọi route lấy `tenantId` từ client** (query/body/cookie), không đối chiếu với tenant của phiên đăng nhập | Operator đã đăng nhập chỉ cần đổi UUID là đọc/ghi được dữ liệu tenant khác. Pattern có sẵn toàn repo, nhưng E5.1 nâng mức thiệt hại từ "lộ cấu hình" lên **"ghi được Page access token vào tenant bất kỳ"** | Thiết kế đã chốt, chưa làm: suy tenant từ `app_user` theo email phiên, seed `dev@localhost`, sửa 29 route + gỡ `DEMO_TENANT_ID` khỏi 13 file UI, bỏ `tenantId` khỏi cookie state OAuth. Ước lượng: 1 phiên làm việc |
| B-5 | **Chưa có key Google AI Studio paid tier.** Đã gỡ chặn 15/08/2026 bằng cách rút xuống MỘT provider (OpenAI): `GOOGLE_AI_API_KEY` thành optional, tiers trong `config/ai-models.yaml` chỉ còn model OpenAI | Hệ thống chạy được chỉ với `OPENAI_API_KEY`. Đổi lại: **không còn provider fallback** — OpenAI timeout/rate-limit là generation fail luôn | Có key paid tier → set `GOOGLE_AI_API_KEY` + thêm lại các key `google:*` vào tiers trong YAML. Không sửa code. Xem `docs/ai/provider-strategy.md` §3.1 |

## 5. Track song song: redesign UI trên Astryx

Không nằm trong WBS gốc. Spec `superpowers/specs/2026-08-14-redesign-ui-astryx-design.md`,
plan `superpowers/plans/2026-08-14-astryx-b0-shell.md`. Lộ trình B0–B9.

| Giai đoạn | Trạng thái |
|---|---|
| B0 nền + shell điều hướng | ✅ commit `c122645` → `799b028` |
| B1 màn Sản phẩm (chốt pattern rows + inspector) | ✅ commit `816f3ea` |
| B2–B9 | ⬜ Chưa có plan. B0 chốt: phải chờ B1 xong mới viết plan B2–B8, viết trước là đoán |

Ngoài lộ trình: màn **Kênh** (`/channels`, commit `312e3bf`) dựng thẳng trên Astryx theo
pattern rows + inspector của B1. Màn **Nhóm kênh** (`/channels/groups`) vẫn còn shadcn —
cố ý không refactor trong phạm vi E5.1, nên hiện hai màn cạnh nhau trong cùng nhóm nav
đang dùng hai bộ component khác nhau. Cần gộp khi tới lượt trong B2–B9.

## 6. Việc tiếp theo — đề xuất

Xếp theo thứ tự gỡ được nhiều rủi ro nhất:

1. **Gỡ B-6 rồi chạy thử E5.1 với token thật** (vài phút). Đặt `TENANT_SECRETS_ENC_KEY`,
   dán User Access Token ở `/channels`, xác nhận Page hiện ra và chọn được ở nhóm kênh.
   Đây là lần đầu tính năng chạm dữ liệu Facebook thật — mọi thứ khác trong E5.1 đã
   chạy thật rồi, chỉ còn đúng bước này.
2. **B-8 — `tenantId` lấy từ phiên.** Đã có Page access token thật nằm sau các route đó,
   nên mức rủi ro không còn lý thuyết nữa. Thiết kế chốt rồi, làm được ngay.
3. **Gỡ B-1** (người vận hành, không phải việc code). Cho tới khi bật xong Sheets
   API thì không có cách nào nghiệm thu Phase 1 trên dữ liệu thật.
4. **E12.3 + E12.4** — chạy thật đầu-cuối gồm cả ca lỗi, rồi UAT theo 15 tiêu chí
   ở brief mục 10. Đây là việc còn thiếu lớn nhất của Phase 1, và cả Phase 2 cũng
   chưa được chạy thật lần nào.
5. **E11.2 + E11.4** — kênh cảnh báo và sao lưu + thử khôi phục. E11.4 ghi rõ
   trong WBS là "thử khôi phục không được bỏ".
6. **E13** — triển khai production, tài liệu vận hành, đào tạo.

## 7. Quy ước cập nhật file này

- Cập nhật **sau mỗi lần merge vào `dev`**, không để dồn.
- Đổi trạng thái phải kèm bằng chứng mới ở cột bằng chứng. Không có đường dẫn
  file / route / bảng thì không được đổi sang ✅.
- Chỉ được ghi ✅ cho E12.x sau khi có output lệnh chạy thật, không phải sau khi
  code xong.
- Sửa cả dòng "Cập nhật lần cuối" và commit đối chiếu ở đầu file.
