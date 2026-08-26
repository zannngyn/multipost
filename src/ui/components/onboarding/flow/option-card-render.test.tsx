import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CheckOptionCardGroup } from "./CheckOptionCard";
import { OptionCardGroup } from "./OptionCard";
import { StepActions } from "./StepActions";

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
  { value: "solo_seller", label: "Bán lẻ cá nhân", emoji: "👋", tone: "indigo" as const },
  { value: "shop_owner", label: "Chủ shop nhỏ", emoji: "💪", tone: "leaf" as const },
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
    expect(html.match(/sr-only/g)?.length ?? 0).toBeGreaterThanOrEqual(COUNT_CHOICES.length);
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
        <OptionCardGroup name="seller" legend="Câu hỏi" choices={[]} value={null} onChange={noop} />,
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

describe("StepActions", () => {
  it("disables the way forward until something is chosen, and says why", () => {
    const html = renderToStaticMarkup(
      <StepActions canContinue={false} onContinue={noop} onSkip={noop} />,
    );
    // The ATTRIBUTE, not the substring: the shared `Button` carries
    // `disabled:opacity-…` utility classes in every state, so a bare
    // `toContain("disabled")` would pass on an enabled button too.
    expect(html).toContain('disabled=""');
    // Spec section 7.1 plus the Buffer pattern in analysis 3.9: the label
    // CHANGES, it does not merely fade — a greyed "Tiếp tục" leaves the
    // operator guessing which of the two controls is the broken one.
    expect(html).toContain("Chọn một mục để tiếp tục");
    expect(html).not.toContain(">Tiếp tục<");
  });

  it("offers the way forward once something is chosen", () => {
    const html = renderToStaticMarkup(<StepActions canContinue onContinue={noop} onSkip={noop} />);
    expect(html).toContain("Tiếp tục");
    expect(html).not.toContain("Chọn một mục để tiếp tục");
    expect(html).not.toContain('disabled=""');
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
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });

  it("keeps the primary button at its measured size", () => {
    // 352x48, corners from the token rather than a hardcoded 12px (visual gate).
    const html = renderToStaticMarkup(<StepActions canContinue onContinue={noop} onSkip={noop} />);
    expect(html).toContain("h-12");
    expect(html).toContain("w-[22rem]");
    expect(html).toContain("rounded-md");
  });
});
