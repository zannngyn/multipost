import type { CSSProperties } from "react";

/**
 * Palette của mẫu ComposeFocus — PM chốt 20/08/2026.
 *
 * DELIBERATE EXCEPTION to core-design-tokens ("no literal hex in product
 * code"), taken with the PM's explicit approval: the compose screen must match
 * `templates 2/compose-focus/ComposeFocus.dc.html` exactly, and the app's
 * global palette (oklch, cool plum ink + violet accent) is a different design.
 *
 * The exception is contained the only way it can be:
 *  - every literal appears ONCE, here, and nowhere else in `compose/**`;
 *  - it is expressed as CSS custom properties on ONE wrapper element, so the
 *    values are read through `var()` everywhere else — the component tier of
 *    the three-tier token model (core-design-tokens §Ba tầng), not a bypass;
 *  - the first block re-points the app's own SEMANTIC variables. That is what
 *    makes `<Button>`, `<Badge>`, `<Input>`, `<Textarea>` and the suggestion
 *    popover wear this skin without a single component being forked
 *    (core-component-reuse: reuse the component, re-point the token).
 *
 * Anything the app has no semantic token for gets a `--compose-*` variable in
 * the second block. Nothing outside this file may write a hex value.
 *
 * Source lines in the template, for anyone diffing the two:
 *   #F1EDE7 page wash (26) · #FFFDFB raised surface (27, 37) · #221F1C ink (26)
 *   #FBF7F2 sunken well (82) · #F4F0EA segmented track (61)
 *   #9C4520 accent (14, 56, 95) · #FDF4F0 + #E0A183 chip đang chọn (15)
 *   #1B62C4 hashtag/link (13, 99) · #17140F nút đăng (129)
 *   #E4EFE6 / #2C6E4B pill trạng thái AI (85) · #9A938A eyebrow (90, 102)
 *   #7A736B / #5C554E chữ phụ (31, 63) · #F3DCCF avatar wash (35)
 */
const PALETTE_VARS: Record<`--${string}`, string> = {
  // --- App semantic tokens, re-pointed for this screen only ----------------
  "--background": "#F1EDE7",
  "--foreground": "#221F1C",
  "--foreground-subtle": "#9A938A",
  "--card": "#FFFDFB",
  "--card-foreground": "#221F1C",
  "--popover": "#FFFDFB",
  "--popover-foreground": "#221F1C",
  "--muted": "#F4F0EA",
  "--muted-foreground": "#7A736B",
  "--secondary": "#F4F0EA",
  "--secondary-foreground": "#221F1C",
  "--primary": "#9C4520",
  "--primary-foreground": "#FFFDFB",
  "--accent": "#F3DCCF",
  "--accent-foreground": "#9C4520",
  "--border": "rgba(34, 31, 28, 0.13)",
  "--input": "rgba(34, 31, 28, 0.14)",
  "--ring": "rgba(156, 69, 32, 0.45)",
  "--success": "#7FB496",
  "--success-foreground": "#2C6E4B",
  "--media-empty": "#F0EAE3",
  "--media-empty-cover": "#EFE3DA",

  // --- Component tier: shapes the app has no semantic token for ------------
  /** Sunken well behind the caption block (template 82). */
  "--compose-well": "#FBF7F2",
  /** The raised block INSIDE the well — the caption itself (97). */
  "--compose-raised": "#FFFDFB",
  /** Segmented track and neutral badges (61, 72). */
  "--compose-track": "#F4F0EA",
  /** Hairline, at the three weights the template uses (58, 69, 100). */
  "--compose-hairline": "rgba(34, 31, 28, 0.09)",
  "--compose-hairline-strong": "rgba(34, 31, 28, 0.16)",
  /** Chip đang chọn: soft fill + 1.5px inset ring (15). */
  "--compose-chip-on": "#FDF4F0",
  "--compose-chip-ring": "#E0A183",
  /** Hashtag line, in the caption and in the preview (13, 99, 145). */
  "--compose-link": "#1B62C4",
  /** The one black action ("Đăng luôn", 129). */
  "--compose-ink": "#17140F",
  /** AI state pill (85). */
  "--compose-ok-bg": "#E4EFE6",
  "--compose-ok-fg": "#2C6E4B",
  /** Second text tone, darker than --muted-foreground (63, 157). */
  "--compose-text-2": "#5C554E",
  /** Cover ring on a photo tile (17). */
  "--compose-cover-ring": "#9C4520",
  /** ✕ on a photo tile (78). */
  "--compose-scrim": "rgba(34, 31, 28, 0.62)",
  /** "+N" veil over the last collage tile (154). */
  "--compose-veil": "rgba(34, 31, 28, 0.48)",
  /**
   * Avatar washes of the channel picker (template 217–221: #8E5AA8, #B4542A,
   * #2F6B4A, #2C5A7A, #A2842A). Indexed, because the mock gives every Page its
   * own colour and this system has no brand colour per Page — the index is
   * derived from the name, so one Page keeps one colour everywhere.
   */
  "--compose-avatar-0": "#8E5AA8",
  "--compose-avatar-1": "#B4542A",
  "--compose-avatar-2": "#2F6B4A",
  "--compose-avatar-3": "#2C5A7A",
  "--compose-avatar-4": "#A2842A",
  /** Modal scrim + panel radius (161–162). */
  "--compose-overlay": "rgba(34, 31, 28, 0.42)",
  "--compose-radius-modal": "18px",
  /** Card radius / block radius / tile radius (37, 82, 76). */
  "--compose-radius-card": "20px",
  "--compose-radius-block": "16px",
  "--compose-radius-control": "14px",
  "--compose-radius-tile": "12px",
};

/**
 * The same map as a `style` value. React types have no index signature for
 * custom properties, so the cast is the documented way to hand them to `style`
 * — it is the ONLY cast in this file and it changes no value.
 */
export const COMPOSE_PALETTE = PALETTE_VARS as CSSProperties;

/**
 * Shadow of the left card and the preview frame (template 37, 140): a hairline
 * drawn as an inset ring plus one soft drop. Written once so the two frames
 * cannot drift apart.
 */
export const COMPOSE_CARD_SHADOW =
  "shadow-[inset_0_0_0_1px_var(--compose-hairline),0_12px_32px_rgba(34,31,28,0.05)]";

/** Hairline-only frame, for blocks sitting inside the card (82, 97, 114). */
export const COMPOSE_HAIRLINE_RING = "shadow-[inset_0_0_0_1px_var(--compose-hairline)]";

/** The 1px rule the template uses between sections (58, 111). */
export const COMPOSE_RULE = "bg-[var(--compose-hairline)] h-px w-full shrink-0";
