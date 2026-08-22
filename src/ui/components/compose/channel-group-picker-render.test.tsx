import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChannelGroupPicker } from "./ChannelGroupPicker";
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
