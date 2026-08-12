# Định hướng công nghệ — Công cụ đăng bài tự động

Bối cảnh: công cụ nội bộ, team rất nhỏ (1 người + AI agent), có thể mở bán SaaS về sau.
Nguyên tắc xuyên suốt: **ít thành phần nhất có thể**, ưu tiên thứ tự-nghiệp-vụ-đúng hơn là hạ tầng đẹp.

> **Cập nhật v2 (12/08/2026):** TikTok chuyển sang Phase 2 (app đã có sẵn, audit theo dõi song song — mục 1.1, 1.2 giữ lại làm tài liệu cho Phase 2). SaaS-ready mức data model đã **chốt**: tenant_id mọi bảng + config theo tenant (xem mục 4). Hai trong ba quyết định ở mục 7 đã đóng, còn B10.

---

## 1. Ba ràng buộc kỹ thuật quyết định toàn bộ thiết kế

Đọc phần này trước khi xem stack. Ba điều dưới đây không thương lượng được và định hình mọi thứ còn lại.

### 1.1. TikTok chưa qua audit thì bài đăng là riêng tư — *(tài liệu cho Phase 2)*

Tài liệu chính thức của TikTok Content Posting API:

> *"All content posted by unaudited clients will be restricted to private viewing mode."*

Nghĩa là chưa qua audit thì mọi bài lên TikTok đều ở chế độ `SELF_ONLY` — chỉ chủ tài khoản thấy. Không phải giới hạn kỹ thuật vòng được, mà là chính sách nền tảng.

**Hệ quả:** tiêu chí "đăng lên cả Facebook và TikTok, một lần bấm" ở mục 1 của brief **không đạt được** cho tới khi TikTok duyệt audit. Kế hoạch phải tách TikTok thành nhánh riêng, có phương án dự phòng, và nộp audit từ ngày đầu tiên.

### 1.2. TikTok đăng ảnh yêu cầu ảnh nằm trên tên miền đã xác minh — *(tài liệu cho Phase 2)*

Endpoint đăng ảnh (`/v2/post/publish/content/init/` với `media_type: PHOTO`) nhận **URL ảnh**, và URL đó phải thuộc tên miền hoặc tiền tố URL đã được xác minh trong TikTok Developer Portal.

**Hệ quả:** không thể đưa link Google Drive thẳng cho TikTok. Hệ thống bắt buộc phải:
- có một tên miền riêng,
- tải ảnh từ Drive về, lưu tạm, và phục vụ ảnh đó qua HTTPS trên tên miền đã xác minh,
- dọn file tạm sau khi đăng xong.

Đây là hạ tầng bắt buộc, không phải tuỳ chọn. Phải tính vào ước lượng.

### 1.3. Không dùng được tính năng hẹn lịch sẵn có của nền tảng

Facebook có tham số hẹn giờ đăng sẵn (`scheduled_publish_time`). Nhưng brief mục 9 yêu cầu:

> *"Kiểm tra lại tồn kho ngay trước khi đăng, không dùng số tồn lúc hẹn lịch. Hẹn hôm nay mai đăng, trong đêm hàng bán hết thì tự động hủy bài."*

Giao cho Facebook hẹn giờ là mất quyền kiểm tra tồn kho tại thời điểm đăng. **Vì vậy hệ thống phải tự chạy scheduler của riêng mình**: đến giờ thì đọc lại tồn kho → nếu còn hàng mới gọi API đăng ngay.

Kéo theo: cần một tiến trình chạy nền 24/7 (không phải serverless chạy theo request), và cần hàng đợi công việc có khả năng thử lại.

---

## 2. Stack đề xuất

| Lớp | Lựa chọn | Lý do |
|---|---|---|
| Web app | **Next.js (App Router) + TypeScript** | Một codebase cho cả giao diện và API nội bộ. Đúng chuyên môn hiện có, không phải học stack mới. |
| Giao diện | **Tailwind + shadcn/ui** | Công cụ nội bộ — cần dựng nhanh, không cần design system riêng. |
| Cơ sở dữ liệu | **PostgreSQL** | Cần transaction thật cho trạng thái bài đăng, và dùng luôn làm hàng đợi. |
| Truy vấn DB | **Drizzle ORM** | TypeScript-first, migration rõ ràng, không có runtime nặng. (Prisma cũng được nếu quen hơn.) |
| Hàng đợi + hẹn lịch | **BullMQ + Redis** *(đổi từ pg-boss — quyết định owner 12/08/2026)* | Hẹn giờ, thử lại, repeatable job, rate-limit theo queue, concurrency control. Redis dùng thêm cho: cache nóng model-registry, rate-limit adapter AI/Graph API. Đánh đổi đã chấp nhận: thêm một service phải vận hành + backup. |
| Tiến trình nền | **Worker Node.js riêng**, cùng repo, khác entrypoint | Upload video mất nhiều phút — không được chạy trong request web. |
| Xử lý media | **ffmpeg / ffprobe** | Kiểm tra tỉ lệ khung hình, thời lượng, dung lượng, codec **trước khi** upload (brief mục 5 yêu cầu rõ). |
| AI viết caption | **AI Gateway đa provider** (ADR-001, `docs/ai/`) — primary Google AI Studio/Gemini (**bắt buộc paid tier** — free tier dùng data để training), fallback OpenAI; model theo **registry** YAML+DB, routing cheap→validate→escalate | KHÔNG hardcode model trong business code; SDK AI chỉ trong `adapters/ai/**` |
| Đăng nhập | **Google OAuth, giới hạn theo tên miền công ty** | Đã dùng Google Drive/Sheet sẵn; không phải tự quản lý mật khẩu. |
| Truy cập Drive/Sheet | **Google Service Account** | Không hết hạn, không cần người dùng cấp lại quyền. Cần IT chia sẻ thư mục và sheet cho email của service account. |
| Triển khai | **1 VPS + Docker Compose** (web + worker + postgres + redis + Caddy) | Video lớn và tiến trình chạy dài không hợp serverless. Chi phí thấp, không khoá nhà cung cấp, có sẵn tên miền phục vụ ảnh cho TikTok. |
| Sao lưu | `pg_dump` theo lịch, đẩy lên object storage | Dữ liệu quan trọng nhất là lịch hẹn và lịch sử đăng. |

### Vì sao không chọn các phương án khác

- **Vercel/serverless:** giới hạn thời gian chạy và dung lượng request; upload video theo từng phần và scheduler 24/7 không hợp. Có thể dùng cho giao diện, nhưng vẫn phải nuôi worker riêng ở nơi khác — thành hai chỗ phải vận hành thay vì một.
- ~~BullMQ + Redis: mạnh hơn nhưng thêm một dịch vụ phải vận hành~~ → **12/08/2026: owner quyết định chuyển sang BullMQ + Redis** (chuẩn bị scale SaaS + tận dụng Redis cho cache/rate-limit). Nhận định cũ về chi phí vận hành vẫn đúng — xử lý bằng: Redis chạy trong Docker Compose cùng stack, AOF persistence, nằm trong kịch bản backup. pg-boss ghi lại ở đây làm phương án thu gọn nếu sau này muốn giảm thành phần.
- **n8n / Make / Zapier:** dựng nhanh cho luồng đơn giản, nhưng brief có validator caption, quy tắc tồn kho nhiều tầng, upload theo từng phần, và bảng tổng kết lô. Nhồi hết vào công cụ no-code sẽ khó gỡ lỗi và không kiểm thử được.

---

## 3. Kiến trúc

```
                     ┌──────────────────────────────┐
   Người vận hành ──▶│  Next.js (giao diện + API)   │
                     └───────────┬──────────────────┘
                                 │ ghi job
                                 ▼
                     ┌──────────────────────────────┐
                     │  PostgreSQL (dữ liệu, lịch)  │
                     │  Redis (hàng đợi BullMQ)     │
                     └───────────┬──────────────────┘
                                 │ nhận job
                                 ▼
                     ┌──────────────────────────────┐
                     │  Worker (Node.js)            │
                     │   • đồng bộ Drive / Sheet    │
                     │   • kiểm tra tồn kho         │
                     │   • sinh caption bằng AI     │
                     │   • kiểm tra thông số video  │
                     │   • đăng bài + thử lại       │
                     └───┬──────────┬───────────┬───┘
                         │          │           │
              ┌──────────▼──┐  ┌────▼──────┐  ┌─▼───────────┐
              │ Google APIs │  │ Meta Graph│  │ TikTok API  │
              │ Drive/Sheet │  │    API    │  │Content Post.│
              └─────────────┘  └───────────┘  └─────────────┘
                                                    ▲
                     ┌──────────────────────────────┘
                     │  Caddy phục vụ /media/* trên tên miền đã xác minh
                     │  (bắt buộc cho TikTok đăng ảnh — xem mục 1.2)
```

**Nguyên tắc phân tách:** mọi thứ nói chuyện với bên ngoài đều nằm trong worker. Giao diện chỉ đọc/ghi database. Nhờ vậy giao diện luôn phản hồi nhanh, và mọi lỗi bên ngoài đều là trạng thái trong DB có thể xem lại được, không phải lỗi biến mất trong log.

---

## 4. Mô hình dữ liệu tối thiểu

**Đã chốt (v2): SaaS-ready mức data model.** Quy tắc bắt buộc:
- **Mọi bảng nghiệp vụ có cột `tenant_id`**, foreign key về `tenant`, và **mọi query đi qua một lớp scope theo tenant** (helper chung, không tin vào việc dev nhớ thêm `where`).
- **Không hardcode cấu hình nguồn dữ liệu.** Drive folder ID, Sheet ID, tên tab, credential kênh — tất cả nằm trong bảng `tenant_integration`, không nằm trong biến môi trường.
- Chưa làm: UI đăng ký tenant, mời thành viên, billing — Phase sau, thêm được mà không đổi schema.

```
tenant             — hiện chỉ 1 dòng (MYSP); mọi bảng dưới đều mang tenant_id
tenant_integration — theo tenant: drive_folder_id, sheet_id, tên tab,
                     credential Google (tham chiếu), cấu hình khác
user               — thuộc tenant, vai trò
channel            — nền tảng, id ngoài, tên, tham chiếu token, trạng thái, hạn token
channel_group      — nhóm kênh đặt sẵn (brief mục 6)
product_snapshot   — bản chụp dữ liệu Sheet: mã, tên, mô tả, chủng loại, mùa vụ,
                     tồn, lưu ý, thời điểm đồng bộ
media_asset        — id file Drive, mã, màu, số thứ tự, loại (ảnh/video), dung lượng
post_batch         — một lần bấm đăng: người tạo, chế độ (A/B), tham số, tổng kết
post_job           — MỘT bài lên MỘT kênh. Đây là đơn vị trung tâm của hệ thống.
                     batch, mã, danh sách màu, định dạng, kênh, thời điểm hẹn,
                     trạng thái, danh sách media, caption đã chốt, link bài, lỗi,
                     khoá chống trùng
caption_version    — mỗi lần AI sinh hoặc người sửa là một phiên bản; giữ đủ lịch sử
prompt_template    — theo nền tảng, có phiên bản (brief mục 7.2 yêu cầu sửa không cần deploy)
audit_log          — ai làm gì lúc nào
```

Trạng thái của `post_job` (một máy trạng thái rõ ràng, tránh trạng thái lửng lơ):

```
draft → caption_ready → approved → queued → publishing → published
                                                  ├──────→ failed
   bất kỳ lúc nào ────────────────────────────────┴──────→ cancelled
                                              (hết hàng, người dùng huỷ)
```

**Vì sao `post_job` là một bài trên một kênh, không phải một bài trên nhiều kênh:** brief yêu cầu mỗi kênh có caption riêng, hẹn giờ riêng, và một kênh lỗi không được làm dừng kênh khác. Tách nhỏ tới mức một-kênh khiến ba yêu cầu này trở thành hiển nhiên thay vì phải xử lý đặc biệt.

**Khoá chống trùng:** mỗi `post_job` mang một khoá duy nhất `(batch, mã, màu, kênh, định dạng)`. Trước khi gọi API đăng, worker đặt khoá này. Nhờ vậy dù worker chết giữa chừng và job chạy lại, bài không bị đăng hai lần. Đây là lỗi tệ nhất của một công cụ đăng bài, phải chống ngay từ thiết kế.

---

## 5. Các luồng quan trọng

### 5.1. Thứ tự bắt buộc khi đăng

Brief mục 3 nói rõ: *"Chưa qua bước này thì không gọi AI, không đăng."* Thứ tự trong code phải đúng như vậy, và nên có test khoá thứ tự này lại:

```
1. Tra Sheet lấy dữ liệu sản phẩm
2. Kiểm tra tồn kho          ← hết hàng thì DỪNG tại đây
3. Gom media (theo màu, theo số đuôi)
4. Kiểm tra thông số video   ← không đạt thì DỪNG, chưa upload gì
5. Gọi AI sinh caption (mỗi kênh một lần gọi riêng)
6. Chạy validator caption    ← không đạt thì viết lại, tối đa N lần
7. Người duyệt (mặc định bật)
8. Đưa vào hàng đợi, đăng giãn cách theo từng kênh
```

Bước 2 đứng trước bước 5 không chỉ vì đúng nghiệp vụ — nó còn tiết kiệm tiền AI cho mọi mã hết hàng.

### 5.2. Kiểm tra tồn kho hai lần

- **Lần 1** — lúc soạn bài: chặn sớm, đỡ tốn chi phí AI.
- **Lần 2** — ngay trước khi gọi API đăng (kể cả đăng ngay, bắt buộc với bài hẹn lịch): nếu đã hết hàng thì chuyển sang `cancelled` và gửi cảnh báo.

Chỉ thực hiện lần 1 là không thoả mục 9 của brief.

### 5.3. Validator caption

Ba lớp kiểm tra chạy sau khi AI viết xong, trước khi cho người duyệt:

| Kiểm tra | Quy tắc | Không đạt thì |
|---|---|---|
| Tên sản phẩm | Dòng đầu bắt đầu đúng tên từ Sheet; không xuất hiện tên mẫu khác | Viết lại |
| Giá tiền | Không có chuỗi số khớp mẫu giá (cần chốt mẫu chính xác — xem câu D2 trong bộ câu hỏi BA) | Viết lại |
| Hashtag | Có 3–5 hashtag ở cuối | Viết lại |
| Rò rỉ dữ liệu nội bộ | Không chứa số tồn kho, không chứa ghi chú sản xuất | Viết lại |
| Trùng lặp giữa các kênh | So khớp với caption các kênh khác cùng bài, theo ngưỡng đã chốt | Viết lại kênh sau |

Sau N lần viết lại vẫn không đạt: chuyển sang trạng thái cần người xử lý, **không** đăng và **không** im lặng bỏ qua.

**Lưu ý về danh sách trắng (brief mục 2.2):** bắt buộc chỉ truyền vào prompt đúng các trường được phép (tên, mô tả, chủng loại, mùa vụ). Cột *Tồn* và *Lưu ý* không bao giờ được đưa vào prompt — không dựa vào việc AI "biết đừng nhắc tới", mà chặn ngay ở tầng dữ liệu.

### 5.4. Upload video

```
Kiểm tra bằng ffprobe (tỉ lệ, thời lượng, dung lượng, codec)
   ↓ đạt
Khởi tạo phiên upload trên nền tảng
   ↓
Upload theo từng phần, ghi phần trăm vào DB sau mỗi phần
   ↓ (giao diện đọc phần trăm từ DB — không giữ kết nối mở)
Hoàn tất, hỏi trạng thái xử lý theo chu kỳ cho tới khi nền tảng xử lý xong
   ↓
Lưu link bài
```

Không đạt ở bước đầu là dừng ngay và báo lỗi cụ thể (sai ở thông số nào, giá trị hiện tại, giá trị yêu cầu) — đúng như brief mục 5 yêu cầu.

---

## 6. Bảng rủi ro kỹ thuật

| # | Rủi ro | Mức | Xử lý |
|---|---|---|---|
| R1 | **TikTok chưa qua audit → bài riêng tư** *(theo dõi song song — chỉ chặn Phase 2)* | Cao | App đã có sẵn — verify trạng thái audit tuần 0, theo dõi hằng tuần. Dự phòng: đẩy vào nháp TikTok, người dùng bấm đăng tay. Phải cho stakeholder biết trước, bằng văn bản. |
| R2 | **Meta App Review chưa chắc đã pass đủ 4 quyền** | Cao | App đã có sẵn nhưng phải verify trên dashboard tuần 0 ("có app" ≠ "đã pass review"). Nếu thiếu quyền: nộp bổ sung ngay, code trên Page test trong lúc chờ. |
| R3 | **TikTok đăng ảnh cần tên miền đã xác minh** *(Phase 2)* | Cao | Mua tên miền và xác minh sớm trong Phase 2, không để tới lúc code mới phát hiện. |
| R4 | **Google Sheet là dữ liệu người nhập tay** — ô trống, chữ trong cột số, đổi tên cột | Cao | Tầng kiểm tra dữ liệu riêng, chuẩn hoá về kiểu đúng, kiểm tra tên cột lúc khởi động và cảnh báo nếu lệch. Ô *Tồn* không đọc được thì coi là hết hàng (an toàn hơn). |
| R5 | **Tồn kho theo mã nhưng đăng theo màu** | Cao | Lỗ hổng nghiệp vụ trong brief — xem câu B10. Cần stakeholder chốt trước khi code phần tồn kho. |
| R6 | **Giới hạn tần suất gọi Google Sheets API** | Trung bình | Cache dữ liệu sản phẩm trong DB, đồng bộ theo chu kỳ. Chỉ đọc trực tiếp cho lần kiểm tra tồn kho thứ hai. |
| R7 | **Đăng trùng khi thử lại** | Trung bình | Khoá chống trùng ở mục 4 + kiểm tra trạng thái trước khi đăng lại. |
| R8 | **Token hết hạn âm thầm** | Trung bình | Job tự làm mới token; cảnh báo trước hạn 7 ngày; hiện trạng thái token trên màn hình quản lý kênh. |
| R9 | **Chi phí AI vượt dự kiến** | Trung bình | Đo trên 50 bài thật ở tuần 3 rồi mới ngoại suy. Bật cache prompt cho phần hướng dẫn cố định. Đặt hạn mức theo ngày. |
| R10 | **Giới hạn tần suất đăng của Meta** | Thấp–TB | Đăng giãn cách (đã có trong brief) đã giảm rủi ro này. Thêm backoff khi gặp lỗi giới hạn. |
| R11 | **File Drive bị đổi tên/xoá giữa lúc hẹn lịch và lúc đăng** | Thấp–TB | Lưu id file Drive (không lưu tên); kiểm tra file còn tồn tại trước khi đăng. |

---

## 7. Ba quyết định chặn thiết kế database — trạng thái

1. ✅ **TikTok không nằm trong phase 1** — chốt 12/08/2026. App có sẵn, audit theo dõi song song, code sang Phase 2.
2. ✅ **Tồn kho theo MÃ** — đóng 12/08/2026 bằng khảo sát dữ liệu thật (`05-data-profile.md` mục 2.4): Sheet mỗi mã một dòng, ô Màu sắc ghi gộp ("KEM, HỒNG"), một số Tồn cho cả mã. Schema không cần bảng tồn-theo-màu. Rủi ro "mã còn hàng nhưng màu cụ thể đã hết" là giới hạn của dữ liệu nguồn — ghi vào rủi ro nghiệp vụ, không xử lý bằng schema.
3. ✅ **SaaS-ready mức data model** — chốt 12/08/2026. tenant_id mọi bảng + `tenant_integration`; chưa làm UI đăng ký/mời user.

**Cả 3 quyết định đã đóng — schema hết bị chặn, E1 bắt đầu được ngay.**

Bổ sung từ khảo sát dữ liệu (`05-data-profile.md`) — 4 yêu cầu mới cho E2:
- **Bảng ánh xạ chuẩn hoá màu** (TRANG→TRẮNG, DEN→ĐEN, XANHTHAN→XANH THAN...) + tách hậu tố `-AI` / `-THỰC TẾ` / `-SAU` / `-MẶT SAU` thành thuộc tính riêng của `media_asset`.
- **Khử trùng lặp**: 1.499 tên file trùng (file ID khác nhau) — rule đề xuất: lấy file mới nhất theo `modifiedTime`.
- **Parser 2 tầng**: tầng nghiêm (đúng brief) + tầng nới lỏng (strip, chấp nhận thiếu số/đuôi); file không parse được vào danh sách lỗi trên màn hình quản trị, không chặn cả luồng (28,2% file sai chuẩn — chặn cứng là công cụ vô dụng).
- Đuôi file phải nhận `png`, `jpeg`, `jpg`, `mp4`, `mov` (brief chỉ ghi jpg/mp4; thực tế png chiếm 50%, video có cả mov).
