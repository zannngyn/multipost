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
 * The OAuth callback lands on `/channels?connected=2`. Its message is read into
 * state and the params are then wiped so a reload cannot replay it hours later
 * — the wipe is what must not take `?tab=` with it.
 */
describe("withoutConnectParams", () => {
  it("drops every parameter the callback wrote", () => {
    expect(withoutConnectParams("connected=2")).toBe("");
    expect(withoutConnectParams("?connected=2")).toBe("");
    expect(withoutConnectParams("connect=cancelled")).toBe("");
    expect(withoutConnectParams("connect=error&reason=oauth_denied")).toBe("");
  });

  it("keeps the hub's tab and anything else the URL carries", () => {
    expect(withoutConnectParams("tab=groups&connected=2")).toBe("tab=groups");
    expect(withoutConnectParams("connect=error&reason=x&tab=connect")).toBe("tab=connect");
    expect(withoutConnectParams("tab=pages")).toBe("tab=pages");
    expect(withoutConnectParams("")).toBe("");
  });

  /**
   * The names are spelt in two places — here and in `parseConnectOutcome`, which
   * this file may not edit. This pins them together: if the schema ever reads a
   * fourth param, the wipe below stops being complete and this test fails.
   */
  it("leaves nothing behind that parseConnectOutcome would still read", () => {
    for (const search of [
      "connected=2",
      "connected=bogus",
      "connect=cancelled",
      "connect=error&reason=oauth_denied",
      "connect=something_new",
      "tab=groups&connected=0",
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
  it("keeps the tab the URL is on while the callback params go", () => {
    expect(channelsHubQuery("tab=groups&connected=2")).toBe("tab=groups");
    expect(channelsHubQuery("connected=2&tab=connect")).toBe("tab=connect");
  });

  it("names the default tab when the callback arrived without one", () => {
    // `/channels?connected=2` is exactly what the OAuth redirect writes.
    expect(channelsHubQuery("connected=2")).toBe(`${CHANNELS_TAB_PARAM}=pages`);
    expect(channelsHubQuery("")).toBe(`${CHANNELS_TAB_PARAM}=pages`);
  });

  it("normalises a hostile or unknown tab instead of carrying it on", () => {
    expect(channelsHubQuery("tab=bogus&connected=2")).toBe("tab=pages");
    expect(channelsHubQuery("tab=groups%26admin%3D1")).toBe("tab=pages");
  });

  it("keeps a parameter that belongs to neither the callback nor the hub", () => {
    expect(channelsHubQuery("tab=groups&highlight=g1&connect=cancelled")).toBe(
      "tab=groups&highlight=g1",
    );
  });
});
