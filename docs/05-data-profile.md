# Khảo sát dữ liệu thật — Drive "Ảnh AI" & Sheet "Mẫu 2026"

**Ngày khảo sát:** 12/08/2026 · **Người thực hiện:** PM + AI agent (query trực tiếp, không ước đoán)
**Phương pháp:** thư mục Drive và Sheet đang ở chế độ chia sẻ công khai theo link → đọc qua `embeddedfolderview` (Drive) và CSV export theo tab (Sheet). Dữ liệu thô lưu tại `sample-data/`.

> ⚠️ **Hai giới hạn của phương pháp:**
> 1. Thư mục gốc trả về đúng **5.500 entry** — con số tròn nên nghi bị cắt, nhưng **3 lần fetch cách nhau (12/08) trả về cùng chính xác một bộ 5.500 file ID**, và các mã "cuối dải" (MRKVX6383, MR0VX6217) đều có mặt → không có bằng chứng truncation; vẫn nên xác nhận lần cuối bằng Service Account khi có.
> 2. Thư mục con **"Hàng Thiết Kế" trả về 0 entry** (không share công khai hoặc rỗng). Đây có thể là nơi chứa ảnh của 236 mã "có trên Sheet nhưng không thấy ảnh" (xem mục 4). **Cần được share để khảo sát bổ sung.**
> 3. Dữ liệu công khai theo link đồng nghĩa **ai có link đều xem được toàn bộ ảnh và Sheet (kể cả giá, tồn kho)** — nên báo stakeholder cân nhắc lại chế độ chia sẻ.

---

## 1. Thư mục Drive "Ảnh AI"

### 1.1. Tổng quan

| Chỉ số | Giá trị |
|---|---|
| Entry ở thư mục gốc | 5.500 (5.497 file + 3 thư mục con) |
| Thư mục con | "Hàng Thiết Kế" (❌ không đọc được), "Nghệ sĩ" (66 file), "Ảnh hiển thị tiktok và shopee" (84 file) |
| Cấu trúc | KHÔNG phẳng hoàn toàn như brief mô tả |
| Mã sản phẩm parse được từ tên file | **186 mã** *(hiệu chỉnh 12/08 chiều: 164 là số khi bắt buộc có đuôi file; nhận thêm 606 file không có đuôi → 186)* |
| Đuôi file (parse được) | png 2.745 · jpeg 783 · jpg 490 · video 19 (mp4 + mov) · **606 file KHÔNG có đuôi** |
| File **video** | **chỉ 19 file** trên toàn thư mục, đa số KHÔNG có "(số)", có cả `.mov` (brief chỉ nói `.mp4`) |

### 1.2. Mức tuân thủ quy ước đặt tên `MÃ-Màu (số).ext`

| Nhóm | Số file | Tỉ lệ |
|---|---:|---:|
| Đúng chuẩn nghiêm (như brief) | 3.948 | **71,8%** |
| Sai chuẩn | 1.549 | **28,2%** |

Phân loại 1.549 file sai chuẩn:

| Kiểu sai | Số file | Ví dụ thật |
|---|---:|---|
| Không có "(số)" | 1.063 | `MGSQ5202-2-XANH.jpg`, `MGKVX6310-BE-AI` (không cả đuôi file) |
| "Màu" = `AI` (không phải màu) | 104 | ` BG0SQ6083-AI (1).png` |
| Khoảng trắng/tab đầu tên | 97 | `   \t MGSQ5202-2-XANH.jpg` |
| Khác (2 mã dính nhau, tên iPhone, tên số...) | 285 | `MG0AD6051-MR0CV6068-AI (1).png`, `7F98EC09-...jpeg`, `1.jpg`, `_prompt_chuyn_4k_202601191649.jpeg` |

**Hàm ý thiết kế:** nguyên tắc "sai chuẩn thì báo lỗi" của brief, áp nguyên văn, sẽ đánh dấu lỗi **~1.500 file** — công cụ thành vô dụng. Parser phải có tầng chuẩn hoá (strip khoảng trắng, chấp nhận thiếu số, nhận diện hậu tố đặc biệt) + màn hình quản trị liệt kê file không parse được, thay vì chặn cứng.

### 1.3. "Màu" trong tên file — hỗn loạn có hệ thống

Các hiện tượng lặp lại đủ nhiều để phải xử lý:

| Hiện tượng | Ví dụ | Hàm ý |
|---|---|---|
| Hậu tố **`-AI`** (ảnh AI-generated) | `KEM-AI`, `XANH-AI`, riêng `AI` trần: 968 file | Cần tách hậu tố; **hỏi nghiệp vụ:** ảnh AI có được đăng không, ưu tiên ảnh thật hay ảnh AI? |
| Hậu tố **`-THỰC TẾ`** | `MGKVX6310-KEM-THỰC TẾ.png` | Đối ứng của `-AI` — ảnh chụp thật |
| Hậu tố **`-SAU` / `-MẶT SAU` / `Mặt sau`** | `TRẮNG-MẶT SAU`, `Hồng-Mặt sau(55)` | Ảnh mặt sau sản phẩm — có đưa vào album không, đứng vị trí nào? |
| Có dấu / không dấu lẫn lộn | `TRẮNG` 303 vs `TRANG` 110 · `ĐEN` 90 vs `DEN` 52 · `VÀNG` vs `VANG` · `ĐỎ` vs `DO` | Bắt buộc có **bảng ánh xạ chuẩn hoá màu**, nếu không lọc màu sẽ sót một nửa ảnh |
| Hoa/thường lẫn lộn | `HỒNG` / `Hồng` / `HONG`, `Mgkvx6310-CAM-AI` | Chuẩn hoá casefold + bỏ dấu khi so khớp |
| Viết liền / có cách | `XANHTHAN` vs `XANH THAN`, `HONGKEM`, `NAUBE` | Thêm vào bảng ánh xạ |
| Màu nhiều từ | `XANH NHẠT`, `NÂU VÀNG`, `HỒNG TÍM` | Regex không được cắt ở dấu cách (đóng câu **B3**) |
| Tên người trong trường màu | `KEM-DIỄN VIÊN NYSAKI` | Ca đặc biệt, cho vào danh sách lỗi |
| Tên sản phẩm KHÁC trong trường màu | `MG0SV6055-PIERA (...)` — Piera là tên của mã MG0AD6112 | Nguy cơ caption nhầm tên nếu tin tên file |
| 2 mã dính nhau | `MG0AD6051-MR0CV6068-AI`, `MGKVX6310-KEMMRKVX6310-BE-AI` | Set đồ chung ảnh? **Hỏi nghiệp vụ** |

### 1.4. Trùng lặp file

- **1.499 tên file xuất hiện ≥2 lần** (tổng 2.192 file dư), file ID khác nhau → trùng thật, không phải lỗi hiển thị.
- Hệ quả: chọn ảnh theo "số đuôi" có thể ra 2 file cùng số → cần quy tắc khử trùng (ví dụ: lấy file mới nhất).

### 1.5. Phân bố số ảnh mỗi mã & số thứ tự

| Số ảnh/mã | Số mã |
|---|---:|
| >30 ảnh (có mã 109 ảnh) | 38 |
| 11–30 | 76 |
| 5–10 | 41 |
| <5 | 9 |

- Số trong ngoặc **không liên tục và không bắt đầu từ 1** ở nhiều mã (ví dụ MGKVX6310: Hồng đánh số 50–64, khuyết 55 vì 55 nằm ở file "Mặt sau(55)"). Đóng câu **B4**: logic "lấy 5–10 ảnh đầu theo số tăng dần" phải hiểu là *sắp theo số hiện có*, không giả định 1..n.
- Mã >100 ảnh đủ loại (AI, thật, mặt sau, nhiều màu) → chế độ "không nhập gì, lấy 5–10 ảnh đầu" có **rủi ro chất lượng cao** (có thể vớ 10 ảnh AI cùng một góc). Đề xuất thứ tự ưu tiên: THỰC TẾ trước AI, mặt trước trước mặt sau — cần stakeholder xác nhận.

---

## 2. Sheet "Hàng thiết kế 2026" — tab "Mẫu 2026"

### 2.1. Cấu trúc

- **Tên cột chính xác** (đóng câu **B7**): `Ảnh` · `Mã sản phẩm` · `Ngày cập nhật` · `Chủng loại` · `Lưu ý nhận sx 1c / sx hết tồn` · `Tên sản phẩm` · `Nguyên Giá (bắt buộc)` · `Giá TMĐT` · `Giá TMĐT làm tròn` · `Giá KM` · `Mùa vụ` · `Tồn` · `Màu sắc` · `SIZE SỐ` · `Chất liệu` · `Mô tả sản phẩm` · `Hàng tặng` · `BST mới` · `Biển` · `Nghệ sĩ` · `Sale CH` (+ nhiều cột trống không tên).
- Sheet có **4 cột giá** — danh sách trắng trường đưa vào prompt (brief mục 2.2) càng quan trọng: tuyệt đối không để cột giá lọt vào AI.
- 302 dòng, trong đó **301 dòng có mã**, **299 mã duy nhất**.

### 2.2. Cột Tồn (đóng câu B8)

- **Luôn là số nguyên hoặc ô trống** — không có chữ. Xử lý duy nhất cần chốt: ô trống (5 dòng) → đề xuất coi như hết hàng (an toàn).
- Phân bố: **Tồn = 0: 225/301 dòng (75%)** · Tồn 1–3: 30 dòng (10%) · Tồn >3: 41 dòng · trống: 5.

### 2.3. Cột Lưu ý (đóng câu B9)

Chỉ **3 giá trị distinct** — sạch hơn dự đoán:

| Giá trị | Số dòng | Rule brief đã phủ? |
|---|---:|---|
| `Không nhận sx 1c` | 184 | ✅ (cảnh báo nội bộ khi tồn thấp) |
| `HẾT HÀNG` | 81 | ✅ (chặn) |
| `Không cần cọc` | 36 | ❌ **chưa có trong brief — hỏi nghĩa và cách xử lý** |

### 2.4. Cột Màu sắc & tồn theo màu (ĐÓNG CÂU B10 — quan trọng nhất)

- Sheet **có cột `Màu sắc`** (298/301 dòng có dữ liệu), nhưng mỗi mã một dòng và ô màu ghi gộp: `KEM, HỒNG` / `XANH, KEM`.
- **Kết luận: tồn kho theo MÃ, không theo màu.** Schema không cần bảng tồn-theo-màu. Rủi ro nghiệp vụ vẫn còn (mã còn 10 nhưng màu Tím hết vẫn sẽ đăng Tím) — nhưng đó là giới hạn của dữ liệu nguồn, không phải của công cụ; ghi nhận vào rủi ro để stakeholder biết.

### 2.5. Mã trùng dòng (đóng câu B11)

2 mã xuất hiện 2 dòng:

| Mã | Tình trạng |
|---|---|
| `MRKSQ6066` | 2 dòng **giống hệt nhau** (Celyra, Tồn 39) — duplicate thuần, khử được tự động |
| `MGKSQ6031` | 2 dòng **XUNG ĐỘT**: "Yelissea / ĐEN, KEM, NÂU BE / Tồn 0" vs "Fioraé / KEM / Tồn 0" — caption sẽ lấy tên nào? **Phải hỏi stakeholder + cần rule khi gặp xung đột (đề xuất: chặn đăng, báo lỗi)** |

### 2.6. Chất lượng dữ liệu cho AI

- **15 dòng thiếu `Mô tả sản phẩm`** → AI không có nguyên liệu chính; cần rule: chặn hay cho đăng với caption ngắn?
- `Tên sản phẩm` đủ 100% — tốt cho quy tắc "tên mở đầu caption".

---

## 3. Thư mục con (ngoài chuẩn hoàn toàn)

| Thư mục | Số file | Nhận xét |
|---|---:|---|
| Hàng Thiết Kế | **không đọc được** | Cần share; nghi là nơi chứa ảnh của 236 mã thiếu ảnh |
| Nghệ sĩ | 66 | Tên kiểu `MGAD5115-XANH THAN- Diễn viên Cù Thị Trà` — có tên người, không "(số)"; nhiều bản trùng |
| Ảnh hiển thị tiktok và shopee | 84 | Tên `1.png`, `10 (1).png` — không mang mã sản phẩm, không dùng được cho luồng tự động |

**Đề xuất scope:** phase 1 chỉ đọc **thư mục gốc**; 2 thư mục con "Nghệ sĩ" và "tiktok/shopee" đứng ngoài luồng tự động (dùng qua chế độ B - tự tải lên nếu cần).

---

## 4. Đối chiếu chéo Drive ↔ Sheet

*(số liệu đã hiệu chỉnh sau lần rà soát thứ hai 12/08 — regex nhận cả file không đuôi)*

| Chỉ số | Giá trị |
|---|---:|
| Mã có ảnh (root Drive) | 186 |
| Mã trên Sheet | 299 |
| **Khớp cả hai** | **64** |
| Mã có ảnh nhưng KHÔNG có trên Sheet (→ không đăng được, thiếu data) | 122 |
| Mã trên Sheet nhưng KHÔNG thấy ảnh ở root (→ nghi nằm trong "Hàng Thiết Kế") | 235 |
| Trong 64 mã khớp: Tồn = 0 hoặc trống (→ bị chặn) | 44 |
| **Mã sẵn sàng đăng ngay hôm nay** | **đúng 20** |

Danh sách 20 mã đăng được ngay: `MG0AD6112` `MG0AD6118` `MG0SQ6026` `MG0SQ6115` `MG0SV6030` `MG0SV6058` `MG0SV6074` `MG0VS6111` `MG0VS6121` `MGKAD6045` `MGKSQ6072` `MGKSQ6309` `MGKSV6024` `MGKVX6010` `MGKVX6044` `MGKVX6310` `MGOAC6011` `MGVVX6076` `MMAC546` `MMAD511`

**Đây là phát hiện quan trọng nhất của khảo sát:** với dữ liệu hiện tại, công cụ xây xong chỉ đăng được đúng 20 mã. Giá trị của công cụ phụ thuộc vào việc (a) mở được thư mục "Hàng Thiết Kế", (b) bổ sung 122 mã có ảnh vào Sheet, (c) nhịp hàng mới về. Cần đưa vào agenda workshop như câu hỏi số một về nghiệp vụ.

---

## 5. Bộ 5 mã mẫu (dùng cho ví dụ tài liệu, test, UAT)

Chi tiết file từng mã: `sample-data/5-ma-mau-file-listing.txt`

| Ca | Mã | Tên | Tồn | Ảnh | Ghi chú |
|---|---|---|---:|---:|---|
| Nhiều màu | `MGKVX6310` | Giannal | 104 | 58 tên file duy nhất | 4+ màu (KEM/HỒNG/NÂU/CAM/BE), đủ mọi kiểu hỗn loạn: `-AI`, `-THỰC TẾ`, `Mặt sau`, thiếu đuôi file, hoa/thường, số không liên tục — **mã test tốt nhất cho parser** |
| Một màu | `MGKAD6045` | Claires | 157 | 33 | XANH + biến thể `MẶTSAU-XANH`, `XANH-AI` |
| Có video | `MG0AC6017` | Maelis | 0 | 78 + video `.mov`+`.mp4` | Đồng thời là ca chặn (Tồn=0) — test được cả hai rule |
| Hết hàng | `MR0AC6080` | **Penny** | 0 | 10 | Chính là ví dụ trong brief mục 2.2/7.3 |
| Tồn thấp (≤3) | `MG0VS6111` | Pavly | 3 | 40 | Màu `KEM`/`NÂU`/`NAU` — test cảnh báo "Tồn thấp 3c" + chuẩn hoá dấu |

---

## 6. Đáp án cho các câu hỏi nhóm B (doc 01)

| Câu | Trạng thái | Đáp án ngắn |
|---|---|---|
| B1 | ✅ Đóng | 5.497 file root (ổn định qua 3 lần fetch) + 3 folder con (1 chưa đọc được); 186 mã; KHÔNG phẳng |
| B2 | ✅ Đóng | 71,8% đúng chuẩn nghiêm; 28,2% sai — xem mục 1.2 |
| B3 | ✅ Đóng | Màu nhiều từ CÓ; dấu/không dấu, hoa/thường, viết liền đều lẫn lộn — cần bảng chuẩn hoá |
| B4 | ✅ Đóng | Số KHÔNG liên tục, KHÔNG chắc từ 1; 1.063 file không có số |
| B5 | ⏳ Hỏi người | Ai sửa/xoá/đổi tên file — workshop |
| B6 | ⏳ Hỏi người | Service Account — cần IT; lưu ý thêm: dữ liệu đang public theo link (mục cảnh báo đầu tài liệu) |
| B7 | ✅ Đóng | 301 dòng; tên cột chính xác ở mục 2.1; có thêm nhiều cột ngoài brief (4 cột giá!) |
| B8 | ✅ Đóng | Tồn luôn là số hoặc trống; chỉ cần rule cho ô trống (đề xuất: chặn) |
| B9 | ✅ Đóng | 3 giá trị; giá trị mới `Không cần cọc` cần hỏi nghĩa |
| B10 | ✅ Đóng | **Tồn theo MÃ**, màu ghi gộp một ô — schema không cần tồn theo màu |
| B11 | ✅ Đóng | 2 mã trùng dòng; 1 ca xung đột dữ liệu (MGKSQ6031) cần rule |
| B12, B13 | ⏳ Hỏi người | Workshop |

## 7. Câu hỏi MỚI phát sinh từ dữ liệu (đưa vào workshop)

1. **Thư mục "Hàng Thiết Kế" chứa gì?** Share để khảo sát — nghi là ảnh của 236 mã thiếu.
2. **Ảnh `-AI` vs `-THỰC TẾ`:** đăng loại nào, ưu tiên loại nào, có được trộn không?
3. **Ảnh `Mặt sau`:** có vào album không, vị trí nào?
4. **`Không cần cọc`** trong cột Lưu ý nghĩa là gì, ảnh hưởng rule đăng không?
5. **MGKSQ6031 hai dòng khác tên** (Yelissea vs Fioraé) — dòng nào đúng?
6. **File 2 mã dính nhau** (`MG0AD6051-MR0CV6068`) — set đồ dùng chung ảnh? Đăng dưới mã nào?
7. **1.499 tên file trùng** — chọn bản nào (mới nhất)? Có dọn Drive không?
8. **Chỉ ~20 mã đăng được ngay** — kế hoạch bổ sung dữ liệu (thêm mã vào Sheet / mở folder con) là gì?
9. **Sheet và Drive đang public theo link** (lộ giá + tồn kho) — có siết lại quyền không? (Nếu siết, công cụ chuyển sang Service Account — câu B6.)

## 8. Nhận định nghiệp vụ (BA điền sau khi thẩm định)

*(dành cho BA — đối chiếu mục 7 với người quản lý Drive/Sheet rồi ghi kết luận tại đây)*
