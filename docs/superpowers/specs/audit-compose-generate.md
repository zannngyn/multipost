# Phương án xử lý luồng tạo bài đăng

## 1. Mục tiêu

Hệ thống hiện có hai cách để tạo một bài đăng và hai luồng này cần được giữ độc lập ở bước xác định dữ liệu đầu vào, nhưng cuối cùng hội tụ vào cùng pipeline `compose → caption → create batch → schedule/publish`.

### Luồng A — Chọn mã sản phẩm

User chọn hoặc nhập một `productCode` đã có trong Product Catalog.

Hệ thống:

1. Resolve `productCode` trong Product Catalog.
2. Lấy thông tin sản phẩm để phục vụ generate caption.
3. Lấy media hiện có của sản phẩm từ Drive.
4. User chọn/sắp xếp album.
5. Generate caption dựa trên dữ liệu sản phẩm.
6. Tạo post.
7. Schedule hoặc publish.

### Luồng B — Upload ảnh để tự nhận diện mã

User **không cần chọn Product Code trước**.

User chỉ upload ảnh. Hệ thống:

1. Phân tích filename.
2. Detect `productCode`.
3. Resolve mã với Product Catalog.
4. Nếu tồn tại → lấy Product metadata nhưng **chỉ dùng ảnh vừa upload cho bài này**.
5. Caption được generate từ **ảnh upload**, có thể kết hợp Product metadata đã resolve để bổ sung context.
6. Nếu không resolve được mã → cho user `Đồng bộ lại` hoặc `Nhập mã`.
7. Không ghi ảnh upload ngược vào Drive/Sheet.
8. Vẫn lưu metadata/asset/post snapshot trong DB để có thể truy lịch sử.

---

# 2. Nguyên tắc quan trọng

## 2.1 Product Catalog là nguồn dữ liệu chuẩn

Product Catalog dùng để:

* xác định product có tồn tại hay không;
* lấy metadata sản phẩm;
* kiểm tồn;
* cung cấp context cho caption.

Không dùng Product Catalog để quyết định ảnh upload nào sẽ được đăng.

## 2.2 Drive và Upload là hai nguồn media khác nhau tùy theo entry flow

### Luồng A

```text
Product
  ↓
Drive media
  ↓
Final album
```

### Luồng B

```text
Uploaded files
  ↓
Final album
```

Ở Luồng B, việc Product tồn tại trong hệ thống chỉ giúp resolve metadata. Không được vì Product có sẵn 10 ảnh Drive mà tự động lấy 10 ảnh đó để thay thế hoặc trộn vào 5 ảnh user vừa upload.

## 2.3 Upload không tự động cập nhật Product Catalog

Upload không được:

* tạo Product mới;
* thêm ảnh vào Product gallery chính;
* ghi ngược filename/SKU vào Google Sheet;
* copy ảnh vào Drive chỉ để "đồng bộ".

Ảnh upload phục vụ bài đăng hiện tại và được lưu đủ lâu để phục vụ post/history theo retention policy.

## 2.4 Post phải lưu snapshot

Khi user bấm Đăng, post phải đóng băng:

* product code đã resolve;
* product metadata cần thiết;
* caption;
* danh sách media;
* thứ tự media;
* nguồn media.

Không được phụ thuộc vào việc Product hoặc Drive media còn tồn tại sau này.

Audit hiện tại đã có mô hình phù hợp ở `post_job.media` và `post_job.product_code`, vì post hiện tại đã lưu snapshot thay vì FK trực tiếp tới `media_asset`.

---

# 3. Luồng A — Chọn mã sản phẩm

## 3.1 User chọn Product Code

Input:

```text
BG0SQ6083
```

Có thể đến từ:

* ProductPicker;
* input;
* deep link hiện tại.

## 3.2 Resolve Product

```text
productCode
   ↓
normalizeProductCode()
   ↓
find product
```

Nếu tồn tại:

```text
Product {
  code
  name
  description
  category
  season
  stock
  ...
}
```

## 3.3 Load media từ Drive

Lấy các `media_asset` có:

```text
origin = drive
product_code = BG0SQ6083
```

Sau đó áp dụng logic hiện tại:

```text
kind
color
sequence
cover
MAX_AUTO_MEDIA
...
```

Audit hiện tại xác nhận compose đang:

1. đọc toàn bộ media của mã;
2. lọc theo `origin`;
3. lọc `kind`;
4. lọc màu;
5. chọn album theo sequence.

Trong Luồng A, đây vẫn là behavior hợp lệ.

## 3.4 Generate caption

Caption lấy Product metadata:

```text
name
description
category
season
```

Audit hiện tại xác nhận route caption đang sử dụng đúng 4 trường này và hiện tại chưa truyền vision image vào AI.

Luồng mới không cần phá behavior này nếu Luồng A vẫn dùng product-text caption.

## 3.5 Create Post

Sau khi user confirm:

```text
PostBatch
  └── PostJob
       ├── productCode
       ├── productOrigin
       ├── caption
       └── media snapshot
```

Sau đó giữ nguyên scheduling/queue/worker hiện tại.

---

# 4. Luồng B — Upload ảnh tự nhận diện Product Code

Đây là luồng cần thay đổi chính.

## 4.1 Entry point

User vào màn Compose nhưng **không bắt buộc nhập Product Code trước**.

User chọn:

```text
[Upload ảnh]
```

và upload `1..N` file.

Ví dụ:

```text
BG0SQ6083-AI (1).png
BG0SQ6083-AI (2).png
BG0SQ6083-AI (3).png
IMG_8821.png
```

Upload vẫn đi qua cơ chế ticket → presigned MinIO → confirm hiện tại.

Audit cho thấy đường upload đang chạy thực tế là:

```text
tickets → browser → MinIO → confirm
```

và route upload multipart cũ là deprecated.

---

# 5. Filename Parser cho Upload

## 5.1 Quy tắc nhận diện Product Code

**Product Code là toàn bộ phần đứng trước dấu `-` đầu tiên, sau khi bỏ extension và normalize.**

Ví dụ:

```text
BG0SQ6083-AI (5).png
→ BG0SQ6083
```

```text
BG0SQ6083-ĐEN-01.png
→ BG0SQ6083
```

```text
BG0SQ6083 - AI (5).png
→ BG0SQ6083
```

```text
BG0SQ6083.png
→ BG0SQ6083
```

Với filename không có dấu `-`, hệ thống có thể dùng toàn bộ stem làm candidate nhưng chỉ chấp nhận sau khi lookup Product Catalog thành công.

Ví dụ:

```text
IMG_8821.png
→ candidate = IMG_8821
→ catalog không có
→ unresolved
```

## 5.2 Không dùng `-AI` làm một phần của Product Code

Đây là điểm phải sửa so với cách hiểu/parser trước đây.

```text
BG0SQ6083-AI (5).png
```

không có nghĩa:

```text
BG0SQ6083-AI
```

mà:

```text
productCode = BG0SQ6083
```

`AI`, `THỰC TẾ`, `MẶT SAU`, màu, sequence... chỉ là phần hậu tố/metadata filename.

## 5.3 Parser không nên là một regex khổng lồ

Nên tách:

```ts
parseUploadedFilename(filename)
```

trả về:

```ts
{
  originalFilename: string,
  stem: string,
  detectedProductCode: string | null,
  suffix: string | null,
  sequence: number | null
}
```

Sau đó:

```ts
resolveDetectedProductCode(...)
```

làm nhiệm vụ lookup Catalog.

Regex/parser chỉ detect candidate, không tự quyết định Product.

---

# 6. Group upload theo Product Code

Một batch có thể chứa nhiều Product.

Ví dụ:

```text
BG0SQ6083-AI (1).png
BG0SQ6083-AI (2).png
BG0SQ6084-AI (1).png
BG0SQ6084-AI (2).png
IMG_123.jpg
```

Phải group thành:

```text
BG0SQ6083
 ├── image 1
 └── image 2

BG0SQ6084
 ├── image 1
 └── image 2

UNRESOLVED
 └── IMG_123.jpg
```

Không được coi toàn bộ batch là một Product.

Mỗi `detectedProductGroup` là một candidate post context.

---

# 7. Resolve Product cho từng group

Sau khi detect:

```text
BG0SQ6083
```

lookup:

```text
Product Catalog
```

## Case A — Product tồn tại

```text
BG0SQ6083 ✅
```

UI:

```text
Đã nhận diện mã: BG0SQ6083

[Tiếp tục với mã này]
```

Khi user bấm:

```text
resolvedProduct = BG0SQ6083
```

Hệ thống lấy:

```text
Product metadata
```

nhưng album là:

```text
uploaded assets của group này
```

Không load gallery Drive cho post này.

---

# 8. Case B — Detect được mã nhưng không tồn tại

Ví dụ:

```text
BG0SQ9999
```

Catalog:

```text
NOT FOUND
```

Không tạo Product.

UI:

```text
Không tìm thấy sản phẩm BG0SQ9999

[Đồng bộ lại dữ liệu]
[Nhập mã BG0SQ9999]
```

## 8.1 Đồng bộ lại

```text
Sync Product Catalog
       ↓
lookup BG0SQ9999 again
```

Nếu tìm thấy:

```text
MATCHED
```

→ tiếp tục.

Nếu vẫn không tồn tại:

```text
NOT_FOUND
```

→ giữ user ở màn resolve.

## 8.2 Nhập mã

Nút phải tự prefill mã vừa detect:

```text
Mã nhận diện được:

BG0SQ9999

[Nhập mã này]
```

Khi bấm:

```text
input value = "BG0SQ9999"
```

User vẫn được phép sửa:

```text
BG0SQ6083
```

Sau đó lookup Catalog.

Điểm quan trọng:

> User không phải nhớ hoặc gõ lại mã mà hệ thống vừa nhận diện.

---

# 9. Case C — Không detect được Product Code

Ví dụ:

```text
IMG_8821.png
IMG_8822.png
```

Parser:

```text
detectedProductCode = null
```

UI:

```text
Không nhận diện được mã sản phẩm

[Đồng bộ lại dữ liệu]
[Nhập mã sản phẩm]
```

Nếu user chọn nhập mã:

```text
BG0SQ6083
```

→ lookup Catalog.

Nếu tồn tại:

```text
resolvedProduct = BG0SQ6083
```

và ảnh vẫn là ảnh upload.

---

# 10. Caption của Luồng B phải là Vision-based

Đây là khác biệt business quan trọng nhất giữa hai flow.

## Luồng A

```text
Product metadata
    ↓
AI
    ↓
Caption
```

## Luồng B

```text
Uploaded images
       +
Resolved Product metadata
       ↓
Vision AI
       ↓
Caption
```

Ảnh upload là input chính cho caption generation.

Product metadata chỉ làm context.

Ví dụ:

```text
Product:
BG0SQ6083
Category:
Áo sơ mi
Season:
Thu Đông
```

cộng với:

```text
5 uploaded images
```

AI nhận cả hai.

Không được dùng:

```text
Product text only
```

làm input duy nhất cho Luồng B.

Audit hiện tại xác nhận `vision.mode = "none"` nên implementation này cần thay đổi riêng cho upload flow.

---

# 11. Upload asset không trở thành Product Media

Sau khi confirm upload:

```text
media_asset
```

có thể tiếp tục tồn tại trong DB với:

```text
origin = upload
```

nhưng semantics phải là:

```text
Uploaded Asset
```

chứ không phải:

```text
Official Product Media
```

Không tự biến:

```text
BG0SQ6083-AI (1).png
```

thành ảnh chính thức của:

```text
BG0SQ6083
```

---

# 12. Xử lý retention của Upload

Upload không được giữ vô hạn nếu chỉ phục vụ post.

Nên có lifecycle:

```text
UPLOADED
   ↓
RESOLVED
   ↓
USED_BY_POST
   ↓
RETAINED
   ↓
EXPIRED
   ↓
CLEANED
```

Quy tắc xóa:

* chưa được post reference → giữ theo TTL;
* đã được post reference → giữ tối thiểu theo retention;
* không được xóa asset nếu một post đang cần nó;
* không cần copy sang Drive.

Hiện hệ thống đã có `cleanup-uploads` và cơ chế không xóa upload mà `post_job.media` còn tham chiếu, nên có thể mở rộng từ cơ chế này thay vì dựng hệ thống cleanup hoàn toàn mới.

---

# 13. Final Album

Sau khi Product đã resolve và caption đã generate, user được xem album.

### Luồng A

```text
Drive images
```

### Luồng B

```text
Uploaded images
```

User có thể:

* reorder;
* remove;
* chọn cover;
* confirm.

Final album phải là một danh sách explicit:

```ts
[
  {
    assetId,
    origin: "upload",
    fileName,
    kind: "image"
  }
]
```

Hoặc:

```ts
[
  {
    assetId,
    origin: "drive",
    fileName,
    kind: "image"
  }
]
```

**Không dùng `source` để quyết định album sau khi final selection đã hoàn thành.**

`source=drive|upload` hiện tại là nguyên nhân làm hai kho ảnh mutually exclusive; audit xác nhận compose hiện lọc đúng một origin theo `source`.

Nên coi `source/origin` là metadata của asset, không phải business command cho Post.

---

# 14. Create Post

Khi user bấm Đăng:

```text
resolvedProduct
+
caption
+
finalAlbum
+
channel
+
schedule
```

được snapshot vào `post_job`.

Ví dụ:

```json
{
  "productCode": "BG0SQ6083",
  "productOrigin": "sheet",
  "caption": "...",
  "media": [
    {
      "assetId": "upload_a1",
      "origin": "upload",
      "fileName": "BG0SQ6083-AI (1).png"
    },
    {
      "assetId": "upload_b2",
      "origin": "upload",
      "fileName": "BG0SQ6083-AI (2).png"
    }
  ]
}
```

Sau bước snapshot:

> Publish pipeline không cần biết bài đó đến từ Flow A hay Flow B.

Nó chỉ cần final `product + caption + media snapshot`.

---

# 15. Không thay đổi pipeline queue/publish hiện tại nếu không cần thiết

Sau khi `post_job` được tạo:

```text
post_job
  ↓
queued
  ↓
BullMQ
  ↓
worker
  ↓
inventory check
  ↓
Facebook publisher
```

Pipeline hiện tại đã có:

* queue;
* worker;
* inventory check lần cuối;
* scheduled handoff;
* Graph publish;
* reconcile Facebook schedule;
* retry/idempotency.

Không nên trộn logic upload detection vào worker.

Upload detection và Product resolution phải hoàn tất **trước khi tạo `post_job`**.

Audit hiện tại xác nhận DB/queue đã được tách rõ: create batch tạo job rồi enqueue, worker mới thực hiện publish.

---

# 16. Kiến trúc logical mới

```text
                       ┌───────────────────────┐
                       │       Compose UI      │
                       └───────────┬───────────┘
                                   │
                    ┌──────────────┴──────────────┐
                    │                             │
                    ▼                             ▼
          FLOW A: PRODUCT-FIRST         FLOW B: IMAGE-FIRST
                    │                             │
          User selects code                User uploads files
                    │                             │
                    ▼                             ▼
             Resolve Product             Parse filenames
                    │                             │
                    │                             ▼
                    │                      Detect product codes
                    │                             │
                    │                             ▼
                    │                      Group by product
                    │                             │
                    │                             ▼
                    │                       Resolve Product
                    │                             │
                    │                    ┌────────┴────────┐
                    │                    │                 │
                    │                  FOUND          NOT FOUND
                    │                    │                 │
                    │                    │         Sync / Manual
                    │                    │                 │
                    └───────────────┬────┴─────────────────┘
                                    │
                                    ▼
                            Product Context
                                    │
                         ┌──────────┴──────────┐
                         │                     │
                         ▼                     ▼
                 Drive Media             Upload Media
                  (Flow A)                (Flow B)
                         │                     │
                         └──────────┬──────────┘
                                    │
                                    ▼
                              Final Album
                                    │
                     ┌──────────────┴──────────────┐
                     │                             │
                     ▼                             ▼
               Text Caption                  Vision Caption
                  Flow A                       Flow B
                     │                             │
                     └──────────────┬──────────────┘
                                    │
                                    ▼
                               Post Snapshot
                                    │
                                    ▼
                              Post Batch
                                    │
                                    ▼
                              BullMQ Queue
                                    │
                                    ▼
                                Worker
                                    │
                                    ▼
                               Facebook
```

---

# 17. Data model đề xuất

Có thể tận dụng phần lớn schema hiện tại.

## `media_asset`

Giữ:

```text
id
tenant_id
drive_file_id / upload_<id>
product_code nullable
origin: drive | upload
storage_key
file_name
kind
sequence
...
```

Nhưng cần cho phép upload asset ở giai đoạn đầu:

```text
product_code = detected/resolved code hoặc null
```

trước khi resolve hoàn toàn.

## Thêm metadata resolution

Có thể thêm:

```text
detected_product_code
resolved_product_code
resolution_method
resolution_status
```

Ví dụ:

```text
detected_product_code = BG0SQ9999
resolved_product_code = BG0SQ6083
resolution_method = manual
resolution_status = matched
```

Điều này giúp audit chính xác:

> Hệ thống nhận diện gì và user đã chọn gì.

## `upload_session`

Nên có khái niệm session/batch:

```text
id
tenant_id
created_by
status
created_at
```

và asset:

```text
upload_session_id
```

Mục đích:

* gom các file user upload trong một lần;
* group theo Product;
* retry detection;
* truy lịch sử;
* retention/cleanup.

---

# 18. Trường hợp 5 ảnh upload + Product có 10 ảnh Drive

Đây là scenario bắt buộc phải pass.

Product:

```text
BG0SQ6083
```

Drive:

```text
10 images
```

Upload:

```text
5 images
```

Flow B:

```text
5 files
  ↓
detect BG0SQ6083
  ↓
Product exists
  ↓
5 uploaded assets
  ↓
Vision caption
  ↓
Final album = 5 uploaded assets
```

**Không được biến thành 15 ảnh.**

**Không được chọn 10 ảnh Drive thay cho 5 ảnh upload.**

**Không được merge tự động.**

Kết quả phải là:

```text
Post
Product: BG0SQ6083
Media: 5 uploaded images
```

---

# 19. Trường hợp upload nhiều Product

Upload:

```text
BG0SQ6083-AI (1).png
BG0SQ6083-AI (2).png

BG0SQ6084-AI (1).png
BG0SQ6084-AI (2).png
```

Hệ thống group:

```text
BG0SQ6083
  → 2 images
  → 1 candidate post

BG0SQ6084
  → 2 images
  → 1 candidate post
```

Không được silently gộp thành một post.

UI phải thể hiện rõ từng group.

---

# 20. Trường hợp filename không chuẩn

Ví dụ:

```text
BG0SQ6083-AI (5).png
```

→ `BG0SQ6083`

```text
BG0SQ6083 - AI (5).png
```

→ `BG0SQ6083`

```text
BG0SQ6083.png
```

→ candidate `BG0SQ6083`, sau đó lookup.

```text
IMG_8821.png
```

→ không có Product Code.

```text
XYZ9999-AI.png
```

→ detect `XYZ9999`, nhưng Product không tồn tại.

Điểm quan trọng:

> Filename parser chỉ tạo candidate; Product Catalog mới quyết định candidate đó có hợp lệ hay không.

---

# 21. UI state machine của Flow B

Nên có các trạng thái:

```text
UPLOADING
   ↓
PROCESSING
   ↓
DETECTED
   ↓
RESOLVING
   ↓
 ┌─────────────┬──────────────┐
 ▼             ▼              ▼
MATCHED     NOT_FOUND     NO_CODE
             │                │
             ▼                ▼
        SYNC / MANUAL    SYNC / MANUAL
             │                │
             └───────┬────────┘
                     ▼
                  MATCHED
                     ↓
               GENERATING_CAPTION
                     ↓
                READY_TO_POST
```

Không nên tạo `post_job` cho tới khi:

```text
Product resolved
+
Caption ready
+
Final album confirmed
```

---

# 22. Các thay đổi cần thực hiện trên code hiện tại

## A. Upload

Giữ cơ chế:

```text
ticket
→ direct upload MinIO
→ confirm
```

nhưng sau confirm cần chạy filename parser cho upload.

Hiện tại `confirmUpload` đang lấy `productCode` từ form và gán cùng mã cho mọi uploaded asset; đây là behavior cần bỏ đối với Flow B.

## B. Filename parser

Tái sử dụng domain parser hiện có nếu phù hợp, nhưng bổ sung behavior riêng cho upload:

```text
code = substring before first "-"
```

Không dùng profile Drive hiện tại một cách máy móc.

## C. Product Resolver

Tạo một use case/service riêng:

```ts
resolveUploadedAssets()
```

chịu trách nhiệm:

```text
assets
→ parse
→ group
→ lookup
→ unresolved
→ resolved
```

## D. Compose

Tách hai strategy:

```ts
composeFromProduct()
composeFromUpload()
```

thay vì dùng:

```ts
source = drive | upload
```

để quyết định toàn bộ behavior.

## E. Caption

Tách:

```ts
generateProductCaption()
generateVisionCaption()
```

Luồng B phải nhận ảnh upload.

## F. Post creation

Không thay đổi contract publish phía sau nếu không cần.

Chỉ đảm bảo `createPostBatch` nhận final snapshot.

---

# 23. Những thứ tuyệt đối không nên làm

### Không làm:

```text
Upload
→ tự tạo Product
```

### Không làm:

```text
Upload
→ thêm ảnh vào Drive
```

### Không làm:

```text
Product exists
→ lấy luôn ảnh Drive thay cho ảnh upload
```

### Không làm:

```text
Upload 5
+ Drive 10
→ tự động merge thành 15
```

### Không làm:

```text
filename regex
→ tự quyết định Product mà không lookup catalog
```

### Không làm:

```text
Không tìm thấy Product
→ silently fallback sang Product khác
```

### Không làm:

```text
Không detect code
→ bắt user rename file
```

---

# 24. Kết quả business cuối cùng

### User muốn dùng dữ liệu có sẵn

```text
Chọn mã
→ hệ thống lấy Product
→ lấy ảnh Drive
→ caption từ Product
→ đăng
```

### User có bộ ảnh mới

```text
Upload
→ hệ thống detect mã trước dấu "-"
→ tìm Product
→ giữ nguyên ảnh upload
→ caption từ ảnh upload
→ đăng
```

### User upload ảnh có mã nhưng mã chưa có

```text
Upload
→ detect code
→ không thấy Product
→ [Đồng bộ lại]
      hoặc
→ [Nhập mã detected]
→ resolve Product
→ caption từ ảnh upload
→ đăng
```

### User upload ảnh không có mã

```text
Upload
→ không detect
→ [Đồng bộ lại]
      hoặc
→ [Nhập mã]
→ resolve Product
→ caption từ ảnh upload
→ đăng
```

### Storage

```text
Không ghi ngược Drive
Không ghi ngược Sheet
```

nhưng:

```text
Upload Asset
→ DB metadata
→ Object Storage
→ Post snapshot
→ History
```

để sau này tra được:

* user nào upload;
* thời điểm nào;
* filename gốc;
* detect mã gì;
* resolve thành mã nào;
* bằng cách nào;
* ảnh nào đã dùng cho post nào;
* post nào đã publish.

---

# 25. Tiêu chí nghiệm thu

Implementation chỉ được coi là đúng khi pass các scenario sau:

```text
[ ] Chọn BG0SQ6083 → lấy Product info + Drive media
[ ] Chọn BG0SQ6083 → caption theo Product flow
[ ] Upload BG0SQ6083-AI (1).png → detect BG0SQ6083
[ ] Upload nhiều file cùng mã → group cùng Product
[ ] Product đã tồn tại → không dùng Drive media trong upload flow
[ ] Product đã tồn tại → caption dùng uploaded images
[ ] Product chưa tồn tại → không tạo Product
[ ] Product chưa tồn tại → nút Sync
[ ] Product chưa tồn tại → nút "Nhập BG0SQxxxx"
[ ] Không có code → Sync / nhập mã
[ ] User không phải tự gõ lại detected code
[ ] Upload không ghi vào Drive
[ ] Upload không ghi vào Sheet
[ ] Upload không tự trở thành Product Media chính thức
[ ] Post snapshot giữ đúng uploaded media
[ ] 5 upload + 10 Drive → post chỉ có 5 upload
[ ] Upload nhiều mã → tạo các candidate group riêng
[ ] Queue/worker/publish phía sau vẫn nhận được final post snapshot
[ ] Cleanup không xóa asset đang được post reference
```

## Kết luận

Điểm thay đổi cốt lõi không phải là “làm cho `source=upload` thông minh hơn”.

Cần chuyển từ mô hình:

```text
source = drive | upload
```

sang mô hình:

```text
ENTRY FLOW
  ↓
resolve Product
  ↓
xác định nguồn media theo flow
  ↓
final album
  ↓
caption strategy theo flow
  ↓
post snapshot
  ↓
pipeline publish chung
```

**Flow A là Product-first:**

```text
Product → Product info + Drive media → Product-text Caption
```

**Flow B là Image-first:**

```text
Upload → Detect Code → Resolve Product → Uploaded media + Product context → Vision Caption
```

Hai flow chỉ hội tụ **sau khi Product đã được resolve và final album đã xác định**.
