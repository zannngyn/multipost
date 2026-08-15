# Tiến độ dự án

> Cập nhật lần cuối: **15/08/2026** · Nhánh đối chiếu: `dev` @ `94da4ed`
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

Số liệu lấy lúc cập nhật, chạy trên `dev` @ `94da4ed`:

- `pnpm typecheck` · `pnpm lint` · `pnpm depcruise` — sạch (321 module, 0 vi phạm luật phụ thuộc)
- `pnpm test` — **1317 test xanh / 6 skip**, 70 file test
- Phân bố test theo tầng: core 33 · adapters 21 · ui 9 · worker 3 · composition 2 · app 2
- 22 API route · 10 màn hình · 14 bảng DB · 6 migration · 11 service trong Docker Compose
- 31 commit toàn lịch sử

## 3. Bảng tiến độ theo epic

### Phase 1 — MVP Facebook

| Epic | Trạng thái | Bằng chứng |
|---|---|---|
| E0 Khởi động & quyền truy cập | 🟡 | E0.5 có `adapters/google/service-account.ts` nhưng **đang hỏng** (mục 4). E0.1/E0.2 (duyệt app Facebook) ❓ không kiểm được từ repo |
| E1 Nền tảng | ✅ | `docker-compose.yml` (11 service), 14 schema ở `adapters/db/schema/`, 6 migration, `worker/index.ts` + BullMQ, `adapters/logging/pino-logger.ts`, `core/domain/errors` |
| E2 Drive & Sheet | ✅ | `adapters/google/{drive-source,sheet-source,sheet-values}.google.ts`, usecase `sync-catalog.ts` + `get-sync-status.ts`, bảng `sync-run`/`media-asset`, màn `/sync` |
| E3 Tồn kho, chọn màu, chọn ảnh | ✅ | usecase `compose-post.ts`, bảng `product`, màn `/products`, 33 test tầng core |
| E4 AI sinh caption | ✅ | `adapters/ai/{google,openai,registry-store,prompt-store,generation-log,cache}`, usecase `generate-captions.ts`, bảng `ai-generation` + `ai-prompt-template` + `ai-model-policy-override`, màn `/prompts`. Chạy OpenAI-only từ 15/08/2026 (B-4); prompt `facebook-product-content` đang ở **v2** |
| E5 Adapter Facebook | ✅ | `adapters/meta/{graph-client,facebook-publisher,graph-error-map,fake-publisher}.ts` |
| E7 Điều phối đa kênh | ✅ | usecase `publish-post.ts` + `retry-post-job.ts` + `reap-post-jobs.ts`, bảng `post-job`/`post-batch`/`channel-group`, `worker/jobs/publish-post-job.ts`, màn `/channels` |
| E10 Giao diện (lõi) | ✅ | 10 màn dưới `app/(app)/`: `/`, `/compose`, `/bulk`, `/scheduled`, `/jobs`, `/products`, `/sync`, `/channels`, `/prompts`, `/batches/[batchId]` |
| E12 Kiểm thử (rút gọn) | 🟡 | 1317 unit test ✅; integration test chỉ 2 file (`ai-gateway`, `db-errors`); 8 smoke script ở `scripts/`. **E12.3 chạy thật đầu-cuối và E12.4 UAT: chưa làm** |

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
| E9 Chế độ B: tự tải file lên | ⬜ **Chưa bắt đầu** | Không có handler `multipart`/`formData()` nào trong `src/app/api`; không có khái niệm chế độ nguồn ảnh trong `compose`. `/api/media/[driveFileId]` là cầu media ký HMAC phục vụ Meta (E3.6), **không phải** upload của người dùng |
| E11 Vận hành & giám sát | 🟡 | E11.1 có màn `/jobs` + `/api/posts/jobs/[postJobId]/retry`; E11.3 có `worker/reaper-schedule.ts`. **E11.2 kênh cảnh báo và E11.4 sao lưu + thử khôi phục: chưa có** |
| E10 phần còn lại | 🟡 | Đang có track redesign Astryx riêng (mục 5) |
| E12 đầy đủ | ⬜ | Xem dòng E12 ở Phase 1 |
| E13 Bàn giao | ⬜ | Có `Dockerfile` + `docker-compose.yml`; chưa có tài liệu vận hành, chưa triển khai production, chưa đào tạo |

## 4. Đang bị chặn

| # | Vấn đề | Ảnh hưởng | Cách gỡ |
|---|---|---|---|
| B-1 | **Google Sheets API chưa bật** ở project `54146412168` (`mysp-multipost-505408`). Lỗi `SHEET_ERROR` khi đồng bộ | Chặn E0.5, và chặn cứng E12.3/E12.4 — không chạy được đầu-cuối trên dữ liệu thật | Bật Sheets API **và** Drive API trong Google Cloud Console, chờ vài phút, đồng bộ lại. Sau đó kiểm service account đã được share folder Drive + sheet "Hàng thiết kế 2026" |
| B-2 | Container `mysp-postgres` chạy ở host port **5433** (tạo tay bằng `docker run`), nhưng service `postgres` trong `docker-compose.yml` **không publish port nào ra host** | `docker compose up` sạch sẽ không dựng lại được môi trường dev đang chạy; `.env` phải sửa tay | Thêm `ports: ["5433:5432"]` vào service `postgres`, cập nhật `.env.example` cho khớp |
| B-3 | 9 câu quyết định nghiệp vụ còn treo (C1, C2, C5, C3, C4, D1, D2, E1, E3 — xem `CLAUDE.md`) | Code đang dùng giá trị tạm, đánh dấu `// PENDING(<mã câu>)` | PM chốt với shop |
| B-4 | **Chưa có key Google AI Studio paid tier.** Đã gỡ chặn 15/08/2026 bằng cách rút xuống MỘT provider (OpenAI): `GOOGLE_AI_API_KEY` thành optional, tiers trong `config/ai-models.yaml` chỉ còn model OpenAI | Hệ thống chạy được chỉ với `OPENAI_API_KEY`. Đổi lại: **không còn provider fallback** — OpenAI timeout/rate-limit là generation fail luôn | Có key paid tier → set `GOOGLE_AI_API_KEY` + thêm lại các key `google:*` vào tiers trong YAML. Không sửa code. Xem `docs/ai/provider-strategy.md` §3.1 |

## 5. Track song song: redesign UI trên Astryx

Không nằm trong WBS gốc. Spec `superpowers/specs/2026-08-14-redesign-ui-astryx-design.md`,
plan `superpowers/plans/2026-08-14-astryx-b0-shell.md`. Lộ trình B0–B9.

| Giai đoạn | Trạng thái |
|---|---|
| B0 nền + shell điều hướng | ✅ commit `c122645` → `799b028` |
| B1 màn Sản phẩm (chốt pattern rows + inspector) | ✅ commit `816f3ea` |
| B2–B9 | ⬜ Chưa có plan. B0 chốt: phải chờ B1 xong mới viết plan B2–B8, viết trước là đoán |

## 6. Việc tiếp theo — đề xuất

Xếp theo thứ tự gỡ được nhiều rủi ro nhất:

1. **Gỡ B-1** (người vận hành, không phải việc code). Cho tới khi bật xong Sheets
   API thì không có cách nào nghiệm thu Phase 1 trên dữ liệu thật.
2. **E12.3 + E12.4** — chạy thật đầu-cuối gồm cả ca lỗi, rồi UAT theo 15 tiêu chí
   ở brief mục 10. Đây là việc còn thiếu lớn nhất của Phase 1, và cả Phase 2 cũng
   chưa được chạy thật lần nào.
3. **E9** — epic tính năng duy nhất còn nguyên vẹn chưa động, và không phụ thuộc
   Google Cloud nên làm được ngay cả khi B-1 chưa gỡ. Cần chốt trước: **file tải
   lên lưu ở đâu** (volume Docker trên VPS hay object storage) — `02-dinh-huong-cong-nghe.md`
   chưa nói, mà quyết định này ảnh hưởng cả E9.1, E9.4 lẫn E13.1.
4. **E11.2 + E11.4** — kênh cảnh báo và sao lưu + thử khôi phục. E11.4 ghi rõ
   trong WBS là "thử khôi phục không được bỏ".

## 7. Quy ước cập nhật file này

- Cập nhật **sau mỗi lần merge vào `dev`**, không để dồn.
- Đổi trạng thái phải kèm bằng chứng mới ở cột bằng chứng. Không có đường dẫn
  file / route / bảng thì không được đổi sang ✅.
- Chỉ được ghi ✅ cho E12.x sau khi có output lệnh chạy thật, không phải sau khi
  code xong.
- Sửa cả dòng "Cập nhật lần cuối" và commit đối chiếu ở đầu file.
