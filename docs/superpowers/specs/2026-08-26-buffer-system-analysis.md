# Phân tích hệ thống Buffer — sau onboarding

Ngày: 2026-08-26 · Bổ trợ cho `2026-08-26-onboarding-buffer-clone-design.md`
Mục đích: làm nền tham chiếu khi dựng lại MYSP

---

## 0. Cách lấy số liệu

Đăng nhập bằng tài khoản Buffer mới (gói Free, **0 kênh đã nối**), đi hết các màn bằng
Chrome, đọc DOM và cây khả năng tiếp cận. Chụp ở khung 1400×867.

**Giới hạn phải nói trước:** tài khoản không nối kênh nào và ở gói Free. Nên mọi màn quan
sát được đều ở **trạng thái rỗng**, và mọi thứ gắn ⚡ đều bị khoá. Không quan sát được:
màn có dữ liệu thật, luồng OAuth nối kênh, Calendar khi có bài, Insights khi có số liệu.
Những chỗ đó dưới đây ghi rõ là **suy ra**, không phải **thấy**.

---

## 1. Bản đồ điều hướng

Điều hướng chính là **cột trái cố định**, không phải thanh trên. Route thật:

```
/home                    Home        — bảng điều khiển
/create/ideas            Create      — kho ý tưởng, mẫu, nguồn cấp
/schedule                Publish     — hàng đợi, lịch          [đếm số bài]
/community/posts         Community   — bình luận, nhắc tên
/insights                Insights    — số liệu                 [nhãn "New"]

/settings/profile · preferences · notifications        (Tài khoản)
/settings/general · channels · billing                 (Tổ chức)
/settings/tags · channel-groups ⚡ · saved-replies      (Tính năng)
/settings/api · apps · beta · refer · integrations     (Khác)

/create/templates/template/{id}
```

Dưới nav chính là khối **"Connect channels"** — các icon kênh chưa nối, luôn hiện, cộng
nút `+`. Đây là lời nhắc thiết lập **thường trực**, không phải một checklist bật rồi tắt.
Đáng chú ý: MYSP đang dùng `SetupDock` cho vai trò này.

Chân cột trái: tên tổ chức + gói (`My organization` / `Free Plan`), và nút thu gọn cột.

**Nút chính là một nút xanh lớn "＋ New"** đặt trên cùng cột trái, mở menu:

| Mục | Mô tả phụ | Ghi chú |
|---|---|---|
| Post | Publish content to a channel | |
| Idea | Capture a content idea | |
| Connect a New Channel | | |
| Create a Start Page | | mở tab ngoài |
| Invite a Team Member | | ⚡ trả phí |

Bài học: **một nút tạo duy nhất, mở menu** — không rải nút "tạo" khắp các màn.

---

## 2. Từng màn

### 2.1 Home — `/home`

Xếp theo thứ tự dọc:

1. Lời chào theo giờ + ngày: "Good Morning, {tên}!" / "Wed, Aug 26 2026".
2. **Ba chỉ số** một hàng: Week Streak · Posting Goals · Comment Score. Mỗi cái có số to
   bên trái và nút ⓘ giải thích. Chưa có kênh thì cả ba bằng 0 kèm dải nhắc màu xanh:
   "Connect a channel to start tracking your posting streak…".
3. **First Steps** — ba thẻ đánh số, mỗi thẻ có tiêu đề, câu mô tả, một nút, và ô tick
   ở góc phải: `1. Connect a channel` · `2. Create a post` · `3. Explore Buffer API`.
4. **Up Next** và **Comments** — hai cột rỗng có biểu tượng và câu giải thích.
5. **Templates** — băng thẻ nội dung mẫu, mỗi thẻ có emoji, tiêu đề hai dòng, đoạn mô tả.

Nhận xét: Home **không phải dashboard số liệu**, mà là **màn dẫn việc**. Chỉ số chỉ là
lớp trên cùng; phần lớn diện tích dành cho "làm gì tiếp".

### 2.2 Create — `/create/ideas`

- Tab: **Ideas · Templates · Feeds**
- Góc phải: `✨ Generate Ideas` (AI) và `＋ New Idea`
- Hàng dưới: bộ lọc `Tags`, và chuyển chế độ xem **Board / Gallery**

Đây là **kho nội dung tách khỏi hàng đợi**: ý tưởng sống độc lập, chưa gắn kênh hay giờ.
MYSP hiện không có khái niệm này — bài đi thẳng từ sản phẩm sang hàng đợi.

### 2.3 Publish — `/schedule`

- Tiêu đề **"All Channels"** kèm icon nhóm kênh và nút đánh dấu — tức tiêu đề chính là
  **bộ chọn phạm vi**, không phải nhãn tĩnh.
- Tab: **Queue · Drafts · Approvals ⚡ · Sent**, mỗi tab có số đếm.
- Chuyển chế độ **List / Calendar**.
- Bộ lọc: `Channels`, `Tags`, và **múi giờ** (`Ho_Chi_Minh`) — múi giờ là bộ lọc hạng nhất,
  đặt ngang hàng với lọc kênh.
- `＋ New Post` góc phải.

**Điểm hay nhất của cả hệ thống:** hàng đợi không liệt kê bài, nó liệt kê **khung giờ**.

```
Today, August 26
  1:00 PM   [ (f) ＋ New ]
  5:00 PM   [ (in) ＋ New ]
Tomorrow, August 27
  9:00 AM   [ (ig) ＋ New ]
  ...
          ＋ More Recommended Times
```

Mỗi dòng là một suất đăng đã định sẵn, gắn với một kênh, đang trống và mời điền. Màn rỗng
vì thế **không hề trống** — nó đã có cấu trúc, người dùng chỉ việc lấp. So với một màn
"chưa có bài nào" thì đây là chênh lệch rất lớn về chất lượng.

### 2.4 Community — `/community/posts`

- Tab **Comments · Mentions**; chế độ xem **By post / List**; lọc `Channels`, `All`, và
  một nút lọc nâng cao.
- Cột trái là danh sách bài, cột phải là hội thoại.
- Trạng thái rỗng: hình minh hoạ, tiêu đề hai dòng, câu phụ, rồi **lưới 8 kênh để nối**.

### 2.5 Insights — `/insights`

- Tab **Post insights · Habits**.
- Dải thời gian: `7 days · 30 days · Month to date · Last month · Custom`.
- Lọc `Channels`, `Tags`, và `Export`.
- **Summary**: bốn ô — Likes · Comments · Impressions · Engagement Rate — mỗi ô có mũi tên
  xu hướng lên/xuống.
- **Top 5 Posts**: năm thẻ ngang.
- Trạng thái rỗng dùng **lại đúng hoạ tiết của màn chào onboarding**: nền lưới + các ô
  pastel trôi nổi, cộng câu "Turn your posts into insights 🔥" và nút nối kênh.

### 2.6 Settings

Bốn nhóm, thứ tự cố định:

- **Account** — Profile, Preferences, Notifications
- **Organization** — General, Channels (có số đếm), Billing
- **Features** — Tags, Channel Groups ⚡, Saved Replies
- **Other** — API 🆕, Apps & Extras, Beta Features, Refer a Friend, Integrations 🆕

`Settings > General` xác nhận mô hình tổ chức:

| Trường | Giá trị quan sát |
|---|---|
| Creation Date | August 26, 2026 — bằng ngày đăng ký |
| Organization Name | **"My organization"** — tự đặt, sửa được, có nút Save Changes riêng |
| Account Owner | email người đăng ký, "current owner" |
| Change Owner | có, kèm chú thích chủ mới phải là Admin |

**Đây là bằng chứng trực tiếp cho yêu cầu của PM:** tổ chức được tạo tự động lúc đăng ký,
tên mặc định chung chung, đổi sau trong cài đặt. Không có bước "tạo công ty" nào cả.

### 2.7 Composer — hộp thoại, không phải trang

Mở từ `＋ New Post` hoặc từ một khung giờ trống trong hàng đợi.

```
┌──────────────────────────────────────────────────────────┐
│ Create Post  [Tags ▾]   Templates · AI Assistant · Preview · ⤢ · ✕ │
├────────────────────────────────┬─────────────────────────┤
│ (X)(f)(ig)(in)(tt)(m)(yt)(@)(bs)│  Post Previews  ⓘ       │
│                                │                         │
│ Start writing or get inspired  │   ┌───────────────┐     │
│ with 📄 Templates              │   │               │     │
│                                │   │  xem trước    │     │
│ ┌──────────┐                   │   └───────────────┘     │
│ │ Kéo thả  │                   │  See your post's        │
│ │ hoặc chọn│                   │  preview here           │
│ └──────────┘                   │                         │
│ ＋ ▾  ☺  #                     │                         │
├────────────────────────────────┴─────────────────────────┤
│                             [ Connect a Channel to Post ] │
└──────────────────────────────────────────────────────────┘
```

- **Hàng chọn kênh nằm trên cùng vùng soạn** — chọn kênh trước, viết sau.
- Một ô soạn duy nhất cho mọi kênh, **xem trước tách theo từng kênh** ở cột phải.
- Thanh công cụ đáy: thêm nội dung, emoji, hashtag.
- Nút chính ở góc phải dưới, và nó **đổi chữ theo trạng thái**: chưa có kênh thì thành
  "Connect a Channel to Post" — nút không chết, nó chỉ đường.

Mô hình này khớp trực tiếp với MYSP: `post_job` = 1 bài × 1 kênh, fan-out từ một bản soạn.

> **PHẠM VI — PM chốt 26/08/2026: KHÔNG đụng vào composer.**
> MYSP tạm thời **giữ nguyên màn soạn bài hiện có** (`/compose`, `src/ui/components/compose/**`).
> Toàn bộ phần composer trong tài liệu này là **tham chiếu cho sau này**, không phải việc
> đang giao. Agent nào nhận task từ đợt này mà thấy mình đang sửa file trong `compose/`
> thì đã đi sai phạm vi — dừng lại và báo orchestrator.

---

## 3. Khuôn mẫu dùng lại toàn hệ thống

1. **Trạng thái rỗng luôn có bốn phần**: hình minh hoạ · tiêu đề · câu giải thích · lối ra
   cụ thể. Không màn nào chỉ ghi "chưa có dữ liệu".
2. **Hoạ tiết lưới + ô pastel trôi nổi** dùng cả ở màn chào onboarding lẫn ô rỗng của
   Insights. Đó là một mô-típ của hệ thống, không phải trang trí một lần.
3. **Tiêu đề màn là bộ chọn phạm vi.** "All Channels" xuất hiện ở Publish, Community,
   Insights — cùng một thành phần, cùng vị trí.
4. **Tab có số đếm** (`Queue 0`, `Drafts 0`, `Sent 0`, `Channels 0`).
5. **Chuyển chế độ xem là cặp nút ghép** ở góc phải: List/Calendar, Board/Gallery,
   By post/List.
6. **⚡ đánh dấu tính năng trả phí**, đặt ngay cạnh tên, không giấu. Approvals, Channel
   Groups, Invite a Team Member đều mang dấu này.
7. **🆕 đánh dấu tính năng mới** (Insights, API, Integrations).
8. **Skeleton, không phải vòng xoay.** Mọi màn tải chậm đều vẽ khung xám đúng hình dạng
   nội dung sắp tới.
9. **Nút chính đổi chữ thay vì chết.** "Connect a Channel to Post" thay cho một nút
   "Post" bị làm mờ.

---

## 4. Quan sát về kiến trúc

- **GraphQL.** Lộ ra qua thông báo lỗi: `Variable "$channelId" got invalid value "connect"`.
- **Tổ chức là gốc của mọi thứ**, tạo tự động lúc đăng ký, có chủ sở hữu chuyển nhượng được.
- **Kênh thuộc tổ chức**, đếm ở `Settings > Channels`, và số kênh là đơn vị tính tiền
  ("0/3 channels connected" ở gói Free).
- **Nhóm kênh là tính năng trả phí** (`Channel Groups ⚡`). MYSP đang cho miễn phí.
- **Múi giờ theo người dùng**, hiện ngay trên thanh lọc chứ không giấu trong cài đặt.
- Có **API công khai** và **Integrations** — hướng mở nền tảng.

---

## 5. Khuyết điểm quan sát được — đừng chép

1. **Lỗi GraphQL thô lọt ra giao diện.** Vào `/channels/connect` (URL đoán) hiện nguyên
   văn `Variable "$channelId" got invalid value "connect"; Invalid ChannelId format.`
   Người vận hành không làm gì được với câu đó. MYSP đã có `AppError` với `userMessage`
   tiếng Việt — giữ kỷ luật đó.
2. **Trạng thái rỗng lặp lại quá nhiều lời mời nối kênh.** Cùng một lưới kênh xuất hiện ở
   Home, Community, Insights và composer. Với người chưa nối kênh, cả sản phẩm biến thành
   một lời nhắc duy nhất lặp bốn lần.
3. **Ô tick 16px** ở khảo sát onboarding dưới ngưỡng vùng bấm 24×24 của WCAG 2.2.
4. **Trạng thái đã chọn chỉ đổi màu viền** (`#EAE8E5` → `#337046`) — màu một mình mang
   nghĩa.
5. **"Explore Buffer API" nằm ở bước 3 của First Steps** cho người dùng mới. Đó là việc
   của lập trình viên, không phải bước thứ ba của một chủ shop.

---

## 6. Đối chiếu với MYSP

### Nên lấy

| Ý tưởng | Vì sao hợp MYSP |
|---|---|
| **Hàng đợi là khung giờ trống, không phải danh sách bài** | Giải quyết được màn rỗng của lịch đăng, và khớp luật giãn cách đã có |
| **Một nút "＋ Tạo mới" duy nhất mở menu** | MYSP đang rải nút tạo ở nhiều màn |
| Tiêu đề màn kiêm bộ chọn phạm vi kênh | Dùng chung được cho màn duyệt, nhật ký, thống kê |
| Tab có số đếm | Trả lời "còn bao nhiêu việc" mà không cần bấm vào |
| Nút chính **đổi chữ** thay vì làm mờ | Đúng Named Status Rule dự án đang theo |
| Skeleton đúng hình dạng nội dung | MYSP đã làm ở vài màn, nên làm đều |
| Khối nhắc thiết lập **thường trực** ở cột trái | Thay cho `SetupDock` dạng thẻ nổi góc màn |
| Tổ chức tự tạo lúc đăng ký, tên mặc định, sửa trong cài đặt | Chính là yêu cầu PM đã chốt |

### Nên cân nhắc

- **Kho ý tưởng tách khỏi hàng đợi** (`Create > Ideas`). MYSP sinh bài từ sản phẩm nên
  chưa cần, nhưng nếu sau này có "soạn trước, gán sản phẩm sau" thì đây là khuôn sẵn.
- **Community (bình luận gộp một chỗ)** — ngoài phạm vi mọi phase hiện tại.
- **Habits** trong Insights — đo thói quen đăng đều, không chỉ đo tương tác.

### Không lấy

- Gộp bình luận đa kênh — không thuộc bài toán đăng bài tự động.
- Start Page — không liên quan.
- Đặt API vào bước thiết lập cho người dùng mới.
- Khoá nhóm kênh sau tường phí.

---

## 7. Chưa quan sát được — cần lượt sau nếu PM muốn

- Luồng OAuth nối kênh (cần nối tài khoản mạng xã hội thật).
- Publish ở chế độ **Calendar** khi có bài.
- Insights khi có số liệu, và tab **Habits**.
- Bộ soạn khi đã chọn kênh: xem trước theo kênh, đếm ký tự, cảnh báo riêng từng nền tảng.
- Luồng duyệt bài (**Approvals ⚡**) — cần gói trả phí.
- Giao diện khi có nhiều thành viên và phân vai.
