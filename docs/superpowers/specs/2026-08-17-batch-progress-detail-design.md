# Tiến độ chi tiết cho màn theo dõi lô đăng

Ngày: 2026-08-17 · Epic: E7.5 (đọc), E5/E7 (ghi), E10 (giao diện)

## 1. Vấn đề

Màn `Theo dõi lô đăng` hiện chỉ hiển thị được trạng thái thô của `post_job`:

```
fb-1121597217877301   Chờ đăng   0   Đang chờ trong hàng đợi để đăng
```

Người vận hành không trả lời được ba câu:

1. Bài đang ở bước nào?
2. Bước đó đã đi được bao nhiêu?
3. Còn bao lâu nữa?

Nguyên nhân: `post_job` chỉ lưu `status` (`draft | queued | publishing | ...`) và
`attempt_count`. Các mốc thật bên trong một lần đăng — chờ giãn cách, kiểm tồn kho
lần hai, đọc credential kênh, tải từng ảnh, gửi bài — đều đã tồn tại trong
`core/usecases/publish-post.ts` nhưng không được ghi lại ở đâu cả. Chúng chỉ đi vào
log của worker, nơi người vận hành không mở.

## 2. Phạm vi

Trong phạm vi:

- Ghi nhận và hiển thị tiến độ của một `post_job` trong lúc nó chạy.
- Lưu mốc lớn vào cơ sở dữ liệu để tra cứu sau khi tiến độ nóng đã hết hạn.
- Định dạng ảnh (`image_post`) đầy đủ; video/reels bắn sự kiện tối thiểu.

Ngoài phạm vi:

- Ước lượng thời gian dựa trên lịch sử các lô trước (đã cân nhắc và loại bỏ, mục 4.3).
- Kết nối giữ lâu (SSE/WebSocket) — giữ nguyên mô hình poll (mục 9).
- Tiến độ chi tiết cho TikTok (Phase 2).

## 3. Nguyên tắc chặn trước

Ba luật này đứng trên mọi chi tiết kỹ thuật bên dưới. Vi phạm là FAIL ở khâu review.

### 3.1. Trạng thái là chân lý, tiến độ là lớp trang trí

`post_job.status` trong Postgres là nguồn chân lý duy nhất về việc một bài đã lên hay
chưa. Tiến độ là dữ liệu bổ trợ, có thể thiếu, có thể cũ, có thể mất.

Hệ quả bắt buộc ở tầng giao diện: chỉ vẽ tiến độ khi `status ∈ {queued, publishing}`.
Một bài đã `failed` mà key Redis vẫn còn `uploading_media 3/10` thì **không** được vẽ
thanh tiến độ — worker chết giữa chừng là tình huống có thật, và màn hình nói "đang tải
ảnh" cho một bài đã chết là lỗi tệ hơn việc không có tiến độ.

### 3.2. Không bịa thời gian còn lại

Trường `waitUntil` chỉ được set khi hệ thống đã tính ra một con số thật:

- chờ giãn cách — `spacingWaitMs` trong `publish-post.ts` §2;
- chờ tới cửa sổ giao lịch — `scheduledAt` trừ `HANDOFF_WINDOW_START_MS`;
- chờ tới giờ hẹn — `scheduledAt`.

Bước tải ảnh **không bao giờ** có `waitUntil`. Nó có `doneCount/totalCount`, đó là sự
thật; suy ra "còn khoảng 25 giây" từ tốc độ ba ảnh đầu là phỏng đoán, và một tấm ảnh
9 MB sau ba tấm 400 KB sẽ biến phỏng đoán đó thành lời nói dối.

Luật này được thực thi ở tầng kiểu dữ liệu (chỉ hàm dựng của các stage chờ mới nhận
`waitUntil`), không phải ở tầng giao diện — để không ai vô tình thêm ước lượng sau này.

### 3.3. Ghi tiến độ hỏng không được làm hỏng bài đăng

Một lần `SET` Redis thất bại, một lần `INSERT` sự kiện thất bại, đều không được phép
làm một bài đăng thất bại theo. Chi tiết ở mục 5.2, bao gồm ngoại lệ có chủ đích với
chuẩn kỹ thuật #5.

## 4. Quyết định

### 4.1. Nơi lưu: Redis nóng + chốt mốc vào Postgres

Đã chốt với PM ngày 17/08/2026.

| | Redis | `post_job_event` (Postgres) |
|---|---|---|
| Ghi gì | mọi thay đổi, kể cả từng ảnh | chỉ mốc lớn |
| Tần suất | ~15 lần / bài | ~6–8 dòng / bài |
| Vòng đời | TTL 1 giờ | vĩnh viễn |
| Dùng cho | màn theo dõi đang chạy | tra cứu "lô hôm qua chậm ở đâu" |

Chọn bảng append-only riêng thay vì thêm cột vào `post_job`: không làm nóng hàng chính
(mỗi ảnh một `UPDATE` lên hàng đang bị worker khác đọc là cách tự tạo tranh chấp), và
một dòng lịch sử có `occurred_at` trả lời được câu hỏi thời lượng mà một cột "trạng thái
mới nhất" không trả lời được.

### 4.2. Nhịp cập nhật: giữ poll, nhanh hơn khi đang chạy

1.5 giây khi có bài ở `publishing`; giữ 3–8 giây thích ứng như hiện tại khi chỉ nằm chờ;
dừng hẳn khi lô đã kết thúc.

Loại bỏ SSE: ghi chú trong `BatchStatusScreen.tsx` đã chốt mô hình "không giữ kết nối
lâu", và một kết nối giữ lâu kéo theo xử lý reconnect, proxy timeout, và một đường ghi
mới từ worker lên web — cái giá không tương xứng với việc rút từ 3 giây xuống tức thời.

### 4.3. Ước lượng: chỉ nói cái biết chắc

Đã cân nhắc và loại bỏ hai phương án:

- *Ngoại suy trong cùng bài* (lấy tốc độ các ảnh đã xong nhân cho số ảnh còn lại): sai
  khi kích thước ảnh lệch nhau, mà album thật thì luôn lệch.
- *Học từ lịch sử các lô trước*: cần bảng đo lường riêng, cần thời gian tích luỹ, và lô
  đầu tiên vẫn không có số.

Cái được hiển thị thay thế đều là sự thật kiểm chứng được: bước đang chạy, `3/10` ảnh,
tên file đang tải, "đã chạy 42 giây", và khi có deadline thật thì đếm ngược tới nó.

## 5. Thiết kế

### 5.1. `core/domain/post-job-progress.ts` — từ vựng giai đoạn

Thuần TypeScript, không import gì ngoài `core/domain` (docs/07 §2).

```ts
export const POST_JOB_STAGES = [
  "waiting_in_queue",       // queued, worker chưa nhận
  "waiting_for_spacing",    // giãn cách — biết chính xác còn bao lâu
  "waiting_for_schedule",   // đã hẹn giờ, chưa tới cửa sổ giao lịch
  "checking_stock",         // rule 3 — kiểm tồn lần hai
  "reading_channel",        // đọc credential từ tenant_integration
  "checking_video_spec",    // chỉ video
  "uploading_media",        // biết done/total
  "sending_to_channel",     // lời gọi tạo bài sắp được gửi đi
  "handing_to_facebook",    // E8.6 giao lịch
  "waiting_on_facebook",    // Facebook giữ bài, chờ tới giờ
  "done",
  "stopped",                // blocked | failed
] as const;
export type PostJobStage = (typeof POST_JOB_STAGES)[number];
```

```ts
export interface PostJobProgress {
  readonly stage: PostJobStage;
  readonly attempt: number;
  /** Chỉ có ở uploading_media. Null ở mọi stage khác. */
  readonly doneCount: number | null;
  readonly totalCount: number | null;
  /** Tên file đang xử lý — để người vận hành biết đứng ở đâu. */
  readonly currentItem: string | null;
  readonly stageStartedAt: Date;
  /** CHỈ khi hệ thống biết chính xác (mục 3.2). Null ở mọi chỗ khác. */
  readonly waitUntil: Date | null;
  readonly updatedAt: Date;
}
```

Thực thi luật 3.2 bằng hàm dựng, không bằng quy ước:

```ts
/** Stage chờ — bắt buộc có deadline thật. */
export function waitingProgress(
  stage: "waiting_for_spacing" | "waiting_for_schedule" | "waiting_on_facebook",
  input: { attempt: number; waitUntil: Date; now: Date },
): PostJobProgress;

/** Stage làm việc — KHÔNG nhận waitUntil, kiểu dữ liệu không cho phép. */
export function workingProgress(
  stage: Exclude<PostJobStage, "waiting_for_spacing" | "waiting_for_schedule" | "waiting_on_facebook">,
  input: { attempt: number; now: Date; doneCount?: number; totalCount?: number; currentItem?: string },
): PostJobProgress;
```

Kèm hai hàm thuần, cùng kỷ luật với `postJobOperatorMessage()` đang có:

- `postJobProgressMessage(progress): string` — một câu tiếng Việt, ví dụ
  `"Đang tải ảnh lên kênh 3/10 (IMG_2041.jpg)"`.
- `progressStepIndex(stage): number` — vị trí trên stepper, để giao diện không tự
  gán số thứ tự và lệch với domain.

**Edge case phải xử lý trước** (chuẩn #1): `doneCount > totalCount`, `totalCount = 0`,
`waitUntil` đã trôi qua, `stageStartedAt` ở tương lai, `attempt` âm. Mỗi trường hợp có
một test riêng trước khi viết nhánh đúng.

### 5.2. `core/ports/job-progress.ts` — port mới

```ts
export interface JobProgressStore {
  /** Best-effort. KHÔNG BAO GIỜ throw — xem hợp đồng bên dưới. */
  report(input: {
    readonly tenantId: string;
    readonly postJobId: string;
    readonly progress: PostJobProgress;
  }): Promise<void>;

  /** Thiếu key = không có tiến độ, không phải lỗi. */
  read(
    tenantId: string,
    postJobIds: readonly string[],
  ): Promise<ReadonlyMap<string, PostJobProgress>>;

  /** Xoá khi bài đã kết thúc, để key chết không sống hết TTL. */
  clear(tenantId: string, postJobId: string): Promise<void>;
}
```

#### Ngoại lệ có chủ đích với chuẩn kỹ thuật #5

Chuẩn #5 nói mọi `catch` phải log kèm context **và** rethrow, hoặc chuyển trạng thái
entity kèm lý do. `report()` và `clear()` làm vế thứ nhất một nửa: log `warn` đầy đủ
context (`tenant_id`, `post_job_id`, `stage`, `error_code`, stack) rồi **không** rethrow.

Lý do: vế "chuyển trạng thái entity kèm lý do" không áp dụng được — telemetry không có
entity để chuyển; và rethrow sẽ biến một lần Redis nghẽn thành một bài đăng thất bại,
tức là đánh đổi thứ quan trọng lấy thứ không quan trọng. Đây là quyết định có ý thức,
được ghi ngay trong code tại chỗ `catch`, và `reviewer-qa` được báo trước để không đọc
nhầm thành lỗi lọt lưới.

Ranh giới của ngoại lệ: **chỉ** `report()` và `clear()`. `read()` gặp lỗi thì trả map
rỗng và log warn (màn hình mất tiến độ, không mất trạng thái). Không có chỗ nào khác
trong hệ thống được viện dẫn ngoại lệ này.

### 5.3. `adapters/queue/redis-job-progress.ts`

- Key: `mysp:progress:{tenantId}:{postJobId}`, giá trị JSON, `SET ... EX 3600`.
- Đọc: một `MGET` cho toàn bộ job của lô — một vòng round trip cho cả bảng.
- **Redis là dữ liệu ngoài** (chuẩn #2): giá trị đọc lên phải qua schema zod trước khi
  dùng. JSON hỏng / thiếu trường / `stage` lạ → bỏ qua key đó, log warn, coi như không
  có tiến độ. Không dùng giá trị mặc định âm thầm.
- Dùng lại connection ioredis sẵn có (`adapters/queue/redis-connection.ts`), không mở
  connection mới.

### 5.4. Bảng `post_job_event`

```
id           uuid pk
tenant_id    (tenantIdColumn)
post_job_id  uuid → post_job(id) on delete cascade
batch_id     uuid
stage        text
attempt      integer not null default 0
detail       jsonb not null default '{}'
occurred_at  timestamptz not null
```

Index: `(tenant_id, post_job_id, occurred_at)` và `(tenant_id, batch_id, occurred_at)`.

Chỉ ghi khi **đổi stage**, không ghi mỗi ảnh: khoảng 6–8 dòng cho một bài. `detail` giữ
số liệu của mốc đó (`{ done: 10, total: 10 }`, `{ wait_ms: 45000 }`).

Ghi qua `PostJobRepo` (mở rộng port sẵn có), không tạo repo mới — cùng transaction
boundary, cùng helper scope tenant (rule nghiệp vụ 7).

### 5.5. `ChannelPublisher` — thêm callback tiến độ

Đây là thay đổi interface duy nhất trong thiết kế này.

```ts
export type PublishProgressEvent =
  | { readonly kind: "media_upload_started"; readonly index: number; readonly total: number; readonly fileName: string }
  | { readonly kind: "media_upload_finished"; readonly index: number; readonly total: number; readonly fileName: string }
  /** Lời gọi tạo bài sắp được gửi đi. Sau điểm này bài có thể đã tồn tại. */
  | { readonly kind: "creating_post" }
  | { readonly kind: "video_upload_progress"; readonly bytesSent: number; readonly bytesTotal: number | null };
```

`PublishImagePostInput`, `PublishVideoPostInput`, `SchedulePostInput` cùng thêm:

```ts
/** Đồng bộ, bắn-và-quên. Adapter KHÔNG await và KHÔNG để lỗi của nó thoát ra. */
readonly onProgress?: (event: PublishProgressEvent) => void;
```

Hợp đồng cho mọi implementer:

- `onProgress` được gọi đồng bộ, adapter bọc trong `try/catch` và nuốt lỗi của callback
  (lỗi của người nghe không phải lỗi của người đăng);
- `creating_post` phải bắn **ngay trước** lời gọi tạo bài, và chỉ một lần;
- vắng `onProgress` là hợp lệ, adapter chạy y như cũ.

Cập nhật ba implementer: `facebook-publisher` (bắn đủ, tại `uploadAlbumPhotos` và các
pha reels), `fake-publisher` (bắn y hệt để dev và test thấy được luồng), `tiktok`
(tối thiểu `creating_post`). Có test cho cả ba — `onProgress` là optional nên adapter
nào quên sẽ im lặng không có tiến độ chứ không vỡ build, test là thứ bắt được việc đó.

### 5.6. `publish-post.ts` — gắn vào các mốc đã có

Không phát minh giai đoạn mới. Mỗi điểm dưới đây là một dòng đã tồn tại trong file:

| Vị trí hiện tại | Stage ghi ra |
|---|---|
| §2 spacing gate hoãn bài | `waiting_for_spacing`, `waitUntil = now + waitMs` |
| §1c ngoài cửa sổ handoff | `waiting_for_schedule`, `waitUntil` = đầu cửa sổ |
| §3 sau khi claim | `checking_stock` |
| §5 đọc `findChannel` | `reading_channel` |
| §6a0 video spec gate | `checking_video_spec` |
| `onProgress` media_upload_* | `uploading_media` + done/total/fileName |
| `onProgress` creating_post | `sending_to_channel` |
| §6b handoff | `handing_to_facebook` → `waiting_on_facebook` |
| §7 published | `clear()` key |
| chuyển sang blocked/failed | `clear()` key |

`GetBatchStatusDeps`-style: `PublishPostDeps` nhận thêm `progress: JobProgressStore`
qua tham số, usecase không tự tạo (docs/07 §2).

### 5.7. `get-batch-status.ts` — hợp nhất

Đọc job từ Postgres như hiện tại, rồi một lần `progress.read()` cho toàn bộ job id.

`BatchChannelStatus` thêm:

```ts
readonly progress: {
  readonly stage: PostJobStage;
  readonly stepIndex: number;
  readonly label: string;        // tiếng Việt, từ postJobProgressMessage
  readonly doneCount: number | null;
  readonly totalCount: number | null;
  readonly currentItem: string | null;
  readonly stageStartedAt: Date;
  readonly waitUntil: Date | null;
} | null;
```

`null` khi: không có key, key hỏng, Redis chết, hoặc `status ∉ {queued, publishing}`
(luật 3.1 được áp ngay tại đây, ở tầng usecase — không để giao diện tự nhớ).

Redis chết không tạo lỗi cho người dùng: bảng vẫn hiện đầy đủ như hôm nay, chỉ mất phần
tiến độ, và một dòng `warn` trong log.

### 5.8. API + schema

`GET /api/posts/batches/[batchId]` trả thêm khối `progress` trong mỗi phần tử `channels`.
Tương thích ngược: trường optional/nullable, client cũ không vỡ.

`src/ui/schemas/post-batch.schema.ts` mở rộng schema zod tương ứng (chuẩn #2: validate
tại biên, cả chiều đi ra giao diện).

### 5.9. Giao diện

Mỗi dòng kênh trong `BatchChannelTable` được bổ sung, chỉ khi `progress !== null`:

- **Stepper ngang gọn**: Chờ hàng đợi → Kiểm tồn → Tải ảnh → Gửi lên kênh → Xong. Bước
  hiện tại nổi bật, bước đã qua đánh dấu xong. Chỉ số lấy từ `progressStepIndex`.
- **Thanh tiến độ xác định chỉ ở bước tải ảnh**: `3/10` = 30%, kèm tên file. Các bước
  khác dùng trạng thái không xác định (nhịp đập), **không** phần trăm giả.
- **Dòng thời gian**: "Đã chạy 42 giây", đếm ở client từ `stageStartedAt` (không cần
  server đẩy). Khi có `waitUntil`: "Còn 45 giây" đếm ngược tới một mốc có thật.
- **A11y**: `role="progressbar"` + `aria-valuenow`/`aria-valuemax`/`aria-valuetext` cho
  thanh xác định; `aria-live` **giữ nguyên ở dòng tổng kết**, không gắn vào từng dòng —
  cập nhật 1.5 giây một lần trên năm dòng sẽ biến trình đọc màn hình thành tiếng ồn.
- Tôn trọng `prefers-reduced-motion` cho phần nhịp đập.

Skill FE phải đọc trước khi code: `core-long-running-jobs` → `web-long-running-jobs`;
`core-data-table` → `web-data-table`; `core-data-fetching` → `web-data-fetching`; và
nhóm 1 bắt buộc: `core/web-component-reuse`, `core/web-accessibility`,
`core/web-feedback-states`, `core/web-design-tokens`.

## 6. Kiểm thử

Edge case trước, happy path sau (chuẩn #1).

**Domain** (`post-job-progress.test.ts`): `doneCount > totalCount`; `totalCount = 0`;
`waitUntil` đã trôi qua; `stageStartedAt` tương lai; `attempt` âm; mọi stage đều sinh
được câu tiếng Việt; `workingProgress` không cách nào tạo ra `waitUntil` khác null.

**Adapter Redis**: JSON hỏng → map rỗng + warn, không throw; thiếu trường → key đó bị
bỏ, các key khác vẫn về; `stage` lạ → bỏ; Redis từ chối kết nối → `report` không throw,
`read` trả map rỗng.

**Publisher**: cả ba implementer bắn đúng thứ tự sự kiện cho album 1 ảnh và 10 ảnh;
`creating_post` bắn đúng một lần và đúng trước lời gọi tạo bài; `onProgress` ném lỗi thì
bài vẫn đăng được.

**Usecase**: mỗi mốc ở bảng 5.6 ghi đúng stage; bài `failed` không trả về `progress`;
`progress.report` throw không làm hỏng publish (dùng store giả luôn ném).

**Usecase đọc**: Redis chết → `progress: null` trên mọi dòng, phần còn lại nguyên vẹn.

**Giao diện**: bốn trạng thái bắt buộc vẫn đúng; dòng có `progress` và dòng không có
cùng render được; thanh tiến độ có thuộc tính ARIA đúng.

**Chạy thật** (không được bỏ): dựng stack bằng docker compose, đăng một lô có album
nhiều ảnh, xem stepper chạy hết các bước trên trình duyệt; sau đó tắt Redis giữa chừng
và xác nhận màn hình lùi về hiển thị cũ thay vì vỡ.

## 7. Phân công

| Agent | Mục |
|---|---|
| `fb-publisher` | 5.1 – 5.6 |
| `ui-web` | 5.7 – 5.9 |
| `reviewer-qa` | gate PASS/FAIL, kèm xác nhận ngoại lệ 5.2 |

## 8. Rủi ro

1. **Ngoại lệ chuẩn #5** (mục 5.2) — đã được PM duyệt, ghi rõ trong code, ranh giới hẹp.
2. **Đổi interface `ChannelPublisher`** — optional nên không vỡ build; implementer quên
   sẽ im lặng mất tiến độ. Test cho cả ba implementer là biện pháp bắt.
3. **Tiến độ lệch pha với trạng thái** khi worker chết — xử lý bằng luật 3.1 áp ở tầng
   usecase đọc, không phụ thuộc giao diện nhớ.
4. **Tải thêm**: mỗi bài ~15 lần `SET` Redis và ~7 dòng `INSERT`; đọc là một `SQL` + một
   `MGET` mỗi 1.5 giây khi đang chạy. Không đáng kể ở quy mô hiện tại, nhưng nhịp 1.5
   giây là con số cần xem lại nếu số lô chạy song song tăng mạnh.
5. **TikTok/video** chỉ có sự kiện tối thiểu — tiến độ của chúng thô hơn ảnh, ghi nhận
   là hạn chế đã biết của Phase này.
