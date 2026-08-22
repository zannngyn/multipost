import type { Catalog } from "@astryxdesign/core/i18n";

/**
 * The Vietnamese catalog for Astryx's OWN strings.
 *
 * WHY THIS EXISTS: every word an operator reads in this tool is Vietnamese
 * except the ones Astryx prints for itself — "Search…" in the ⌘K palette,
 * "Required" beside a field label, "Close" on a dialog. Nobody wrote those, so
 * nobody noticed them, and they are the loudest possible signal that the screen
 * is half-translated. `astryx docs internationalization` has exactly one
 * supported way to change them: a catalog passed to
 * `InternationalizationProvider` (see `AppFrame`).
 *
 * SCOPE: only the keys reachable from a component this app actually renders
 * (the import surface of `@astryxdesign/core` across `src/ui`). Astryx resolves
 * a missing key by walking the locale chain down to its bundled `en`, so an
 * untranslated key degrades to English rather than to an empty string — and a
 * catalog padded with 250 guesses would be 250 strings nobody proof-read.
 *
 * NOT COVERED BY THIS FILE — the ⌘K footer hints ("Navigate / Select / Close").
 * `CommandPaletteFooter` hard-codes them in JSX with no message key, so the only
 * supported route is its `children` slot; `AppSearch` passes Vietnamese hints
 * there.
 *
 * PLURALS: Vietnamese has a single plural category, so the counted strings are
 * written flat ("{count, number} kết quả") instead of with an ICU `plural`
 * block that would only ever select `other`.
 */
export const ASTRYX_VI: Catalog = {
  // --- App shell ------------------------------------------------------------
  "@astryx.appShell.skipToContent": { defaultMessage: "Tới nội dung chính" },
  "@astryx.appShell.mobileNavigation": { defaultMessage: "Điều hướng trên di động" },
  "@astryx.sideNav.label": { defaultMessage: "Menu bên trái" },
  "@astryx.sideNav.resizeSidebar": { defaultMessage: "Đổi bề rộng menu" },
  "@astryx.sideNav.heading.openMenu": { defaultMessage: "Mở menu" },
  "@astryx.sideNav.heading.dialogLabel": { defaultMessage: "Menu điều hướng" },
  "@astryx.topNav.landmarkLabel": { defaultMessage: "Thanh trên cùng" },
  "@astryx.topNav.heading.openMenu": { defaultMessage: "Mở menu" },
  "@astryx.topNav.heading.dialogLabel": { defaultMessage: "Menu điều hướng" },

  // --- Command palette (⌘K) -------------------------------------------------
  "@astryx.commandPalette.label": { defaultMessage: "Tìm màn hình" },
  "@astryx.commandPalette.input.placeholder": { defaultMessage: "Tìm màn hình…" },
  "@astryx.commandPalette.list.label": { defaultMessage: "Danh sách màn hình" },
  "@astryx.commandPalette.emptySearch": { defaultMessage: "Không có màn hình nào khớp" },
  "@astryx.commandPalette.emptyBootstrap": { defaultMessage: "Gõ để tìm" },
  "@astryx.commandPalette.noResultsFor": {
    defaultMessage: "Không có kết quả cho “{query}”",
  },
  "@astryx.commandPalette.resultCount": { defaultMessage: "{count, number} kết quả" },
  "@astryx.commandPalette.loading": { defaultMessage: "Đang tải" },

  // --- Dialog / banner / menu ----------------------------------------------
  "@astryx.dialog.close": { defaultMessage: "Đóng" },
  "@astryx.banner.dismiss": { defaultMessage: "Bỏ qua" },
  "@astryx.banner.collapse": { defaultMessage: "Thu gọn" },
  "@astryx.banner.expand": { defaultMessage: "Mở rộng" },
  "@astryx.dropdownMenu.label": { defaultMessage: "Menu" },
  "@astryx.link.newTab": { defaultMessage: "(mở tab mới)" },
  "@astryx.button.loading": { defaultMessage: "Đang xử lý" },

  // --- Fields ---------------------------------------------------------------
  "@astryx.field.required": { defaultMessage: "Bắt buộc" },
  "@astryx.field.optional": { defaultMessage: "Không bắt buộc" },
  "@astryx.input.statusButton.error": { defaultMessage: "Chi tiết lỗi" },
  "@astryx.input.statusButton.warning": { defaultMessage: "Chi tiết cảnh báo" },
  "@astryx.input.statusButton.success": { defaultMessage: "Chi tiết" },
  "@astryx.textInput.clearLabel": { defaultMessage: "Xoá {label}" },
  "@astryx.textArea.charactersRemaining": {
    defaultMessage: "Còn {count, number} ký tự",
  },
  "@astryx.textArea.charactersOverLimit": {
    defaultMessage: "Vượt {count, number} ký tự",
  },
  "@astryx.selector.placeholder": { defaultMessage: "Chọn…" },
  "@astryx.selector.searchPlaceholder": { defaultMessage: "Tìm…" },
  "@astryx.selector.searchOptions": { defaultMessage: "Tìm trong danh sách" },
  "@astryx.selector.clearLabel": { defaultMessage: "Xoá {label}" },

  // --- Date / time (compose + schedule pickers) -----------------------------
  "@astryx.dateInput.placeholder": { defaultMessage: "Chọn ngày" },
  "@astryx.dateInput.dialogLabel": { defaultMessage: "Chọn ngày" },
  "@astryx.dateInput.openCalendar": { defaultMessage: "Mở lịch" },
  "@astryx.dateInput.closeCalendar": { defaultMessage: "Đóng lịch" },
  "@astryx.dateInput.toggleCalendarClose": { defaultMessage: "Đóng lịch" },
  "@astryx.dateInput.clear": { defaultMessage: "Xoá {label}" },
  "@astryx.dateTimeInput.placeholder": { defaultMessage: "Chọn ngày" },
  "@astryx.dateTimeInput.dialogLabel": { defaultMessage: "Chọn ngày" },
  "@astryx.dateTimeInput.timePlaceholder": { defaultMessage: "Chọn giờ" },
  "@astryx.dateTimeInput.timeSuffix": { defaultMessage: "Giờ của {label}" },
  "@astryx.calendar.previousMonth": { defaultMessage: "Tháng trước" },
  "@astryx.calendar.nextMonth": { defaultMessage: "Tháng sau" },
  "@astryx.calendar.daySelected": { defaultMessage: "{date}, đang chọn" },

  // --- Table ----------------------------------------------------------------
  "@astryx.table.label": { defaultMessage: "Bảng dữ liệu" },
  "@astryx.table.noData": { defaultMessage: "Chưa có dữ liệu" },
  "@astryx.table.pagination.label": { defaultMessage: "Phân trang bảng" },
  "@astryx.table.filter.allPlaceholder": { defaultMessage: "Tất cả" },
  "@astryx.table.filter.reset": { defaultMessage: "Đặt lại" },
  "@astryx.table.filter.apply": { defaultMessage: "Áp dụng" },
  "@astryx.table.selection.selectAllRows": { defaultMessage: "Chọn mọi dòng" },
  "@astryx.table.selection.selectRow": { defaultMessage: "Chọn dòng này" },
  "@astryx.table.selection.selectRowNamed": { defaultMessage: "Chọn {label}" },
  "@astryx.table.sort.ascending": { defaultMessage: "Sắp xếp tăng dần" },
  "@astryx.table.sort.descending": { defaultMessage: "Sắp xếp giảm dần" },
  "@astryx.table.sort.clear": { defaultMessage: "Bỏ sắp xếp" },
  "@astryx.table.sort.direction.ascending": { defaultMessage: "tăng dần" },
  "@astryx.table.sort.direction.descending": { defaultMessage: "giảm dần" },
  "@astryx.table.sort.sortBy": { defaultMessage: "Sắp xếp theo {label}" },
  "@astryx.table.sort.sortedBy": {
    defaultMessage: "Sắp xếp theo {label}, đang {direction}",
  },

  // --- Code block -----------------------------------------------------------
  // The one deliberate exception to the SCOPE rule above: nothing renders
  // `CodeBlock` yet. `/prompts` wanted it for prompt bodies (a copy button is
  // exactly what an operator comparing two versions needs) and did NOT adopt it
  // precisely because these three keys were missing, which would have put
  // "Copy code" on a Vietnamese screen. Translating first removes that blocker;
  // the swap itself is a separate change.
  //
  // "code" here is source code — the prompt template text — not a PIN or a
  // discount code (per the `description` fields in Astryx's own en.json).
  "@astryx.codeBlock.code": { defaultMessage: "Đoạn mã" },
  "@astryx.codeBlock.copyCode": { defaultMessage: "Chép đoạn mã" },
  "@astryx.codeBlock.copied": { defaultMessage: "Đã chép" },
};

/** The locale tag this app runs Astryx in. One constant, two call sites. */
export const ASTRYX_LOCALE = "vi";
