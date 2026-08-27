# Thiết kế — Phân loại ảnh tải lên thành nhiều bài (nhiều mã, nhiều màu)

Ngày: 26/08/2026 · Trạng thái: chờ PM duyệt · Epic: E9 (chế độ B) + E10 (giao diện)
Phụ thuộc: `2026-08-26-minio-presigned-upload-design.md` — spec này đặt lên trên đường ống upload mới.

## 1. Vấn đề

Chế độ B hôm nay là **1 bài = 1 mã**, và mã phải do operator gõ trước khi kéo file:
`upload-media.ts` ném `INVALID_INPUT` / "Thiếu mã sản phẩm cho các file vừa tải lên." khi thiếu.

Thực tế operator thả cả lô ảnh và gặp ba tình huống, PM xác nhận cả ba đều phải đỡ:

1. **Tên file CÓ mã, hệ thống không đọc.** `parseMediaFileName` đã biết bóc `CODE-Màu (n).ext`,
   biết `knownCodes` từ Sheet, biết cả `MULTIPLE_PRODUCT_CODES` — nhưng chỉ chạy cho file từ Drive.
   Mode B cố tình bỏ qua tên file (`color: null`, `needsReview: false`).
2. **Tên file KHÔNG có mã** (`IMG_1234.jpg` chụp từ điện thoại). Không có gì để đọc.
3. **Đọc được mã nhưng mã chưa có trong dữ liệu đã đồng bộ** → không có tên/mô tả cho AI.

Miếng ghép đã có sẵn; cái thiếu là tầng phân loại nối chúng lại.

## 2. Phạm vi

**Trong phạm vi**

1. Luật gom nhóm thuần (`core/domain/upload-grouping.ts`).
2. Usecase `plan-upload-groups.ts` + route `POST /api/posts/uploads/plan`.
3. Modal phân loại hai bước tại màn Soạn bài: gom nhóm → duyệt caption → chạy.
4. Ghi **màu** lên asset upload (thay đổi hành vi cố ý, mục 8).
5. Thu hẹp phạm vi "thay thế lần tải trước" từ `(mã)` xuống `(mã, màu)`.
6. `CaptionReviewDialog` dùng chung, và tách `useBulkRun` làm hai chặng để màn Chạy hàng loạt cũng
   có khâu duyệt (mục 13).

**Ngoài phạm vi**

- Đổi schema `post_draft` để chứa nhiều nháp — xem mục 6.3 vì sao tránh được.
- Kéo cả thư mục (`webkitdirectory`), gộp theo tên thư mục — profile `folder-per-code` đã có ở parser
  nhưng PM không chọn tình huống đó.
- Video nhiều file một bài (Phase 2).

## 3. Quyết định đã chốt với PM

| Câu | Chốt |
|---|---|
| Kết quả mong muốn | Một màn phân loại → nhiều bài, duyệt một lần |
| Dạng màn | **Modal tại chỗ**, không điều hướng sang trang khác |
| Chỗ thả file | Ô upload của màn **Soạn bài** |
| Mã lạ | Cho nhập tay tên/mô tả ngay tại bảng phân loại |
| Gom nhóm | Theo **(mã + màu đọc từ tên file)**; số đuôi `(1)(2)(3)` chỉ quyết định thứ tự ảnh |
| Bắt buộc có | Preview ảnh, và chọn được ảnh bìa |
| Cap một lô | **60 file / 300MB**, mỗi bài vẫn tối đa 10 ảnh |
| Tên file có 2 mã | **Một bài**, gán mã đứng đầu, kèm cảnh báo, sửa được trong modal |
| Duyệt caption ở màn Chạy hàng loạt | **Có làm**, cùng kiểu modal — dùng chung component bước 2 (mục 13) |
| Gộp màu của một mã | **Cho gộp** bằng nút trong modal; **mặc định vẫn tách** theo màu (mục 14) |

## 4. Luồng

```
(1) thả N file  ──► browser dựng preview bằng URL.createObjectURL  (0 byte lên mạng)
(2) POST /api/posts/uploads/plan   { files:[{fileName, mimeType, sizeBytes}] }   ~7KB
    ◄── { groups[], unassigned[], limits }
(3) MODAL bước 1 — phân loại: sửa mã/màu, đổi thứ tự, đặt bìa, gán ảnh trong khay, nhập tay mã lạ
(4) MODAL bước 2 — với mỗi nhóm tuần tự:
       tickets → PUT thẳng MinIO → confirm → composePost(source:'upload') → generateCaptions
    rồi hiện caption từng bài cho operator sửa
(5) chạy: createPostBatch cho từng nhóm — luồng tồn kho/AI/duyệt/giãn cách giữ nguyên
```

Byte ảnh chỉ rời máy ở bước (4), và chỉ những file operator giữ lại. Ảnh bị bỏ ở bước (3) **không tốn
byte nào** — đây là điểm luồng mới tốt hơn hôm nay, vì hôm nay thả file là upload ngay.

## 5. Luật gom nhóm

`core/domain/upload-grouping.ts` — thuần, không I/O, test không cần DB.

Vào: `[{fileName, mimeType, sizeBytes}]`, `MediaProfile` của tenant, `knownCodes`.

Với mỗi file, gọi `parseMediaFileName(fileName, profile, { knownCodes })`:

- `ok: false` → vào `unassigned[]`, mang theo `issue` (`EMPTY_NAME` / `NO_PRODUCT_CODE`) và `detail`
  (câu tiếng Việt parser đã có sẵn). **Không im lặng bỏ file nào** (rule nghiệp vụ 5).
- `ok: true` → khoá nhóm = `` `${productCode}::${color ?? ""}` ``.

Trong nhóm:

- Sắp theo `sequence` tăng dần, `null` xuống cuối, hoà thì theo tên — **đúng thuật toán `compose-post`
  đang dùng**, để thứ tự trong modal khớp thứ tự album thật.
- Ảnh đầu tiên = bìa. Operator đổi được.

Tách nhóm, theo thứ tự:

1. Nhóm lẫn ảnh và video → tách thành nhóm ảnh và nhóm video. Ở khâu phân loại, **tách là hành vi đúng**;
   `assertOneAlbumKind` vẫn là cổng cuối ở `confirm-upload`, không bỏ.
2. Nhóm video nhiều clip → mỗi clip một nhóm (một bài video = một clip).
3. Nhóm > `MAX_UPLOADS_PER_POST` (10) → cắt thành nhóm con, đánh dấu `splitFrom` để modal nói rõ
   "đã tách vì quá 10 ảnh", chứ không âm thầm cắt.

Cảnh báo mang lên nhóm: `MULTIPLE_PRODUCT_CODES` (tên có 2 mã — 739 file thật theo doc 05),
`REPEATED_PRODUCT_CODE`, `MISSING_SEQUENCE`, `UNKNOWN_COLOR`.

Tên có 2 mã → gán vào mã **đứng đầu**, một bài, kèm cảnh báo và cho sửa trong modal (PM chốt 26/08/2026).

## 6. Server

### 6.1 `POST /api/posts/uploads/plan`

Auth tier M, role `editor`, **trước khi** đọc body — cùng chuẩn với route upload.
Body zod: `{ files: [{ fileName, mimeType, sizeBytes }] }`, tối đa `MAX_FILES_PER_BATCH`.

Usecase `core/usecases/plan-upload-groups.ts`:

1. Edge case trước: mảng rỗng → `INVALID_INPUT`; quá cap lô → `INVALID_INPUT` nói rõ số;
   tổng byte quá cap → `INVALID_INPUT`; mime ngoài allowlist → file đó vào `unassigned` với lý do riêng.
2. `catalogConfig` → `resolveMediaProfile`.
3. `products.listCodes(tenantId)` → `knownCodes`. **Method repo mới** — hôm nay chỉ `sync-catalog`
   dựng tập này trong bộ nhớ (dòng 591), chưa có đường đọc lại.
4. Gom nhóm bằng domain thuần ở mục 5.
5. Mỗi nhóm: `products.findByCode` →
   - không có row → `status: 'unknown'` (modal mở form nhập tay);
   - có row → `evaluateProductInventory` → `'ok'` | `'blocked'` | `'stock-skipped'`, kèm `blockedReason`.

Trả: `{ groups, unassigned, limits: { maxFilesPerPost, maxFilesPerBatch, maxBytesPerFile, maxBytesPerBatch } }`.

Cap chốt: `MAX_FILES_PER_BATCH = 60`, `MAX_BYTES_PER_BATCH = 300MB`, `MAX_UPLOADS_PER_POST = 10`
(giữ nguyên), `MAX_UPLOAD_BYTES = 25MB` (giữ nguyên). 300MB nằm dưới ngưỡng body 100MB của Cloudflare
vì mỗi lần PUT chỉ một file, không phải cả lô một request.

Cap phát từ server chứ không hằng số trong bundle UI, để đổi cap không phải build lại front-end.
UI vẫn giữ hằng số riêng làm chặn đầu (đúng như `UploadPanel` hôm nay dùng `MAX_UPLOAD_FILES`) — nó chỉ
để tránh một request vô ích, **server mới là bên quyết định**. Khi hai bên lệch, UI lấy số của server
từ lần `plan` gần nhất.

### 6.2 Thay đổi `confirm-upload`

Spec MinIO định nghĩa `confirm-upload.ts`. Spec này thêm hai điều vào đó:

- Nhận `color?: string`, chuẩn hoá bằng `normalizeColorName`, ghi `color` + `colorRaw` lên asset.
- Nhóm **đã gộp màu**: gửi `color` rỗng → asset ghi `color: null` nhưng **giữ `colorRaw`** là tên màu
  gốc của từng file. `composePost` khi đó gọi không kèm `colors`, `restrictToDominantColor` gom tất cả
  về một khoá `""` → một album, không cảnh báo. Không sửa `compose-post` dòng nào.
- `discardPreviousUploads` thu hẹp từ `(tenant, mã)` xuống `(tenant, mã, màu)`; màu rỗng là **một khoá
  riêng**, không phải "mọi màu". Nếu không thu hẹp, tải nhóm `MG123-TRẮNG` rồi `MG123-ĐEN` thì nhóm thứ
  hai xoá sạch nhóm thứ nhất.
- Kéo theo: `MediaRepo.listUnreferencedUploadsForCode(tenantId, code, color)` + query adapter.

`needsReview` vẫn `false`: cờ đó nghĩa là "tên file phá chuẩn, cần người nhìn lại", mà ở đây người đã
nhìn — modal chính là khâu review. Cảnh báo tên file vẫn ghi vào `warnings` để truy vết.

### 6.3 Vì sao không sinh N bản nháp

`PostDraftRepo` upsert theo bộ ba (tenant, operator, …) — **một nháp cho mỗi operator mỗi tenant**.
Sinh N nháp đòi bỏ ràng buộc đó và thêm khoá nháp: đổi schema, đổi autosave, đổi màn khôi phục nháp.
Đổi lại chẳng được gì mà bước 2 của modal không làm được. Nên: **không đụng `post_draft`.**

## 7. Modal

### 7.1 Khi nào mở

Mở khi **bất kỳ** điều nào đúng: ra hơn một nhóm · có file trong `unassigned` · có nhóm `unknown`
hoặc `blocked` · có nhóm bị tách.

Ngược lại — đúng một nhóm sạch — **không mở modal**: điền sẵn mã và màu vào wizard, operator làm tiếp
như hôm nay. Bắt xác nhận một hộp thoại cho một bài là thêm click vô nghĩa.

### 7.2 Bước 1 — phân loại

Trái: danh sách nhóm (`mã · màu · n ảnh · nhãn trạng thái`). Phải: lưới preview của nhóm đang chọn.

Thao tác mỗi nhóm: sửa mã (dùng lại picker gợi ý mã ở `product-suggestions.ts`) · sửa màu · kéo đổi
thứ tự và **đặt ảnh bìa** (dùng lại `AlbumArranger`, đã có đường bàn phím) · bỏ ảnh · tách nhóm · kéo ảnh từ khay
"Chưa gán mã" vào.

**Gộp nhóm** mở khi hai nhóm **cùng mã**, kể cả khác màu (PM chốt 26/08/2026 — xem mục 14):

- gộp lại các nhóm con vừa bị tách vì quá 10 ảnh;
- gộp nhiều màu của một mã thành một bài, khi operator muốn thế.

**Mặc định vẫn tách theo màu.** Gộp là thao tác operator chủ động bấm, không phải hành vi tự động.
Gộp xong mà quá 10 ảnh thì nút tắt, kèm lý do. Nhóm đã gộp hiện nhãn "đa màu" và liệt kê các màu gốc.

Gộp hai **mã** khác nhau: không bao giờ — một bài nói về một sản phẩm.

Nhóm `unknown` mở form nhập tay: **Tên sản phẩm · Mô tả · Chủng loại · Mùa vụ** — đúng whitelist của
rule nghiệp vụ 2, không có ô Tồn, Lưu ý hay bất kỳ cột giá nào. Dữ liệu đi qua `composePost`
(`manualProduct`), usecase tự lưu lại.

Nút sang bước 2 **tắt** khi còn: nhóm thiếu mã · nhóm `blocked` · ảnh chưa gán trong khay. Câu giải
thích nói rõ còn bao nhiêu cái và loại nào, không nói chung chung "chưa hợp lệ".

### 7.3 Bước 2 — duyệt caption

Với mỗi nhóm, tuần tự: `tickets` → PUT lên MinIO (tối đa 3 luồng song song, có tiến độ và huỷ) →
`confirm` → `composePost({ productCode, colors: [color], source: 'upload', manualProduct? })` →
`generateCaptions`. Caption sinh xong hiện ra cho operator sửa từng bài từng kênh.

Đây là chỗ giữ khâu "người duyệt" trong thứ tự bất biến của rule nghiệp vụ 1, mà không phải đụng
`post_draft`. Màn Chạy hàng loạt hiện tại **bỏ** khâu này; spec này không đi theo tiền lệ đó.

Kênh, tone, giãn cách, hẹn giờ: chọn **một lần** cho cả lô, áp cho mọi nhóm — dùng lại đúng các ô của
`BulkRunScreen`. Caption thì mỗi kênh một bản, không dùng chung (brief §7.2).

### 7.4 Chạy

`createPostBatch` cho từng nhóm, tuần tự. Bảng tiến độ theo khuôn `BulkProgressTable`: một nhóm lỗi thì
dòng đó đỏ kèm lý do, các nhóm khác chạy tiếp (rule nghiệp vụ 6, theo tinh thần).

### 7.5 Tiếp cận được

Dialog có focus trap và trả focus về nút mở. Mọi thao tác kéo-thả có đường bàn phím tương đương — đã có
tiền lệ ở `AlbumArranger` (`KeyboardSensor` + nút ↑ ↓ / Đặt làm bìa). Preview có `alt` là tên file.

Live region báo tiến độ nhưng **chỉ đọc khi trạng thái đổi**, không đọc lại mỗi vòng poll — lỗi này đã
sửa một lần ở commit `5a9b78a`, không tái phạm.

## 8. Thay đổi hành vi: ghi màu lên asset upload

Hôm nay `upload-media.ts` cố ý đặt `color: null` với lý do ghi trong code: mode B không có convention
tên file nên đoán màu là bịa. Spec này lật lại điều đó — nhưng **màu không còn do đoán**, nó do parser
đọc ra và operator đã xác nhận trong modal.

Rủi ro kéo theo, phải giữ được:

- `compose-post` lọc màu rồi `restrictToDominantColor` gom theo `asset.color ?? ""`. Asset upload cũ
  (`color: null`) và asset mới (có màu) cùng một mã sẽ thành hai nhóm màu khác nhau.
- Vì `discardPreviousUploads` nay thu hẹp theo màu, hai nhóm đó **cùng tồn tại** thay vì đè nhau.
- Nhánh "không phân màu" phải chạy y hệt hôm nay: nhóm không đọc được màu → `color: null` →
  `composePost` gọi **không kèm** `colors`, để `restrictToDominantColor` tự xử.

Test hồi quy bắt buộc: một bài upload không màu, tạo theo đường cũ, vẫn compose và đăng được nguyên vẹn.

## 9. Lỗi và log

Mã lỗi mới: `UPLOAD_PLAN_EMPTY`, `UPLOAD_PLAN_TOO_MANY_FILES`, `UPLOAD_PLAN_TOO_MANY_BYTES`,
`UPLOAD_GROUP_UNRESOLVED_CODE`, `UPLOAD_GROUP_BLOCKED_STOCK`.

Mỗi log entry kèm `tenant_id`, `batch_id` khi đã có, mã sản phẩm, màu, số file, `error_code`.
Nhánh nghiệp vụ phải log đủ để trả lời "vì sao ảnh này không thành bài" mà không cần debug: file nào
rơi vào khay và vì sao, nhóm nào bị tách và vì sao, nhóm nào bị chặn tồn kho.

## 10. Kiểm chứng

Unit thuần (`upload-grouping`): tên chuẩn 1 mã 1 màu nhiều số đuôi → 1 nhóm đúng thứ tự · 1 mã 2 màu →
2 nhóm · 3 mã → 3 nhóm · 12 ảnh cùng mã cùng màu → 2 nhóm có `splitFrom` · trộn ảnh video → 2 nhóm ·
2 video → 2 nhóm · `IMG_1234.jpg` → `unassigned` · tên rỗng → `unassigned` · tên 2 mã → 1 nhóm + cảnh báo ·
tên có mã không thuộc `knownCodes` và không khớp pattern nội bộ → `unassigned`.

Usecase (`plan-upload-groups`, fake repo): mã không có row → `unknown` · mã hết hàng → `blocked` kèm
`blockedReason` · tenant khác không thấy mã của tenant này · quá cap lô → từ chối cả lô.

`confirm-upload`: tải `MG123-TRẮNG` rồi `MG123-ĐEN` → **cả hai còn**, không đè nhau. Đây là test chống
hồi quy cho rủi ro nặng nhất của spec.

Tích hợp, stack thật (`docker compose up`), chạy hết luồng kể cả case sai:

1. Thả 12 ảnh của 3 mã (một mã 2 màu) → modal ra 4 nhóm → chạy → 4 batch, ảnh đúng nhóm, bìa đúng.
2. Thả kèm 2 ảnh `IMG_*.jpg` → vào khay → gán tay → thành bài.
3. Thả mã chưa đồng bộ → nhập tay → caption sinh ra có tên sản phẩm vừa gõ.
4. Thả mã hết hàng → nhóm bị chặn, nút chạy tắt, câu giải thích đúng mã.
5. Bỏ 3 ảnh ở bước 1 → 3 ảnh đó **không** có ticket, **không** có object trên MinIO.
6. Ngắt mạng giữa lúc PUT nhóm 2 → nhóm 1 đã xong vẫn nguyên, nhóm 2 báo lỗi, nhóm 3 vẫn chạy.
7. Hồi quy: bài upload không màu theo đường cũ vẫn đăng được.

`pnpm verify` (typecheck · lint · depcruise · test · build) exit 0, và kiểm artifact thật chứ không tin
exit code.

## 11. Rủi ro

| # | Rủi ro | Bù |
|---|---|---|
| 1 | Thu hẹp `discardPreviousUploads` sai → nhóm sau xoá nhóm trước, hoặc để rác | Test `confirm-upload` ở mục 10; sweep giờ dọn phần sót |
| 2 | Ghi màu lên asset upload làm gãy bài upload cũ | Test hồi quy 7; nhánh "không phân màu" giữ nguyên đường gọi |
| 3 | `products.listCodes` với tenant nhiều mã → truy vấn nặng mỗi lần thả file | Cache Redis theo tenant, hết hạn khi sync xong; giới hạn số mã đọc |
| 4 | Modal ôm quá nhiều việc, phình thành file khổng lồ | Luật gom nhóm nằm ở domain thuần; state modal nằm ở `upload-triage.ts` thuần; component chỉ vẽ |
| 5 | Lô lớn làm bước 2 chạy rất lâu, operator đóng tab | Chạy tuần tự có tiến độ, nói rõ đóng tab thì mất; đã có tiền lệ câu chữ ở `BulkRunScreen` |

## 12. Trạng thái quyết định

Mọi câu đã chốt — bảng đầy đủ ở **mục 3**. Hai câu cần đọc thêm phần thiết kế đi kèm:
`Duyệt caption ở màn Chạy hàng loạt` → mục 13 · `Gộp màu` → mục 14.

Không còn `PENDING` nào trong spec này.

## 13. Duyệt caption cho màn Chạy hàng loạt

PM chốt bổ sung khâu duyệt cho cả `BulkRunScreen`, cùng kiểu modal. Thiết kế: **một component duy nhất**
`CaptionReviewDialog`, dùng chung cho hai chỗ.

- Vào: `[{ groupId, productCode, color, media[], captionByChannel }]`.
- Ra: bản đã sửa, hoặc huỷ.
- Màn Soạn bài gọi nó ở bước 2 của modal phân loại.
- Màn Chạy hàng loạt gọi nó **sau khi vòng lặp sinh xong caption cho mọi mã, trước khi tạo batch đầu tiên**.
  Nghĩa là `useBulkRun` phải tách làm hai chặng: chặng sinh (compose + captions) rồi dừng lại chờ duyệt,
  chặng đăng (createPostBatch) chạy sau khi operator bấm duyệt.

Đây là **thay đổi hành vi của màn Chạy hàng loạt đang chạy**: hôm nay nó chạy một mạch từ mã tới batch.
Sau thay đổi nó dừng giữa chừng. Cần: nói rõ trên UI rằng còn một bước duyệt nữa, và giữ được kết quả
đã sinh khi operator đang duyệt (không mất nếu bấm nhầm ra ngoài dialog).

Rủi ro riêng: lô 50 mã thì dialog duyệt có 50 bài × n kênh. Phải phân trang hoặc cuộn theo nhóm, và
phải có nút "duyệt hết" cho người tin AI — nếu không khâu duyệt biến thành cực hình và operator sẽ bấm
bừa, tức là tệ hơn không có.

## 14. Gộp màu (`C3/C4`) — dữ kiện và khuyến nghị

Tra lại code, hai sự thật quyết định câu này:

1. **Tồn kho tính theo mã, không theo màu.** `evaluateProductInventory` chỉ đọc `code`, `stockRaw`,
   `noteRaw`, `hasConflict` từ `Product` — không có chiều màu. Gộp màu **không** làm hỏng cổng tồn kho.
2. **Màu không bao giờ đến AI.** `toPromptInput` trả về đúng `code · name · description · category ·
   season`. `generate-captions.ts` không có một chữ "color" nào.

Hệ quả của (2) là lập luận mạnh nhất, và nó chống lại việc tách màu: một mã 4 màu tách thành 4 bài thì
**4 caption sinh ra từ đúng một đầu vào**, gần như chắc chắn giống nhau. Điều đó đụng thẳng luật `D1`
đang treo của chính dự án ("không trùng >8 từ liên tiếp"). Cộng thêm giãn cách 5 phút, feed nhận 4 bài
na ná nhau rải suốt 20 phút — trông như spam.

Ngược lại, gộp màu **không** phá khoá chống trùng: `postJobDuplicateKey` có chiều màu, gộp thì màu rỗng
và hai bài gộp cùng mã trong một batch vẫn đụng khoá đúng như mong muốn.

**Cách làm, nếu PM đồng ý gộp — không sửa `compose-post` một dòng nào:**

Nhóm đã gộp → `confirm-upload` ghi `color: null` cho mọi asset của nhóm (bài này không thuộc màu nào),
nhưng giữ `colorRaw` là tên màu gốc để truy vết. Rồi `composePost` gọi **không kèm** `colors`, nên
`restrictToDominantColor` gom theo `asset.color ?? ""` — tất cả cùng một khoá, ra **một album, không
cảnh báo**. Chính là đường mà bài upload không màu đang đi hôm nay.

**PM chốt 26/08/2026:** cho gộp. Mở nút "gộp các màu của mã này thành một bài" trong modal,
**mặc định vẫn tách theo màu** như hiện tại.

Phạm vi của quyết định này hẹp đúng như vậy: nó chỉ áp cho lô đang phân loại ở chế độ B. Đường Drive
**không đổi** — bài soạn từ ảnh Drive vẫn tách màu như hôm nay.

Câu còn lại chưa hỏi: "mặc định có nên đổi thành gộp cho cả đường Drive không". Nó ảnh hưởng rộng hơn
spec này nhiều, và nên hỏi sau khi có số liệu thật về caption trùng — không đoán trước.
