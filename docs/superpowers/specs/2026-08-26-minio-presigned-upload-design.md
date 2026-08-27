# Thiết kế — Chuyển lưu trữ media sang MinIO + upload thẳng bằng presigned URL

Ngày: 26/08/2026 · Trạng thái: chờ PM duyệt · Epic liên quan: E9 (chế độ B), E3.6 (media bridge)

## 1. Vì sao

Hôm nay byte của mode B đi xuyên qua app server rồi mới xuống đĩa VPS:

- `src/app/api/_lib/read-upload-form.ts:71` gọi `request.formData()` — buffer **toàn bộ** body vào RAM;
  route sau đó lại `part.arrayBuffer()` từng phần, nên có lúc giữ hai bản.
- Cap tổng `MAX_TOTAL_UPLOAD_BYTES` (250MB = 25MB × 10) kiểm ở dòng 113, tức **sau** khi đã buffer xong.
  Cap đó từ chối request nhưng không cứu được RAM.
- `src/adapters/media/local-blob-store.ts` ghi `writeFile` vào Docker volume `uploaddata` trên **một** VPS.
  Không backup riêng, không chạy được nhiều node web.
- `GET /api/media/[driveFileId]` stream byte qua Node cho UI preview (xem mục 7 — ảnh đăng lên
  Facebook KHÔNG đi qua đường này).

Nút thắt không nằm ở số file cho phép mà ở chỗ byte đi qua tiến trình Node. Không có con số cap nào sửa được điều đó.

## 2. Phạm vi

**Trong phạm vi**

1. Adapter mới `MinioBlobStore` implement `MediaBlobStore`, thay `local-blob-store` ở production và dev.
2. Mở rộng port `MediaBlobStore` để hỗ trợ presigned PUT/GET và đọc một phần object.
3. Đường upload mới hai chặng: xin vé → PUT thẳng lên MinIO → xác nhận.
4. Đảo thứ tự kiểm duyệt kiểu file, kèm cơ chế bù (vùng staging tách khỏi vùng phục vụ).
5. `GET /api/media/[driveFileId]` trả **302** sang presigned GET cho asset `origin = 'upload'`
   (phục vụ UI preview — mục 7 giải thích vì sao đường đăng ảnh không dùng tới).
6. Service `minio` trong Compose (dev + prod), env, bucket, policy.
7. Script di trú một lần: copy file đang có trong volume `uploaddata` lên MinIO.
8. Mở rộng sweep `cleanup-uploads` để dọn vé quá hạn và object mồ côi.

**Ngoài phạm vi**

- Modal phân loại ảnh nhiều mã (spec riêng, làm SAU spec này).
- Dedup theo hash, upload chunked/resumable, CDN, transcode.
- Asset `origin = 'drive'` — Drive không ký hộ ta được, vẫn stream qua Node như cũ.

## 3. Quyết định đã chốt với PM

| Câu | Chốt |
|---|---|
| MinIO làm tới đâu | Cả đổi chỗ lưu **và** presigned PUT |
| Thứ tự so với modal phân loại | MinIO trước, modal sau |
| Thư viện ký | package `minio` (client chính chủ), **thêm 1 dependency** |

Lý do làm MinIO trước: hook upload phía UI của feature modal phải bám vào API upload. Làm modal trước
nghĩa là viết bám multipart cũ rồi vứt đi viết lại.

## 4. Kiến trúc đích

```
browser ──(1) POST /api/posts/uploads/tickets ─────────► web (Node)
        ◄──── [{assetId, url, headers, expiresAt}] ─────
        ──(2) POST multipart <postUrl+formFields> ────► MinIO   (byte KHÔNG qua Node)
        ──(3) POST /api/posts/uploads/confirm ────────► web (Node)
                                                        │ stat + đọc 4KB đầu → sniff
                                                        │ copy staging/ → media/
                                                        │ xoá staging
                                                        └─ registerUpload() như hôm nay

UI preview ─GET /api/media/<id>?sig=… ─► web ──302──► MinIO (presigned GET, TTL 5')

Đăng ảnh:  worker ─readMediaBytes()─► MinIO ─byte─► worker ─multipart source─► Graph
           (Facebook KHÔNG gọi media bridge cho ảnh — xem mục 7)
```

Điểm bất biến: sau bước (3), row `media_asset` giống hệt hôm nay (`origin='upload'`, `storage_key`,
`sequence`, …). Nên `compose-post`, `create-post-batch`, `publish-post`, worker **không đổi một dòng nào**.

## 5. Thay đổi port `MediaBlobStore`

Giữ nguyên `put` / `get` / `delete` (test và đường di trú vẫn dùng). Thêm:

**Đính chính kỹ thuật quan trọng:** `presignedPutObject` **không** mang được `content-length-range` —
ký xong thì client PUT bao nhiêu byte cũng được, tức storage không tự chặn 25MB. Muốn bucket tự chặn
thì phải dùng **POST policy** (`newPostPolicy()` + `setContentLengthRange(1, 25MB)` + `setContentType()`
+ `presignedPostPolicy()`), browser POST multipart thẳng vào bucket. Mọi chỗ trong spec nói "presigned
PUT" đọc là **POST policy**; bản chất vẫn là URL ký sẵn, byte vẫn không qua Node.

```ts
createUploadUrl(input: {
  tenantId; assetId; declaredMimeType; maxBytes; expiresInSeconds;
}): Promise<{
  /** Nơi browser POST multipart tới. */
  postUrl: string;
  /** Field phải đính kèm TRƯỚC field `file` trong FormData. */
  formFields: Record<string, string>;
  storageKey: string;
  expiresAt: Date;
}>;

/** Đọc n byte đầu để sniff. null khi object không tồn tại. */
readRange(input: { tenantId; storageKey; length: number }): Promise<Uint8Array | null>;

stat(input: { tenantId; storageKey }): Promise<{ sizeBytes: number; mimeType: string | null } | null>;

/** Chuyển object từ vùng staging sang vùng phục vụ. Copy phía server, không qua Node. */
promote(input: { tenantId; assetId }): Promise<{ storageKey: string; sizeBytes: number }>;

/** URL đọc ngắn hạn cho media bridge. null = implementer không hỗ trợ (bridge tự stream). */
createDownloadUrl(input: { tenantId; storageKey; expiresInSeconds }): Promise<string | null>;
```

`local-blob-store` giữ lại **chỉ để đọc** trong lúc di trú, rồi **xoá hẳn** (PM chốt 26/08/2026) —
cùng với `MEDIA_STORAGE_DRIVER`, biến env đó không còn lý do tồn tại. Unit test dùng fake in-memory
implement đủ surface (container đã có `overrides.blobs`).

## 6. Luồng upload chi tiết

### 6.1 Xin vé — `POST /api/posts/uploads/tickets`

Auth: tier M, role `editor`, y như route upload hiện tại — **trước khi** đụng body.

Body JSON (zod ở biên):

```
{ productCode: string, color?: string,
  files: [{ fileName: string, mimeType: string, sizeBytes: number }] }
```

Usecase mới `core/usecases/issue-upload-tickets.ts`:

- Edge case trước: mảng rỗng → `INVALID_INPUT`; > `MAX_UPLOADS_PER_POST` → từ chối cả lô;
  mime ngoài `ALLOWED_UPLOAD_MIME_TYPES` → từ chối **riêng file đó**, báo trong `rejected[]`;
  `sizeBytes` > `MAX_UPLOAD_BYTES` → từ chối riêng file đó; trộn ảnh với video → `MIXED_ALBUM_KIND`
  (dùng lại `assertOneAlbumKind`, chuyển thành hàm thuần nhận `kind[]`).
- Sinh `assetId`, gọi `blobs.createUploadUrl` với key `staging/<tenantId>/<assetId>`, ràng buộc
  `content-length-range` = [1, MAX_UPLOAD_BYTES] và `Content-Type` đúng mime khai báo.
- Ghi một hàng vào **bảng mới `upload_ticket`** (xem 6.4). **Không** ghi vào `media_asset`.
- TTL vé: 30 phút.

Trả về `{ tickets: [{assetId, url, headers, expiresAt}], rejected: [...] }`.

### 6.2 Browser PUT thẳng

`useUploadTickets` PUT từng file, tối đa 3 luồng song song, có thanh tiến độ và nút huỷ
(`AbortController`). Lỗi một file không dừng file khác. File PUT lỗi → không đưa vào bước xác nhận.

### 6.3 Xác nhận — `POST /api/posts/uploads/confirm`

Body: `{ productCode, color?, assets: [{assetId}], order?: number[] }`.

Usecase mới `core/usecases/confirm-upload.ts`, **thứ tự bắt buộc**:

1. Đọc `upload_ticket` theo `(tenantId, assetId)`. Không có / hết hạn / khác tenant → từ chối file đó.
2. `blobs.stat()` — kích thước **thật**. 0 byte hoặc > cap → xoá object, xoá vé, báo rejected.
3. `blobs.readRange(4096)` → `sniffMediaMimeType` → so với mime của vé. Lệch → xoá object, xoá vé,
   báo rejected với đúng câu tiếng Việt hiện có ("Nội dung file … không khớp định dạng khai báo").
4. `assertOneAlbumKind` trên tập file đã qua.
5. `blobs.promote()` — copy `staging/…` sang `media/<tenantId>/<assetId>`, xoá bản staging.
6. `discardPreviousUploads` — giữ nguyên hành vi hôm nay.
7. `media.registerUpload()` với asset y hệt hôm nay, `sequence` theo `order`.
8. Không file nào qua → `AppError('INVALID_INPUT')` như `upload-media.ts` đang làm.

Rollback: promote xong mà `registerUpload` lỗi → xoá object vùng phục vụ (đúng như nhánh rollback
hiện có trong `upload-media.ts`).

`upload-media.ts` cũ và `POST /api/posts/uploads` multipart: **giữ nguyên**, đánh dấu deprecated, xoá ở
cuối spec modal khi UI đã chuyển hết. Chúng vẫn chạy được sau khi đổi driver, vì `MinioBlobStore` cũng
implement `put()` — đường cũ chỉ mất lợi ích "byte không qua Node", không gãy.

### 6.4 Bảng `upload_ticket`

```
tenant_id, asset_id (pk), storage_key, file_name, declared_mime, declared_size,
product_code, created_by, created_at, expires_at
```

Cố ý **không** đụng `media_asset`: nếu ghi row `media_asset` trạng thái `pending`, mọi truy vấn media
đang có (compose, danh sách sản phẩm, preview) đều phải thêm điều kiện lọc — bỏ sót một chỗ là ảnh chưa
duyệt lọt vào bài đăng. Bảng riêng khiến rủi ro đó bằng không.

### 6.5 Sweep

Mở rộng `cleanup-uploads` (job giờ, đã có):

- vé quá hạn > 2h → xoá object staging trước, rồi xoá vé (byte trước, row sau — luật sẵn có).
- object trong `staging/` không có vé tương ứng → xoá.
- phần dọn `media_asset` mồ côi giữ nguyên.

## 7. Media bridge trả 302 — phạm vi hẹp hơn tôi nói ở vòng trước

Đọc lại `publish-post.ts` thì câu hỏi "Facebook có follow 302 không" **tự tan** ở Phase 1: ảnh không
đi qua URL nào cả.

- `publish-post.ts:661-666` ghi rõ ảnh được gửi lên Graph bằng multipart `source`, không phải `url=`.
  Lý do đã đo trên bài thật: đưa `url=` thì Facebook tự đi tải rồi bỏ cuộc quanh 30 giây, hỏng 4/10 ảnh;
  cùng 10 ảnh đó gửi bằng byte thì qua hết.
- Worker đọc byte qua `readMediaBytes` (dòng 1176) → cache → blob store, rồi POST thẳng lên Graph.
- Chỉ **video** mới đưa URL cho Meta/TikTok tự tải (dòng 704), và video thuộc Phase 2.

Bốn hệ quả:

1. Facebook không bao giờ gọi `/api/media/...` cho ảnh → bỏ rủi ro "302" khỏi Phase 1.
2. 302 chỉ còn giá trị cho **UI preview**. Vẫn là thắng lợi thật — mỗi lần mở màn duyệt là hàng chục
   ảnh đi qua Node — nhưng nhỏ hơn hẳn. Tôi đã nói nhầm ở vòng trước rằng nó gỡ băng thông đường đăng bài.
3. Đường đăng ảnh **vẫn** là `MinIO → worker → Graph`. Byte vẫn qua Node và không tránh được, vì Graph
   đòi byte. Spec này không sửa được, và không nên cố sửa.
4. Câu hỏi 302 quay lại ở Phase 2 khi làm video. Lúc đó phải đo thật, không suy đoán.

Thiết kế giữ nguyên: giữ cổng HMAC, chỉ 302 **sau khi** chữ ký hợp lệ, TTL 5 phút, không log URL presigned.

## 8. Hạ tầng

Compose (dev + prod): service `minio` (`minio/minio`), volume `miniodata`, bucket `mysp-media`, policy
**private hoàn toàn** — chỉ presigned mới đọc/ghi được.

Env mới:

```
MINIO_INTERNAL_ENDPOINT=minio:9000      # web/worker gọi trong mạng Docker
MINIO_PUBLIC_ENDPOINT=https://media.vannt.asia # host dùng để KÝ url đưa ra browser
MINIO_ACCESS_KEY / MINIO_SECRET_KEY
MINIO_BUCKET=mysp-media
MINIO_USE_SSL=true
```

**Bẫy phải nói rõ:** presigned URL ký kèm hostname. Ký bằng `minio:9000` thì browser không dùng được;
ký bằng host công khai thì thao tác server-side lại đi vòng ra ngoài. Adapter giữ **hai client**: một
nội bộ cho `stat`/`readRange`/`promote`/`delete`, một công khai chỉ để ký URL đưa ra ngoài.

Theo quy ước hạ tầng của dự án (Cloudflare Tunnel → Traefik, không mở IP public),
`media.vannt.asia` (PM cấp 26/08/2026) phải được trỏ qua tunnel về service `minio`. Cloudflare giới hạn body **100MB** — cap 25MB/file nằm dưới ngưỡng,
nhưng con số phải ghi vào tài liệu vận hành chứ không để ngầm.

## 9. Di trú dữ liệu đang có

Script một lần `scripts/migrate-uploads-to-minio.ts`:

1. Quét `media_asset` `origin='upload'` có `storage_key`.
2. Đọc từ volume `uploaddata`, `putObject` lên MinIO **giữ nguyên key**, so lại kích thước.
3. In báo cáo: đã chuyển / lệch kích thước / không tìm thấy file.
4. Không xoá gì. Xoá volume là thao tác tay sau khi PM xác nhận.

Rollback: PM đã chốt xoá hẳn `local-blob-store`, nên **không có đường lui bằng env**. Lưới an toàn
duy nhất là: script không xoá gì ở volume `uploaddata`, và việc xoá adapter cũ là **commit cuối cùng**
của epic, làm sau khi đã đăng thật thành công. Trước commit đó, quay lui = revert commit đổi wiring.

## 10. Lỗi và log

Mọi nhánh từ chối phải log kèm `tenant_id`, `product_code`, `asset_id`, `file_name`, `reason`.

`ERROR_CODES` trong `core/domain/errors.ts` là **danh sách đóng, không thêm mã mới** — đúng như
`upload-media.ts` đang làm. Các nhánh dưới đây là giá trị `reason` trong `context`, mang mã
`INVALID_INPUT` (lỗi của đầu vào) hoặc `INTERNAL` (lỗi của store): `UPLOAD_TICKET_NOT_FOUND`,
`UPLOAD_TICKET_EXPIRED`, `UPLOAD_OBJECT_MISSING`, `UPLOAD_SIZE_MISMATCH`,
`CONTENT_TYPE_MISMATCH` (đã có), `BLOB_PROMOTE_FAILED`, `BLOB_PRESIGN_FAILED`.

Không nuốt lỗi. Không log URL presigned, không log access key.

## 11. Kiểm chứng

Unit (vitest, fake port): xin vé với lô rỗng / quá 10 / mime lạ / trộn ảnh-video; confirm với vé hết hạn,
vé của tenant khác, object thiếu, size lệch, sniff lệch; rollback khi `registerUpload` lỗi.

**Integration bắt buộc chạy với MinIO thật** (`docker compose up minio`), vì đây là việc dính nhiều thành
phần — mock không bắt được lỗi ở chỗ ghép:

1. Upload 3 ảnh → PUT thật → confirm → 3 row `origin='upload'`, sequence 1/2/3, object nằm ở `media/`,
   `staging/` rỗng.
2. Đổi tên `.exe` thành `.jpg` → PUT thành công → confirm **phải** từ chối, xoá object, `media/` không có gì.
3. POST file 30MB → MinIO tự từ chối theo `content-length-range` của policy, không cần Node can thiệp.
4. Dùng lại URL sau 30 phút → hỏng.
5. Confirm hai lần cùng assetId → lần hai không tạo row thừa.
6. `GET /api/media/<id>` với chữ ký hợp lệ → 302; chữ ký sai → 401, **không** lộ URL MinIO.
7. Đăng một bài thật lên Facebook bằng ảnh upload — chứng minh worker đọc được byte từ MinIO qua
   `readMediaBytes` và Graph nhận đủ ảnh. Đây là cổng cuối, phải qua trước khi xoá `local-blob-store`.

Lệnh cổng: `pnpm verify` (typecheck · lint · depcruise · test · build) phải exit 0, và phải kiểm artifact
thật chứ không tin exit code.

## 12. Rủi ro

| # | Rủi ro | Bù |
|---|---|---|
| 1 | Ký sai host (nội bộ vs công khai) — lỗi im lặng, chỉ lộ khi chạy qua tunnel | Hai client tách bạch; test tích hợp phải gọi URL từ ngoài mạng Docker |
| 2 | File chưa duyệt nằm trên storage — nới một rào cố ý | Vùng `staging/` tách khỏi `media/`; chỉ `promote` sau khi sniff xong; sweep dọn |
| 3 | ~~Facebook không follow 302~~ — đã gỡ: ảnh đăng bằng byte, không qua URL (mục 7). Rủi ro này quay lại ở Phase 2 (video) | Đo thật khi làm video, không suy đoán trước |
| 4 | package `minio` với Next 16 / ESM | Kiểm ngay ở bước đầu, trước khi viết adapter |
| 5 | Cloudflare 100MB body + timeout mạng chậm | Cap 25MB/file; UI báo tiến độ và cho thử lại từng file |
| 6 | Di trú làm mất mapping | Giữ nguyên key, không xoá nguồn, rollback bằng env |

## 13. Đã chốt (26/08/2026)

| Câu | Chốt |
|---|---|
| Hostname MinIO công khai | `media.vannt.asia`, trỏ qua Cloudflare Tunnel |
| TTL vé upload | 30 phút |
| TTL presigned download | 5 phút |
| Số phận `local-blob-store` | Xoá hẳn — commit cuối của epic, sau khi test tích hợp 7 đã qua |
| Facebook có follow 302 không | Không cần trả lời ở Phase 1 (mục 7) |
