import { describe, expect, it, vi } from "vitest";

import { ChannelTileGroup } from "../ChannelTile";
import { CheckOptionCardGroup } from "../CheckOptionCard";
import { activateCardOnEnter, OptionCardGroup } from "../OptionCard";

/**
 * THE KEYBOARD, EXERCISED RATHER THAN INSPECTED.
 *
 * vitest runs `environment: "node"` and the repo has no jsdom, so the other
 * suites here assert on `renderToStaticMarkup` output. That cannot reach an
 * event handler — which is exactly how the first attempt at Enter shipped with
 * no test at all: deleting every `onKeyDown` left the whole suite green.
 *
 * These call the group components as PLAIN FUNCTIONS and walk the React
 * elements they return. A React element is an ordinary object (`type`, `props`),
 * so the handler can be pulled off the input's props and invoked with a stub
 * event. No DOM, no dependency, and deleting the handler makes it fail because
 * `onKeyDown` is then `undefined`.
 *
 * None of the three groups uses a hook, which is what makes calling them
 * directly legitimate rather than a trick.
 */

interface ElementLike {
  type?: unknown;
  props?: Record<string, unknown>;
}

/** Every `<input>` in a rendered tree, in render order. */
function findInputs(node: unknown): Record<string, unknown>[] {
  if (Array.isArray(node)) return node.flatMap(findInputs);
  if (node === null || typeof node !== "object") return [];

  const element = node as ElementLike;
  const props = element.props ?? {};
  const fromChildren = findInputs(props.children);

  return element.type === "input" ? [props, ...fromChildren] : fromChildren;
}

function keyEvent(key: string) {
  return { key, preventDefault: vi.fn() };
}

const SELLER_CHOICES = [
  { value: "solo_seller", label: "Bán lẻ cá nhân", emoji: "👋" },
  { value: "shop_owner", label: "Chủ shop nhỏ", emoji: "💪" },
];

const TOOL_CHOICES = [
  { value: "manual_facebook", label: "Tự đăng tay trên Facebook", emoji: "💻" },
  { value: "ai_platform", label: "Nền tảng AI", emoji: "🤖" },
];

describe("activateCardOnEnter", () => {
  it("activates on Enter, and stops the browser doing anything else with it", () => {
    const activate = vi.fn();
    const event = keyEvent("Enter");

    activateCardOnEnter(event, activate);

    expect(activate).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it("LEAVES SPACE ALONE — the browser already toggles on it", () => {
    // The bug this forbids: `preventDefault` on Space would swallow the one key
    // that always worked, trading a missing shortcut for a broken control.
    const activate = vi.fn();
    const event = keyEvent(" ");

    activateCardOnEnter(event, activate);

    expect(activate).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("leaves the arrows and Tab alone, which move focus inside the group", () => {
    for (const key of ["ArrowDown", "ArrowUp", "Tab", "Escape", "a"]) {
      const activate = vi.fn();
      const event = keyEvent(key);

      activateCardOnEnter(event, activate);

      expect(activate, `${key} must not activate`).not.toHaveBeenCalled();
      expect(
        event.preventDefault,
        `${key} must not be swallowed`,
      ).not.toHaveBeenCalled();
    }
  });
});

describe("Enter on a card — dạng A/C, one answer", () => {
  it("chooses the card that has focus", () => {
    const onChange = vi.fn();
    const tree = OptionCardGroup({
      name: "seller",
      legend: "Bạn đang bán hàng kiểu nào?",
      choices: SELLER_CHOICES,
      value: null,
      onChange,
    });

    const inputs = findInputs(tree);
    expect(inputs).toHaveLength(SELLER_CHOICES.length);

    const onKeyDown = inputs[1]?.onKeyDown as
      ((event: unknown) => void) | undefined;
    expect(onKeyDown, "the radio carries no Enter handler").toBeTypeOf(
      "function",
    );

    onKeyDown?.(keyEvent("Enter"));
    expect(onChange).toHaveBeenCalledWith("shop_owner");
  });

  it("does not fire on Space, which the radio itself handles", () => {
    const onChange = vi.fn();
    const tree = OptionCardGroup({
      name: "seller",
      legend: "Bạn đang bán hàng kiểu nào?",
      choices: SELLER_CHOICES,
      value: null,
      onChange,
    });

    const onKeyDown = findInputs(tree)[0]?.onKeyDown as
      ((event: unknown) => void) | undefined;
    onKeyDown?.(keyEvent(" "));

    // Not "chose nothing" by accident — the browser's own Space still fires
    // `onChange` through the input. This asserts we did not fire it a SECOND
    // time, which would be a double write on every Space press.
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("Enter on a card — dạng B, several answers", () => {
  it("ticks an unticked box", () => {
    const onToggle = vi.fn();
    const tree = CheckOptionCardGroup({
      name: "tools",
      legend: "Bạn đang đăng bài bằng gì?",
      choices: TOOL_CHOICES,
      values: [],
      onToggle,
    });

    const onKeyDown = findInputs(tree)[0]?.onKeyDown as
      ((event: unknown) => void) | undefined;
    expect(onKeyDown, "the checkbox carries no Enter handler").toBeTypeOf(
      "function",
    );

    onKeyDown?.(keyEvent("Enter"));
    expect(onToggle).toHaveBeenCalledWith("manual_facebook", true);
  });

  it("UNTICKS a ticked one — Enter toggles, it does not only turn on", () => {
    // The direction a hardcoded `true` would get wrong, and the reason the
    // handler reads `!isSelected` rather than a constant.
    const onToggle = vi.fn();
    const tree = CheckOptionCardGroup({
      name: "tools",
      legend: "Bạn đang đăng bài bằng gì?",
      choices: TOOL_CHOICES,
      values: ["manual_facebook"],
      onToggle,
    });

    const onKeyDown = findInputs(tree)[0]?.onKeyDown as
      ((event: unknown) => void) | undefined;
    onKeyDown?.(keyEvent("Enter"));

    expect(onToggle).toHaveBeenCalledWith("manual_facebook", false);
  });
});

describe("Enter on a card — dạng D, channel tiles", () => {
  it("toggles both ways, same as dạng B", () => {
    const onToggle = vi.fn();
    const ticked = ChannelTileGroup({
      name: "channels",
      legend: "Kênh nào bạn đang tập trung?",
      choices: [{ value: "facebook" as const }, { value: "tiktok" as const }],
      values: ["facebook"],
      onToggle,
    });

    const inputs = findInputs(ticked);
    const first = inputs[0]?.onKeyDown as
      ((event: unknown) => void) | undefined;
    const second = inputs[1]?.onKeyDown as
      ((event: unknown) => void) | undefined;
    expect(first, "the tile carries no Enter handler").toBeTypeOf("function");

    first?.(keyEvent("Enter"));
    expect(onToggle).toHaveBeenCalledWith("facebook", false);

    second?.(keyEvent("Enter"));
    expect(onToggle).toHaveBeenCalledWith("tiktok", true);
  });
});
