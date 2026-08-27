import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChannelTileGroup } from "./ChannelTile";
import { CheckOptionCardGroup } from "./CheckOptionCard";
import { OptionCardGroup } from "./OptionCard";
import { StepActions } from "./StepActions";
import { WelcomeScreen } from "./WelcomeScreen";

/**
 * `renderToStaticMarkup`, not testing-library: vitest runs `environment: "node"`
 * and the repo has no jsdom. Every card here takes its state and its handler as
 * props, so all of it renders without a DOM.
 *
 * ON THE SEMANTICS ASSERTED BELOW. The plan asks for `role="radiogroup"` on the
 * group and `role="radio"` + `aria-checked` on each item. The group DOES carry
 * the literal role — a `<fieldset>`'s own role is `group`, so stating
 * `radiogroup` adds meaning. Each ITEM is a native `<input type="radio">`,
 * whose implicit role IS `radio` and whose implicit `aria-checked` IS the
 * `checked` attribute; writing those two ARIA attributes onto it would be
 * redundant ARIA layered over built-in semantics, which `core-accessibility`
 * forbids outright ("Đừng thêm ARIA vào thứ đã có sẵn ngữ nghĩa"). Native also
 * buys the arrow-key navigation the plan requires, for free. So the item
 * assertions below check the native form of those same two facts.
 */

const noop = () => {};

const SELLER_CHOICES = [
  {
    value: "solo_seller",
    label: "Bán lẻ cá nhân",
    emoji: "👋",
    tone: "yellow" as const,
  },
  {
    value: "shop_owner",
    label: "Chủ shop nhỏ",
    emoji: "💪",
    tone: "green" as const,
  },
  { value: "other", label: "Khác", emoji: "🦄", tone: "neutral" as const },
];

const COUNT_CHOICES = [
  { value: "1_3", label: "1-3" },
  { value: "4_6", label: "4-6" },
];

const TOOL_CHOICES = [
  { value: "manual_facebook", label: "Tự đăng tay trên Facebook", emoji: "💻" },
  {
    value: "social_suite",
    label: "Công cụ quản lý mạng xã hội",
    hint: "vd: Hootsuite, Later",
    emoji: "🛠",
  },
];

describe("OptionCardGroup — dạng A và C, một lựa chọn", () => {
  it("marks the chosen card with something that is NOT a colour", () => {
    // Spec section 9.3: a green border alone does not carry meaning. The tick
    // is the carrier, so it must be ABSENT until the card is chosen and PRESENT
    // once it is — a card that always draws it proves nothing.
    const unchosen = renderToStaticMarkup(
      <OptionCardGroup
        name="seller"
        legend="Bạn đang bán hàng kiểu nào?"
        choices={SELLER_CHOICES}
        value={null}
        onChange={noop}
      />,
    );
    const chosen = renderToStaticMarkup(
      <OptionCardGroup
        name="seller"
        legend="Bạn đang bán hàng kiểu nào?"
        choices={SELLER_CHOICES}
        value="solo_seller"
        onChange={noop}
      />,
    );

    expect(unchosen).not.toContain('data-slot="option-tick"');
    expect(chosen).toContain('data-slot="option-tick"');
    // And the tick is a drawn glyph, not a recoloured box.
    expect(chosen.match(/<svg/g)?.length ?? 0).toBeGreaterThan(
      unchosen.match(/<svg/g)?.length ?? 0,
    );

    // SINCE 26/08/2026 the glyph rides a 26px badge on the card's corner
    // (animation spec section 5.2). The RULE is unchanged and is what the
    // assertions above still check — absent, then present; only the drawing
    // moved. The badge is asserted separately so that losing it is a red test
    // rather than a silent return to a tick in the row.
    expect(unchosen).not.toContain('data-slot="option-check-badge"');
    expect(chosen).toContain('data-slot="option-check-badge"');
    // It springs in on mount. There is no matching "out": a radio group never
    // un-chooses, it swaps which card is chosen.
    expect(chosen).toContain("onboarding-check-in");

    // Ink, not the dye — the prototype's `--sel` and `--check` are both
    // `#2e2820`, which is `--foreground` here. Border and badge move together.
    expect(chosen).toContain("border-foreground");
    expect(chosen).toContain("bg-foreground");
    expect(chosen).not.toContain("border-primary");
    expect(chosen).not.toContain("bg-primary");
  });

  it("draws the emoji wells in the prototype's six tints, at the prototype's size", () => {
    /**
     * They were built from theme roles and measured wrong against the
     * prototype: dull yellow, a blue with no blue left in it, and beige where
     * the purple should be. The theme holds no hue near the purple's 310°, so
     * the six are scoped custom properties instead — argued in full in
     * `onboarding-motion.css`. 40px well, up from the 32px taken off Buffer.
     */
    const html = renderToStaticMarkup(
      <OptionCardGroup
        name="seller"
        legend="Bạn đang bán hàng kiểu nào?"
        choices={SELLER_CHOICES}
        value={null}
        onChange={noop}
      />,
    );
    expect(html).toContain("bg-[var(--well-yellow)]");
    expect(html).toContain("bg-[var(--well-green)]");
    expect(html).toContain("size-10");
    // The old theme-role wash must be gone, or two systems paint one well.
    expect(html).not.toContain("bg-warning/25");
    expect(html).not.toContain("bg-info/20");
  });

  it("turns the cards that were not chosen down, and only when one was", () => {
    // Animation spec section 5.2, point 3. The dim is what points at the choice
    // — so it must not be on before there is one, and it must never be on the
    // card that was chosen.
    const unchosen = renderToStaticMarkup(
      <OptionCardGroup
        name="seller"
        legend="Bạn đang bán hàng kiểu nào?"
        choices={SELLER_CHOICES}
        value={null}
        onChange={noop}
      />,
    );
    const chosen = renderToStaticMarkup(
      <OptionCardGroup
        name="seller"
        legend="Bạn đang bán hàng kiểu nào?"
        choices={SELLER_CHOICES}
        value="solo_seller"
        onChange={noop}
      />,
    );

    expect(unchosen).not.toContain('data-dimmed="true"');
    expect(chosen.match(/data-dimmed="true"/g)).toHaveLength(
      SELLER_CHOICES.length - 1,
    );
    expect(chosen.match(/data-chosen="true"/g)).toHaveLength(1);
    // PAINT, NOT MOTION: stated on the element, so a visitor who asked for less
    // movement still sees which card they chose. Only the transition between
    // the two states lives behind `prefers-reduced-motion: no-preference`.
    //
    // WHAT THIS LINE DOES NOT PROVE. It shows the class is in the markup; it
    // says nothing about the opacity that actually paints. Those came apart for
    // real: with `animation-fill-mode: both` on the entrance, the keyframe's
    // final `opacity: 1` sat in the animation origin and outranked this class
    // for the life of the page — measured "1" in Chrome while this test was
    // green. The effective value is guarded in `onboarding-motion.test.ts`
    // ("fills the entrance BACKWARDS"), which is where that class of bug lives.
    expect(chosen).toContain("opacity-45");
  });

  it("hands each card its place in the stagger, counted from zero", () => {
    // Animation spec section 4, row 5. The base delay is stated once on the
    // grid and each card only adds its index — six delays written out by hand
    // is six chances for one of them to be wrong.
    //
    // Three choices here, so this never reaches the cap; the CAP is exercised
    // where it actually bites, on the eight channel tiles of step 4 (see
    // `channel-tile-render.test.tsx`) and on `enterIndex` directly.
    const html = renderToStaticMarkup(
      <OptionCardGroup
        name="seller"
        legend="Bạn đang bán hàng kiểu nào?"
        choices={SELLER_CHOICES}
        value={null}
        onChange={noop}
      />,
    );
    expect(html).toContain("--enter-delay:260ms");
    expect(
      [...html.matchAll(/--enter-index:(\d+)/g)].map((match) => match[1]),
    ).toEqual(["0", "1", "2"]);
  });

  it("is a real radiogroup of real radios", () => {
    const html = renderToStaticMarkup(
      <OptionCardGroup
        name="seller"
        legend="Bạn đang bán hàng kiểu nào?"
        choices={SELLER_CHOICES}
        value="shop_owner"
        onChange={noop}
      />,
    );

    expect(html).toContain('role="radiogroup"');
    expect(html).toContain("<fieldset");
    expect(html.match(/type="radio"/g)).toHaveLength(SELLER_CHOICES.length);
    // The checked state — `aria-checked` in ARIA terms — on exactly one of them.
    expect(html.match(/checked=""/g)).toHaveLength(1);
    // Never a div wearing a role and pretending to be a control.
    expect(html).not.toContain('role="radio"');
  });

  it("names the group for assistive tech without repeating the question on screen", () => {
    const html = renderToStaticMarkup(
      <OptionCardGroup
        name="seller"
        legend="Bạn đang bán hàng kiểu nào?"
        choices={SELLER_CHOICES}
        value={null}
        onChange={noop}
      />,
    );
    expect(html).toContain("<legend");
    expect(html).toContain("Bạn đang bán hàng kiểu nào?");
    // The visible question is the screen's own <h1>; the legend is its echo.
    expect(html).toContain("sr-only");
  });

  it("puts the hit area on the whole card, not on a 16px box", () => {
    // WCAG 2.2 target size: the input itself is off-screen and the <label>
    // around it is the target, so the target is the card.
    const html = renderToStaticMarkup(
      <OptionCardGroup
        name="count"
        legend="Bạn đang quản lý bao nhiêu trang?"
        choices={COUNT_CHOICES}
        value={null}
        onChange={noop}
      />,
    );
    expect(html).toContain("<label");
    expect(html.match(/sr-only/g)?.length ?? 0).toBeGreaterThanOrEqual(
      COUNT_CHOICES.length,
    );
  });

  it("draws the shorter plain card when a choice carries no emoji (dạng C)", () => {
    const withEmoji = renderToStaticMarkup(
      <OptionCardGroup
        name="seller"
        legend="Bạn đang bán hàng kiểu nào?"
        choices={SELLER_CHOICES}
        value={null}
        onChange={noop}
      />,
    );
    const plain = renderToStaticMarkup(
      <OptionCardGroup
        name="count"
        legend="Bạn đang quản lý bao nhiêu trang?"
        choices={COUNT_CHOICES}
        value={null}
        onChange={noop}
      />,
    );

    // 58px tall with the emoji well, 47px without it (spec sections 5.1, 5.3).
    expect(withEmoji).toContain("min-h-[3.625rem]");
    expect(plain).toContain("min-h-[2.9375rem]");
    expect(plain).not.toContain("min-h-[3.625rem]");
  });

  it("hides the emoji from screen readers — it decorates a label that already reads", () => {
    const html = renderToStaticMarkup(
      <OptionCardGroup
        name="seller"
        legend="Bạn đang bán hàng kiểu nào?"
        choices={SELLER_CHOICES}
        value={null}
        onChange={noop}
      />,
    );
    expect(html).toContain('aria-hidden="true"');
  });

  it("renders nothing rather than an empty fieldset when the vocabulary is missing", () => {
    // An empty option list is a bug upstream, not a screen state. Drawing an
    // empty radiogroup would announce a group with no members.
    expect(
      renderToStaticMarkup(
        <OptionCardGroup
          name="seller"
          legend="Câu hỏi"
          choices={[]}
          value={null}
          onChange={noop}
        />,
      ),
    ).toBe("");
  });
});

describe("CheckOptionCardGroup — dạng B, nhiều lựa chọn", () => {
  it("is a group of real checkboxes", () => {
    const html = renderToStaticMarkup(
      <CheckOptionCardGroup
        name="tools"
        legend="Bạn đang đăng bài bằng gì?"
        choices={TOOL_CHOICES}
        values={["manual_facebook"]}
        onToggle={noop}
      />,
    );

    expect(html.match(/type="checkbox"/g)).toHaveLength(TOOL_CHOICES.length);
    expect(html.match(/checked=""/g)).toHaveLength(1);
    expect(html).not.toContain('role="checkbox"');
    expect(html).not.toContain('type="radio"');
  });

  it("holds more than one answer at a time", () => {
    const html = renderToStaticMarkup(
      <CheckOptionCardGroup
        name="tools"
        legend="Bạn đang đăng bài bằng gì?"
        choices={TOOL_CHOICES}
        values={["manual_facebook", "social_suite"]}
        onToggle={noop}
      />,
    );
    expect(html.match(/checked=""/g)).toHaveLength(2);
  });

  it("renders the second line of a choice that has one", () => {
    const html = renderToStaticMarkup(
      <CheckOptionCardGroup
        name="tools"
        legend="Bạn đang đăng bài bằng gì?"
        choices={TOOL_CHOICES}
        values={[]}
        onToggle={noop}
      />,
    );
    expect(html).toContain("vd: Hootsuite, Later");
  });

  it("ticks the box itself, so the state is never the border colour alone", () => {
    const ticked = renderToStaticMarkup(
      <CheckOptionCardGroup
        name="tools"
        legend="Bạn đang đăng bài bằng gì?"
        choices={TOOL_CHOICES}
        values={["manual_facebook"]}
        onToggle={noop}
      />,
    );
    const empty = renderToStaticMarkup(
      <CheckOptionCardGroup
        name="tools"
        legend="Bạn đang đăng bài bằng gì?"
        choices={TOOL_CHOICES}
        values={[]}
        onToggle={noop}
      />,
    );
    expect(ticked).toContain('data-slot="option-tick"');
    expect(empty).not.toContain('data-slot="option-tick"');
  });

  it("renders nothing rather than an empty fieldset when the vocabulary is missing", () => {
    expect(
      renderToStaticMarkup(
        <CheckOptionCardGroup
          name="tools"
          legend="Câu hỏi"
          choices={[]}
          values={[]}
          onToggle={noop}
        />,
      ),
    ).toBe("");
  });
});

describe("the entrance never shares an element with the state it would outrank", () => {
  /**
   * THE RULE B1 EXISTS TO ENFORCE, checked on real markup.
   *
   * A running animation's value comes from the animation origin, which beats
   * every author declaration while the animation is live. So an element may
   * carry an `.onboarding-enter*` class OR an opacity/scale utility — never
   * both. It carried both, and a dimmed card measurably faded up to full and
   * only dropped to .45 when its own animation finished.
   *
   * `animation-fill-mode` cannot express this; only the markup can, which is
   * why the guard lives here rather than in the stylesheet suite.
   *
   * IT COVERS `opacity` AND `scale` ONLY, ON PURPOSE — do not "fix" it by
   * widening the pattern. The entrance keyframes animate `transform` and
   * `opacity`. In Tailwind v4 the `translate-*`, `rotate-*` and `scale-*`
   * utilities compile to the STANDALONE `translate`, `rotate` and `scale`
   * properties, which compose with `transform` instead of overwriting it — so
   * only `opacity` can truly collide, and `scale` is watched as a precaution
   * because `.onboarding-check-in` animates that property directly. Widening
   * this to `translate` would immediately flag the live region's own
   * `-translate-x-1/2`, which is centring and collides with nothing.
   */
  const ENTRANCE = /class="([^"]*\bonboarding-enter[a-z-]*\b[^"]*)"/g;

  /**
   * THE VARIANT PREFIX IS THE WHOLE POINT, and the first version of this regex
   * missed it. It anchored on `^`, so it matched a bare `opacity-45` and was
   * blind to `disabled:opacity-50` — which is precisely the class
   * `buttonVariants` puts on every `Button`, i.e. the one this guard exists to
   * catch. Proven blind: putting `onboarding-enter-fade` back on
   * `<Button disabled={isSaving}>` left the whole suite green.
   *
   * `(^|:)` accepts the end of any variant chain — `disabled:`, `motion-safe:`,
   * `hover:`, `dark:disabled:`, `data-[state=open]:` — while still refusing
   * `bg-opacity-50`, where the `-` is preceded by a word rather than by a colon
   * or the start of the name.
   */
  const COLLIDING_UTILITY = /(^|:)-?(opacity|scale)-/;

  /**
   * How many elements are actually wearing the entrance.
   *
   * WITHOUT THIS THE GUARD BELOW IS HALF A TEST. `offendingClassLists` returns
   * `[]` both when the entrance and the state are correctly on separate
   * elements AND when there is no entrance in the markup at all — so deleting
   * `className="onboarding-enter"` outright left the whole suite green. Every
   * case now pins the COUNT as well as the absence, which is what makes the two
   * outcomes tell each other apart.
   */
  function entranceCount(html: string): number {
    return [...html.matchAll(ENTRANCE)].length;
  }

  function offendingClassLists(html: string): string[] {
    return [...html.matchAll(ENTRANCE)]
      .map((match) => match[1])
      .filter((classList) =>
        classList.split(/\s+/).some((name) => COLLIDING_UTILITY.test(name)),
      );
  }

  it("recognises a colliding utility behind a variant prefix", () => {
    // The regex itself, pinned. Everything below is only as good as this line.
    for (const name of [
      "opacity-45",
      "scale-[0.985]",
      "disabled:opacity-50",
      "motion-safe:opacity-0",
      "dark:disabled:opacity-50",
      "hover:scale-105",
      "-scale-x-100",
    ]) {
      expect(COLLIDING_UTILITY.test(name), `${name} should be caught`).toBe(
        true,
      );
    }

    // …and does not cry wolf over names that merely contain the word.
    for (const name of [
      "bg-opacity-50",
      "text-opacity-50",
      "opacity",
      "scale",
    ]) {
      expect(COLLIDING_UTILITY.test(name), `${name} should be ignored`).toBe(
        false,
      );
    }
  });

  it("keeps the dim off the element that animates — dạng A, B, C and D", () => {
    const dangA = renderToStaticMarkup(
      <OptionCardGroup
        name="seller"
        legend="Bạn đang bán hàng kiểu nào?"
        choices={SELLER_CHOICES}
        value="solo_seller"
        onChange={noop}
      />,
    );
    // The dim is on screen — this is not passing by having no dim at all.
    expect(dangA).toContain("opacity-45");
    // Six cards, six entrances — proof the assertion above had something to
    // look at (`SELLER_CHOICES` is three, so three).
    expect(entranceCount(dangA)).toBe(SELLER_CHOICES.length);
    expect(offendingClassLists(dangA)).toEqual([]);

    const dangB = renderToStaticMarkup(
      <CheckOptionCardGroup
        name="tools"
        legend="Bạn đang đăng bài bằng gì?"
        choices={TOOL_CHOICES}
        values={["manual_facebook"]}
        onToggle={noop}
      />,
    );
    // Dạng B carries no opacity/scale state, so the emptiness above proves
    // nothing on its own — the count is the whole assertion here.
    expect(entranceCount(dangB)).toBe(TOOL_CHOICES.length);
    expect(offendingClassLists(dangB)).toEqual([]);

    // Dạng C — the plain cards of step 3. It dims exactly like dạng A, and it
    // was not rendered here at all until the gate pointed that out.
    const dangC = renderToStaticMarkup(
      <OptionCardGroup
        name="count"
        legend="Bạn đang quản lý bao nhiêu trang?"
        choices={COUNT_CHOICES}
        value="1_3"
        onChange={noop}
      />,
    );
    expect(dangC).toContain("opacity-45");
    expect(entranceCount(dangC)).toBe(COUNT_CHOICES.length);
    expect(offendingClassLists(dangC)).toEqual([]);

    // Dạng D — the channel tiles of step 4, also previously unrendered.
    const dangD = renderToStaticMarkup(
      <ChannelTileGroup
        name="channels"
        legend="Kênh nào bạn đang tập trung?"
        choices={[
          { value: "facebook" },
          { value: "tiktok", isComingSoon: true },
        ]}
        values={["facebook"]}
        onToggle={noop}
      />,
    );
    // Same as dạng B: no state to collide with, so the count is the guard.
    expect(entranceCount(dangD)).toBe(2);
    expect(offendingClassLists(dangD)).toEqual([]);
  });

  it("keeps the saving fade off the element that animates, on both actions", () => {
    // `Button` fades a disabled control with `disabled:opacity-50`; the skip
    // button's entrance used to sit on that same element.
    const saving = renderToStaticMarkup(
      <StepActions canContinue isSaving onContinue={noop} onSkip={noop} />,
    );
    // Proof the fade is really in this markup, so the assertion below is not
    // passing on an empty haystack the way the first version did.
    expect(saving).toContain("disabled:opacity-50");
    // The CTA wrapper and the "Bỏ qua" wrapper.
    expect(entranceCount(saving)).toBe(2);
    expect(offendingClassLists(saving)).toEqual([]);

    const blocked = renderToStaticMarkup(
      <StepActions canContinue={false} onContinue={noop} onSkip={noop} />,
    );
    expect(entranceCount(blocked)).toBe(2);
    expect(offendingClassLists(blocked)).toEqual([]);
  });

  it("covers the greeting too — the last screen to keep the entrance on a Button", () => {
    const html = renderToStaticMarkup(
      <WelcomeScreen name="Vân" onStart={noop} />,
    );
    expect(html).toContain("disabled:opacity-50");
    // The heading and the button wrapper.
    expect(entranceCount(html)).toBe(2);
    expect(offendingClassLists(html)).toEqual([]);
  });
});

describe("StepActions", () => {
  it("shuts the way forward until something is chosen, and says why", () => {
    const html = renderToStaticMarkup(
      <StepActions canContinue={false} onContinue={noop} onSkip={noop} />,
    );
    // The ATTRIBUTE, not the substring: the shared `Button` carries
    // `disabled:opacity-…` utility classes in every state, so a bare
    // `toContain("disabled")` would pass on an enabled button too.
    //
    // AND IT IS `aria-disabled`, NOT `disabled` (animation spec section 5.3,
    // PM 26/08/2026). Both say "this cannot go anywhere"; only one of them
    // still lets the press arrive, and the press is what the explanation hangs
    // off. A `disabled` button here would be a control that refuses to say why.
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toContain(' disabled=""');
    // Spec section 7.1 plus the Buffer pattern in analysis 3.9: the label
    // CHANGES, it does not merely fade — a greyed "Tiếp tục" leaves the
    // operator guessing which of the two controls is the broken one.
    expect(html).toContain("Chọn một mục để tiếp tục");
    expect(html).not.toContain(">Tiếp tục<");
  });

  it("keeps a live region for the answer to a press that cannot go anywhere", () => {
    // The region is in the document BEFORE it has anything to say: a
    // `role="status"` element inserted together with its text is routinely not
    // announced, because nothing was watching it. The sentence itself only
    // appears after the press, so it is not in the server markup.
    const html = renderToStaticMarkup(
      <StepActions canContinue={false} onContinue={noop} onSkip={noop} />,
    );
    expect(html).toContain('role="status"');
    expect(html).not.toContain("Chọn một lựa chọn ở trên");
    // AND NO `aria-describedby` POINTING AT IT. It had one; that made a single
    // element both the button's description and a live region, so the sentence
    // could be announced twice on the press that reveals it — once as the
    // region changing, once as the description of the focused control. The live
    // region is the one that fires at the right moment, so it kept the job.
    expect(html).not.toContain("aria-describedby=");
  });

  it("offers the way forward once something is chosen", () => {
    const html = renderToStaticMarkup(
      <StepActions canContinue onContinue={noop} onSkip={noop} />,
    );
    expect(html).toContain("Tiếp tục");
    expect(html).not.toContain("Chọn một mục để tiếp tục");
    expect(html).not.toContain(' disabled=""');
    expect(html).not.toContain('aria-disabled="true"');
    // The ready look is seeded from the answer, not animated into place: a step
    // reopened with its answer on file must render finished on the first frame.
    expect(html).toContain("onboarding-cta-ready");
  });

  it("arrives on the shared entrance timeline rather than on delays of its own", () => {
    // Animation spec section 4, rows 6 and 7. Written as multiples of the
    // stagger, which is itself derived from a duration token — a typed 635ms
    // would drift the day the theme moves.
    const html = renderToStaticMarkup(
      <StepActions canContinue onContinue={noop} onSkip={noop} />,
    );
    expect(html).toContain("--enter-delay:calc(260ms + 6 * var(--stagger))");
    expect(html).toContain("--enter-delay:calc(260ms + 7 * var(--stagger))");
    // The entrance rides a wrapper and the pop rides the button: two
    // `animation-name` declarations on one element overwrite each other.
    expect(html).toContain(
      'class="onboarding-enter flex w-full justify-center"',
    );
  });

  it("always leaves Bỏ qua reachable, and never underlines it", () => {
    const html = renderToStaticMarkup(
      <StepActions canContinue={false} onContinue={noop} onSkip={noop} />,
    );
    expect(html).toContain("Bỏ qua");
    expect(html).not.toContain("underline");
  });

  it("says it is saving, and locks both ways out while it is", () => {
    // Spec section 2.5: each step writes to the server before it moves on. Two
    // presses would be two writes and, worse, two steps forward.
    const html = renderToStaticMarkup(
      <StepActions canContinue isSaving onContinue={noop} onSkip={noop} />,
    );
    expect(html).toContain("Đang lưu");
    // REALLY disabled, both of them — this is the one state where swallowing
    // the press is the right answer, because the press costs a second write.
    expect(html.match(/ disabled=""/g)).toHaveLength(2);
  });

  it("keeps the primary button at its measured size, on the prototype's corner", () => {
    // 352x48 unchanged. The corner moved from `rounded-md` (12.8px, measured
    // off the Buffer shots) to `rounded-lg`, which IS `--radius` — 16px, the
    // prototype's own value and the shared `Button`'s default. Still a token,
    // never a hardcoded 16px, which is what the visual gate actually forbids.
    const html = renderToStaticMarkup(
      <StepActions canContinue onContinue={noop} onSkip={noop} />,
    );
    expect(html).toContain("h-12");
    expect(html).toContain("w-[22rem]");
    expect(html).toContain("rounded-lg");
    expect(html).not.toContain("rounded-md");
  });

  it("paints the ready CTA in ink, not in the dye", () => {
    /**
     * The prototype's `#2e2820` is this app's `--foreground`, so the ready
     * button is ink on cream rather than `--primary` indigo (PM 26/08/2026).
     * Tokens, not the prototype's hex — which is also the only reason the dark
     * theme inverts correctly, something a light-only prototype cannot say.
     * Contrast after the swap: 12.85:1 light, 13.82:1 dark.
     */
    const ready = renderToStaticMarkup(
      <StepActions canContinue onContinue={noop} onSkip={noop} />,
    );
    expect(ready).toContain("bg-foreground");
    expect(ready).toContain("text-background");
    expect(ready).not.toContain("bg-primary");

    // The blocked state keeps its sunken surface — it is not an action yet.
    const blocked = renderToStaticMarkup(
      <StepActions canContinue={false} onContinue={noop} onSkip={noop} />,
    );
    expect(blocked).not.toContain("bg-foreground");
  });
});
