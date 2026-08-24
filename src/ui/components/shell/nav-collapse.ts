/**
 * Persistence of the side nav's collapsed state. Kept free of React and of
 * `window` so the parsing rules can be tested in the node environment the
 * project already uses, and so the server layout and the client nav share ONE
 * definition of the cookie (two parsers would eventually disagree).
 *
 * A cookie, not localStorage: the server has to know the state while it renders
 * the shell, otherwise every reload paints the expanded nav first and snaps it
 * shut after hydration (web-state-architecture: cấm đọc localStorage ở lần
 * render đầu — hydration mismatch).
 *
 * No secret in it, so it is readable by scripts on purpose — the nav writes it
 * itself from the click handler.
 */

export const NAV_COLLAPSED_COOKIE = "mysp-nav-collapsed";

/** A year: a personal preference, not a credential. Losing it costs one click. */
const NAV_COLLAPSED_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/**
 * Where Astryx's `useResizable` persists the nav width — `STORAGE_PREFIX`
 * ("astryx-resizable:") + the `autoSaveId` passed to `SideNav.resizable`
 * (@astryxdesign/core@0.4.0 `dist/Resizable/useResizable.js:29,54-78`). Must
 * match the `autoSaveId` in AppSideNav.
 */
export const NAV_WIDTH_STORAGE_KEY = "astryx-resizable:mysp-nav";

/**
 * The collapsed state carried by the cookie. Anything that is not exactly "1"
 * — missing, empty, "true", a value somebody typed in devtools — reads as
 * EXPANDED. A preference has no safe way to fail other than the default state,
 * and this must never throw: it runs while the shell is being rendered.
 */
export function isNavCollapsedCookie(value: string | null | undefined): boolean {
  return value === "1";
}

/**
 * The `document.cookie` string for the new state.
 *
 * `secure` is a parameter because the dev box runs on plain http, where the
 * browser silently drops a `Secure` cookie — the same rule the active-tenant
 * cookie follows.
 */
export function buildNavCollapsedCookie(
  isCollapsed: boolean,
  options: { secure: boolean },
): string {
  return [
    `${NAV_COLLAPSED_COOKIE}=${isCollapsed ? "1" : "0"}`,
    "Path=/",
    `Max-Age=${NAV_COLLAPSED_MAX_AGE_SECONDS}`,
    "SameSite=Lax",
    ...(options.secure ? ["Secure"] : []),
  ].join("; ");
}

/** Storage surface actually used here — enough to fake in a node test. */
export interface NavWidthStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
}

/**
 * Drops a leftover "width 0" left behind by the pre-cookie build.
 *
 * WHY this exists: Astryx keeps TWO facts about collapsing and only persists
 * one of them. `SideNav` initialises `collapsed` from props
 * (`dist/SideNav/SideNav.js:125-136` — never from storage), while `useResizable`
 * restores `isCollapsed = (persisted === 0)` from localStorage
 * (`dist/Resizable/useResizable.js:115-118`) and re-persists `isCollapsed ? 0 :
 * size` in an effect (`:121-125`). Somebody who collapsed the nav on the build
 * before this one has `0` in storage and no cookie: the server would render the
 * expanded nav at 256px, the resize hook would render `width: 0` on hydration,
 * and the effect would write `0` back for ever.
 *
 * So: when the cookie says expanded and storage still says width 0, the stale
 * value is removed BEFORE `useResizable` reads it. Runs once, on the client,
 * during the first render of the nav — the parent renders before its children.
 *
 * Only that exact combination is touched; a real, non-zero width the operator
 * dragged is left alone.
 */
export function dropStaleCollapsedWidth(
  storage: NavWidthStorage,
  isCollapsed: boolean,
): void {
  if (isCollapsed) return;

  const raw = storage.getItem(NAV_WIDTH_STORAGE_KEY);
  if (raw === null) return;
  if (!isZeroWidth(raw)) return;

  storage.removeItem(NAV_WIDTH_STORAGE_KEY);
}

/**
 * Parsed the way Astryx parses it: `JSON.parse`, number only
 * (`dist/Resizable/useResizable.js:54-69`). A value this cannot read is a value
 * Astryx cannot read either — it falls back to the default width, which is the
 * state we want anyway, so there is nothing to clean up and nothing to report.
 */
function isZeroWidth(raw: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  return typeof parsed === "number" && parsed === 0;
}
