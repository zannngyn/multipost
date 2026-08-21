# Hướng dẫn dùng Impeccable cho Claude — dự án MYSP

> Nguồn: https://impeccable.style/docs/ (đọc 21/08/2026) + skill đã cài ở `~/.claude/skills/impeccable/`.
> Đối tượng đọc: Claude session làm việc trên repo này (đặc biệt nhánh redesign). Người dùng gọi lệnh bằng `/impeccable <command> [target]`.

## 1. Impeccable là gì

Skill thiết kế UI cho AI coding agent: lập kế hoạch, dựng, review và tinh chỉnh UI theo ngữ cảnh sản phẩm thật thay vì lời khuyên chung chung. Gồm 3 phần:

- **Bộ lệnh** `/impeccable <command>` chạy trong agent (bảng ở mục 4).
- **Detector CLI** `npx impeccable detect` — quét pattern lỗi thiết kế, chạy tay hoặc CI.
- **Hook** tự chạy detector sau mỗi lần agent sửa file UI.

## 2. Ba file ngữ cảnh (design context)

Không có ngữ cảnh → kết quả generic. Thứ tự thẩm quyền khi mâu thuẫn: PRODUCT.md thắng về quyết định sản phẩm bền vững · DESIGN.md thắng về quyết định thị giác · surface brief thắng về chiến lược từng trang · code hiện hữu là tín hiệu docs có thể đã cũ.

| File | Vai trò | Trạng thái MYSP | Cập nhật bằng |
|---|---|---|---|
| `PRODUCT.md` (root) | Tầng chiến lược: platform, users, định vị, ràng buộc, evidence | **ĐÃ CÓ** (tạo 21/08/2026, schema 1) | `/impeccable init` khi chiến lược đổi |
| `DESIGN.md` (root) | Hệ thị giác: palette, typography, component, radius/elevation, luật | **CHƯA CÓ** | `/impeccable document` (ghi hệ hiện hữu) hoặc new-work (hệ mới khi redesign) |
| `.impeccable/surfaces/*.md` | Brief từng trang: mode, job, proof sequence, direction đã chọn | Chưa có | Sinh ra bởi chính công việc (shape/new-work); sửa khi chiến lược trang đổi |

File sinh máy: `.impeccable/design.json` — **không sửa tay**, refresh bằng `/impeccable document`.

Điểm chốt của PRODUCT.md hiện tại (đọc file để biết đủ): 2 vai người dùng (chủ shop cấu hình / nhân viên vận hành), desktop-first, định vị **SaaS thật sự**, "MYSP" là **tên tạm** không ràng buộc nhận diện, chưa có testimonial/số liệu — **không được bịa**.

## 3. Quy trình chuẩn cho redesign MYSP

Nguyên tắc skill: **refinement giữ nguyên bản sắc hiện có; redesign thay thế** — giữ product truth, nội dung, chức năng, ràng buộc, nhưng coi giao diện cũ là bằng chứng và anti-reference. Không được "lai" hai hướng thành bản đánh bóng giao diện cũ.

1. **Bối cảnh**: mỗi session chạy `node ~/.claude/skills/impeccable/scripts/context.mjs` một lần (skill tự làm khi được gọi). `init` đã xong.
2. **Ghi hệ hiện hữu trước khi thay** *(khuyến nghị)*: `/impeccable document` để chốt DESIGN.md từ Astryx hiện tại — làm mốc so sánh và nguồn trích invariant.
3. **Redesign qua new-work**: mô tả yêu cầu cho `/impeccable <mô tả redesign>` hoặc `/impeccable shape <màn>` — hệ thống tự phân loại (greenfield / new surface / redesign / refinement). Với redesign, new-work chọn **visual world** thay thế (188 world trong catalog cạnh tranh với ý tưởng từ model; ràng buộc người dùng nêu ra luôn thắng), rồi viết **direction contract** 5 khối trước khi code: THESIS · OWN-WORLD · STORY · FIRST VIEWPORT · FORM.
4. **Build**: đường build của repo này là **code-first** (harness không có image generation) — ambition ghi trong direction contract, audit ở bước cuối.
5. **Sau build**: DESIGN.md được thay bằng giá trị thật từ code mới; surface brief tự sinh.
6. **Kiểm**: verify theo **vòng có giới hạn** — build đủ, 1 vòng inspect gộp (desktop + mobile), sửa 1 đợt, tối đa 1 vòng xác nhận nữa rồi dừng. Không tự QA vô hạn.

Mode cho app UI MYSP (compose, duyệt caption, kênh, members, sync, platform) là **Operate**: scanability, nhất quán, đúng kỳ vọng người vận hành > biểu đạt. Trang marketing/landing (nếu làm) là **Persuade**.

## 4. Bảng lệnh

| Nhóm | Lệnh | Dùng khi |
|---|---|---|
| Create | `/impeccable <mô tả>` | Việc mới bất kỳ: trang mới, redesign — hệ thống tự phân loại |
| | `shape <feature>` | Lên kế hoạch UX/UI, chốt brief trước khi code |
| Evaluate | `critique <target>` | Review UX: LLM đọc code + mở trang thật, chấm theo Nielsen 10 heuristics + checklist cognitive load + brand fit; có overlay highlight lỗi trên trang |
| | `audit <target>` | Kiểm kỹ thuật: a11y, perf, responsive |
| Refine | `polish` · `bolder` · `quieter` · `distill` · `harden` · `onboard` | Đánh bóng cuối / tăng cá tính / giảm ồn / tối giản / production-ready (error, i18n, edge case) / first-run & empty state |
| Enhance | `animate` · `colorize` · `typeset` · `layout` · `delight` · `overdrive` | Motion / thêm màu chiến lược / typography / spacing-hierarchy / điểm nhấn cá tính / vượt giới hạn |
| Fix | `clarify` · `adapt` · `optimize` | UX copy & error message / responsive đa thiết bị / hiệu năng UI |
| System | `init` · `document` · `extract` · `live` · `doctor` · `hooks` | Ngữ cảnh sản phẩm / ghi DESIGN.md / rút token-component / iterate trực quan / sửa drift / quản hook |

Mẹo: `/impeccable pin <command>` tạo shortcut `/<command>` đứng riêng. Polish tạo **diff nhỏ có chủ đích** (alignment, spacing, type, màu, interaction), không rewrite — review diff, revert phần không ưng.

## 5. Live mode — iterate từng phần tử

`/impeccable live`: overlay picker trên dev server (hỗ trợ Next.js). Workflow: click phần tử → gõ yêu cầu hoặc chọn chip (`bolder`, `quieter`, `polish`, `typeset`, `colorize`, `layout`, `animate`, `delight`, `overdrive`, `distill`) → vẽ/ghi chú trực tiếp nếu cần → Go → sinh **3 variant** production-quality → mũi tên để xem qua HMR → accept 1 (ghi về source) hoặc bỏ cả 3.

Giới hạn: cần dev server chạy (`pnpm dev`); chỉ cho iterate **từng phần tử**, không phải redesign vĩ mô (dùng new-work); không dùng trên trang còn placeholder; lần đầu có thể đề nghị patch CSP dev-only — cần đồng ý tường minh.

## 6. Detector CLI + Hook + Doctor

**Detector** — quét contrast, typography drift, overflow, "AI-design tells" (gradient text, purple palette, nested cards…), vi phạm design system (tự bật khi có DESIGN.md):

```bash
npx impeccable detect src/            # quét thư mục
npx impeccable detect <file|URL>      # 1 file hoặc trang đang chạy
npx impeccable detect --json src/     # output JSON
# exit 0 = sạch · 2 = có finding (dùng fail CI) · 1 = lệnh lỗi
# --no-design-system · --scope type|layout
```

**Hook** — tự chạy detector sau mỗi edit file UI (`.tsx .jsx .html .vue .css .scss .ts .js`…), 2 tầng: per-edit chỉ báo lỗi nghiêm trọng (contrast, overflow, gradient text, lệch DESIGN.md), cuối session chạy full ruleset.

```
/impeccable hooks status | on | off
/impeccable hooks ignore-rule <rule-id>
/impeccable hooks ignore-file "src/legacy/X.tsx"
/impeccable hooks ignore-value <rule> <value> --shared --reason "..."
```

Finding cố ý (đúng brand) → dùng ignore có `--reason`, không sửa bừa cho detector im. Inline: `<!-- impeccable-disable <rule>: lý do -->`.

**Doctor** — `/impeccable doctor`: tìm và sửa drift giữa artifact (PRODUCT.md, DESIGN.md + design.json, config, surface brief, hook) và version đã cài. Mechanical → tự sửa; còn lại route về `init`/`document`. Config ở `.impeccable/config.json` (chia sẻ, commit) và `.impeccable/config.local.json` (cá nhân, không commit).

## 7. Luật riêng của repo này — Impeccable KHÔNG ghi đè

1. **Astryx v0.4.0 là design system bắt buộc** (`@astryxdesign/core` + CLI): mọi output của lệnh Impeccable vẫn phải qua component Astryx + token — không `<div>`, không raw hex/px, tra `astryx build/component/search` trước khi viết UI. Redesign đổi *world* thị giác = đổi theme/token qua `astryx theme` + cấu hình, không vứt bỏ Astryx khi chưa bàn với PM.
2. **Flow agent team giữ nguyên**: việc UI thuộc domain `ui-web`; mọi task code chỉ "xong" khi `reviewer-qa` PASS. Lệnh Impeccable là công cụ trong tay agent, không thay gate.
3. **Verify thật**: `pnpm typecheck && pnpm lint && pnpm depcruise && pnpm build` + preview `pnpm dev` trước khi báo xong (chuẩn CLAUDE.md).
4. **Không bịa nội dung**: evidence chưa có (testimonial, số liệu, khách ngoài) đã ghi trong PRODUCT.md — trang Persuade không được tự chế.
5. **Quyết định treo** C1/C2/C5, C3/C4, D1, D2, E1, E3: gặp thì dùng giá trị tạm + `// PENDING(<mã>)`, không tự chốt.
6. UI tiếng Việt cho người vận hành; log/code tiếng Anh.
