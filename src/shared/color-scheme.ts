/**
 * Light / dark, as a per-VIEWER preference.
 *
 * NOT the same axis as the appearance preset. The preset is the platform's
 * colour and one admin sets it for everybody; this is each operator's own
 * choice of scheme, and it belongs to their browser. `presets.css` already
 * carries both schemes for every preset — this module is what decides which of
 * the two a given person sees.
 *
 * A COOKIE, NOT localStorage: the server has to know the scheme while it
 * renders, or every load paints the light palette and snaps to dark after
 * hydration (web-design-tokens §5 — nháy trắng là lỗi nhìn thấy được, and the
 * same rule `nav-collapse.ts` follows for the same reason).
 *
 * THREE CHOICES, NOT TWO. "system" is the default and is the one the server
 * cannot answer on its own — it lives in the operating system, not in the
 * request. That is what `COLOR_SCHEME_BOOTSTRAP_SCRIPT` is for: an explicit
 * light/dark choice is stamped server-side and needs no script at all, and only
 * "system" pays for a synchronous read before paint.
 *
 * Free of React and of `window` on purpose, so the parsing rules are testable
 * in the node environment the project already uses, and so the layout and the
 * toggle share ONE definition (two parsers would eventually disagree).
 */

export const COLOR_SCHEME_COOKIE = "mysp-color-scheme";

/** A year: a personal preference, not a credential. Losing it costs one click. */
const COLOR_SCHEME_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

export const COLOR_SCHEME_CHOICES = ["system", "light", "dark"] as const;
export type ColorSchemeChoice = (typeof COLOR_SCHEME_CHOICES)[number];

/** What the app actually paints, once "system" has been resolved. */
export type ResolvedColorScheme = "light" | "dark";

export const DEFAULT_COLOR_SCHEME_CHOICE: ColorSchemeChoice = "system";

/** The class `globals.css` keys its dark palette on. */
export const DARK_SCHEME_CLASS = "dark";

/** Records the CHOICE on the root element, so the toggle renders it correctly. */
export const COLOR_SCHEME_ATTRIBUTE = "data-color-scheme";

export const COLOR_SCHEME_LABELS: Record<ColorSchemeChoice, string> = {
  system: "Theo máy",
  light: "Sáng",
  dark: "Tối",
};

/**
 * The choice carried by the cookie. Anything unrecognised — missing, empty, a
 * value somebody typed into devtools — reads as "system". A preference has no
 * safe way to fail other than its default, and this must never throw: it runs
 * while the root layout is being rendered, in front of every page in the app.
 */
export function parseColorSchemeCookie(
  value: string | null | undefined,
): ColorSchemeChoice {
  return isColorSchemeChoice(value) ? value : DEFAULT_COLOR_SCHEME_CHOICE;
}

export function isColorSchemeChoice(value: unknown): value is ColorSchemeChoice {
  return (
    typeof value === "string" &&
    (COLOR_SCHEME_CHOICES as readonly string[]).includes(value)
  );
}

/**
 * What the SERVER can commit to. "system" answers null rather than guessing
 * light: guessing means a viewer on a dark desktop gets a white page for one
 * frame, which is the exact flash this module exists to prevent. The bootstrap
 * script fills that case in before paint.
 */
export function resolveColorSchemeOnServer(
  choice: ColorSchemeChoice,
): ResolvedColorScheme | null {
  return choice === "system" ? null : choice;
}

/**
 * The `document.cookie` string for a new choice.
 *
 * `secure` is a parameter because the dev box runs on plain http, where the
 * browser silently drops a `Secure` cookie — the same rule the nav-collapse and
 * active-tenant cookies follow.
 */
export function buildColorSchemeCookie(
  choice: ColorSchemeChoice,
  options: { secure: boolean },
): string {
  const safe = isColorSchemeChoice(choice) ? choice : DEFAULT_COLOR_SCHEME_CHOICE;
  return [
    `${COLOR_SCHEME_COOKIE}=${safe}`,
    "Path=/",
    `Max-Age=${COLOR_SCHEME_MAX_AGE_SECONDS}`,
    "SameSite=Lax",
    ...(options.secure ? ["Secure"] : []),
  ].join("; ");
}

/**
 * Runs synchronously in `<body>`, before anything below it is painted, and ONLY
 * when the choice is "system" — the one case the server could not answer.
 *
 * Deliberately tiny and dependency-free: it blocks parsing, so every byte is
 * paid for on every page load. It is also wrapped in try/catch and does nothing
 * on failure, because the fallback (the light palette already on the element) is
 * a working page, and a thrown error here would be an error on EVERY route
 * including sign-in.
 */
export const COLOR_SCHEME_BOOTSTRAP_SCRIPT = `try{if(matchMedia('(prefers-color-scheme: dark)').matches){document.documentElement.classList.add('${DARK_SCHEME_CLASS}')}}catch(e){}`;
