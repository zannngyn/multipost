import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChannelGroupPicker } from "../ChannelGroupPicker";
import type { ChannelGroup } from "@/ui/schemas/channel-group.schema";
import type { Channel } from "@/ui/schemas/channel.schema";

/**
 * The /bulk channel list, asserted on real markup — the four mandatory states
 * plus the two rules this screen exists to get right: one row per Page, and a
 * Page named rather than numbered.
 *
 * `renderToStaticMarkup`, like `calendar-render.test.tsx`: the repo runs vitest
 * in `environment: "node"` with no jsdom, and the regressions that matter here
 * (a duplicated checkbox, a raw id, a disabled Page silently offered) are all
 * visible in the server-rendered HTML.
 */

function channel(overrides: Partial<Channel> = {}): Channel {
  return {
    channelId: "fb-1121597217877301",
    platform: "facebook",
    name: "Lady Fashion",
    externalId: "1121597217877301",
    status: "active",
    tokenExpiresAt: null,
    ...overrides,
  };
}

function group(overrides: Partial<ChannelGroup> = {}): ChannelGroup {
  return {
    id: "grp-1",
    name: "Nhóm sáng",
    channelIds: ["fb-a"],
    channelCount: 1,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function render(props: {
  groups: ChannelGroup[];
  channels?: Channel[];
  selected?: Set<string>;
  loading?: boolean;
  error?: unknown;
}): string {
  return renderToStaticMarkup(
    <ChannelGroupPicker
      groups={props.groups}
      channels={props.channels}
      selected={props.selected ?? new Set<string>()}
      onToggleChannel={() => {}}
      onToggleGroup={() => {}}
      loading={props.loading ?? false}
      error={props.error}
      onRetry={() => {}}
    />,
  );
}

describe("ChannelGroupPicker states", () => {
  // --- The three non-data states first --------------------------------------
  it("loading: draws a skeleton and no checkbox", () => {
    const html = render({ groups: [], loading: true });
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain('type="checkbox"');
  });

  it("error: shows the retry notice instead of a list", () => {
    const html = render({ groups: [], error: new Error("boom") });
    expect(html).not.toContain('type="checkbox"');
    expect(html).toContain("Thử lại");
  });

  it("empty: no group at all points at where groups are made", () => {
    const html = render({ groups: [] });
    expect(html).toContain("Chưa có nhóm kênh nào");
  });

  it("empty: groups that hold no Page say so instead of drawing a blank box", () => {
    const html = render({ groups: [group({ channelIds: [] })] });
    expect(html).toContain("Các nhóm kênh hiện chưa có Page nào");
  });
});

describe("ChannelGroupPicker data", () => {
  it("names the Page and keeps the id as the secondary line", () => {
    const html = render({
      groups: [group({ channelIds: ["fb-1121597217877301"] })],
      channels: [channel()],
    });
    expect(html).toContain("Lady Fashion");
    // Full id still reachable (title + sr-only) even though it is shortened.
    expect(html).toContain('title="fb-1121597217877301"');
  });

  it("shows a Page in TWO groups exactly once, naming both groups", () => {
    const html = render({
      groups: [
        group({ id: "g1", name: "Nhóm sáng", channelIds: ["fb-a"] }),
        group({ id: "g2", name: "Nhóm chiều", channelIds: ["fb-a"] }),
      ],
      channels: [channel({ channelId: "fb-a", name: "Lady Fashion" })],
    });
    // Two group shortcuts + ONE Page row = three checkboxes, not four.
    expect(html.match(/type="checkbox"/g)).toHaveLength(3);
    expect(html).toContain("Thuộc nhóm: Nhóm sáng · Nhóm chiều");
  });

  it("lists a switched-off Page but refuses to offer it", () => {
    const html = render({
      groups: [group({ channelIds: ["fb-a"] })],
      channels: [channel({ channelId: "fb-a", name: "Lady Fashion", status: "disabled" })],
    });
    expect(html).toContain("Lady Fashion");
    expect(html).toContain("Kênh đang tắt");
    expect(html).toContain("disabled=");
  });

  it("keeps every row tickable when the Page list could not be loaded", () => {
    const html = render({ groups: [group({ channelIds: ["fb-a"] })], channels: undefined });
    expect(html).not.toContain("disabled=");
    expect(html).not.toContain("đã gỡ");
  });
});

/**
 * The group shortcut.
 *
 * WHAT IS TESTED WHERE: the ids a press hands over are decided by
 * `groupToggleViews` and asserted directly in `channel-option-labels.test.ts`
 * ("NEVER offers a switched-off or removed Page to the group toggle") — that
 * value is what this component passes straight to `onToggleGroup`, and firing a
 * real click would need a DOM the repo does not have. What the markup CAN prove
 * is the rest of the contract: the counter, and a shortcut that has nothing to
 * offer being off rather than lying. The join between the two — that the
 * component hands over THAT value and not a wider one — is locked below.
 */
describe("ChannelGroupPicker group shortcut", () => {
  it("counts the ROWS of the list, not the raw stored ids", () => {
    const html = render({
      // Stored: 3 entries — one duplicate and one blank. The list shows 2 rows.
      groups: [group({ channelIds: ["fb-a", "fb-a", "  ", "fb-b"] })],
      channels: [
        channel({ channelId: "fb-a", name: "Lady Fashion" }),
        channel({ channelId: "fb-b", name: "My Shop" }),
      ],
      selected: new Set(["fb-a"]),
    });
    expect(html).toContain("1/2");
    expect(html).not.toContain("1/4");
  });

  it("says how many rows of a group can never be ticked", () => {
    const html = render({
      groups: [group({ channelIds: ["fb-a", "fb-off"] })],
      channels: [
        channel({ channelId: "fb-a", name: "Lady Fashion" }),
        channel({ channelId: "fb-off", name: "My Shop", status: "disabled" }),
      ],
    });
    expect(html).toContain("0/2");
    expect(html).toContain("1 không đăng được");
  });

  it("switches the shortcut off — never '0/1' — when a group holds no row", () => {
    // A second, healthy group is needed for the shortcut row to exist at all:
    // with only the broken one the whole picker is in its empty state.
    const html = render({
      groups: [
        group({ id: "g1", name: "Nhóm rỗng", channelIds: ["  "] }),
        group({ id: "g2", name: "Nhóm sáng", channelIds: ["fb-a"] }),
      ],
      channels: [channel({ channelId: "fb-a", name: "Lady Fashion" })],
    });

    // The broken group's OWN label: a fraction there would be counting an id
    // that is not on screen and can never be ticked.
    const brokenLabel = html.slice(html.indexOf("Nhóm rỗng"));
    const ownLabel = brokenLabel.slice(0, brokenLabel.indexOf("</label>"));
    expect(ownLabel).toContain("(chưa có Page)");
    expect(ownLabel).not.toMatch(/\d+\/\d+/);
    // The healthy group next to it still counts normally.
    expect(html).toContain("0/1");
  });

  it("switches the shortcut off when every row of the group is blocked", () => {
    // A shortcut that can only ever add nothing must not look pressable.
    const html = render({
      groups: [group({ name: "Nhóm sáng", channelIds: ["fb-off"] })],
      channels: [channel({ channelId: "fb-off", name: "My Shop", status: "disabled" })],
    });
    expect(html).toContain("1 không đăng được");
    expect(html.match(/disabled=""/g)?.length).toBe(2);
  });
});

/**
 * THE JOIN between the pure rule and the component that obeys it.
 *
 * The helper decides which ids a group press may add, and its own tests lock
 * that decision. The markup tests lock what the row says. Neither can see the
 * one line in between: `onChange` could hand `toggle.rowIds` — blocked Pages
 * included — over to the parent and every other test in this file would still
 * be green, because the value only exists inside a click this environment
 * cannot fire (`vitest.config.ts` runs `environment: "node"`, no jsdom; see
 * `read-only-sweep.test.ts` for the same structural answer to the same limit).
 *
 * So the call site is asserted as source. Coarse enough to survive an honest
 * rename of the callback, exact about the one thing that must not drift.
 */
describe("ChannelGroupPicker ↔ groupToggleViews wiring", () => {
  const SOURCE = readFileSync(
    fileURLToPath(new URL("../ChannelGroupPicker.tsx", import.meta.url)),
    "utf8",
  );

  /** First argument of every `onToggleGroup(…)` call in the component. */
  function groupToggleArguments(): string[] {
    return [...SOURCE.matchAll(/onToggleGroup\(\s*([^,)]+)/g)].map((match) => match[1].trim());
  }

  it("hands the parent ONLY the ids a press may legally tick", () => {
    // `rowIds` is the denominator of the counter and includes rows that can
    // never be ticked; handing it over is the exact bug T1 closed — those ids
    // reached `run.start` and came back blocked, one code at a time.
    expect(groupToggleArguments()).toEqual(["toggle.selectableIds"]);
  });

  it("keys each shortcut on the guarded group id", () => {
    // `groupToggleViews` invents a positional id when the payload has none;
    // keying on `group.id` again here would put the collision straight back.
    expect(SOURCE).toContain("key={toggle.groupId}");
  });

  it("switches a shortcut off from the same set it would hand over", () => {
    // Enabled by one set and acting on another is how a press comes to add
    // nothing while still looking pressable.
    expect(SOURCE).toContain("toggle.selectableIds.length === 0");
  });
});
