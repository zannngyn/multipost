import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_MEDIA_URL_TTL_MS,
  MAX_MEDIA_URL_TTL_MS,
  MEDIA_QUERY_PARAMS,
  MEDIA_ROUTE_PREFIX,
  MIN_MEDIA_URL_TTL_MS,
  buildMediaPath,
  mediaSignaturePayload,
  signMediaUrl,
  verifyMediaUrlSignature,
} from "./media-url";

/**
 * Edge cases first: every way a link can be wrong (forged, expired, replayed
 * across tenants/assets, tampered expiry) before the one way it can be right.
 */

const TENANT = "00000000-0000-0000-0000-000000000001";
const OTHER_TENANT = "00000000-0000-0000-0000-000000000002";
const ASSET = "1bA48sjugz9BczcoR0";
const NOW = Date.UTC(2026, 7, 12, 9, 0, 0);
const SECRET = "test-secret-at-least-32-characters-long";

const sign = (payload: string) => createHmac("sha256", SECRET).update(payload).digest("hex");
const otherSign = (payload: string) => createHmac("sha256", "another-secret").update(payload).digest("hex");

function signed(overrides: { ttlMs?: number; assetId?: string; tenantId?: string } = {}) {
  return signMediaUrl({
    tenantId: overrides.tenantId ?? TENANT,
    assetId: overrides.assetId ?? ASSET,
    baseUrl: "https://mysp.example.com",
    nowMs: NOW,
    ttlMs: overrides.ttlMs,
    sign,
  });
}

function verify(
  input: Partial<Parameters<typeof verifyMediaUrlSignature>[0]> & { signature: unknown },
) {
  return verifyMediaUrlSignature({
    tenantId: TENANT,
    assetId: ASSET,
    expiresAt: NOW + DEFAULT_MEDIA_URL_TTL_MS,
    nowMs: NOW,
    sign,
    ...input,
  });
}

describe("mediaSignaturePayload", () => {
  it.each([
    ["a tenant that is not a UUID", { tenantId: "tenant-1", assetId: ASSET, expiresAtMs: NOW }],
    ["an empty asset id", { tenantId: TENANT, assetId: "", expiresAtMs: NOW }],
    ["an asset id with a separator", { tenantId: TENANT, assetId: "a\nb", expiresAtMs: NOW }],
    ["a non-integer expiry", { tenantId: TENANT, assetId: ASSET, expiresAtMs: 1.5 }],
    ["a negative expiry", { tenantId: TENANT, assetId: ASSET, expiresAtMs: -1 }],
  ])("refuses %s", (_label, claims) => {
    expect(() => mediaSignaturePayload(claims)).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("is versioned and unambiguous across fields", () => {
    const payload = mediaSignaturePayload({ tenantId: TENANT, assetId: ASSET, expiresAtMs: NOW });
    expect(payload).toBe(`v1\n${TENANT}\n${ASSET}\n${NOW}`);
  });

  it("never puts the secret in the error context", () => {
    const error = (() => {
      try {
        mediaSignaturePayload({ tenantId: "nope", assetId: ASSET, expiresAtMs: NOW });
        return null;
      } catch (caught) {
        return caught as { context: Record<string, unknown> };
      }
    })();
    expect(JSON.stringify(error?.context)).not.toContain(SECRET);
  });
});

describe("signMediaUrl", () => {
  it.each([
    ["a relative base URL", "/api"],
    ["a non-http scheme", "ftp://mysp.example.com"],
    ["an empty base URL", "  "],
  ])("refuses %s — Facebook must be able to GET it", (_label, baseUrl) => {
    expect(() => signMediaUrl({ tenantId: TENANT, assetId: ASSET, baseUrl, nowMs: NOW, sign })).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("refuses a malformed tenant/asset before producing a link", () => {
    expect(() =>
      signMediaUrl({ tenantId: "t1", assetId: ASSET, baseUrl: "https://x.io", nowMs: NOW, sign }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("refuses a signer that returns nothing", () => {
    expect(() =>
      signMediaUrl({
        tenantId: TENANT,
        assetId: ASSET,
        baseUrl: "https://x.io",
        nowMs: NOW,
        sign: () => "",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("clamps a TTL that is too long or too short instead of minting a forever link", () => {
    expect(signed({ ttlMs: 30 * 24 * 60 * 60 * 1000 }).expiresAtMs).toBe(NOW + MAX_MEDIA_URL_TTL_MS);
    expect(signed({ ttlMs: 5 }).expiresAtMs).toBe(NOW + MIN_MEDIA_URL_TTL_MS);
    expect(signed().expiresAtMs).toBe(NOW + DEFAULT_MEDIA_URL_TTL_MS);
  });

  it("builds an absolute http(s) URL create-post-batch accepts", () => {
    const result = signed();
    const url = new URL(result.url);

    expect(result.url.startsWith("https://mysp.example.com")).toBe(true);
    expect(/^https?:\/\/\S+$/i.test(result.url)).toBe(true);
    expect(url.pathname).toBe(`${MEDIA_ROUTE_PREFIX}/${ASSET}`);
    expect(url.searchParams.get(MEDIA_QUERY_PARAMS.tenant)).toBe(TENANT);
    expect(url.searchParams.get(MEDIA_QUERY_PARAMS.expires)).toBe(String(result.expiresAtMs));
    expect(url.searchParams.get(MEDIA_QUERY_PARAMS.signature)).toBe(result.signature);
    expect(result.signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it("drops a trailing slash of the base URL instead of doubling it", () => {
    const result = signMediaUrl({
      tenantId: TENANT,
      assetId: ASSET,
      baseUrl: "https://mysp.example.com//",
      nowMs: NOW,
      sign,
    });
    expect(result.url).toBe(`https://mysp.example.com${result.path}`);
  });
});

describe("verifyMediaUrlSignature", () => {
  it("rejects a missing or non-hex signature", () => {
    expect(verify({ signature: undefined })).toEqual({ ok: false, reason: "MISSING_SIGNATURE" });
    expect(verify({ signature: "not-a-mac" })).toEqual({ ok: false, reason: "MISSING_SIGNATURE" });
  });

  it("rejects malformed claims before touching the MAC", () => {
    const good = signed();
    expect(verify({ tenantId: "t1", signature: good.signature })).toEqual({
      ok: false,
      reason: "MALFORMED_CLAIMS",
    });
    expect(verify({ expiresAt: "not-a-number", signature: good.signature })).toEqual({
      ok: false,
      reason: "MALFORMED_CLAIMS",
    });
  });

  it("rejects an expired link", () => {
    const good = signed({ ttlMs: MIN_MEDIA_URL_TTL_MS });
    expect(
      verify({
        expiresAt: good.expiresAtMs,
        signature: good.signature,
        nowMs: good.expiresAtMs + 1,
      }),
    ).toEqual({ ok: false, reason: "EXPIRED" });
  });

  it("rejects an expiry beyond the ceiling even with a valid MAC", () => {
    const farFuture = NOW + MAX_MEDIA_URL_TTL_MS + 60_000;
    const signature = sign(
      mediaSignaturePayload({ tenantId: TENANT, assetId: ASSET, expiresAtMs: farFuture }),
    );
    expect(verify({ expiresAt: farFuture, signature })).toEqual({
      ok: false,
      reason: "EXPIRY_TOO_FAR",
    });
  });

  it("rejects a signature made with another secret", () => {
    const forged = otherSign(
      mediaSignaturePayload({
        tenantId: TENANT,
        assetId: ASSET,
        expiresAtMs: NOW + DEFAULT_MEDIA_URL_TTL_MS,
      }),
    );
    expect(verify({ signature: forged })).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });

  it("rejects a signature replayed on another tenant or another asset", () => {
    const good = signed();
    expect(
      verify({ tenantId: OTHER_TENANT, expiresAt: good.expiresAtMs, signature: good.signature }),
    ).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
    expect(
      verify({ assetId: "other-file-id", expiresAt: good.expiresAtMs, signature: good.signature }),
    ).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });

  it("rejects an extended expiry (the MAC covers it)", () => {
    const good = signed();
    expect(verify({ expiresAt: good.expiresAtMs + 1, signature: good.signature })).toEqual({
      ok: false,
      reason: "BAD_SIGNATURE",
    });
  });

  it("accepts the link it just signed, from the URL itself", () => {
    const good = signed();
    const url = new URL(good.url);

    const verdict = verifyMediaUrlSignature({
      tenantId: url.searchParams.get(MEDIA_QUERY_PARAMS.tenant),
      assetId: decodeURIComponent(url.pathname.slice(`${MEDIA_ROUTE_PREFIX}/`.length)),
      // Query values always arrive as strings — the verifier must accept them.
      expiresAt: url.searchParams.get(MEDIA_QUERY_PARAMS.expires),
      signature: url.searchParams.get(MEDIA_QUERY_PARAMS.signature),
      nowMs: NOW + 1000,
      sign,
    });

    expect(verdict).toEqual({
      ok: true,
      claims: { tenantId: TENANT, assetId: ASSET, expiresAtMs: good.expiresAtMs },
    });
  });

  it("accepts an upper-case signature (a proxy may normalise it)", () => {
    const good = signed();
    expect(
      verify({ expiresAt: good.expiresAtMs, signature: good.signature.toUpperCase() }).ok,
    ).toBe(true);
  });
});

describe("buildMediaPath", () => {
  it("escapes an asset id so it cannot inject query parameters", () => {
    const path = buildMediaPath({
      tenantId: TENANT,
      assetId: "a b?c&d",
      expiresAtMs: NOW,
      signature: "ab",
    });
    expect(path.startsWith(`${MEDIA_ROUTE_PREFIX}/a%20b%3Fc%26d?`)).toBe(true);
  });
});
