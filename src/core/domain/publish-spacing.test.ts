import { describe, expect, it } from "vitest";

import {
  MAX_SPACING_MS,
  RECOMMENDED_MIN_SPACING_MS,
  isValidSpacingMs,
  parseBatchSpacingMs,
  resolveSpacingMs,
  spacingRejectionMessage,
} from "./publish-spacing";

const TENANT_SPACING = 60_000;

describe("parseBatchSpacingMs — edge cases first", () => {
  it("treats undefined and null as 'no value for this run'", () => {
    expect(parseBatchSpacingMs(undefined)).toEqual({ ok: true, ms: null });
    expect(parseBatchSpacingMs(null)).toEqual({ ok: true, ms: null });
  });

  it("refuses NaN and Infinity instead of silently disabling the gate", () => {
    expect(parseBatchSpacingMs(Number.NaN)).toMatchObject({ ok: false, reason: "NOT_A_NUMBER" });
    expect(parseBatchSpacingMs(Number.POSITIVE_INFINITY)).toMatchObject({
      ok: false,
      reason: "NOT_A_NUMBER",
    });
  });

  it("refuses a numeric STRING — it never coerces (\"5\" means 5 minutes to a human)", () => {
    expect(parseBatchSpacingMs("5")).toMatchObject({ ok: false, reason: "NOT_A_NUMBER" });
    expect(parseBatchSpacingMs("300000")).toMatchObject({ ok: false, reason: "NOT_A_NUMBER" });
  });

  it("refuses booleans, objects and arrays", () => {
    for (const raw of [true, {}, [], () => 0]) {
      expect(parseBatchSpacingMs(raw)).toMatchObject({ ok: false, reason: "NOT_A_NUMBER" });
    }
  });

  it("refuses a fractional millisecond", () => {
    expect(parseBatchSpacingMs(1.5)).toMatchObject({ ok: false, reason: "NOT_AN_INTEGER" });
  });

  it("refuses a negative value and names the bound", () => {
    expect(parseBatchSpacingMs(-1)).toMatchObject({ ok: false, reason: "BELOW_MIN", received: -1 });
    expect(parseBatchSpacingMs(-60_000)).toMatchObject({ ok: false, reason: "BELOW_MIN" });
  });

  it("refuses anything above the 24h ceiling", () => {
    expect(parseBatchSpacingMs(MAX_SPACING_MS + 1)).toMatchObject({
      ok: false,
      reason: "ABOVE_MAX",
    });
  });

  it("accepts 0 (spacing off for this run) and both bounds", () => {
    expect(parseBatchSpacingMs(0)).toEqual({ ok: true, ms: 0 });
    expect(parseBatchSpacingMs(MAX_SPACING_MS)).toEqual({ ok: true, ms: MAX_SPACING_MS });
  });

  it("accepts a free-form number of minutes BELOW the recommendation (advice, not a floor)", () => {
    expect(parseBatchSpacingMs(60_000)).toEqual({ ok: true, ms: 60_000 });
    expect(parseBatchSpacingMs(RECOMMENDED_MIN_SPACING_MS - 1)).toMatchObject({ ok: true });
  });

  it("every rejection has a Vietnamese operator message", () => {
    for (const reason of ["NOT_A_NUMBER", "NOT_AN_INTEGER", "BELOW_MIN", "ABOVE_MAX"] as const) {
      expect(spacingRejectionMessage(reason).length).toBeGreaterThan(10);
    }
  });
});

describe("isValidSpacingMs", () => {
  it("rejects everything parseBatchSpacingMs rejects, accepts the rest", () => {
    expect(isValidSpacingMs(0)).toBe(true);
    expect(isValidSpacingMs(MAX_SPACING_MS)).toBe(true);
    expect(isValidSpacingMs(-1)).toBe(false);
    expect(isValidSpacingMs(MAX_SPACING_MS + 1)).toBe(false);
    expect(isValidSpacingMs(1.5)).toBe(false);
    expect(isValidSpacingMs("60000")).toBe(false);
    expect(isValidSpacingMs(null)).toBe(false);
  });
});

describe("resolveSpacingMs — batch value wins, absence keeps the old behaviour", () => {
  it("falls back to the tenant when the batch has no value (old rows, NULL column)", () => {
    expect(resolveSpacingMs(null, TENANT_SPACING)).toEqual({
      ms: TENANT_SPACING,
      source: "tenant",
      ignoredBatchSpacingMs: null,
    });
    expect(resolveSpacingMs(undefined, TENANT_SPACING)).toEqual({
      ms: TENANT_SPACING,
      source: "tenant",
      ignoredBatchSpacingMs: null,
    });
  });

  it("lets the batch value override the tenant one", () => {
    expect(resolveSpacingMs(300_000, TENANT_SPACING)).toEqual({
      ms: 300_000,
      source: "batch",
      ignoredBatchSpacingMs: null,
    });
  });

  it("treats a batch 0 as a VALUE (spacing off), not as an absence", () => {
    expect(resolveSpacingMs(0, TENANT_SPACING)).toEqual({
      ms: 0,
      source: "batch",
      ignoredBatchSpacingMs: null,
    });
  });

  it("ignores an impossible stored value and reports it so the caller can log it", () => {
    expect(resolveSpacingMs(-5, TENANT_SPACING)).toEqual({
      ms: TENANT_SPACING,
      source: "tenant",
      ignoredBatchSpacingMs: -5,
    });
    expect(resolveSpacingMs(MAX_SPACING_MS + 1, TENANT_SPACING)).toEqual({
      ms: TENANT_SPACING,
      source: "tenant",
      ignoredBatchSpacingMs: MAX_SPACING_MS + 1,
    });
  });

  it("passes the tenant number through untouched — spacingWaitMs owns the <=0 guard", () => {
    expect(resolveSpacingMs(null, 0)).toMatchObject({ ms: 0, source: "tenant" });
  });
});
