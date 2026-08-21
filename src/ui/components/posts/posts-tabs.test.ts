import { describe, expect, it } from "vitest";

import {
  DEFAULT_POSTS_TAB,
  parsePostsTab,
  resolveActiveTab,
  withTabParam,
} from "@/ui/components/posts/posts-tabs";
import { jobLogSearchParams } from "@/ui/schemas/post-batch.schema";
import { SCHEDULED_DIALOG_PARAMS, scheduledSearchParams } from "@/ui/schemas/scheduled.schema";

describe("parsePostsTab", () => {
  // Edge cases first: `?tab=` is untrusted input, and every one of these used
  // to be a URL an operator could hit by editing the address bar.
  it("falls back to the default tab for anything that is not a tab", () => {
    expect(parsePostsTab(undefined)).toBe(DEFAULT_POSTS_TAB);
    expect(parsePostsTab(null)).toBe(DEFAULT_POSTS_TAB);
    expect(parsePostsTab("")).toBe(DEFAULT_POSTS_TAB);
    expect(parsePostsTab("Log")).toBe(DEFAULT_POSTS_TAB);
    expect(parsePostsTab(["log", "scheduled"])).toBe(DEFAULT_POSTS_TAB);
    expect(parsePostsTab("__proto__")).toBe(DEFAULT_POSTS_TAB);
  });

  it("keeps the two real tabs", () => {
    expect(parsePostsTab("scheduled")).toBe("scheduled");
    expect(parsePostsTab("log")).toBe("log");
  });
});

describe("withTabParam", () => {
  // The regression it exists for: the log tab rewrites the query when a filter
  // changes, the rebuilt query has no `tab`, and the next server render sends
  // the operator back to the scheduled tab mid-filter.
  it("carries the tab in front of the screen's own query", () => {
    expect(withTabParam("status=failed", "log")).toBe("tab=log&status=failed");
    expect(withTabParam("?status=failed", "log")).toBe("tab=log&status=failed");
    expect(withTabParam("", "log")).toBe("tab=log");
  });

  it("leaves the query untouched when there is no tab to carry", () => {
    expect(withTabParam("status=failed", null)).toBe("status=failed");
    expect(withTabParam("status=failed", undefined)).toBe("status=failed");
    expect(withTabParam("status=failed", "")).toBe("status=failed");
    expect(withTabParam("status=failed", "   ")).toBe("status=failed");
    expect(withTabParam("", null)).toBe("");
  });

  it("keeps every other param, in order, exactly once", () => {
    expect(withTabParam("channelId=c1&month=2026-08&day=2026-08-21", "scheduled")).toBe(
      "tab=scheduled&channelId=c1&month=2026-08&day=2026-08-21",
    );
    // A stale `tab` inside the rebuilt query loses to the one the URL has now.
    expect(withTabParam("tab=scheduled&status=failed", "log")).toBe("tab=log&status=failed");
  });

  it("encodes a hostile tab instead of splicing it into the query", () => {
    expect(withTabParam("status=failed", "log&admin=1")).toBe("tab=log%26admin%3D1&status=failed");
  });
});

/**
 * The exact expression the two child screens run when they rewrite the URL,
 * composed here without React: their own schema builder, then `withTabParam`.
 * It is the shape of the bug the gate caught — `/posts?status=failed` with no
 * tab, which the next server render reads back as the scheduled tab.
 */
describe("the query a child screen writes while inside the hub", () => {
  it("keeps the log tab when the job log changes or clears its filter", () => {
    const filtered = jobLogSearchParams({ status: "failed", batchId: null }).toString();
    expect(withTabParam(filtered, "log")).toBe("tab=log&status=failed");
    expect(parsePostsTab(new URLSearchParams(withTabParam(filtered, "log")).get("tab"))).toBe("log");

    // "Xoá bộ lọc" rebuilds an EMPTY query — the tab still has to survive it.
    expect(withTabParam("", "log")).toBe("tab=log");
  });

  it("keeps the scheduled tab across filter, month and dialog writes", () => {
    const params = scheduledSearchParams(
      { channelId: "c1", from: null, to: null },
      { view: "calendar", month: "2026-08", day: "2026-08-21" },
    );
    params.set(SCHEDULED_DIALOG_PARAMS.reschedule, "job-9");
    const query = withTabParam(params.toString(), "scheduled");

    const read = new URLSearchParams(query);
    expect(read.get("tab")).toBe("scheduled");
    expect(read.get("channelId")).toBe("c1");
    expect(read.get(SCHEDULED_DIALOG_PARAMS.reschedule)).toBe("job-9");
  });
});

describe("resolveActiveTab", () => {
  it("uses the server's tab only while the URL has none", () => {
    expect(resolveActiveTab(null, "log")).toBe("log");
    expect(resolveActiveTab(null, "scheduled")).toBe("scheduled");
  });

  it("lets the URL win once it has a tab of its own", () => {
    expect(resolveActiveTab("log", "scheduled")).toBe("log");
    expect(resolveActiveTab("scheduled", "log")).toBe("scheduled");
  });

  it("falls back to the default tab for an empty or unknown ?tab=", () => {
    expect(resolveActiveTab("", "log")).toBe(DEFAULT_POSTS_TAB);
    expect(resolveActiveTab("bogus", "log")).toBe(DEFAULT_POSTS_TAB);
  });
});
