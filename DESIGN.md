---
name: MYSP
description: Công cụ đăng bài tự động cho shop thời trang — pastel ấm, phẳng, đáng tin
colors:
  iris-violet: "oklch(0.5435 0.1643 288.03)"
  iris-deep: "oklch(0.4266 0.1511 285.6)"
  lavender-chip: "oklch(0.8844 0.0554 296.7)"
  warm-paper: "oklch(0.9661 0.0069 67.74)"
  porcelain: "oklch(0.995 0.0034 67.78)"
  sunken-paper: "oklch(0.9511 0.0069 67.74)"
  plum-ink: "oklch(0.2747 0.0212 305.64)"
  plum-quiet: "oklch(0.5196 0.0292 303.05)"
  plum-mist: "oklch(0.6751 0.0273 303.28)"
  ink-hairline: "oklch(0.2747 0.0212 305.64 / 10%)"
  clay-red: "oklch(0.5855 0.1423 24.55)"
  amber-honey: "oklch(0.7741 0.1176 70.59)"
  amber-deep: "oklch(0.4967 0.1041 65.17)"
  jade-mint: "oklch(0.7038 0.1152 163.84)"
  jade-deep: "oklch(0.5192 0.0964 166.23)"
  cornflower: "oklch(0.6432 0.1249 257.31)"
  cornflower-deep: "oklch(0.4906 0.1283 258.66)"
  lilac-veil: "oklch(0.9168 0.0321 301.57)"
typography:
  display:
    fontFamily: "Be Vietnam Pro, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.3
  headline:
    fontFamily: "Be Vietnam Pro, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.4
  title:
    fontFamily: "Be Vietnam Pro, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: "Be Vietnam Pro, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    letterSpacing: "0.1em"
rounded:
  sm: "0.375rem"
  md: "0.5rem"
  lg: "0.625rem"
  xl: "0.875rem"
  full: "9999px"
spacing:
  xs: "0.25rem"
  sm: "0.5rem"
  md: "1rem"
  lg: "1.5rem"
  xl: "2rem"
components:
  button-primary:
    backgroundColor: "{colors.iris-violet}"
    textColor: "{colors.porcelain}"
    rounded: "{rounded.lg}"
    height: "2rem"
    padding: "0 0.625rem"
  button-primary-hover:
    backgroundColor: "oklch(0.5435 0.1643 288.03 / 80%)"
  button-outline:
    backgroundColor: "{colors.warm-paper}"
    textColor: "{colors.plum-ink}"
    rounded: "{rounded.lg}"
    height: "2rem"
    padding: "0 0.625rem"
  button-destructive:
    backgroundColor: "oklch(0.5855 0.1423 24.55 / 10%)"
    textColor: "{colors.clay-red}"
    rounded: "{rounded.lg}"
    height: "2rem"
    padding: "0 0.625rem"
  input:
    backgroundColor: "{colors.warm-paper}"
    textColor: "{colors.plum-ink}"
    rounded: "{rounded.lg}"
    height: "2.25rem"
    padding: "0.25rem 0.75rem"
  badge-neutral:
    backgroundColor: "{colors.sunken-paper}"
    textColor: "{colors.plum-quiet}"
    rounded: "{rounded.full}"
    padding: "0.125rem 0.625rem"
  card:
    backgroundColor: "{colors.porcelain}"
    textColor: "{colors.plum-ink}"
    rounded: "{rounded.xl}"
    padding: "1rem"
---

# Design System: MYSP

## Overview

**Creative North Star: "The Pastel Atelier"**

MYSP là bàn làm việc số của một xưởng thời trang: mặt giấy ấm, ánh tím diên vĩ, và những chip vải oải hương — nhưng trước hết nó là công cụ vận hành mà nhân viên nhìn suốt cả buổi sáng. Giọng điệu là **ấm · tĩnh · đáng tin**: pastel làm dịu mắt trong phiên soạn lô dài, còn cấu trúc bên dưới thì chính xác như sổ vận hành — mã sản phẩm chạy chữ mono, trạng thái phân biệt được trong một liếc mắt, lỗi hiện ra bằng lời giải thích chứ không bằng tiếng còi.

Hệ được hiện thực trên nền Astryx v0.4.0 (`@astryxdesign/core` + `theme-neutral`) với một lớp semantic riêng ("ComposePastel") ghi trong `src/app/globals.css` bằng oklch — tint (`/10`) và shade nội suy được, hex thì không. Mọi màu, radius, khoảng cách đi qua token; component trình bày thuần, mapping trạng thái nghiệp vụ nằm ở caller từng màn hình.

**Key Characteristics:**
- Nền wash ấm nhiều lớp tonal thay vì trắng tinh + đổ bóng
- Một màu hành động duy nhất (Iris Violet); ba màu trạng thái tách bạch ngay ở tint 10%
- Chữ Việt là công dân hạng nhất: Be Vietnam Pro (subset vietnamese) + JetBrains Mono cho mã/số
- Mềm nhưng dứt khoát: bo tròn lớn, màu dịu, nhưng hover/focus/lỗi luôn tức thì và rõ
- Light + dark đầy đủ, cùng ngữ nghĩa token, chỉ đổi giá trị

## Colors

Bảng màu là vải pastel trên giấy ấm: một tím diên vĩ làm giọng chính, họ mận cho chữ, và ba sắc trạng thái được chọn để không lẫn nhau khi pha loãng 10% trên nền gần trắng.

### Primary
- **Iris Violet** (oklch(0.5435 0.1643 288.03)): màu hành động duy nhất — nút chính, link, focus ring (45% alpha), điểm đang active. Dark mode sáng lên thành oklch(0.72 0.135 288.03) vì bản light không đủ tương phản trên nền tối.
- **Iris Deep** (oklch(0.4266 0.1511 285.6)): chữ đứng trên nền lavender — dùng cho chip/accent được chọn.
- **Lavender Chip** (oklch(0.8844 0.0554 296.7)): nền accent — chip được chọn, hàng đang highlight.

### Neutral
- **Warm Paper** (oklch(0.9661 0.0069 67.74)): nền toàn trang — wash ấm, không phải trắng.
- **Porcelain** (oklch(0.995 0.0034 67.78)): mặt card/popover/sidebar — một bậc sáng hơn wash.
- **Sunken Paper** (oklch(0.9511 0.0069 67.74)): bề mặt chìm — secondary/muted, nền hàng hover.
- **Plum Ink** (oklch(0.2747 0.0212 305.64)): chữ chính — mực mận, không phải đen.
- **Plum Quiet** (oklch(0.5196 0.0292 303.05)): chữ phụ (muted-foreground).
- **Plum Mist** (oklch(0.6751 0.0273 303.28)): tầng chữ thứ ba — eyebrow, metadata mono, số thứ tự tile.
- **Ink Hairline** (oklch(0.2747 0.0212 305.64 / 10%)): mọi viền — là mực loang, không phải xám (input dùng 14%).

### Status (semantic)
- **Clay Red** (oklch(0.5855 0.1423 24.55)): destructive/thất bại — "bài không lên".
- **Amber Honey** (oklch(0.7741 0.1176 70.59)) + **Amber Deep** làm chữ: cảnh báo — tồn thấp, "xong nhưng có vấn đề".
- **Jade Mint** (oklch(0.7038 0.1152 163.84)) + **Jade Deep** làm chữ: thành công — đã đăng, sync xong.
- **Cornflower** (oklch(0.6432 0.1249 257.31)) + **Cornflower Deep** làm chữ: thông tin trung tính — pill kênh/nền tảng, "sự thật về bài đăng" chứ không phải hành động.
- **Lilac Veil** (oklch(0.9168 0.0321 301.57)): bề mặt media-empty — ô ảnh chưa tải được là bề mặt trống có nhãn, không bao giờ là ảnh giả.

### Named Rules
**The Ink Hairline Rule.** Viền không bao giờ là xám trung tính — luôn là Plum Ink ở 10–14% alpha (dark: trắng 12–16%). Xám nguội tách card khỏi nền ấm.
**The One Violet Rule.** Iris Violet là màu hành động duy nhất. Màu trạng thái (jade/amber/clay/cornflower) mô tả sự thật, không bao giờ đánh dấu hành động.
**The 10% Tint Rule.** Nền trạng thái là màu gốc ở 10% opacity + viền 30–40% + chữ bản `-deep`; ba trạng thái phải phân biệt được ngay ở mức pha loãng này.

## Typography

**Display Font:** Be Vietnam Pro (fallback system-ui, sans-serif)
**Body Font:** Be Vietnam Pro
**Label/Mono Font:** JetBrains Mono (fallback ui-monospace)

**Character:** Geometric sans vẽ riêng cho tiếng Việt — dấu thanh cùng một gia đình với con chữ, không rơi fallback giữa từ. Mono cho mọi thứ cần thẳng cột: mã, số, đếm.

### Hierarchy
- **Display** (600, 1.5rem, lh 1.3): tiêu đề trang — mỗi màn một lần.
- **Headline** (600, 1.125rem, lh 1.4): tiêu đề khối/section trong trang.
- **Title** (600, 1rem, lh 1.4): tiêu đề card, hàng nổi bật.
- **Body** (400/500, 0.875rem, lh 1.5): mặc định toàn UI — đây là công cụ mật độ cao, text-sm là giọng nền.
- **Label** (400, 0.75rem, tracking 0.1em, UPPERCASE, mono): eyebrow trên heading ("BƯỚC 1 / 3"), metadata.

### Named Rules
**The Mono Ledger Rule.** Mã sản phẩm, số đuôi ảnh, số lượng, ID — luôn JetBrains Mono để thẳng cột trong bảng và badge.
**The Diacritics Rule.** Mọi font mới bắt buộc ship subset `vietnamese`; một mặt chữ không có dấu thanh cùng họ là bị loại ngay (đây là lý do Outfit của bản duyệt gốc bị thay bằng Be Vietnam Pro).

## Layout

Khung app: shell tối đa 1440px (`max-w-[1440px]`), side nav trái trên nền Porcelain, nội dung chính trên Warm Paper. Vùng nội dung màn hình thường bó ở `max-w-5xl` (64rem); khối văn bản dài dùng `max-w-prose`. Nhịp khoảng cách theo bậc Tailwind 4px — dày ở bảng/danh sách (py-2, gap-2), thoáng ở giữa các khối (space-y-6, p-4/p-6). Mật độ nghiêng về công cụ vận hành: nhiều hàng hiển thị cùng lúc quan trọng hơn khoảng trắng trình diễn. `scrollbar-gutter: stable` giữ trang ngắn và dài cùng một offset ngang.

## Elevation & Depth

**Phẳng + hairline.** Chiều sâu đến từ ba lớp tonal (Warm Paper → Sunken Paper → Porcelain) và viền Ink Hairline, không phải từ bóng. Shadow chỉ xuất hiện ở lớp thật sự nổi khỏi trang: popover, dialog, dropdown (shadow-lg), và một chút `shadow-xs` cho input. Dark mode: bóng gần như vô hình trên nền tối — elevation chuyển thành hairline sáng hơn (trắng 12–16%).

### Named Rules
**The Flat-By-Default Rule.** Bề mặt đứng yên thì phẳng. Bóng là phản ứng của lớp nổi (overlay), không phải trang trí của card.

## Shapes

Ngôn ngữ bo tròn mềm, base radius 0.625rem (10px): `rounded-lg` (10px) cho control (nút, input), `rounded-xl` (14px) cho card/khối, `rounded-full` cho badge/pill/avatar. Không có góc vuông sắc trong UI; cũng không đi quá 2xl cho khối nội dung. Viền 1px hairline trên mọi bề mặt có ranh giới; không double-border.

## Components

Cảm giác chung: **mềm nhưng dứt khoát** — bo tròn lớn, màu dịu, nhưng mọi trạng thái tương tác trả lời tức thì và không thể hiểu nhầm.

### Buttons
- **Shape:** bo mềm (rounded-lg, 10px), cao 32px (h-8), text-sm font-medium; size sm 28px, lg 36px, icon 32px vuông.
- **Primary:** nền Iris Violet, chữ Porcelain; hover giảm còn 80% opacity; active dịch xuống 1px (`translate-y-px`) — phản hồi vật lý nhỏ, dứt khoát.
- **Hover / Focus:** focus-visible = viền + ring 3px Iris Violet 50%; không dùng outline mặc định.
- **Outline:** viền hairline, nền Warm Paper, hover sang Sunken Paper. **Ghost:** trong suốt, hover Sunken Paper. **Destructive:** nền Clay Red 10%, chữ Clay Red, hover 20% — hành động phá huỷ không bao giờ là khối đỏ đặc.

### Badges (status pill)
- **Style:** rounded-full, text-xs font-medium, px-2.5 py-0.5, viền + nền tint + chữ deep theo The 10% Tint Rule.
- **State:** 5 tone — neutral / success / warning / danger / info. Tone do **caller** chọn từ trạng thái nghiệp vụ; mapping nằm ở màn hình, không giấu trong component.

### Cards / Containers
- **Corner Style:** rounded-xl (14px).
- **Background:** Porcelain trên nền Warm Paper.
- **Shadow Strategy:** không bóng (Flat-By-Default); tách nền bằng chênh tonal + hairline.
- **Border:** 1px Ink Hairline.
- **Internal Padding:** p-4 (16px) mặc định, p-6 cho khối đầu trang.

### Inputs / Fields
- **Style:** h-9 (36px), rounded-lg, nền Warm Paper, viền Ink Hairline 14%, shadow-xs, text-sm; placeholder Plum Quiet.
- **Focus:** viền + ring 3px Iris Violet 50% — cùng ngôn ngữ với nút.
- **Error / Disabled:** `aria-invalid` → viền Clay Red + ring đỏ 20%; disabled → opacity 50%, không đổi màu nền.

### Navigation
- **Side nav** trên Porcelain: item text-sm, active = nền Lavender Chip nhạt (sidebar-accent) + chữ Iris Deep; hover Sunken Paper. Top bar chứa tenant switcher và search.

### Eyebrow (signature)
Nhãn mono nhỏ phía trên heading ("BƯỚC 1 / 3", "TIẾN TRÌNH") — Plum Mist, uppercase, tracking-widest, cố ý không phải heading để không tạo outline trùng cho screen reader. Đây là chữ ký thị giác nối chất "sổ vận hành" vào xưởng pastel.

## Do's and Don'ts

### Do:
- **Do** lấy mọi màu/radius/spacing từ token semantic (`bg-primary`, `text-muted-foreground`, `rounded-lg`) — lớp giá trị nằm duy nhất ở `globals.css`.
- **Do** viết màu mới bằng oklch và định nghĩa đủ cặp light/dark cùng ngữ nghĩa.
- **Do** cho mọi trạng thái nghiệp vụ một lối ra thị giác: tint + viền + chữ deep, kèm lời giải thích "vì sao" bằng tiếng Việt.
- **Do** dùng mono cho mã/số/đếm và eyebrow mono cho nhãn khối (The Mono Ledger Rule).
- **Do** giữ active state vật lý nhỏ (translate-y-px) và focus ring 3 px thống nhất toàn hệ.

### Don't:
- **Don't** dùng hex/px trần hay xám trung tính cho viền — viền là Plum Ink loang (The Ink Hairline Rule).
- **Don't** đổ bóng lên card đứng yên; bóng chỉ dành cho overlay (The Flat-By-Default Rule).
- **Don't** dùng màu trạng thái cho hành động, hay khối đỏ đặc cho nút phá huỷ.
- **Don't** import `@astryxdesign/core/tailwind-theme.css` trước mốc B9 — bridge này remap `--color-primary/card/muted` và phá các utility shadcn còn dùng (ghi chú đầu `globals.css`).
- **Don't** hiển thị ảnh giả cho media chưa tải được — ô trống Lilac Veil có nhãn, người vận hành không được "duyệt" thứ chưa nhìn thấy.
- **Don't** thêm font không có subset vietnamese (The Diacritics Rule).
