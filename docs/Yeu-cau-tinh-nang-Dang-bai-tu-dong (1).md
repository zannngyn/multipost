# YÊU CẦU TÍNH NĂNG
## Công cụ đăng bài tự động lên Facebook và TikTok, có AI tự viết content

---

## 1. Mục tiêu

Xây dựng công cụ đăng bài bán hàng tự động lên nhiều nền tảng, thay cho việc thủ công tải ảnh/video, viết caption và đăng từng bài, từng kênh.

Công cụ phải làm được 6 việc cốt lõi:

| # | Việc | Mô tả ngắn |
|---|---|---|
| 1 | Lấy ảnh/video linh hoạt | Tự động lấy từ Google Drive theo mã sản phẩm, hoặc người dùng tự tải lên |
| 2 | Đăng được cả ảnh và video | Bài ảnh nhiều tấm, bài video, hoặc Reels |
| 3 | Đăng đa nền tảng | Facebook và TikTok, một lần bấm lên cả hai |
| 4 | AI tự viết content | Kết hợp dữ liệu từ file "Hàng thiết kế 2026" và ảnh sản phẩm |
| 5 | Mỗi kênh một content riêng | Đăng lên bao nhiêu kênh thì sinh bấy nhiêu caption khác nhau |
| 6 | Đăng ngay hoặc hẹn lịch | Đăng luôn, hoặc đặt lịch đăng vào giờ đã chọn |

---

## 2. Nguồn dữ liệu

### 2.1. Ảnh và video — Google Drive, thư mục "Ảnh AI"

https://drive.google.com/drive/folders/1bA48sjugz9BczcoR0-zOc-VNlIYikp4v

**Quy ước đặt tên file:**

```
Ảnh:   MÃSẢNPHẨM-Màu (số thứ tự).jpg
Video: MÃSẢNPHẨM-Màu (số thứ tự).mp4
```

Ví dụ: `MRKVX6371-Tím (25).jpg`, `MR0VS6078-Xám (3).jpg`

| Thành phần | Ví dụ | Ý nghĩa |
|---|---|---|
| Mã sản phẩm | `MRKVX6371` | Khóa để tìm file và tra dữ liệu |
| Màu | `Tím` | Phân biệt phiên bản màu, dùng cho chức năng chọn màu |
| Số trong ngoặc | `25` | Số thứ tự, dùng để chọn ảnh cần đăng |
| Đuôi file | `.jpg` / `.mp4` | Hệ thống tự phân loại ảnh hay video |

File đặt sai chuẩn thì hệ thống báo lỗi rõ ràng, không được bỏ qua im lặng.

### 2.2. Thông tin sản phẩm — Google Sheet "Hàng thiết kế 2026"

https://docs.google.com/spreadsheets/d/1Qdhp9YS0mePn7G3focqAhqV3Mb1eymFqbX0EC1bFCVs

Tab đang dùng: **"Mẫu 2026"**. Tra theo cột **Mã sản phẩm**.

Chỉ đọc và sử dụng đúng những cột sau, các cột còn lại trong sheet bỏ qua hoàn toàn:

| Cột trong sheet | Dùng để làm gì |
|---|---|
| Mã sản phẩm | Khóa tra cứu, khớp với tên file |
| Tên sản phẩm | Bắt buộc đặt ở đầu caption (ví dụ `MR0AC6080` → `Penny`) |
| Mô tả sản phẩm | Nguyên liệu chính để AI viết content |
| Chủng loại | Bối cảnh cho AI (váy xòe, set quần, áo cộc tay...) |
| Mùa vụ | Bối cảnh cho AI chọn giọng văn |
| Tồn | Chỉ dùng nội bộ để kiểm tra tồn kho (mục 3), không đưa vào caption |
| Lưu ý nhận sx 1c / sx hết tồn | Chỉ dùng nội bộ để kiểm tra tồn kho (mục 3), không đưa vào caption |

Bắt buộc có danh sách trắng các trường được phép đưa vào caption. Ngoài danh sách đó, không dữ liệu nào từ Sheet được lọt ra bài đăng công khai.

---

## 3. Quy tắc tồn kho

Bước bắt buộc chạy đầu tiên, ngay sau khi tra được dữ liệu sản phẩm. Chưa qua bước này thì không gọi AI, không đăng. Áp dụng cho mọi nền tảng và mọi định dạng.

| Trạng thái | Điều kiện | Hành động |
|---|---|---|
| Hết hàng | Cột *Tồn* = 0 **hoặc** cột *Lưu ý* = "HẾT HÀNG" | Chặn, không đăng. Cảnh báo trên màn hình: *"Mã [XXX] đã hết hàng — không đăng"* |
| Tồn thấp | Cột *Tồn* từ 1 đến 3 | Vẫn đăng bình thường. Hiện cảnh báo **trên màn hình cho người vận hành**: *"Tồn thấp 3c — không nhận sx 1c"* |
| Bình thường | Cột *Tồn* lớn hơn 3 | Đăng bình thường |

**Cảnh báo tồn thấp là thông tin nội bộ.** Chỉ hiển thị trên giao diện công cụ và ghi vào log để nhân viên nắm tình hình. Tuyệt đối không đưa vào caption bài đăng.

Thứ tự ưu tiên: điều kiện hết hàng luôn thắng. *Tồn* = 0 thì chặn, bất kể cột *Lưu ý* ghi gì. Trong Sheet có dòng vừa ghi "Không nhận sx 1c" vừa có *Tồn* = 0 (ví dụ `MG0SQ6042`) — trường hợp này vẫn là hết hàng, chặn đăng.

Khi chạy hàng loạt: mã hết hàng thì bỏ qua, không làm dừng cả lô. Cuối phiên hiện bảng tổng kết — mã nào đã đăng lên kênh nào, mã nào bị bỏ qua.

---

## 4. Chọn màu và chọn ảnh

### 4.1. Chọn màu

Mã có nhiều màu thì giao diện phải có **ô chọn màu**. Hệ thống lọc file theo phần màu trong tên file.

- Chọn "Tím" thì chỉ lấy các file `MRKVX6371-Tím (...)`
- Chọn được nhiều màu cùng lúc
- Danh sách màu lấy từ tên file thực tế trên Drive, không nhập tay
- Mỗi màu đăng thành một bài riêng, trừ khi người dùng chọn gộp chung

### 4.2. Chọn ảnh theo số đuôi

Người dùng nhập số đuôi của những ảnh muốn đăng, cách nhau bằng dấu phẩy:

```
25, 3, 7, 12, 18
```

| Người dùng nhập | Hệ thống làm gì |
|---|---|
| Nhiều số (`25, 3, 7, 12, 18`) | Lấy **đúng** những ảnh có số đuôi đó, không thêm ảnh nào khác. Thứ tự đăng theo đúng thứ tự đã nhập, số đầu tiên là ảnh bìa |
| Một số duy nhất (`25`) | Ảnh số 25 lên đầu làm ảnh bìa, các ảnh còn lại xếp sau theo số tăng dần, lấy tối đa 10 ảnh |
| Không nhập gì | Lấy 5–10 ảnh đầu theo số tăng dần |

**Quy tắc số lượng:**
- Khi nhập danh sách số cụ thể: lấy đúng số ảnh đã chọn, không áp quy tắc tối thiểu 5
- Khi không nhập hoặc chỉ nhập một số: tối thiểu 5 ảnh, tối đa 10 ảnh. Mã có ít hơn 5 ảnh thì lấy hết số đang có
- Số đuôi không tồn tại: báo lỗi, ghi rõ số nào không tìm thấy, không tự bỏ qua im lặng

---

## 5. Định dạng bài đăng

Người dùng chọn định dạng cho từng lần đăng:

| Định dạng | Facebook | TikTok |
|---|---|---|
| Bài nhiều ảnh | Album ảnh | Bài ảnh dạng carousel |
| Bài video | Video post hoặc Reels | Video |

Yêu cầu:
- Hệ thống tự nhận diện file là ảnh hay video dựa vào đuôi file
- Mã có cả ảnh và video thì cho người dùng chọn dùng cái nào, hoặc chọn "ảnh lên Facebook, video lên TikTok"
- Video phải được kiểm tra thông số trước khi tải lên: tỷ lệ khung hình, dung lượng, thời lượng. Không đạt thì báo lỗi trước, không đăng rồi mới lỗi
- Video lớn phải tải lên theo từng phần và hiển thị tiến độ

---

## 6. Đăng đa nền tảng

- Một lần bấm, chọn được nhiều Facebook Page và nhiều tài khoản TikTok cùng lúc
- Danh sách hiển thị dạng tick chọn, gom nhóm theo nền tảng
- Lưu được nhóm kênh đặt sẵn để bấm một phát chọn cả nhóm
- Đăng giãn cách, không đăng dồn cùng lúc. Khoảng cách chỉnh được, mặc định 1–3 phút
- Kết quả trả về theo từng kênh: kênh nào thành công, kênh nào lỗi, kèm link bài
- Một kênh lỗi không được làm dừng các kênh còn lại

---

## 7. AI tự sinh content

### 7.1. Nguồn thông tin cho AI

AI kết hợp hai nguồn:

1. **Dữ liệu từ Sheet** — nguồn chính: tên sản phẩm, mô tả sản phẩm, chủng loại, mùa vụ. Cột *Mô tả sản phẩm* đã rất chi tiết, đây là nguyên liệu chính.
2. **Ảnh sản phẩm** — nguồn phụ: AI nhìn ảnh để nắm bối cảnh, ánh sáng, thần thái, cách phối đồ, viết content giàu hình ảnh hơn.

Nguyên tắc bắt buộc: khi ảnh và Sheet mâu thuẫn thì tin Sheet. Mọi thông số cụ thể chỉ lấy từ Sheet, AI không được suy đoán thông số từ ảnh.

Với bài video: AI dựa vào dữ liệu Sheet và ảnh của cùng mã đó để viết caption, không cần phân tích nội dung video.

### 7.2. Mỗi kênh một content riêng

Đây là yêu cầu bắt buộc. Đăng lên bao nhiêu kênh thì AI sinh bấy nhiêu caption **khác nhau hoàn toàn**, không được dùng lại caption của kênh khác.

- Hai Facebook Page thì hai caption khác nhau
- Facebook và TikTok thì caption khác nhau
- Ba kênh thì ba caption khác nhau

Giọng văn cấu hình bằng file prompt mẫu riêng cho từng nền tảng, chỉnh được mà không cần sửa code.

### 7.3. Cấu trúc caption

Dòng đầu tiên luôn là: `Tên sản phẩm – TIÊU ĐỀ CẢM XÚC VIẾT HOA`

```
Penny – MANG CẢ NHỊP THỞ MÙA HÈ VÀO TỪNG BƯỚC CHÂN
```

Sau dòng tiêu đề là phần nội dung do AI viết, dựa trên cột *Mô tả sản phẩm* và ảnh sản phẩm.

Kết thúc bằng **3–5 hashtag**.

Không có giá trong caption ở cả hai nền tảng.

### 7.4. Quy tắc về tên sản phẩm

Tên sản phẩm phải nhất quán trong toàn bộ caption. Dòng đầu là "Penny" thì mọi lần nhắc lại cũng phải là "Penny", không được lẫn tên mẫu khác.

Xử lý bằng cách truyền tên sản phẩm như một biến bắt buộc vào prompt, và kiểm tra tự động sau khi AI viết xong: caption chứa tên sản phẩm khác thì báo lỗi, bắt viết lại.

### 7.5. Kiểm tra tự động trước khi đăng

Caption không được chứa con số nào trông giống giá tiền (ví dụ "750.000", "1.450.000"). Nếu có thì chặn, bắt viết lại.

### 7.6. Bước xem trước và duyệt

- AI viết xong thì hiện caption của **từng kênh** cho người dùng xem trước
- Người dùng có thể sửa tay từng bản, bấm "viết lại" để AI sinh bản khác, hoặc duyệt để đăng
- Có tùy chọn bật/tắt chế độ tự động đăng luôn, mặc định TẮT

---

## 8. Hai chế độ lấy file

**Chế độ A — Tự động từ Drive theo mã sản phẩm**
Người dùng nhập mã sản phẩm, chọn màu, nhập số đuôi ảnh. Hệ thống tự tìm file trên Drive và tra dữ liệu từ Sheet.

**Chế độ B — Tự tải lên**
Dùng khi file chưa có trên Drive, hoặc muốn dùng file khác:
- Kéo-thả hoặc chọn ảnh/video từ máy tính, điện thoại
- Kéo-thả để sắp xếp lại thứ tự, ảnh đầu tiên là ảnh bìa
- Vẫn nhập mã sản phẩm để hệ thống tra Sheet và AI viết caption

Hai chế độ dùng chung toàn bộ phần kiểm tra tồn kho, AI viết caption và phần đăng bài.

---

## 9. Đăng ngay hoặc hẹn lịch

**Đăng ngay** — bấm là đăng, bài lên trong vài giây đến vài phút.

**Hẹn lịch** — chọn ngày giờ cụ thể:
- Đặt lịch cho từng bài, hoặc hàng loạt nhiều bài cùng lúc
- Màn hình quản lý bài đã hẹn: xem danh sách, sửa nội dung, đổi giờ, hủy trước khi đăng
- Hẹn giờ riêng cho từng kênh, vì Facebook và TikTok có khung giờ vàng khác nhau
- Kiểm tra lại tồn kho ngay trước khi đăng, không dùng số tồn lúc hẹn lịch. Hẹn hôm nay mai đăng, trong đêm hàng bán hết thì tự động hủy bài và báo người vận hành
- Đến giờ mà đăng lỗi thì phải báo cho người vận hành, không im lặng bỏ qua

---

## 10. Tiêu chí đánh giá hoàn thành

- Nhập mã thì bài lên đủ các kênh đã chọn, không cần thao tác tay thêm
- Đăng được cả bài ảnh và bài video
- Chọn màu hoạt động đúng, lọc được ảnh theo màu
- Nhập danh sách số đuôi thì đăng đúng những ảnh đó, đúng thứ tự
- Mỗi kênh có một caption riêng, không kênh nào trùng caption với kênh nào
- Mã hết hàng bị chặn, cảnh báo rõ ràng, không lên bất kỳ kênh nào
- Mã tồn ≤ 3 vẫn đăng bình thường, cảnh báo "Tồn thấp 3c — không nhận sx 1c" chỉ hiện trên màn hình cho người vận hành, không có trong caption
- Không có giá tiền, số tồn kho hay ghi chú sản xuất nào xuất hiện trong caption
- Caption luôn mở đầu bằng đúng tên sản phẩm từ Sheet, nhất quán trong cả bài
- Caption kết thúc bằng 3–5 hashtag
- Video sai thông số bị báo lỗi trước khi tải lên
- Tự tải file lên cũng đăng được, sắp xếp thứ tự được
- Hẹn lịch đúng giờ, sửa và hủy được, kiểm tra lại tồn trước khi đăng
- Chạy hàng loạt: mã lỗi bị bỏ qua, các mã còn lại vẫn chạy, cuối phiên có bảng tổng kết
