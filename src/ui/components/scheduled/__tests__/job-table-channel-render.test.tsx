import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ScheduledJobTable } from "../ScheduledJobTable";
import { channelLabelIndex } from "@/ui/components/channels/channel-option-labels";
import type { Channel } from "@/ui/schemas/channel.schema";
import type { ScheduledJobEntry } from "@/ui/schemas/scheduled.schema";

/**
 * The "Kênh" column of the schedule, asserted on real markup.
 *
 * Same reasoning as `calendar-render.test.tsx`: vitest runs in `environment:
 * "node"`, and everything worth guarding here — the Page name, the id kept for
 * support, the "(đã gỡ)" that must NOT appear while the channel list is merely
 * loading — is visible in server-rendered HTML.
 */

const NOW = new Date(2026, 7, 13, 10, 0).getTime();

function entry(overrides: Partial<ScheduledJobEntry> = {}): ScheduledJobEntry {
  return {
    postJobId: "job-1",
    batchId: "batch-1",
    productCode: "MGKVX6310",
    color: "Tím",
    channelId: "fb-1121597217877301",
    format: "image_post",
    status: "queued",
    scheduledAt: new Date(2026, 7, 13, 20, 0).toISOString(),
    startsInMs: 3_600_000,
    overdue: false,
    captionPreview: "Váy hoa mùa hè…",
    mediaCount: 3,
    userMessage: "Chờ tới giờ đăng.",
    canReschedule: true,
    canCancel: true,
    createdAt: new Date(2026, 7, 12, 9, 0).toISOString(),
    ...overrides,
  };
}

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

function render(
  items: ScheduledJobEntry[],
  channels: Channel[] | undefined,
  readOnlyReason: string | null = null,
): string {
  return renderToStaticMarkup(
    <ScheduledJobTable
      items={items}
      headingId="day-heading"
      nowMs={NOW}
      hrefFor={(action, postJobId) => `/posts?${action}=${postJobId}`}
      busyJobId={null}
      readOnlyReason={readOnlyReason}
      channelLabels={channelLabelIndex(
        items.map((item) => item.channelId),
        channels,
      )}
    />,
  );
}

const OTHER: Channel = channel({ channelId: "fb-2", name: "Lady Outlet", externalId: "2" });

describe("ScheduledJobTable channel column", () => {
  // --- Edge cases first ------------------------------------------------------
  it("accuses nothing while the channel list is still unknown", () => {
    const html = render([entry()], undefined);
    expect(html).not.toContain("đã gỡ");
    expect(html).toContain('title="fb-1121597217877301"');
  });

  it("says a Page is gone when the list is known and does not hold it", () => {
    const html = render([entry()], []);
    expect(html).toContain("(đã gỡ)");
  });

  it("names the Page and keeps the id underneath for support", () => {
    const html = render([entry()], [channel()]);
    expect(html).toContain("Lady Fashion");
    expect(html).toContain('title="fb-1121597217877301"');
  });

  it("names the Page in the action's accessible name, not the id", () => {
    const html = render([entry()], [channel()]);
    expect(html).toContain("bài MGKVX6310 trên kênh Lady Fashion");
  });
});

/**
 * The fold (wave 2, spec §3.2). The RULE is tested in
 * `posts/job-row-grouping.test.ts`; this checks it reaches the markup and that
 * a folded row never keeps a per-job action it cannot honour.
 */
describe("ScheduledJobTable folding", () => {
  function countRows(html: string): number {
    return (html.match(/<tr class="border-t align-top">/g) ?? []).length;
  }

  it("leaves a single row alone — no disclosure, actions still on the row", () => {
    const html = render([entry()], [channel()]);
    expect(countRows(html)).toBe(1);
    expect(html).not.toContain('aria-expanded="');
    expect(html).toContain("Đổi giờ");
  });

  it("does NOT fold two posts of one code that carry different captions", () => {
    const html = render(
      [entry(), entry({ postJobId: "job-2", channelId: "fb-2", captionPreview: "Khác…" })],
      [channel(), OTHER],
    );
    expect(countRows(html)).toBe(2);
  });

  it('folds one post fanned out to three Pages into "× 3 kênh"', () => {
    const html = render(
      [
        entry(),
        entry({ postJobId: "job-2", channelId: "fb-2" }),
        entry({ postJobId: "job-3", channelId: "fb-3" }),
      ],
      [channel(), OTHER],
    );
    expect(countRows(html)).toBe(1);
    expect(html).toContain("× 3 kênh");
    expect(html).toContain('aria-controls="scheduled-fold-job-1"');
  });

  it("moves Đổi giờ / Huỷ into the panel and says so on the folded row", () => {
    const html = render(
      [entry(), entry({ postJobId: "job-2", channelId: "fb-2" })],
      [channel(), OTHER],
    );
    expect(html).toContain("Mở danh sách kênh để đổi giờ hoặc huỷ từng kênh");
    // Both channels keep their own action inside the (hidden) panel.
    expect(html).toContain("bài MGKVX6310 trên kênh Lady Fashion");
    expect(html).toContain("bài MGKVX6310 trên kênh Lady Outlet");
  });

  it("calls the folded hour the soonest one when publish spacing staggered them", () => {
    const html = render(
      [
        entry(),
        entry({
          postJobId: "job-2",
          channelId: "fb-2",
          scheduledAt: new Date(2026, 7, 13, 20, 5).toISOString(),
        }),
      ],
      [channel(), OTHER],
    );
    expect(html).toContain("sớm nhất");
  });

  it("does NOT say 'sớm nhất' when the gap is milliseconds — the cell shows 20:00 twice", () => {
    const html = render(
      [
        entry(),
        entry({
          postJobId: "job-2",
          channelId: "fb-2",
          scheduledAt: new Date(2026, 7, 13, 20, 0, 0, 41).toISOString(),
        }),
      ],
      [channel(), OTHER],
    );
    expect(html).not.toContain("sớm nhất");
  });

  it("does not promise buttons the panel has none of once the whole group is past its hour", () => {
    const past = { overdue: true, canReschedule: false, canCancel: false } as const;
    const html = render(
      [entry(past), entry({ postJobId: "job-2", channelId: "fb-2", ...past })],
      [channel(), OTHER],
    );
    expect(html).not.toContain("Mở danh sách kênh để");
    expect(html).toContain("Đã tới giờ — không sửa được nữa");
  });

  it("offers only Huỷ when Facebook is holding every channel of the group", () => {
    const held = { status: "scheduled_on_facebook", canReschedule: false } as const;
    const html = render(
      [entry(held), entry({ postJobId: "job-2", channelId: "fb-2", ...held })],
      [channel(), OTHER],
    );
    expect(html).toContain("Mở danh sách kênh để huỷ từng kênh");
  });
});

/**
 * Support mode (M3.3). The read-only reason replaces the row's OWN reason
 * slot — it must never be paraphrased as "Đã tới giờ", which blames the clock
 * for something the session did.
 */
describe("ScheduledJobTable in a read-only support session", () => {
  const READ_ONLY = "Phiên hỗ trợ chỉ đọc";

  it("gives the read-only reason on a row that has NOT passed its hour", () => {
    const html = render([entry()], [channel()], READ_ONLY);
    expect(html).not.toContain("Đã tới giờ — không sửa được nữa");
    expect(html).toContain(READ_ONLY);
  });

  it("gives the same reason on a FOLDED row, not a list of buttons it disabled", () => {
    const html = render(
      [entry(), entry({ postJobId: "job-2", channelId: "fb-2" })],
      [channel(), OTHER],
      READ_ONLY,
    );
    expect(html).not.toContain("Đã tới giờ — không sửa được nữa");
    expect(html).not.toContain("Mở danh sách kênh để");
    expect(html).toContain(READ_ONLY);
  });
});

describe("ScheduledJobTable colour column", () => {
  it("shows the colour as a dyed chip, name included", () => {
    const html = render([entry({ color: "Tím" })], [channel()]);
    expect(html).toContain("background:#9B7BC4");
    expect(html).toContain("Tím");
  });
});
