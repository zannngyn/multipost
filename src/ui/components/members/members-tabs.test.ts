import { describe, expect, it } from "vitest";

import {
  DEFAULT_MEMBERS_TAB,
  MEMBERS_TAB_PARAM,
  parseMembersTab,
  resolveActiveMembersTab,
} from "@/ui/components/members/members-tabs";
import { withTabParam } from "@/ui/components/posts/posts-tabs";
import { accessSearchParams } from "@/ui/schemas/access-request.schema";

describe("parseMembersTab", () => {
  // Edge cases first: `?tab=` is untrusted input, and every one of these used to
  // be a way to render a hub with no panel at all.
  it("falls back to the default tab for anything that is not a tab", () => {
    expect(parseMembersTab(undefined)).toBe(DEFAULT_MEMBERS_TAB);
    expect(parseMembersTab(null)).toBe(DEFAULT_MEMBERS_TAB);
    expect(parseMembersTab("")).toBe(DEFAULT_MEMBERS_TAB);
    expect(parseMembersTab("HISTORY")).toBe(DEFAULT_MEMBERS_TAB);
    expect(parseMembersTab("bogus")).toBe(DEFAULT_MEMBERS_TAB);
    // A repeated `?tab=a&tab=b` arrives as an array in a Server Component.
    expect(parseMembersTab(["history"])).toBe(DEFAULT_MEMBERS_TAB);
    expect(parseMembersTab({})).toBe(DEFAULT_MEMBERS_TAB);
  });

  it("keeps the three real tabs", () => {
    expect(parseMembersTab("members")).toBe("members");
    expect(parseMembersTab("invites")).toBe("invites");
    expect(parseMembersTab("history")).toBe("history");
  });

  it("opens on the member list by default", () => {
    expect(DEFAULT_MEMBERS_TAB).toBe("members");
  });
});

describe("resolveActiveMembersTab", () => {
  it("uses the server's tab only while the URL has none", () => {
    expect(resolveActiveMembersTab(null, "history")).toBe("history");
    expect(resolveActiveMembersTab(null, "invites")).toBe("invites");
  });

  it("lets the URL win once it has a tab of its own", () => {
    expect(resolveActiveMembersTab("history", "members")).toBe("history");
    expect(resolveActiveMembersTab("invites", "history")).toBe("invites");
  });

  it("falls back to the default tab for an empty or unknown ?tab=", () => {
    expect(resolveActiveMembersTab("", "history")).toBe(DEFAULT_MEMBERS_TAB);
    expect(resolveActiveMembersTab("bogus", "history")).toBe(DEFAULT_MEMBERS_TAB);
  });
});

/**
 * The exact expression `AccessRequestsScreen` runs when it rewrites the URL,
 * composed here without React: its own schema builder, then `withTabParam`.
 *
 * It is the shape of the bug this hub could have shipped — `/members?status=
 * approved` with no tab, which the next render reads back as the MEMBER LIST,
 * throwing the operator out of the history they were filtering.
 */
describe("the query the history panel writes while inside the hub", () => {
  it("keeps the history tab when the filter changes", () => {
    const filtered = accessSearchParams("approved").toString();
    expect(withTabParam(filtered, "history")).toBe("tab=history&status=approved");
    expect(
      parseMembersTab(new URLSearchParams(withTabParam(filtered, "history")).get(MEMBERS_TAB_PARAM)),
    ).toBe("history");
  });

  it("keeps the history tab when the filter returns to its default", () => {
    // "Chờ duyệt" is the default, so `accessSearchParams` builds an EMPTY query
    // — the tab still has to survive it, or the panel disappears mid-filter.
    const cleared = accessSearchParams("pending").toString();
    expect(cleared).toBe("");
    expect(withTabParam(cleared, "history")).toBe("tab=history");
  });

  it("replaces a stale tab the child may still be carrying", () => {
    expect(withTabParam("tab=members&status=blocked", "history")).toBe(
      "tab=history&status=blocked",
    );
  });
});
