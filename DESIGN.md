---
name: MYSP
description: Sổ mẫu vải của xưởng — nền vải mộc, mực nâu ấm, chàm hành động, thẻ mẫu bậc thang
colors:
  indigo-dye: "oklch(0.45 0.105 262)"
  indigo-wash: "oklch(0.89 0.045 262)"
  indigo-deep: "oklch(0.38 0.11 263)"
  muslin: "oklch(0.955 0.013 84)"
  swatch-card: "oklch(0.984 0.007 84)"
  sunken-cloth: "oklch(0.933 0.014 84)"
  warm-ink: "oklch(0.28 0.018 55)"
  ink-muted: "oklch(0.47 0.02 58)"
  ink-subtle: "oklch(0.53 0.02 60)"
  ink-hairline: "oklch(0.28 0.018 55 / 12%)"
  madder: "oklch(0.54 0.15 30)"
  turmeric: "oklch(0.76 0.12 75)"
  turmeric-deep: "oklch(0.49 0.10 68)"
  leaf: "oklch(0.68 0.11 160)"
  leaf-deep: "oklch(0.50 0.09 163)"
  fact-blue: "oklch(0.60 0.10 255)"
  fact-blue-deep: "oklch(0.47 0.11 257)"
  media-empty: "oklch(0.92 0.02 84)"
typography:
  display:
    fontFamily: "Be Vietnam Pro, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "Be Vietnam Pro, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Be Vietnam Pro, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 500
  body:
    fontFamily: "Be Vietnam Pro, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  body-quiet:
    fontFamily: "Be Vietnam Pro, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    letterSpacing: "0.1em"
  meta:
    fontFamily: "Be Vietnam Pro, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 400
  micro-label:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "10px"
    fontWeight: 400
    letterSpacing: "0.1em"
  numeral:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "2.25rem"
    fontWeight: 600
    lineHeight: 1
rounded:
  sm: "0.3rem"
  md: "0.4rem"
  lg: "0.5rem"
  xl: "0.7rem"
  full: "9999px"
spacing:
  xs: "0.25rem"
  sm: "0.5rem"
  md: "1rem"
  lg: "1.5rem"
  xl: "2rem"
components:
  button-primary:
    backgroundColor: "{colors.indigo-dye}"
    textColor: "{colors.swatch-card}"
    rounded: "{rounded.lg}"
    height: "2rem"
    padding: "0 0.625rem"
  button-primary-hover:
    backgroundColor: "oklch(0.45 0.105 262 / 80%)"
  button-outline:
    backgroundColor: "{colors.muslin}"
    textColor: "{colors.warm-ink}"
    rounded: "{rounded.lg}"
    height: "2rem"
    padding: "0 0.625rem"
  button-destructive:
    backgroundColor: "oklch(0.54 0.15 30 / 10%)"
    textColor: "{colors.madder}"
    rounded: "{rounded.lg}"
    height: "2rem"
    padding: "0 0.625rem"
  input:
    backgroundColor: "{colors.muslin}"
    textColor: "{colors.warm-ink}"
    rounded: "{rounded.lg}"
    height: "2.25rem"
    padding: "0.25rem 0.75rem"
  compose-control:
    backgroundColor: "{colors.swatch-card}"
    textColor: "{colors.warm-ink}"
    rounded: "{rounded.lg}"
    height: "3.25rem"
    padding: "0 1rem"
  badge-neutral:
    backgroundColor: "{colors.sunken-cloth}"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.full}"
    padding: "0.125rem 0.625rem"
  card:
    backgroundColor: "{colors.swatch-card}"
    textColor: "{colors.warm-ink}"
    rounded: "{rounded.md}"
    padding: "1rem"
  card-work:
    backgroundColor: "{colors.swatch-card}"
    textColor: "{colors.warm-ink}"
    rounded: "{rounded.xl}"
    padding: "1.5rem"
---

# Design System: MYSP

## Overview

**Creative North Star: "Sổ mẫu vải" (The Swatch Book)**

MYSP là cuốn sổ mẫu vải của xưởng: mỗi màu là một thẻ vải, mỗi mã sản phẩm một trang mẫu. Nền là **vải mộc** (unbleached muslin) chứ không phải trắng văn phòng; chữ là **mực nâu đen ấm** chứ không phải đen lạnh; hành động duy nhất nhuộm **chàm** (indigo). Thế giới này từ chối admin-SaaS "card trắng + accent tím rải đều" — thay vào đó là bề mặt dệt: dải số liệu khâu bằng chỉ hairline, thẻ mẫu có mấu bậc thang thò ra khỏi tay áo, nhãn dệt mono cho mọi mã và số. (Direction contract seed `e06531fb`, ghi trong `src/app/layout.tsx`; giá trị thật ở `src/app/globals.css` + `src/ui/theme/mysp-theme.ts`.)

Câu chuyện vận hành không đổi: người vận hành mở sổ, thấy việc hôm nay, rút thẻ soạn bài, duyệt caption, và luôn trả lời được "vì sao bài này không lên". Toàn bộ palette là oklch semantic — tint (`/10`) và shade nội suy được; light/dark cùng ngữ nghĩa, chỉ đổi giá trị (dark là vải nhuộm sẫm, chàm được nâng sáng). Astryx components ăn theo cùng một mực qua theme "mysp" (`defineTheme` remap 4 token text về `var(--foreground)`/`var(--muted-foreground)`/`var(--primary)` — một nguồn mực duy nhất).

**Key Characteristics:**
- Nền vải mộc ba lớp tonal (muslin → sunken cloth → swatch card) + viền chỉ mực, không bóng trang trí
- Một màu hành động duy nhất (chàm); trạng thái là ba màu nhuộm có tên chữ: madder / turmeric / leaf
- Chữ Việt là công dân hạng nhất: Be Vietnam Pro (subset vietnamese) + JetBrains Mono cho mã/số
- Hình dạng chữ ký: thẻ mẫu vải mấu bậc thang, dải tape khâu chỉ, rail bước đánh số mono
- Đang chạy thì động, đã chốt thì đứng im — mỗi thời điểm chỉ một chuyển động có chủ đích
- Mật độ reflow theo bậc container khai báo (@2xl/@4xl/@5xl), không co giãn tự do

## Colors

Bảng màu là thuốc nhuộm tự nhiên trên vải mộc: chàm cho hành động, và ba màu nhuộm trạng thái được chọn để không lẫn nhau khi pha loãng 10% trên nền gần trắng.

### Primary
- **Indigo Dye — Chàm** (oklch(0.45 0.105 262)): màu hành động duy nhất — nút chính, link, caret (`caret-color`), focus ring (45% alpha), thẻ soạn bài. Dark mode nâng sáng thành oklch(0.68 0.09 262) vì bản light không đủ tương phản trên vải sẫm.
- **Indigo Wash — Chàm nhạt** (oklch(0.89 0.045 262)): bề mặt "đang chọn" — accent, hàng hover (`bg-accent/40`), tab thẻ mẫu, và cả `::selection` của trình duyệt.
- **Indigo Deep** (oklch(0.38 0.11 263)): chữ đứng trên nền chàm nhạt (accent-foreground).

### Neutral
- **Muslin — Vải mộc** (oklch(0.955 0.013 84)): nền toàn trang, nền nút outline và input.
- **Swatch Card — Thẻ mẫu** (oklch(0.984 0.007 84)): mặt card/popover/sidebar — một bậc sáng hơn vải.
- **Sunken Cloth** (oklch(0.933 0.014 84)): bề mặt chìm — secondary/muted, tay áo (sleeve) sau thẻ soạn bài.
- **Warm Ink — Mực nâu đen ấm** (oklch(0.28 0.018 55)): chữ chính — không phải đen lạnh.
- **Ink Muted** (oklch(0.47 0.02 58)): chữ phụ (muted-foreground).
- **Ink Subtle** (oklch(0.53 0.02 60)): tầng chữ thứ ba — nhãn dệt (Eyebrow), metadata mono, số bước. Được chỉnh để đạt 4.65:1 trên vải và 5.07:1 trên card — vì nó gắn nhãn chữ nhỏ 10–12px nên phải qua chuẩn small text (dark: oklch(0.66 0.018 60), giữ đúng bậc 0.06 dưới ink-muted).
- **Ink Hairline** (oklch(0.28 0.018 55 / 12%)): mọi viền là mực loang, không phải xám (input dùng 16%; dark: trắng 12–16%).
- **Media Empty** (oklch(0.92 0.02 84)): ô ảnh chưa tải được — bề mặt trống có nhãn, không bao giờ là ảnh giả.

### Status (semantic — thuốc nhuộm có tên chữ)
- **Madder — Đỏ thiến thảo** (oklch(0.54 0.15 30)): destructive/thất bại — "bài không lên".
- **Turmeric — Nghệ** (oklch(0.76 0.12 75)) + **Turmeric Deep** làm chữ trên nền tint: cảnh báo — tồn thấp, "xong nhưng có vấn đề".
- **Leaf — Lá** (oklch(0.68 0.11 160)) + **Leaf Deep** làm chữ: thành công — đã đăng, sync xong.
- **Fact Blue** (oklch(0.60 0.10 255)) + **Fact Blue Deep**: thông tin trung tính — "sự thật về bài đăng", không phải hành động. Badge tone `info` KHÔNG pha tint mà đứng trên nền trơn + viền hairline (xem The 10% Tint Rule). Dark mode đẩy hue về 235° lạnh hơn và sáng hơn hẳn — bản dịch sáng thẳng của light chỉ cách chàm 7° và hai pill nhìn thành một màu.
- Chart tái dùng đúng năm hue semantic theo thứ tự đọc: chàm, fact, leaf, turmeric, madder — không phát minh màu thứ sáu cho biểu đồ.

### Named Rules
**The Ink Hairline Rule.** Viền không bao giờ là xám trung tính — luôn là Warm Ink ở 12–16% alpha (dark: trắng 12–16%). Xám nguội tách card khỏi vải ấm.
**The One Indigo Rule.** Chàm là màu hành động duy nhất. Màu trạng thái (madder/turmeric/leaf/fact) mô tả sự thật, không bao giờ đánh dấu hành động.
**The 10% Tint Rule.** Nền trạng thái là màu gốc ở 10–15% opacity + viền 30–40% + chữ bản `-deep`; ba màu nhuộm trạng thái (madder/turmeric/leaf) phải phân biệt được ngay ở mức pha loãng này (đã đo trên vải mộc: cách nhau 0.043–0.064 sRGB, gấp ~6 lần ngưỡng "nhìn thành một màu"). Fact Blue không tham gia trò tint — ở 10% nó lẫn với leaf và chàm, nên pill info là nền trơn + hairline.
**The Named Status Rule.** Trạng thái luôn có tên chữ đi kèm — badge mang chữ, hàng lỗi mang lý do, nút mờ mang câu giải thích ngay cạnh. Màu không bao giờ là kênh thông tin duy nhất.

## Typography

**Display Font:** Be Vietnam Pro (fallback system-ui, sans-serif) — weight 400/500/600/700
**Body Font:** Be Vietnam Pro
**Label/Mono Font:** JetBrains Mono (fallback ui-monospace) — subset vietnamese

**Character:** Geometric sans vẽ riêng cho tiếng Việt — dấu thanh cùng gia đình với con chữ. Mono là chỉ dệt của sổ mẫu: mọi mã, số, nhãn đều chạy mono để thẳng cột và đọc to được.

### Hierarchy
- **Numeral** (mono, 600, 2.25rem/1, `tabular-nums`): con số của dải tape — số liệu đếm được duy nhất trên màn hình, to nhất trang.
- **Display** (600, 1.5rem, tracking -0.025em): tiêu đề trang hub — mỗi màn một lần.
- **Headline** (600, 1.25rem, tracking -0.025em): tiêu đề section trong trang ("Việc cần chú ý", "Lô đang chạy"), h1 màn compose.
- **Title** (500, 1rem): nhấn trong card — hành động doorway, giá trị nổi.
- **Body** (400/500, 0.875rem, lh 1.5): mặc định toàn UI — công cụ mật độ cao chạy trên text-sm.
- **Body-quiet** (400, **13px**): bậc body phụ đã hợp thức hoá (PM ruling) — câu phụ đề, hint, note giải thích, control phụ trong compose.
- **Label** (mono, 400, 0.75rem, tracking 0.1em, UPPERCASE): nhãn dệt (Eyebrow) trên heading và ô tape.
- **Meta** (400, **11px**): chip đếm, đánh dấu inline nhỏ.
- **Micro-label** (mono, 400, **10px**, tracking 0.1em–0.12em, UPPERCASE): nhãn dệt cỡ nhỏ nhất — nhãn khối trong preview, ordinal chip.

### Named Rules
**The Mono Ledger Rule.** Mã sản phẩm, số đuôi ảnh, số lượng, ID, số bước — luôn JetBrains Mono (`tabular-nums` khi là số đếm) để thẳng cột trong bảng, badge và tape.
**The Woven Label Rule.** Nhãn dệt (Eyebrow) là mono uppercase tracking-widest màu Ink Subtle, luôn là `<p>` gắn nhãn cho khối theo sau — không bao giờ là heading, để không tạo outline trùng cho screen reader.
**The Legitimized Ramp Rule.** Ramp gồm đúng các bậc trên, kể cả 13/11/10px đã được duyệt. Không thêm cỡ lẻ mới ngoài ramp; cần nhỏ hơn body thì chọn đúng bậc 13 → 12 → 11 → 10 theo vai trò, không theo chỗ trống.
**The Diacritics Rule.** Mọi font mới bắt buộc ship subset `vietnamese`; một mặt chữ không có dấu thanh cùng họ là bị loại ngay (lý do Outfit của bản duyệt gốc bị thay bằng Be Vietnam Pro).

## Layout

Khung app: shell tối đa 1440px, side nav trái trên Swatch Card, nội dung trên Muslin. Vùng nội dung màn thường bó `max-w-5xl` (64rem), văn bản dài `max-w-prose`; `scrollbar-gutter: stable` giữ trang ngắn và dài cùng offset. Nhịp khoảng cách theo bậc Tailwind 4px — dày ở hàng/danh sách (py-3, gap-2), thoáng giữa các khối (space-y-8/10).

**Mật độ reflow theo bậc container, không tự do:** mỗi màn khai báo `@container` và đổi layout đúng ở các bậc đã ghi — dải tape 1 cột < 42rem (@2xl), 2 cột ≥ 42rem, 4 cột thành một dải liền ≥ 56rem (@4xl); overview tách 2 cột nội dung ở @4xl (cột hành động 21rem đứng TRƯỚC trong DOM ở mọi bề rộng — thứ tự tab không bao giờ cãi nhau với thứ tự đọc); compose tách thẻ trái 190 (47.5rem) + preview sticky ở @5xl (64rem). Dữ liệu quét là HÀNG (Table, List/Item, divide-y), không bao giờ là lưới card.

## Elevation & Depth

**Phẳng + chỉ khâu.** Chiều sâu đến từ ba lớp tonal (Muslin → Sunken Cloth → Swatch Card) và viền Ink Hairline. Bóng chỉ ở đúng ba chỗ: thẻ làm việc lớn của compose và thẻ soạn bài mang `shadow-sm` (nhích lên `shadow-md` khi hover — thẻ đang được rút ra), còn lớp thật sự nổi khỏi trang (popover, dialog, toast) mang `shadow-lg`. Control cỡ lớn của compose không dùng border mà dùng **vòng khâu inset** — `shadow-[inset_0_0_0_1px_var(--input)]` (1.5px khi active) — nét chỉ may nằm trong mép vải. Dark mode: bóng gần vô hình trên vải sẫm — elevation chuyển thành hairline sáng hơn (trắng 12–16%).

### Named Rules
**The Flat-By-Default Rule.** Bề mặt đứng yên thì phẳng, tách nền bằng chênh tonal + hairline. Bóng là dấu hiệu "đang được nhấc lên" (thẻ mẫu, overlay), không phải trang trí của card.

## Shapes

Base radius **0.5rem** — "cạnh cắt vải", vuông vức hơn hệ pastel cũ: `rounded-md` (6.4px) cho container hàng/tape/list, `rounded-lg` (8px) cho control (nút, input), `rounded-xl` (11.2px) cho thẻ làm việc lớn, `rounded-full` cho badge/pill/số bước. Viền 1px hairline trên mọi bề mặt có ranh giới; không double-border.

**Hình dạng chữ ký — thẻ mẫu bậc thang:** thẻ hành động là một thẻ vải rút nửa chừng khỏi tay áo (sleeve Sunken Cloth phía sau), với các mấu tab bậc thang (`rounded-t-sm`, cao 2.5–3.5px nhô trên mép) — thẻ trong tay và thẻ kế tiếp trong xấp. Cùng hình học đó lặp ở cỡ nhỏ trên thẻ "Lô đang chạy". **Dải tape khâu chỉ:** các ô của stat tape là một bề mặt duy nhất, đường chỉ giữa các ô vẽ bằng `gap-px` trên nền `bg-border` — mỗi đường khâu vẽ đúng một lần ở mọi số cột.

## Components

Cảm giác chung: **đồ nghề xưởng may** — phẳng, thẳng cột, mọi trạng thái tương tác trả lời tức thì. Motion theo hợp đồng: **mỗi thời điểm một chuyển động có chủ đích, đã chốt thì đứng im** — con số ĐỔI thì lún vào chỗ (settle, không fade — mực đậm đủ từng frame), thẻ soạn bài nhấc lên dưới con trỏ (`-translate-y-1.5`, 300ms ease-out); không gì lặp vô hạn trừ skeleton `animate-pulse` (aria-hidden, chỉ sống khi query đang chạy); mọi animation đều `motion-safe:`.

### Buttons
- **Shape:** rounded-lg (8px), cao 32px (h-8), text-sm font-medium; sm 28px, lg 36px, icon 32px vuông.
- **Primary:** nền Indigo Dye, chữ Swatch Card; hover 80% opacity; active dịch xuống 1px (`translate-y-px`).
- **Hover / Focus:** focus-visible = viền + ring 3px `--ring` (chàm 45–50%); không dùng outline mặc định.
- **Outline:** viền hairline, nền Muslin, hover Sunken Cloth. **Ghost:** trong suốt, hover Sunken Cloth. **Destructive:** nền Madder 10%, chữ Madder, hover 20% — không bao giờ khối đỏ đặc.

### Compose Controls (oversized)
Màn compose dùng control cỡ 52px (h-13), chữ 15px, nền Swatch Card với vòng khâu inset thay border; hàng phụ 38px (h-9.5) chữ 13px. Nút toggle active ("Hẹn lịch" đang bật) = nền Indigo Wash + vòng khâu 1.5px chàm. Cạnh nút mờ luôn có câu 13px nói VÌ SAO (The Named Status Rule).

### Badges (status pill)
- **Style:** rounded-full, text-xs font-medium, px-2.5 py-0.5.
- **State:** 5 tone — `neutral` (Sunken Cloth + Ink Muted) / `success` (leaf 10% + viền 30% + Leaf Deep) / `warning` (turmeric 10% + viền 40% + Turmeric Deep) / `danger` (madder 10% + viền 30% + chữ Madder) / `info` (nền trơn + hairline + Warm Ink — không tint). Tone do **caller** chọn từ trạng thái nghiệp vụ; mapping nằm ở màn hình.

### Cards / Containers
- **Corner Style:** rounded-md (6.4px) cho tape/danh sách; rounded-xl (11.2px) cho thẻ làm việc compose (p-6, shadow-sm).
- **Background:** Swatch Card trên Muslin; hàng hover `bg-accent/40` (chàm nhạt).
- **Border:** 1px Ink Hairline; danh sách dùng `divide-y` cùng màu.
- **Internal Padding:** px-4/px-5 py-3/py-4 cho hàng; p-6 cho thẻ lớn.

### Swatch Card (signature)
Thẻ hành động chính ("Soạn bài mới"): nền Indigo Dye đặc, mấu tab bậc thang phía trên (một tab Indigo Wash, một tab Indigo Dye), tay áo Sunken Cloth phía sau, shadow-sm; hover nhấc lên 6px + shadow-md — chuyển động hover duy nhất của trang. Bản nhỏ trên nền Swatch Card cho "Lô đang chạy" — một mấu tab, cùng xấp bài.

### Stat Tape (signature)
Dải nhãn dệt bấm được: 4 ô là MỘT bề mặt khâu chỉ (gap-px trên bg-border), mỗi ô = Eyebrow + numeral mono 36px `tabular-nums` (hoặc câu doorway text-base khi chưa có nguồn đếm — không bịa số) + câu đích 12px. Đếm được bao nhiêu nói bấy nhiêu: "25+" khi còn trang cursor, không bao giờ tổng bịa.

### Step Rail (signature)
Rail bước của compose: cột trái cố định 2.5rem, số bước trong vòng tròn hairline (size-7, mono 13px, Ink Subtle) + Eyebrow "Bước N — nhãn". KHÔNG phải stepper — mọi bước cùng trên màn hình, số chỉ gọi tên thứ tự nghiệp vụ bất biến (tra mã → gom ảnh → chọn kênh → caption), không gate gì và không đổi theo state.

### Inputs / Fields
- **Style:** h-9 (36px), rounded-lg, nền Muslin, viền Ink Hairline 16%, shadow-xs, text-sm; placeholder Ink Muted. Bản compose: h-13, không border, vòng khâu inset 1.5px.
- **Focus:** viền + ring 3px chàm — cùng ngôn ngữ với nút. **Error / Disabled:** `aria-invalid` → viền Madder + ring madder 20%; disabled → opacity 50%.

### Navigation
- **Side nav** (Astryx SideNav) trên Swatch Card: landmark có section, icon lucide 1 glyph/route (test pin sẵn), active = nền Indigo Wash + chữ Indigo Deep, collapse ghi cookie. Top bar chứa tenant switcher và search.
- **Hub TabList:** màn gộp (posts/channels/members) là `TabList` điều hướng `?tab=` — hub không giữ dữ liệu, tab là button (không phải link), `router.replace` (không push), chỉ `?tab=` sống sót khi đổi tab. Không dùng SegmentedControl cho điều hướng.

### Eyebrow (signature)
Nhãn dệt mono trên heading và ô tape ("BƯỚC 1 — SẢN PHẨM", "ĐANG CHỜ GIỜ") — Ink Subtle, uppercase, tracking-widest, `<p>` không phải heading. Đây là sợi chỉ nối chất "sổ vận hành" vào sổ mẫu vải.

## Do's and Don'ts

### Do:
- **Do** lấy mọi màu/radius từ token semantic (`bg-primary`, `text-muted-foreground`, `rounded-lg`) — lớp giá trị nằm duy nhất ở `globals.css`; Astryx token đổi mực qua `defineTheme` trong `mysp-theme.ts` (build lại bằng `pnpm exec astryx theme build`), không bao giờ override `--color-*` trong `:root` trần.
- **Do** viết màu mới bằng oklch và định nghĩa đủ cặp light/dark cùng ngữ nghĩa; kiểm khoảng cách với chàm và các màu nhuộm hiện có ở cả mức đặc lẫn tint.
- **Do** cho mọi trạng thái nghiệp vụ một lối ra chữ: tint + viền + chữ deep, kèm câu "vì sao" tiếng Việt ngay tại chỗ hỏng (lỗi cục bộ theo nguồn, nguồn khác vẫn hiển thị).
- **Do** dùng mono `tabular-nums` cho mã/số/đếm, nhãn dệt mono cho nhãn khối, và chỉ nói số đã đọc được ("3+ lô", không tổng bịa).
- **Do** reflow theo bậc `@container` đã khai báo và giữ thứ tự DOM cố định qua mọi bậc.
- **Do** giữ mỗi thời điểm một chuyển động: cái gì đã chốt thì đứng im; mọi animation `motion-safe:`.

### Don't:
- **Don't** dùng hex/px trần hay xám trung tính cho viền — viền là Warm Ink loang (The Ink Hairline Rule).
- **Don't** đổ bóng trang trí lên bề mặt đứng yên — bóng nghĩa là "đang được nhấc lên" (thẻ mẫu, overlay).
- **Don't** dùng màu trạng thái cho hành động, pha tint cho pill info, hay khối đỏ đặc cho nút phá huỷ.
- **Don't** thêm cỡ chữ ngoài ramp (kể cả arbitrary `text-[…px]` mới) — 13/11/10px là các bậc đã duyệt, không phải giấy phép tự do.
- **Don't** hiển thị ảnh giả cho media chưa tải được — ô Media Empty có nhãn; người vận hành không "duyệt" thứ chưa nhìn thấy.
- **Don't** thêm font không có subset vietnamese (The Diacritics Rule).
- **Don't** import `@astryxdesign/core/tailwind-theme.css` trước mốc B9 — bridge remap `--color-primary/card/muted` và phá các utility shadcn còn dùng (ghi chú đầu `globals.css`).

## Migration boundary

Hệ trên mô tả **wave 1** (branch `redesign/swatch-book-w1`): shell + nav, Tổng quan, Compose, các hub Bài đăng / Kênh / Thành viên, và tầng token toàn cục. Các màn đợi đợt 2 — **bulk, sync, products, prompts, và ruột bảng bên trong các hub** — vẫn chạy trên khung cũ: chúng đã ăn token màu mới qua `globals.css` nhưng chưa mang hình dạng chữ ký (tape, thẻ bậc thang, rail bước, nhãn dệt) và chưa được rà ramp chữ. Khi đụng các màn này, theo DESIGN.md này chứ không theo hình dáng hiện tại của chúng.
