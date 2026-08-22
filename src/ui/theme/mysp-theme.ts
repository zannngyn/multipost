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

    /**
     * THE ACTION COLOUR — The One Indigo Rule (DESIGN.md §Colors).
     *
     * The neutral theme's `--color-accent` is `light-dark(#262626, #ebebeb)`,
     * so every Astryx `variant="primary"` button painted itself near-BLACK
     * while every button built on the local `ui/button` primitive painted
     * itself indigo. Two "most important action" colours on one screen
     * ("Lấy danh sách Page" black next to "Tạo nhóm" indigo, /channels), a
     * difference nobody can name and everybody sees.
     *
     * Knock-on effects, all of them wanted and all of them checked:
     *  - the caret in every Astryx TextInput becomes indigo, matching the
     *    `caret-color: var(--primary)` globals.css already sets on the
     *    Tailwind side (craft floor — browser surfaces belong to the design);
     *  - focus outlines/rings on Astryx controls become indigo, matching the
     *    `--ring` used by the local primitives;
     *  - contrast on the primary button is 7.19:1 light (primary-foreground on
     *    indigo dye) and 5.99:1 dark — both past 4.5:1.
     *
     * NOT affected, verified in the built CSS: `StatusDot`/`ProgressBar` with
     * `accent`, and `Banner` with `info`, each re-declare `--color-accent`
     * on their own element, so they keep the values the neutral theme gave
     * them and no status colour turns into an action colour.
     */
    "--color-accent": "var(--primary)",
    /** The ink that stands on that indigo — one source, class-switched. */
    "--color-on-accent": "var(--primary-foreground)",
    /**
     * The icon half of the same decision. Left at the neutral near-black it
     * would draw an indigo label with a black glyph beside it.
     */
    "--color-icon-accent": "var(--primary)",
    /**
     * The "đang chọn" surface (selected nav row, checked control): Indigo
     * Wash, the same tint `bg-accent` paints on the Tailwind side. The neutral
     * value is a cold `#f1f1f1`, which is the grey The Ink Hairline Rule
     * exists to keep off this cloth.
     */
    "--color-accent-muted": "var(--accent)",

    /**
     * THE GROUND — every screen in the app stands on this one.
     *
     * `AppShell` is the ONLY element that paints the area behind a screen
     * (measured: `.astryx-app-shell` 1440×900, everything from `Layout` down is
     * `rgba(0,0,0,0)`), and it paints `--color-background-body`. The neutral
     * theme sets that to `#F1F1F1` — a cold generic grey — so the unbleached
     * muslin `body { background: var(--background) }` paints was covered on
     * every route, and the swatch cards on /sync, /compose and /prompts were
     * warm panels floating on somebody else's grey.
     *
     * Painting the cloth here rather than in `globals.css` is the only
     * supported way: the shell's rule is scoped to `[data-astryx-theme]`.
     */
    "--color-background-body": "var(--background)",
    /**
     * One step above the ground: the layer Astryx gives a dialog panel, a text
     * input, a segmented control and the shell's nav bands. Neutral shipped
     * `#FFFFFF` — the pure white this world does not contain — so it becomes
     * the swatch card, the same surface `bg-card` paints on the Tailwind side.
     */
    "--color-background-surface": "var(--card)",
    "--color-background-card": "var(--card)",
    "--color-background-popover": "var(--popover)",
    /**
     * Sunken fills (a muted band, a filled cell). `--muted` is the same warm
     * shade `bg-muted` uses, so an Astryx panel and a Tailwind one sink by the
     * same amount instead of one going grey.
     */
    "--color-background-muted": "var(--muted)",

    /**
     * THE INK HAIRLINE RULE (DESIGN.md §Borders) applied to Astryx too. The
     * neutral border is `#00000014` — black at 8%, which reads cold and blue on
     * an unbleached ground; ours is the warm ink at the same weight, so a table
     * rule and a card edge are drawn with the same pen.
     */
    "--color-border": "var(--border)",
    /** The heavier hairline (focus-adjacent edges, dividers that must count). */
    "--color-border-emphasized": "var(--input)",
    /**
     * Loading is one of the four mandatory states, so its slabs belong to the
     * world as much as the data does. Neutral's `#EBEBEB` skeleton and grey
     * track were the last cold rectangles left on screen.
     */
    "--color-skeleton": "var(--muted)",
    "--color-track": "var(--muted)",
  },
});
