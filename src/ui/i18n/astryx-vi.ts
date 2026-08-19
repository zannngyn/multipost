import type { Catalog } from "@astryxdesign/core";

/**
 * Vietnamese catalog for the Astryx strings this app renders.
 *
 * Astryx ships English only (plus a three-key French sample), so every label it
 * owns — the sidebar collapse button, the command palette, the skip link —
 * arrives in English inside an otherwise Vietnamese screen. A catalog is the
 * supported way to replace them: no component gets patched, and the sibling
 * test fails if an upgrade renames a key out from under us.
 *
 * DELIBERATELY PARTIAL, on two rules:
 *
 *  - a key nothing renders is not listed. Anything the app already labels with
 *    its own prop (the side nav landmark, the palette's own label and empty
 *    text) stays out, or the same string would have two spellings and only one
 *    of them would ever be read aloud;
 *  - a key not listed falls back through the locale chain to English, which is
 *    Astryx's documented behaviour, so a missing entry degrades instead of
 *    breaking. Add one when a screen starts rendering the component that owns
 *    it.
 *
 * Each `description` is copied verbatim from
 * `@astryxdesign/core/locales/en.json` — it is what tells the next person what
 * the string is really for, and the test compares against that same file.
 */
export const ASTRYX_VI: Catalog = {
  // --- App frame -----------------------------------------------------------
  "@astryx.appShell.skipToContent": {
    defaultMessage: "Tới nội dung chính",
    description:
      "Text of the skip link — the first focusable element on the page, visible only while keyboard-focused. Activating it jumps focus past the navigation to the main content area. Imperative verb; keep short.",
  },
  "@astryx.appShell.mobileNavigation": {
    defaultMessage: "Điều hướng trên màn hình nhỏ",
    description:
      "Screen-reader-only accessible name for the mobile-only navigation region on small viewports. \"Mobile\" = phone/tablet (small screen), not \"movable\".",
  },

  // --- Mobile navigation drawer --------------------------------------------
  "@astryx.mobileNav.toggle.open": {
    defaultMessage: "Mở điều hướng",
    description:
      "Screen-reader-only label on the hamburger button that opens the MobileNav overlay (rendered when the overlay is closed). Pairs with `mobileNav.closeNavigation`.",
  },
  "@astryx.mobileNav.closeNavigation": {
    defaultMessage: "Đóng điều hướng",
    description:
      "Screen-reader-only label on the X/close button that dismisses the MobileNav overlay. Pairs with `mobileNav.toggle.open`.",
  },
  "@astryx.mobileNav.navigation": {
    defaultMessage: "Điều hướng",
    description:
      "Screen-reader-only fallback name for the MobileNav overlay dialog when no explicit label was passed.",
  },

  // --- Side nav ------------------------------------------------------------
  "@astryx.sideNav.resizeSidebar": {
    defaultMessage: "Kéo để đổi bề rộng thanh bên",
    description:
      "Screen-reader-only label on the vertical drag handle at the right edge of the SideNav that lets the user resize the sidebar's width.",
  },
  "@astryx.sideNavCollapseButton.collapseSidebar": {
    defaultMessage: "Thu gọn thanh bên",
    description:
      "Aria label AND tooltip on the same toggle when the sidebar is currently expanded (clicking collapses it). Pairs with `expandSidebar`.",
  },
  "@astryx.sideNavCollapseButton.expandSidebar": {
    defaultMessage: "Mở rộng thanh bên",
    description:
      "Aria label AND tooltip on the SideNav collapse/expand toggle when the sidebar is currently collapsed (clicking expands it). Pairs with `collapseSidebar`.",
  },
  "@astryx.sideNavItem.collapse": {
    defaultMessage: "Thu gọn {label}",
    description:
      "Screen-reader-only label on the same chevron when the group is expanded. Example: `Collapse Settings`. Pairs with `sideNavItem.expand`.",
  },
  "@astryx.sideNavItem.expand": {
    defaultMessage: "Mở rộng {label}",
    description:
      "Screen-reader-only label on the chevron next to a SideNav item with children when the group is collapsed. Example: `Expand Settings`. Pairs with `sideNavItem.collapse`.",
  },
  "@astryx.sideNav.heading.openMenu": {
    defaultMessage: "Mở menu",
    description:
      "Screen-reader-only label on the `⋯` overflow-menu button embedded in a SideNav section heading. Same string as `topNav.heading.openMenu` — translations may share.",
  },
  "@astryx.sideNav.heading.dialogLabel": {
    defaultMessage: "Menu điều hướng",
    description:
      "Screen-reader-only accessible name for the dropdown dialog opened from a SideNavHeading's overflow menu.",
  },

  // --- Top nav -------------------------------------------------------------
  "@astryx.topNav.heading.openMenu": {
    defaultMessage: "Mở menu",
    description:
      "Screen-reader-only label on the `⋯` overflow button in a TopNav section heading. Kept separate from `sideNav.heading.openMenu` so translations may diverge.",
  },
  "@astryx.topNav.heading.dialogLabel": {
    defaultMessage: "Menu điều hướng",
    description:
      "Screen-reader-only accessible name for the dropdown dialog opened from a TopNavHeading's overflow menu. Kept separate from the SideNav sibling.",
  },

  // --- Command palette -----------------------------------------------------
  "@astryx.commandPalette.input.placeholder": {
    defaultMessage: "Tìm…",
    description:
      "Grey placeholder inside the CommandPalette's search input. Imperative verb; trailing `…` is one character.",
  },
  "@astryx.commandPalette.list.label": {
    defaultMessage: "Danh sách lệnh",
    description:
      "\"Command\" = an app action a user can invoke (metaphor from CLI), not a Unix command. Screen-reader-only name for the matching-commands list.",
  },
  "@astryx.commandPalette.emptyBootstrap": {
    defaultMessage: "Gõ để tìm",
    description:
      "Onboarding empty-state text shown inside a CommandPalette on first open, before the user has typed anything. Imperative sentence fragment.",
  },
  "@astryx.commandPalette.noResultsFor": {
    defaultMessage: "Không có kết quả cho {query}",
    description:
      "Screen-reader-only announcement when a CommandPalette query matches nothing. `{query}` is the user's verbatim search text; keep it last if your language allows so truncation-by-AT still conveys the outcome.",
  },
  // Vietnamese has one plural form, so the English `plural` branches
  // collapse to a bare count. `number` stays: it is what groups the
  // digits the Vietnamese way.
  "@astryx.commandPalette.resultCount": {
    defaultMessage: "{count, number} kết quả",
    description:
      "Screen-reader-only announcement of how many commands match the CommandPalette query as the user types. Example: `12 results`, `1 result`; keep compact.",
  },
  "@astryx.commandPalette.loading": {
    defaultMessage: "Đang tải",
    description:
      "Screen-reader-only announcement that a CommandPalette search has started and results are being fetched. Present-progressive form; matches the visible spinner.",
  },

  // --- Dialogs the shell opens ---------------------------------------------
  "@astryx.dialog.close": {
    defaultMessage: "Đóng",
    description:
      "\"Close\" = shut/dismiss the dialog, not \"nearby\" (English homograph). Aria label AND tooltip on the X at the top-right of a Dialog.",
  },
};
