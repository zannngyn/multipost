import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ScheduledJobTable } from "./ScheduledJobTable";
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

function render(items: ScheduledJobEntry[], channels: Channel[] | undefined): string {
  return renderToStaticMarkup(
    <ScheduledJobTable
      items={items}
      headingId="day-heading"
      nowMs={NOW}
      hrefFor={(action, postJobId) => `/posts?${action}=${postJobId}`}
      busyJobId={null}
      channelLabels={channelLabelIndex(
        items.map((item) => item.channelId),
        channels,
      )}
    />,
  );
}

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
