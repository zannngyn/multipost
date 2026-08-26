import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SELLER_KINDS, TOOL_KINDS } from "@/ui/schemas/onboarding-profile.schema";

import { StepSeller } from "./StepSeller";
import { StepTools } from "./StepTools";

/**
 * `renderToStaticMarkup`, not testing-library: vitest runs `environment: "node"`
 * and the repo has no jsdom. Both screens take their answer and their handlers
 * as props, so neither needs a router or a DOM to render.
 *
 * THE CODES ARE ASSERTED AGAINST THE SCHEMA, not against a copy written here.
 * `onboarding-profile.schema.ts` is the mirror the API route validates against;
 * a screen that offers a seventh option, or spells one differently, would send
 * an answer the route rejects. Comparing the rendered `value=` attributes to
 * `SELLER_KINDS`/`TOOL_KINDS` in order is what makes that a red test rather
 * than a 400 in production.
 */

const noop = () => {};

/**
 * Every `value="…"` of a radio or checkbox, in the order it was rendered.
 *
 * Tag first, attributes second: React does not emit attributes in the order
 * they were written (it moves `checked` ahead of `value`), so a single regex
 * spanning several attributes silently matches nothing on the chosen card.
 */
function inputValues(html: string): string[] {
  return [...html.matchAll(/<input\b[^>]*>/g)]
    .map((match) => match[0])
    .filter((tag) => /type="(?:radio|checkbox)"/.test(tag))
    .map((tag) => /value="([^"]*)"/.exec(tag)?.[1] ?? "");
}

describe("StepSeller — bước 1, một lựa chọn", () => {
  it("offers exactly the codes the API accepts, in schema order", () => {
    const html = renderToStaticMarkup(
      <StepSeller value={null} onChange={noop} onContinue={noop} onSkip={noop} />,
    );
    expect(inputValues(html)).toEqual([...SELLER_KINDS]);
  });

  it("renders the Vietnamese wording of spec section 6", () => {
    const html = renderToStaticMarkup(
      <StepSeller value={null} onChange={noop} onContinue={noop} onSkip={noop} />,
    );
    for (const label of [
      "Bán lẻ cá nhân",
      "Chủ shop nhỏ",
      "Trong đội marketing",
      "Cộng tác viên/freelancer",
      "Agency",
      "Khác",
    ]) {
      expect(html).toContain(label);
    }
    // The question is the screen's own <h1> — the frame moves focus to it.
    expect(html).toContain("Bạn đang bán hàng kiểu nào?");
    expect(html).toContain("<h1");
    expect(html).toContain('tabindex="-1"');
  });

  it("is one answer at a time, and says so in markup rather than in prose", () => {
    const html = renderToStaticMarkup(
      <StepSeller value="shop_owner" onChange={noop} onContinue={noop} onSkip={noop} />,
    );
    expect(html).toContain('role="radiogroup"');
    expect(html.match(/type="radio"/g)).toHaveLength(SELLER_KINDS.length);
    expect(html).not.toContain('type="checkbox"');
    // Exactly one card is chosen, whatever else is on screen.
    expect(html.match(/checked=""/g)).toHaveLength(1);
  });

  it("keeps the way forward shut until an answer exists", () => {
    const blank = renderToStaticMarkup(
      <StepSeller value={null} onChange={noop} onContinue={noop} onSkip={noop} />,
    );
    const answered = renderToStaticMarkup(
      <StepSeller value="agency" onChange={noop} onContinue={noop} onSkip={noop} />,
    );

    expect(blank).toContain('disabled=""');
    expect(blank).toContain("Chọn một mục để tiếp tục");
    // "Bỏ qua" is never shut: skipping is an answer too (spec section 7.2).
    expect(blank).toContain("Bỏ qua");
    expect(blank.match(/disabled=""/g)).toHaveLength(1);

    expect(answered).not.toContain('disabled=""');
    expect(answered).toContain("Tiếp tục");
  });
});

describe("StepTools — bước 2, nhiều lựa chọn", () => {
  it("offers exactly the codes the API accepts, in schema order", () => {
    const html = renderToStaticMarkup(
      <StepTools values={[]} onToggle={noop} onContinue={noop} onSkip={noop} />,
    );
    expect(inputValues(html)).toEqual([...TOOL_KINDS]);
  });

  it("renders the Vietnamese wording of spec section 6", () => {
    const html = renderToStaticMarkup(
      <StepTools values={[]} onToggle={noop} onContinue={noop} onSkip={noop} />,
    );
    for (const label of [
      "Tự đăng tay trên Facebook",
      "Meta Business Suite",
      "Công cụ quản lý mạng xã hội",
      "Công cụ chuyên một nền tảng",
      "Nền tảng AI",
      "Khác",
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("Bạn đang đăng bài bằng gì?");
  });

  it("is several answers at once, never a radio group", () => {
    const html = renderToStaticMarkup(
      <StepTools
        values={["manual_facebook", "ai_platform"]}
        onToggle={noop}
        onContinue={noop}
        onSkip={noop}
      />,
    );
    expect(html.match(/type="checkbox"/g)).toHaveLength(TOOL_KINDS.length);
    expect(html).not.toContain('type="radio"');
    expect(html).not.toContain('role="radiogroup"');
    expect(html.match(/checked=""/g)).toHaveLength(2);
  });

  it("puts each second line inside the card it explains, and nowhere else", () => {
    const html = renderToStaticMarkup(
      <StepTools values={[]} onToggle={noop} onContinue={noop} onSkip={noop} />,
    );

    // Only the two choices spec section 6 gives an example for carry one.
    expect(html).toContain("vd: Hootsuite, Later");
    expect(html).toContain("ChatGPT/Claude…");

    // A hint that renders after the NEXT choice's label belongs to the wrong
    // card — the failure mode of a hint hoisted out of its own <label>.
    const hintAt = html.indexOf("vd: Hootsuite, Later");
    const ownerAt = html.indexOf("Công cụ quản lý mạng xã hội");
    const nextAt = html.indexOf("Công cụ chuyên một nền tảng");
    expect(ownerAt).toBeGreaterThan(-1);
    expect(hintAt).toBeGreaterThan(ownerAt);
    expect(hintAt).toBeLessThan(nextAt);

    // 12px, measured (spec section 5.2).
    expect(html).toContain("text-xs");
  });

  it("keeps the way forward shut until at least one box is ticked", () => {
    const blank = renderToStaticMarkup(
      <StepTools values={[]} onToggle={noop} onContinue={noop} onSkip={noop} />,
    );
    const answered = renderToStaticMarkup(
      <StepTools values={["meta_business_suite"]} onToggle={noop} onContinue={noop} onSkip={noop} />,
    );

    expect(blank).toContain('disabled=""');
    expect(blank).toContain("Chọn một mục để tiếp tục");
    expect(answered).not.toContain('disabled=""');
    expect(answered).toContain("Tiếp tục");
  });
});
