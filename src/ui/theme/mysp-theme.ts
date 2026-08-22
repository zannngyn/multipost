import { defineTheme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral";

/**
 * The "Sổ mẫu vải" theme — the neutral theme with MYSP's ink in it.
 *
 * WHY THIS FILE EXISTS: Astryx components read their own tokens, not ours.
 * `Layout`, `Text`, `Heading` and everything inside `AppShell` were painting
 * `--color-text-primary`, which the neutral theme sets to `#171717` — a cold
 * near-black next to the warm brown ink (`--foreground`) every Tailwind screen
 * uses. Two inks on one page, a shade apart, is the kind of difference nobody
 * can name and everybody sees.
 *
 * WHY NOT A CSS OVERRIDE: `astryx docs theme` has exactly one supported way to
 * re-value a token — `defineTheme`, extending the base theme. Redeclaring
 * `--color-*` in a bare `:root` would sit OUTSIDE the `@scope
 * ([data-astryx-theme=…])` block the theme CSS is written in, so it would win
 * or lose by cascade accident and break the day a component starts reading a
 * derived token instead.
 *
 * WHY THE VALUES ARE `var(...)` AND NOT LITERALS: the swatch palette lives in
 * `app/globals.css`, and it is class-switched (`.dark`), not
 * `prefers-color-scheme`-switched. A `[light, dark]` tuple here would compile
 * to `light-dark()`, which follows `color-scheme` and would ignore the class —
 * the app would be stuck in one scheme. Pointing at the variable keeps ONE
 * source of truth and inherits the class switch for free.
 *
 * BUILT, NOT RUNTIME: `astryx theme build` compiles this to `mysp-theme.css`,
 * which is imported in `globals.css`. A runtime theme injects its tokens in
 * `useInsertionEffect`, i.e. after hydration — the first paint would show the
 * neutral ink and then swap (`astryx docs theme` §Runtime vs Built).
 * After editing this file, re-run:
 *   pnpm exec astryx theme build src/ui/theme/mysp-theme.ts
 */
export const myspTheme = defineTheme({
  name: "mysp",
  extends: neutralTheme,
  tokens: {
    /** Body copy, headings, anything Astryx calls "primary" ink. */
    "--color-text-primary": "var(--foreground)",
    /** Supporting lines — `<Text type="supporting">` and every description. */
    "--color-text-secondary": "var(--muted-foreground)",
    /**
     * Deliberately NOT `--foreground-subtle`: subtle is a readable third tone
     * (4.5:1, used for eyebrows and mono metadata), while this one marks a
     * control that cannot be used. Kept at the muted tone with the alpha that
     * says "off", so the two never get confused.
     */
    "--color-text-disabled": "color-mix(in oklch, var(--muted-foreground) 55%, transparent)",
    /**
     * Links and accented text: the indigo dye. The neutral theme does NOT ship
     * a blue here — its `--color-text-accent` is `light-dark(#262626, #ebebeb)`,
     * a near-black/near-white that makes an accented word indistinguishable
     * from body copy. This is what gives a link its colour back.
     */
    "--color-text-accent": "var(--primary)",
  },
});
