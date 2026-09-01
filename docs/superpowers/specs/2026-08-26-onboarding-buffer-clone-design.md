# Thiết kế — Onboarding kiểu Buffer (đo từ hệ thống thật)

Ngày: 2026-08-26 · Epic E10 · **Thay thế** `2026-08-26-onboarding-slideshow-design.md`
Trạng thái: chờ PM duyệt

---

## 0. Nguồn số liệu — đọc trước khi nghi ngờ bất kỳ con số nào

Mọi giá trị trong tài liệu này **đo từ DOM thật** của `https://publish.buffer.com/onboarding`
bằng Chrome + `getComputedStyle`, màu chuyển sang hex bằng cách vẽ 1 pixel lên canvas rồi
đọc `getImageData` (Chrome trả `lab()` nên đọc chuỗi trực tiếp là vô nghĩa). **Không có con
số nào ước lượng từ ảnh chụp.**

Ai muốn đo lại: đăng nhập Buffer rồi mở thẳng `publish.buffer.com/onboarding` — URL này
phát lại luồng onboarding **kể cả khi tài khoản đã hoàn thành nó**.

Đo ở khung 1568×737 và 1534×950.

## 0b. Ảnh tham chiếu — XEM TRƯỚC KHI DỰNG

Ảnh chụp từ hệ thống thật, lưu trong repo. **Đọc số đo mà không mở ảnh là dựng mù.**

| Ảnh | URL lúc chụp | Nội dung |
|---|---|---|
| `assets/buffer-onboarding/00-welcome.jpg` | `/onboarding` | Màn chào — lưới nền, icon rải, nút xanh |
| `assets/buffer-onboarding/01-seller-selected.jpg` | `/onboarding` | Bước 1, **thẻ "Solo creator" ĐANG CHỌN** |
| `assets/buffer-onboarding/02-tools-selected.jpg` | `/onboarding` | Bước 2, **ô tick đã tick**, dòng phụ, thẻ đang chọn |
| `assets/buffer-onboarding/03-count-selected.jpg` | `/onboarding` | Bước 3, thẻ chữ trơn đang chọn, **Skip đang hover** |
| `assets/buffer-onboarding/04-channels.jpg` | `/onboarding` | Bước 4, lưới 11 ô kênh, **ô tick hiện khi hover** |
| `assets/buffer-onboarding/05-step-transition-crossfade.jpg` | `/onboarding` | **Bắt đúng lúc chuyển bước** — xem mục 2.5 |

Host: `publish.buffer.com`. **Cột URL giống hệt nhau ở cả sáu ảnh — đó không phải lỗi ghi
chép, xem mục 0c.**

### Ảnh tham chiếu KHÔNG phải tỉ lệ 1:1 với CSS — đọc trước khi "sửa cho khớp ảnh"

Sáu ảnh là bản chụp khung **1534×950** đã thu nhỏ về **1400×867**, tỉ lệ ≈ **0.9126**.
Bằng chứng: ô lưới nền đo trong ảnh ra 48–49px, trong khi giá trị CSS thật của Buffer là
`background-size: 54px 54px` (54 × 0.9126 = 49.3).

Hệ quả, và đây là chỗ dễ làm hỏng nhất:

- **Số kích thước CSS lấy từ DOM là sự thật**: 54px lưới, 48px nút, 341×58 thẻ, 12px bo
  (MYSP dùng token 12.8px). **Đừng chia chúng cho 0.9126.** Nền lưới là `background-size`
  cố định, không co theo khung.
- **Số vị trí theo trục dọc thì đối chiếu bằng TỈ LỆ**, không bằng pixel tuyệt đối. Tâm khối
  nội dung màn chào ở y≈279 trên ảnh 867 cao = **32.2% từ đỉnh**; con số đó mới là thứ phải
  khớp, ở bất kỳ chiều cao khung nào.
- Dựng đúng rồi thì **lưới của ta sẽ trông to hơn lưới trong ảnh khoảng 10%**. Đó là đúng,
  không phải lỗi. Ai "sửa" cho khớp mắt sẽ làm sai giá trị CSS thật.

## 0c. Buffer giữ MỘT URL cho cả luồng — MYSP cố ý làm khác

Quan sát trực tiếp: từ màn chào tới hết bước 4, thanh địa chỉ **không đổi một ký tự**, luôn
là `publish.buffer.com/onboarding`. Vị trí trong luồng nằm trong state React; chỉ có đáp án
là ghi lên server sau mỗi bước.

**MYSP làm ngược lại: đặt bước lên URL (`/onboarding?step=…`).** Đây là quyết định có chủ ý,
không phải quên bắt chước:

| | Buffer | MYSP |
|---|---|---|
| Bấm F5 giữa chừng | về màn chào, phải bấm lại | về đúng bước đang dở |
| Nút Back của trình duyệt | thoát khỏi cả luồng | lùi một bước |
| Gửi link cho đồng nghiệp / hỗ trợ | không chỉ được bước nào | chỉ được |
| Ghi lỗi khi có sự cố | chỉ biết "ở onboarding" | biết đúng bước |

`core/web-wizard` trong bộ skill của dự án cũng yêu cầu bước nằm ở URL chứ không ở state.

**Hệ quả cho người dựng:** đừng nhìn ảnh rồi kết luận "không có gì trên URL nên mình cũng
không cần". Phần nhìn thấy được thì clone; phần điều hướng thì theo MYSP.

Bốn ảnh có chữ "SELECTED"/"đang chọn" là thứ ảnh chụp tay ban đầu **không có**, và là
trạng thái dễ làm sai nhất.

---

## 1. Thay đổi nghiệp vụ

**Trước:** tài khoản mới không thuộc công ty nào → wizard bắt tạo công ty → 6 slide thiết
lập (Google Drive, Sheet, Facebook, nhóm kênh, mời người, chúc mừng).

**Sau:**

1. Đăng ký xong → **hệ thống tự tạo sẵn một tổ chức**, không hỏi. Không còn màn "Tạo công ty".
2. Đăng nhập lần đầu → màn chào toàn màn hình.
3. Bốn bước khảo sát hồ sơ.
4. Xong → vào thẳng ứng dụng.

**Việc kết nối Drive/Sheet/Facebook/nhóm kênh KHÔNG còn nằm trong onboarding** (PM chốt:
"survey thay luôn, kết nối tính sau"). Chúng quay về `SetupDock` và các route thật
`/sync`, `/data-mapping`, `/channels`, `/channels/groups` — vốn vẫn hoạt động đầy đủ.

**Giữ lại từ lượt trước:** cơ chế cookie `mysp_oauth_return` (commit `064ca88`, `0df33f7`)
vẫn có ích và không được gỡ — nó giúp callback OAuth quay về đúng nơi phát lệnh.

**NGOÀI PHẠM VI — PM chốt 26/08/2026:** màn soạn bài `/compose` **giữ nguyên như hiện tại**.
Đợt việc này chỉ đụng onboarding. Composer của Buffer đã được phân tích trong
`2026-08-26-buffer-system-analysis.md` §2.7 nhưng đó là tham chiếu cho sau, **không** phải
việc đang giao. Không sửa `src/ui/components/compose/**`.

---

## 2. Bảng token đo được

### 2.1 Màu — chế độ sáng

| Vai trò | Giá trị đo | Ghi chú |
|---|---|---|
| Nền trang (`body`, `html`) | `#FFFFFF` | Trắng thật |
| **Bề mặt onboarding** | `#F7F6F3` | Một `div` bọc, KHÔNG phải body — đây mới là màu kem nhìn thấy |
| Chữ chính | `#292928` | Tiêu đề, nhãn thẻ, chữ nút |
| Chữ phụ | `#5A5A59` | Dòng "e.g. Hootsuite, Sprout Social, Later" |
| Chữ mờ | `#7C7B79` | Chữ trên nút Continue khi tắt |
| Viền thẻ (thường) | `#EAE8E5` | 1px solid |
| **Viền thẻ (đã chọn)** | `#337046` | 1px solid — xanh lá đậm |
| Nền thẻ | `#FFFFFF` | Cả chọn lẫn không chọn — **chỉ viền đổi** |
| Nền nút chính | `#B0EC9C` | Xanh pastel |
| Nền nút tắt | `#DEDCD9` | |
| Viền ô tick | `#8C8B88` | |
| Chấm tiến độ (đang ở) | `#292928` | |
| Chấm tiến độ (còn lại) | `#BCBAB6` | |
| Đường lưới nền | `#DEDCD9` @ 40% | 1px |
| Gradient làm mờ rìa | `#EAE8E5` | |

### 2.2 Màu — chế độ tối (`<html class="dark">`)

| Vai trò | Giá trị đo |
|---|---|
| Bề mặt onboarding | `#131313` |
| Chữ chính | `#EDEDED` |
| Nền thẻ | `#1E1F1F` |
| Viền thẻ | `#2B2C2C` |
| Nút Continue (tắt) | `rgba(216,216,216,.05)`, chữ `#707373` |

### 2.3 Chữ

| | Buffer dùng | MYSP dùng |
|---|---|---|
| Tiêu đề | **Stolzl** 28px / line-height 35px / weight 400 | **Font tiêu đề của Astryx** — Stolzl là font thương mại, KHÔNG dùng được |
| Nhãn thẻ | 16px / 400 | giữ nguyên cỡ |
| Chữ phụ trong thẻ | 12px / 400 | giữ nguyên cỡ |
| Nút, Skip | **Inter** 14px / 500 | font body của Astryx |

Tiêu đề **căn giữa**, `text-align: center`, không giới hạn `max-width`.

### 2.4 Hình khối

| Thứ | Giá trị |
|---|---|
| Bo góc thẻ, nút, ô kênh | `12px` |
| Bo góc ô emoji, ô logo | `8px` |
| Bo góc ô tick | `4px` |
| Đổ bóng | **`none`** — không thẻ nào có bóng. Phân tách bằng viền 1px |
| Chiều cao nút | `48px` |
| Padding nút | `0 24px` |

### 2.5 Chuyển động đo được

| Nơi | Giá trị |
|---|---|
| Nút chính | `border-color .15s ease-out, background-color .15s ease-out, color .15s ease-out` |
| Thẻ lựa chọn | `opacity .15s ease-out, border-color .1s ease-out` |

**Chuyển cảnh giữa các bước là CROSSFADE, không phải trượt ngang.** Bắt được trong
`assets/buffer-onboarding/05-step-transition-crossfade.jpg`: hai màn chồng lên nhau, cùng
căn giữa, một cái mờ đi trong khi cái kia hiện lên — **không có dịch chuyển ngang nào**.
Đây là chỗ dễ làm sai nhất vì bản năng sẽ dựng slideshow trượt ngang.

Kèm theo: nút Tiếp tục **hiện vòng quay trong lúc lưu** rồi mới sang bước sau — tức mỗi
bước ghi lên server trước khi đi tiếp, khớp với mục 8.

MYSP dùng chuẩn đã có trong dự án cho thời lượng — vào 320ms, ra 200ms, chỉ
`transform`/`opacity`, `useReducedMotion()` thu về 120ms — nhưng **kiểu chuyển phải là
crossfade**, không phải trượt.

---

## 3. Khung chung mọi màn

```
┌────────────────────────────────────────────────────────┐
│ ←  [logo]              ● ○ ○ ○              [☀ ☾]      │  y=39
│                                                        │
│                                                        │
│                    Tiêu đề 28/35                       │
│                                                        │
│                 ┌────────┐ ┌────────┐                  │
│                 │ thẻ    │ │ thẻ    │                  │
│                 └────────┘ └────────┘                  │
│                                                        │
│                 [    Continue  →    ]                  │  352×48
│                        Skip                            │
└────────────────────────────────────────────────────────┘
```

- Mũi tên quay lại + logo: góc trái trên. **Màn chào không có mũi tên quay lại.**
- Bốn chấm tiến độ: **6×6px**, bo tròn, giữa đỉnh. Màn chào không có chấm.
- Nút chuyển sáng/tối: góc phải trên, dạng viên thuốc hai nửa.
- **Căn dọc KHÔNG giống nhau giữa màn chào và bốn bước khảo sát.** Đo lại từ chính ảnh
  tham chiếu ở khung 1400×867:

  | Màn | Tâm khối nội dung | So với tâm khung (433) |
  |---|---|---|
  | `00-welcome` | y ≈ **279** | cao hơn 154px |
  | `01-seller` | y ≈ **460** | gần như đúng giữa |
  | `03-count` | y ≈ **462** | gần như đúng giữa |

  **Con số chốt (đo lại ở Task 7, chính xác hơn bảng trên):**

  | Màn | Tâm khối | Tỉ lệ so với chiều cao khung |
  |---|---|---|
  | Chào | 279 / 867 | **32.2%** |
  | Bốn bước khảo sát | 459.5 / 867 | **53.0%** |

  **Tâm là thuộc tính của KHUNG, không phải của nội dung** — bằng chứng: hai ảnh gốc
  `01-seller` và `03-count` lệch nhau 15px chiều cao khối mà tâm vẫn trùng đúng 459.5.
  Ai thấy tâm lệch thì đừng đổ cho "nội dung chưa đủ"; đó là lỗi bố cục thật.

  Ngang thì cả năm màn đều căn giữa. Bản spec đầu viết "mọi màn căn giữa cả ngang lẫn dọc"
  là **sai** — khảo sát ở 53% chứ không phải 50%, và màn chào ở 32%.

---

## 4. Màn chào

- Bề mặt trắng, phủ **lưới ô 54×54px**, đường 1px `#DEDCD9` @ 40%, làm mờ dần ở rìa.

Công thức nền, sao chép nguyên văn từ `background-image` thật:

```css
background-image:
  linear-gradient(to top,   #EAE8E5 0%, transparent 20%, transparent 80%, #EAE8E5 100%),
  linear-gradient(to right, #EAE8E5 0%, transparent 20%),
  linear-gradient(to left,  rgba(222,220,217,.4) 1px, transparent 1px),
  linear-gradient(          rgba(222,220,217,.4) 1px, transparent 1px);
background-size: 100% 100%, 100% 100%, 54px 54px, 54px 54px;
```

- Trên lưới rải **các ô logo mạng xã hội**. Đo được:
  - Mỗi ô chiếm **đúng một ô lưới 54×54px** và **bám vào lưới** — không rải tự do.
  - Logo bên trong **40×40px**, căn giữa ô.
  - Độ rõ khác nhau rất mạnh: vài logo đầy màu và nét, phần lớn nhạt gần như chìm vào nền.
    Đây là thứ tạo chiều sâu; rải đều một độ mờ sẽ trông như lỗi.
  - Đếm được ~16 ô trong khung 1534×950; đo chính xác được 10, ví dụ (% so với khung):
    (25.4, 7.6) · (11.3, 36.0) · (21.8, 58.7) · (39.4, 64.4) · (7.8, 18.9) · (74.6, 7.6).
  - **Vị trí cụ thể không quan trọng** — đây là trang trí. Quy tắc cần giữ là: bám lưới,
    thưa ở giữa (chừa chỗ cho chữ), dày hơn ở rìa, độ rõ biến thiên mạnh.
  - Xem `assets/buffer-onboarding/00-welcome.jpg`.
- `<h1>` hai dòng, căn giữa: `Chào {tên} 👋` / `Chào mừng tới MYSP`.
- Nút `Bắt đầu →`: nền `#B0EC9C`, chữ `#292928`, bo 12px, cao 48px, padding `0 24px`,
  rộng **139px** (co theo nội dung, không giãn hết).

**MYSP:** dùng logo Facebook + TikTok + các kênh ở mục 6. Không đủ 16 kênh như Buffer thì
lặp lại với độ mờ khác nhau — đám icon là trang trí, `aria-hidden="true"`.

---

## 4b. Chuyển động nền màn chào (PM giao 26/08 — "chưa đủ tầm")

**Hiện trạng:** nền hoàn toàn tĩnh. Task 5 có viết hiệu ứng trôi bằng framer-motion nhưng đo
trong app thật ra `transform: none` suốt 900ms — không chạy. Agent gỡ bỏ thay vì để lại code
chết. Quyết định đó đúng; thiếu sót là không thay bằng cái chạy được.

**Bằng chứng Buffer có hiệu ứng vào màn:** ảnh chụp đầu tiên trong quá trình khảo sát bị
nhoè trắng toàn bộ khung — chữ, nút, icon đều mờ gần hết. Đó là một khung bắt giữa lúc
fade-in, không phải lỗi chụp.

**Bốn lớp, xếp theo thứ tự phải làm:**

1. **Vào màn (bắt buộc).** Các ô hiện lên so le từ giữa lan ra rìa — `opacity` + `scale`,
   bước lệch 30–50ms theo khoảng cách tới tâm. Chữ và nút vào sau cùng. Đây là lớp Buffer có.
2. **Trôi môi trường (bắt buộc).** Mỗi ô trôi vài px theo chu kỳ riêng, rất chậm (8–20s),
   pha lệch nhau. Đây là thứ biến nền tĩnh thành nền sống mà không cướp sự chú ý.
3. **Thị sai theo con trỏ (đây là lớp tạo ấn tượng).** Ô ở tầng sâu khác nhau dịch chuyển
   với hệ số khác nhau khi rê chuột. Tầng sâu **ánh xạ theo độ mờ sẵn có** — ô mờ ở xa, dịch
   ít; ô rõ ở gần, dịch nhiều. Nhất quán với chiều sâu đã có sẵn thay vì bịa thêm.
4. **Lưới hô hấp (tuỳ chọn).** Đường lưới sáng lên rất nhẹ theo chu kỳ dài.
5. **Phản ứng theo lân cận con trỏ (PM yêu cầu 26/08).** Con trỏ đi ngang qua thì ô phản
   ứng — càng gần càng rõ. **Không dùng `:hover`**: cả lớp nền là `pointer-events-none` và
   phải giữ nguyên như thế, nếu không trang trí sẽ ăn sự kiện chuột của nút "Bắt đầu". Dùng
   chính vòng rAF của lớp 3, tính khoảng cách con trỏ tới từng ô. Phản ứng theo độ gần mượt
   hơn hover thật vì không nhảy bậc. Cách hợp nhất là **tăng độ rõ** — độ mờ đang là thang
   chiều sâu sẵn có, nên ô mờ sáng lên khi con trỏ tới gần đọc rất tự nhiên.

### Lưới và icon phải khớp — cách kiểm không thể tự lừa mình

**Lỗi đã xảy ra:** Task 5 báo "icon bám lưới, `x % 54 == 0`" và PM xem app thật thì thấy
chúng **không** nằm trong lưới. Phép đo sai ở chỗ nó so với **khung chứa ô**, chưa bao giờ
so với **đường kẻ thật sự được vẽ ra**. Hai lớp lệch gốc hoặc lệch pha thì phép đo đó vẫn ra 0.

Nghi phạm số một là **pha của gradient**:
- `linear-gradient(var(--border) 1px, transparent 1px)` → đường ngang ở **mép TRÊN** ô (y = 0, 54, 108…)
- `linear-gradient(to left, var(--border) 1px, transparent 1px)` → đường dọc ở **mép PHẢI** ô (x = 53, 107, 161…)

Hai trục lệch nhau cả cạnh lẫn một pixel, trong khi track của CSS grid đều bắt đầu ở mép
trái/trên. Thêm nữa `repeat(auto-fill, 54px)` để lại phần dư ở mép phải/dưới.

**Cách kiểm bắt buộc, hai tầng:**
1. Qua DOM: `(cellLeft - groundLeft) % 54` và `(cellTop - groundTop) % 54`, đo trên **ô 54px
   bọc ngoài**, không phải ô 40px bên trong.
2. **Qua pixel**: chụp màn, quét một hàng ngang và một cột dọc tìm toạ độ thật của đường kẻ,
   rồi so với mép ô. **Đây mới là sự thật** — mọi phép đo qua DOM đều có thể tự lừa mình.

**Token motion của Astryx — nguồn có thẩm quyền, thay mọi con số tự đặt.**
Đọc từ `pnpm exec astryx docs motion` và `https://astryx.atmeta.com/docs/motion`, hai bản
trùng khớp.

| Token | Giá trị | | Token | Giá trị |
|---|---|---|---|---|
| `--duration-fast-min` | 130ms | | `--duration-medium-max` | 550ms |
| `--duration-fast` | 175ms | | `--duration-slow-min` | 730ms |
| `--duration-fast-max` | 230ms | | `--duration-slow` | 975ms |
| `--duration-medium-min` | 310ms | | `--duration-slow-max` | 1300ms |
| `--duration-medium` | 410ms | | | |

**Easing chỉ có MỘT:** `--ease-standard: cubic-bezier(0.24, 1, 0.4, 1)`.
Nhập bằng `import {durationVars, easeVars} from '@astryxdesign/core'`.

> **CẢNH BÁO: bảng trên là mặc định của THƯ VIỆN, không phải giá trị MYSP thật sự chạy.**
> `src/ui/theme/mysp.css` (sinh tự động, canh bởi `pnpm theme:check`) **định lại thang này
> nhanh hơn**: `--duration-fast` = **125ms** (không phải 175), `--duration-medium-min` =
> **225ms** (không phải 310), `--duration-fast-min` = **95ms** (không phải 130).
> `--ease-standard` không đổi.
>
> Hệ quả: CSS đọc `var()` nên tự lấy đúng giá trị của MYSP. Nhưng **framer-motion không
> nhận `var()`** — nơi nào truyền số trực tiếp cho framer-motion thì phải dùng con số của
> `mysp.css` (0.225 / 0.125 / 0.095), kèm comment chỉ về `mysp.css` làm nguồn. Chép số của
> thư viện vào đó là làm onboarding chạy chậm hơn phần còn lại của app.

Hệ quả: crossfade chuyển bước phải là **vào `--duration-medium-min` (310), ra
`--duration-fast` (175), easing `--ease-standard`** — không phải 320/200 với bezier tự chọn
như bản đầu spec này viết.

**PHẠM VI TOKEN — chỗ dễ làm hỏng hệ thống thiết kế:**
Astryx motion **chỉ phủ transition**. Không có token nào cho vòng lặp môi trường, thị sai,
stagger, hay keyframe trang trí. Nên:

- Là **transition** → bắt buộc dùng token.
- Là **vòng lặp trang trí** → không có token, và **đừng bịa ra một cái**. Hardcode kèm
  comment nói thẳng *"Astryx motion covers transitions only; this is a decorative loop
  outside that scale"*. Bịa tên token là làm hỏng hệ thống; hardcode có ghi lý do là trung thực.
- Bước lệch stagger nên **dẫn xuất từ token** (một phần của `--duration-fast`) thay vì số trần.
- Vòng lặp liên tục dùng `linear`/sine, **không** dùng `--ease-standard` — ease-out trong
  vòng lặp sẽ giật ở điểm nối.

Hai câu trong tài liệu áp thẳng vào đây: *"Motion should never stand between the user and
their next action"* (hiệu ứng vào màn không được chặn nút "Bắt đầu") và *"replace animations
with instant state changes"* khi bật reduced motion (tắt hẳn, không làm chậm).

**Cách làm — KHÔNG lặp lại lỗi của Task 5:**
- **Lớp 1, 2, 4 làm bằng CSS `@keyframes`**, tham số riêng từng ô truyền qua CSS custom
  property (`--delay`, `--dur`, `--phase`). Lý do: 21 instance framer-motion là 21 vòng lặp
  JS, và bản framer-motion trước đã im lặng không chạy. CSS chạy trên compositor, không cần
  JS, và **nhìn thấy được ngay trong DevTools** nếu hỏng.
- **Lớp 3 làm bằng JS nhưng chỉ MỘT vòng rAF ở container**, ghi hai biến CSS
  (`--px`, `--py`); từng ô đọc hai biến đó nhân với hệ số tầng sâu của mình. Không phải 21
  listener, không phải 21 animation.
- **Chỉ `transform` và `opacity`.** Không đụng `width`/`height`/`top`/`left`.

**Ràng buộc không được vi phạm:**
- `prefers-reduced-motion: reduce` → **tắt cả bốn lớp**, hiện thẳng trạng thái cuối. Không
  phải làm chậm lại, mà là không có.
- Nền vẫn `aria-hidden="true"`. Chuyển động trang trí không được vào cây khả năng tiếp cận.
- **Không cướp sự chú ý khỏi nút "Bắt đầu".** Biên độ trôi vài px, không phải vài chục.
- Bốn màn khảo sát **không** có lớp 2 và 3 — người dùng đang đọc và chọn, nền động sau lưng
  là quấy rầy. Chỉ màn chào.
- Phải đo được: sau khi dựng, kiểm `transform` thật đổi theo thời gian trong app thật, không
  tin vào việc code "trông có vẻ chạy". Đây đúng là chỗ Task 5 vấp.

## 5. Ba dạng thẻ lựa chọn

### 5.1 Dạng A — một lựa chọn, có emoji (bước 1)

- Thẻ là `<label>`, **341×58px**, nền `#FFFFFF`, bo 12px, viền 1px `#EAE8E5`, padding `12px`.
- **Đã chọn: chỉ đổi viền sang `#337046`.** Nền không đổi, không bóng, không đổi cỡ chữ.
- Ô emoji **32×32px**, bo 8px, nền = **màu thương hiệu ở alpha thấp** (đo được:
  `#8755F0` @20%, `#5CDED1` @24%). Emoji 16px.
- Nhãn 16px/400 `#292928`.
- Lưới **2 cột × 341px, gap 8px**, tổng rộng 690px. Mục lẻ cuối nằm một mình cột trái.

### 5.2 Dạng B — nhiều lựa chọn, có ô tick (bước 2)

- Thẻ **375×58px**, padding `12px 16px 12px 12px`, `display:flex`, `align-items:center`, `gap:8px`.
- Ô tick là `<button>` **16×16px**, bo 4px, viền 1px `#8C8B88`, nền `#FFFFFF`, **nằm bên phải**.
- Thẻ có thể có **dòng phụ** 12px/400 `#5A5A59` ngay dưới nhãn.
- **Đã tick:** ô vuông chuyển thành nền xanh đậm có dấu tick trắng, VÀ viền thẻ đổi sang
  `#337046`. Xem `assets/buffer-onboarding/02-tools-selected.jpg`.

### 5.3 Dạng C — chữ trơn (bước 3)

- Thẻ **341×47px** (thấp hơn dạng A vì không có ô emoji), padding `12px`, nhãn 16px/400.
- Lưới 2 cột × 341px, gap 8px.

### 5.4 Dạng D — ô kênh (bước 4)

- Ô **156×148px**, `display:flex; flex-direction:column; gap:12px`, padding `0`, bo 12px,
  viền 1px `#EAE8E5`, nền `#FFFFFF`.
- Logo thương hiệu **40×40px**, bo 8px, nền = màu thật của thương hiệu (đo Instagram `#F00276`).
- Nhãn 16px/400 dưới logo.
- Vùng chứa: `display:flex; flex-wrap:wrap; gap:12px; justify-content:center`, rộng tối đa
  **1110px** → 6 ô hàng đầu, 5 ô hàng sau, hàng sau tự căn giữa.
- **Màu thương hiệu ĐƯỢC dùng làm nền ô logo ở bước 4** — ô bo góc tô màu thương hiệu,
  glyph trắng ở giữa, đúng như `04-channels.jpg`.

  Đây là **ngoại lệ có chủ đích** với luật "không hex thô": ở màn chọn kênh, màu thương hiệu
  là **nội dung nhận dạng**, không phải màu giao diện. Facebook xanh và TikTok đen là cách
  người dùng nhận ra kênh trong một phần giây; tô trung tính hết thì lưới 8 ô trông giống
  nhau và mất luôn tác dụng. Phạm vi ngoại lệ **chỉ gồm ô logo của `ChannelTile` và các
  mark trang trí ở màn chào** — mọi bề mặt khác (nền thẻ, viền, chữ, nút) vẫn phải dùng
  token. Bảng `CHANNEL_BRAND_COLOR` trong `channel-marks.tsx` là nơi duy nhất giữ những hex
  đó, và comment ở đầu file phải sửa lại cho khớp ngoại lệ này.

- **Ô tick chỉ hiện ở góc phải trên khi hover/focus**, không hiện thường trực. Xem ô
  Bluesky trong `assets/buffer-onboarding/04-channels.jpg`.
  **MYSP không sao chép chỗ này:** trạng thái chỉ lộ khi rê chuột là không dùng được bằng
  bàn phím và trên cảm ứng. Ô tick của MYSP hiện thường trực.

---

## 6. Bốn bước của MYSP

Buffer hỏi về mạng xã hội; MYSP bán hàng qua Facebook nên câu chữ đổi, **cấu trúc giữ nguyên**.

Câu chữ dưới đây là **bản đang chạy**, cập nhật theo commit `b885c5c` (đổi cho rõ nghĩa
hơn bản phác đầu). `survey-step-render.test.tsx` ghim đúng những chuỗi này — sửa một bên
mà quên bên kia là cách bảng này lệch khỏi sản phẩm lần trước.

| Bước | Câu hỏi | Dạng thẻ | Lựa chọn |
|---|---|---|---|
| 1 | Mô tả đúng nhất về bạn? | A (1 chọn, emoji) | Bán lẻ cá nhân · Chủ shop nhỏ · Trong đội marketing · Cộng tác viên/freelancer · Agency · Khác |
| 2 | Bạn đã sử dụng những công cụ nào trước đây? | B (nhiều chọn, tick) | Đăng thủ công trên Facebook · Meta Business Suite · Công cụ quản lý mạng xã hội *(vd: Hootsuite, Later)* · Công cụ chuyên một nền tảng · Nền tảng AI *(ChatGPT/Claude…)* · Khác |
| 3 | Bạn quản lý bao nhiêu trang mạng xã hội? | C (chữ trơn) | 1-3 · 4-6 · 7-10 · 11-20 · 21-50 · 50+ |
| 4 | Các kênh bạn đang tập trung | D (ô kênh) | xem dưới |

**Bước 4 — danh sách kênh và nhãn "sắp có"** (PM chốt: liệt kê đủ như Buffer, kênh chưa hỗ
trợ phải ghi rõ):

| Kênh | Trạng thái |
|---|---|
| Facebook | dùng được ngay |
| TikTok | **sắp có** |
| Instagram · YouTube · Threads · Zalo OA · Shopee · Lazada | **sắp có** |

Ô "sắp có" vẫn chọn được — coi như phiếu bầu nhu cầu — nhưng phải mang nhãn nhìn thấy, để
không hứa suông. **Không được chỉ làm mờ**: mờ mà vẫn bấm được là trạng thái nói dối.

---

## 7. Hành vi

1. **`Continue` tắt cho tới khi có lựa chọn.** Đo được: `disabled=true`, nền `#DEDCD9`,
   chữ `#7C7B79`. Chọn xong → nền `#B0EC9C`, chữ `#292928`.
2. **`Skip` luôn bấm được**, 14px/500, `#292928`, **không gạch chân**, nằm dưới `Continue`.
   Khi hover/focus có nền viên thuốc xám bo tròn — xem `assets/buffer-onboarding/03-count-selected.jpg`.
   Bỏ qua = đi tiếp không lưu đáp án bước đó.
3. **Mũi tên quay lại** ở góc trái: lùi một bước, giữ nguyên đáp án đã chọn.
4. **Chấm tiến độ không bấm được** — chỉ báo vị trí.
5. Bước 1 và 3: **một lựa chọn**. Bước 2 và **bước 4**: **nhiều lựa chọn**.

   *(Sửa 26/08 — bản đầu xếp nhầm bước 4 vào nhóm một-lựa-chọn. Ba bằng chứng ngược lại:
   cột lưu là `focus_channels text[]`, ảnh `04-channels.jpg` vẽ ô tick, và §6 gọi đáp án
   là "phiếu bầu nhu cầu" — bầu thì phải chọn được nhiều.)*
6. Đóng tab giữa chừng rồi quay lại → mở lại đúng bước còn dở (giống Buffer: mở lại
   `/onboarding` là phát lại luồng).

---

## 8. Lưu dữ liệu

PM chốt: **bảng mới `tenant_profile`**. Đây là thay đổi schema đầu tiên của epic này —
spec trước ghi "không đổi schema DB", điều đó **không còn đúng**.

```
tenant_profile
  tenant_id        (PK, FK -> tenant)
  seller_kind      text        null   -- bước 1, một giá trị
  current_tools    text[]      null   -- bước 2, nhiều giá trị
  channel_count    text        null   -- bước 3, một giá trị
  focus_channels   text[]      null   -- bước 4, nhiều giá trị
  completed_at     timestamptz null   -- null = chưa xong
  created_at / updated_at
```

- `null` ở mọi cột là hợp lệ — đó là ý nghĩa của nút Skip. **Không dùng chuỗi rỗng.**
- Mỗi bước lưu ngay khi bấm Continue, không đợi tới cuối. Bỏ dở giữa chừng vẫn giữ được
  phần đã trả lời.
- `completed_at` là thứ quyết định có hiện onboarding nữa hay không.
- Mọi giá trị lưu là **mã ổn định** (`solo_seller`, `meta_business_suite`…), **không lưu
  chữ tiếng Việt hiển thị** — đổi câu chữ sau này không được làm hỏng dữ liệu cũ.
- Bảng có `tenant_id`, truy vấn qua helper scope như mọi bảng khác (CLAUDE.md rule 7).

**Tự tạo tổ chức khi đăng ký** là thay đổi ở tầng usecase đăng ký, **không thuộc `ui-web`**.
Tên tổ chức mặc định lấy theo tên hiển thị của tài khoản, sửa được sau trong phần cài đặt.

---

## 9. Khả năng tiếp cận — bắt buộc, Buffer làm chưa đủ

Buffer dùng `<label>` bọc input, nhưng thiếu vài thứ. MYSP **không sao chép phần thiếu đó**:

1. Mỗi bước đúng **một `<h1>`**, focus nhảy vào nó khi đổi bước.
2. Nhóm thẻ một-lựa-chọn là `radiogroup`; nhóm nhiều-lựa-chọn là các `checkbox` thật.
   Bàn phím phải đi được bằng mũi tên trong nhóm radio.
3. **Trạng thái đã chọn không được chỉ dựa vào màu viền.** Viền `#337046` khác `#EAE8E5`
   chưa đủ tương phản để một mình mang nghĩa — phải kèm dấu tick hoặc đổi độ dày viền.
   Đây là chỗ MYSP cố ý **khác** Buffer.
4. Chấm tiến độ kèm chữ "Bước n/4" cho trình đọc màn hình (Buffer không có).
5. Vùng bấm tối thiểu 24×24 CSS px. Ô tick 16px của Buffer **không đạt** — vùng bấm phải
   mở rộng ra cả thẻ.
6. Lưới nền và đám icon là trang trí: `aria-hidden="true"`.
7. `prefers-reduced-motion`: tắt trôi nổi của icon, chuyển cảnh thành crossfade 120ms.

---

## 10. Chỗ MYSP cố ý khác Buffer

| Thứ | Buffer | MYSP | Vì sao |
|---|---|---|---|
| Font tiêu đề | Stolzl | Font Astryx | Stolzl là font thương mại có phí |
| Màu | hex thô | **token Astryx** | CLAUDE.md cấm hex thô và cấm override `--color-*` |
| Xanh nút chính | `#B0EC9C` | token accent của Astryx | giữ nhận diện MYSP |
| Trạng thái chọn | chỉ đổi viền | viền **+** dấu tick | màu một mình không mang nghĩa (mục 9.3) |
| Chấm tiến độ | chỉ hình | hình **+** chữ "Bước n/4" | như trên |
| Vùng bấm ô tick | 16px | cả thẻ | 16px dưới ngưỡng WCAG |

Bảng hex ở mục 2 là để **ánh xạ sang token Astryx**, không phải để dán thẳng vào code.
Thiếu token tương ứng thì báo PM, **không tự thêm biến màu mới**.

---

## 11. Việc của lượt trước — giữ hay bỏ

| Thứ | Quyết định |
|---|---|
| `oauth-return-cookie.ts` + 4 route OAuth (`064ca88`, `0df33f7`) | **Giữ** — vẫn đúng, vẫn có ích |
| `eslint.config.mjs` bỏ qua `.claude/**` (`53fa2cb`) | **Giữ** |
| `onboarding-steps.ts`, `SlideShell`, `ProgressRail`, `OnboardingFlow` | **Viết lại** — máy trạng thái 6 slide không còn đúng |
| `SlideCompany` | **Bỏ** — không còn màn tạo công ty |
| `SlideData`, `DataMappingReminderDialog` (chưa commit) | **Bỏ** khỏi onboarding; cân nhắc dùng lại ở `/sync` sau |
| `FirstRunWizard`, `WizardRail` (đã xoá) | giữ nguyên đã xoá |
| `framer-motion`, `canvas-confetti` | **Giữ** framer-motion. `canvas-confetti` **không còn dùng** — luồng mới không có màn chúc mừng; gỡ nếu không ai dùng |

---

## 12. Câu còn treo

- **Tên người dùng ở màn chào — đã tra xong, câu trả lời khác dự đoán.**
  `/api/me` CÓ `account.displayName` (nullable) kèm helper `accountDisplayName(me, fallback)`
  trong `src/ui/schemas/me.schema.ts`. Nhưng payload **không có trường email nào cả**, nên
  phương án dự phòng "lấy phần trước `@` của email" ghi ở bản spec đầu là **bất khả thi**.

  **Chốt:** có `displayName` thì chào tên; `null` thì chào trống — "Chào bạn 👋 / Chào mừng
  tới MYSP". Không bịa tên, không hiện chuỗi rỗng, và **không** thêm email vào `/api/me`
  chỉ để phục vụ một lời chào.
- **Nút chuyển sáng/tối — đã tra xong, dùng đúng component này:**
  `src/ui/components/shell/ColorSchemeToggle.tsx` (cookie `mysp-color-scheme`, gắn class
  `dark` lên `<html>`, cố ý không giữ React state).

  **`src/ui/hooks/useAppearance.ts` KHÔNG phải cái đó** — đó là preset màu cấp nền tảng,
  thiết lập của quản trị viên. Nối onboarding vào nó chính là dựng bộ chuyển theme thứ hai
  mà spec đang cấm. Bản spec đầu chỉ sai địa chỉ, đã sửa.

- **Bo góc: dùng token, KHÔNG hardcode 12px.** Buffer đo được 12px; thang của MYSP là
  `--radius: 1rem` (Astryx `radius: { base: 4, multiplier: 2 }`), token gần nhất là
  `rounded-md` = `calc(var(--radius) * 0.8)` = **12.8px**. Lệch 0.8px không nhìn thấy được;
  hardcode `12px` thì mâu thuẫn `DESIGN.md` và phá hệ thống. **Dùng `rounded-md`.**

- **Nút chính cao 48px phải override bằng `className`.** `src/ui/components/ui/button.tsx`
  cao nhất là `h-9` (36px). **Không** thêm biến thể kích thước mới vào Button dùng chung
  chỉ vì một màn.

- **Repo chưa có tài sản thương hiệu nào** — không `public/`, không component icon, không gì
  khớp facebook/tiktok. Tám dấu hiệu kênh phải **tự vẽ inline SVG**, đặt chung MỘT file để
  màn chào (§4) và bước 4 (§5.4) dùng lại, không vẽ hai lần.

- **Phiên dev giả thuộc 2 tổ chức và `activeTenantId` là `null`**, nên `useActiveTenant().role`
  ra `null` và `OnboardingFlow` đá về `/`. Muốn chụp được onboarding phải đặt cookie
  `mysp_active_tenant` trước. Không đặt thì ảnh chụp ra màn chọn công ty, không phải onboarding.
