import { describe, expect, it } from "vitest";

import {
  CHANNELS_TAB_PARAM,
  DEFAULT_CHANNELS_TAB,
  channelsHubQuery,
  parseChannelsTab,
  resolveActiveChannelsTab,
  withoutConnectParams,
} from "@/ui/components/channels/channels-tabs";
import { parseConnectOutcome } from "@/ui/schemas/channel.schema";

describe("parseChannelsTab", () => {
  // Edge cases first: `?tab=` is untrusted input, and every one of these used
  // to be a way to render a hub with no panel at all.
  it("falls back to the default tab for anything that is not a tab", () => {
    expect(parseChannelsTab(undefined)).toBe(DEFAULT_CHANNELS_TAB);
    expect(parseChannelsTab(null)).toBe(DEFAULT_CHANNELS_TAB);
    expect(parseChannelsTab("")).toBe(DEFAULT_CHANNELS_TAB);
    expect(parseChannelsTab("PAGES")).toBe(DEFAULT_CHANNELS_TAB);
    expect(parseChannelsTab("bogus")).toBe(DEFAULT_CHANNELS_TAB);
    // A repeated `?tab=a&tab=b` arrives as an array in a Server Component.
    expect(parseChannelsTab(["groups"])).toBe(DEFAULT_CHANNELS_TAB);
    expect(parseChannelsTab({})).toBe(DEFAULT_CHANNELS_TAB);
  });

  it("keeps the three real tabs", () => {
    expect(parseChannelsTab("pages")).toBe("pages");
    expect(parseChannelsTab("groups")).toBe("groups");
    expect(parseChannelsTab("connect")).toBe("connect");
  });

  it("opens on the connected Pages by default", () => {
    expect(DEFAULT_CHANNELS_TAB).toBe("pages");
  });
});

describe("resolveActiveChannelsTab", () => {
  it("uses the server's tab only while the URL has none", () => {
    expect(resolveActiveChannelsTab(null, "groups")).toBe("groups");
    expect(resolveActiveChannelsTab(null, "connect")).toBe("connect");
  });

  it("lets the URL win once it has a tab of its own", () => {
    expect(resolveActiveChannelsTab("groups", "pages")).toBe("groups");
    expect(resolveActiveChannelsTab("connect", "groups")).toBe("connect");
  });

  it("falls back to the default tab for an empty or unknown ?tab=", () => {
    expect(resolveActiveChannelsTab("", "groups")).toBe(DEFAULT_CHANNELS_TAB);
    expect(resolveActiveChannelsTab("bogus", "groups")).toBe(DEFAULT_CHANNELS_TAB);
  });
});

/**
 * Every query string `app/api/channels/callback/route.ts` can send the browser
 * back with. Copied from its four `redirect(...)` calls, values and all — the
 * success shape carries FIVE params, not one, and a wipe that only knew about
 * `connected` left `?new=1&skipped=3` stuck in the address bar for good.
 *
 * Change the route and this list is what has to change with it: every test
 * below reads from here, so an added param fails them instead of quietly
 * surviving the wipe.
 */
const CALLBACK_QUERIES = [
  "connected=2&new=1&skipped=3",
  "connected=0&new=0&skipped=0",
  "connect=cancelled",
  "connect=error&reason=STATE_MISMATCH",
] as const;

/**
 * The callback lands on `/channels?connected=2&new=1&skipped=3`. Its message is
 * read into state and the params are then wiped so a reload cannot replay it
 * hours later — the wipe is what must not take `?tab=` with it, and must not
 * leave a shred of the callback behind either.
 */
describe("withoutConnectParams", () => {
  it("drops every parameter the callback wrote, in every shape it writes", () => {
    for (const search of CALLBACK_QUERIES) {
      expect(withoutConnectParams(search)).toBe("");
      expect(withoutConnectParams(`?${search}`)).toBe("");
    }
  });

  it("keeps the hub's tab and anything else the URL carries", () => {
    expect(withoutConnectParams("tab=groups&connected=2&new=1&skipped=3")).toBe("tab=groups");
    expect(withoutConnectParams("connect=error&reason=STATE_MISMATCH&tab=connect")).toBe(
      "tab=connect",
    );
    expect(withoutConnectParams("tab=pages")).toBe("tab=pages");
    expect(withoutConnectParams("")).toBe("");
  });

  /**
   * `parseConnectOutcome` reads three of the five (it has no use for the counts),
   * so it can only pin part of the list — but that part is the one whose names
   * are spelt twice, here and in a schema file this change may not edit.
   */
  it("leaves nothing behind that parseConnectOutcome would still read", () => {
    for (const search of [
      ...CALLBACK_QUERIES,
      "connected=bogus",
      "connect=something_new",
      "tab=groups&connected=0&new=0&skipped=0",
    ]) {
      const stripped = new URLSearchParams(withoutConnectParams(search));
      expect(parseConnectOutcome(stripped)).toBeNull();
    }
  });
});

/**
 * The exact expression the hub runs when it wipes the callback out of the URL:
 * strip the callback params, then carry the tab back in. The bug it exists for
 * is `router.replace(pathname)` — which dropped `?tab=` and bounced the operator
 * from "Nhóm kênh" back to "Page đã kết nối" right after connecting.
 */
describe("channelsHubQuery", () => {
  it("leaves nothing but the tab, whatever shape the callback arrived in", () => {
    for (const search of CALLBACK_QUERIES) {
      // Came back onto a tab the operator had chosen…
      expect(channelsHubQuery(`tab=groups&${search}`)).toBe("tab=groups");
      // …and the other way round, since the route appends its own params.
      expect(channelsHubQuery(`${search}&tab=connect`)).toBe("tab=connect");
    }
  });

  it("names the default tab when the callback arrived without one", () => {
    // `/channels?connected=2&new=1&skipped=3` is what the OAuth redirect writes:
    // no `tab` of its own, so the wipe has to put the real one back.
    for (const search of CALLBACK_QUERIES) {
      expect(channelsHubQuery(search)).toBe(`${CHANNELS_TAB_PARAM}=pages`);
    }
    expect(channelsHubQuery("")).toBe(`${CHANNELS_TAB_PARAM}=pages`);
  });

  it("normalises a hostile or unknown tab instead of carrying it on", () => {
    expect(channelsHubQuery("tab=bogus&connected=2&new=1&skipped=3")).toBe("tab=pages");
    expect(channelsHubQuery("tab=groups%26admin%3D1")).toBe("tab=pages");
  });

  it("keeps a parameter that belongs to neither the callback nor the hub", () => {
    expect(channelsHubQuery("tab=groups&highlight=g1&connect=cancelled")).toBe(
      "tab=groups&highlight=g1",
    );
  });
});
