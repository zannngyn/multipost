import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { JobLogTable } from "./JobLogTable";
import type { Channel } from "@/ui/schemas/channel.schema";
import type { PostJobLogEntry } from "@/ui/schemas/post-batch.schema";

/**
 * The fold, asserted on real markup (spec §3.2).
 *
 * `job-row-grouping.test.ts` owns the RULE; this owns the fact that the rule
 * reaches the screen — the folded label, the disclosure that can reopen it, and
 * the two things a folded row must never claim: one channel's permalink and one
 * channel's "Chạy lại".
 *
 * Same reasoning as `job-table-channel-render.test.tsx`: vitest runs in
 * `environment: "node"`, and everything asserted here is in the server-rendered
 * HTML — the panel is rendered `hidden`, not unmounted.
 */

function entry(overrides: Partial<PostJobLogEntry> = {}): PostJobLogEntry {
  return {
    postJobId: "job-1",
    batchId: "batch-1",
    productCode: "MGKVX6310",
    color: "Tím",
    channelId: "fb-1",
    format: "image_post",
    status: "failed",
    attemptCount: 2,
    lastErrorCode: "FB_RATE_LIMIT",
    userMessage: "Facebook đang giới hạn tần suất.",
    publishedPostId: null,
    publishedUrl: null,
    publishedAt: null,
    scheduledAt: null,
    createdAt: new Date(2026, 7, 13, 9, 0).toISOString(),
    updatedAt: new Date(2026, 7, 13, 10, 0).toISOString(),
    canRetry: true,
    ...overrides,
  };
}

const CHANNELS: Channel[] = [
  {
    channelId: "fb-1",
    platform: "facebook",
    name: "Lady Fashion",
    externalId: "1",
    status: "active",
    tokenExpiresAt: null,
  },
  {
    channelId: "fb-2",
    platform: "facebook",
    name: "Lady Outlet",
    externalId: "2",
    status: "active",
    tokenExpiresAt: null,
  },
];

function render(items: PostJobLogEntry[]): string {
  return renderToStaticMarkup(
    <JobLogTable items={items} onRetry={() => {}} retryingJobId={null} channels={CHANNELS} />,
  );
}

/** How many data rows the markup carries, folded panels excluded. */
function countRows(html: string): number {
  return (html.match(/<tr class="border-t align-top">/g) ?? []).length;
}

describe("JobLogTable folding", () => {
  // --- Edge cases first ------------------------------------------------------
  it("leaves a single row exactly as it was — no fold, no disclosure", () => {
    const html = render([entry()]);
    expect(countRows(html)).toBe(1);
    // The attribute, not the `aria-expanded:` variant inside a button's class.
    expect(html).not.toContain('aria-expanded="');
    expect(html).toContain("Lady Fashion");
  });

  it("keeps two jobs of one code apart when they failed differently", () => {
    const html = render([
      entry(),
      entry({ postJobId: "job-2", channelId: "fb-2", lastErrorCode: "FB_TOKEN_EXPIRED" }),
    ]);
    expect(countRows(html)).toBe(2);
    expect(html).not.toContain("× 2 kênh");
  });

  it("never offers one channel's permalink from a folded row", () => {
    const html = render([
      entry({ status: "published", canRetry: false, publishedUrl: "https://facebook.com/a" }),
      entry({
        postJobId: "job-2",
        channelId: "fb-2",
        status: "published",
        canRetry: false,
        publishedUrl: "https://facebook.com/b",
      }),
    ]);
    // Both links exist — inside the panel, one per channel — and neither is on
    // the summary row itself.
    expect(html).toContain("https://facebook.com/a");
    expect(html).toContain("https://facebook.com/b");
    expect(countRows(html)).toBe(1);
  });

  // --- The fold itself -------------------------------------------------------
  it('folds five channels of one failure into "× 5 kênh" with a disclosure', () => {
    const html = render(
      [1, 2, 3, 4, 5].map((n) =>
        entry({ postJobId: `job-${n}`, channelId: n === 1 ? "fb-1" : `fb-${n}` }),
      ),
    );
    expect(countRows(html)).toBe(1);
    expect(html).toContain("MGKVX6310");
    expect(html).toContain("× 5 kênh");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("5 kênh");
  });

  it("keeps the panel in the markup but hidden, so aria-controls points at it", () => {
    const html = render([entry(), entry({ postJobId: "job-2", channelId: "fb-2" })]);
    expect(html).toContain('aria-controls="job-fold-job-1"');
    expect(html).toContain('id="job-fold-job-1"');
    expect(html).toContain("hidden=");
  });

  it("names every folded channel inside the panel, not just the head", () => {
    const html = render([entry(), entry({ postJobId: "job-2", channelId: "fb-2" })]);
    expect(html).toContain("Lady Fashion");
    expect(html).toContain("Lady Outlet");
  });

  it("says where the retry buttons went instead of acting on one of five", () => {
    const html = render([entry(), entry({ postJobId: "job-2", channelId: "fb-2" })]);
    expect(html).toContain("Mở danh sách kênh để chạy lại");
  });

  it("marks the folded hour as the most recent one when the members disagree", () => {
    const html = render([
      entry(),
      entry({
        postJobId: "job-2",
        channelId: "fb-2",
        updatedAt: new Date(2026, 7, 13, 9, 55).toISOString(),
      }),
    ]);
    expect(html).toContain("mới nhất");
  });

  it("draws the colour dot next to the colour NAME, never instead of it", () => {
    const html = render([entry({ color: "Đen" })]);
    expect(html).toContain("Đen");
    expect(html).toContain("background:#221F1C");
  });

  it("prints an unknown colour as plain text rather than inventing a shade", () => {
    const html = render([entry({ color: "MÀU LẠ 99" })]);
    expect(html).toContain("MÀU LẠ 99");
    expect(html).not.toContain("background:#");
  });
});
