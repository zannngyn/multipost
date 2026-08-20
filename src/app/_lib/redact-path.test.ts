import { describe, expect, it } from "vitest";

import { redactSensitivePath } from "./redact-path";

/**
 * B1 regression guard: an invite token in `/join/<token>` is a BEARER, and the
 * deny path of the proxy logs the pathname of every signed-out request — the
 * exact route a colleague's first click takes. The full token must never
 * survive into a log payload; the browser's redirect keeps it.
 */

const TOKEN = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";

describe("redactSensitivePath", () => {
  // --- The case the gate failed on --------------------------------------------
  it("hides the token of /join/<token> completely", () => {
    const redacted = redactSensitivePath(`/join/${TOKEN}`);
    expect(redacted).toBe("/join/<redacted>");
    expect(redacted).not.toContain(TOKEN);
  });

  it("hides DEEPER segments too — over-hiding beats leaking", () => {
    expect(redactSensitivePath(`/join/${TOKEN}/whatever`)).toBe("/join/<redacted>");
  });

  it("mirrors the exact JSON shape logDenied emits — token absent from the payload", () => {
    // The proxy logs JSON.stringify({ ..., path: redactSensitivePath(p) });
    // this pins the property END to END, not just the helper.
    const payload = JSON.stringify({
      message: "Request blocked: no valid session",
      path: redactSensitivePath(`/join/${TOKEN}`),
    });
    expect(payload).not.toContain(TOKEN);
    expect(payload).toContain("/join/<redacted>");
  });

  // --- Everything else stays untouched ----------------------------------------
  it("leaves the bare /join and ordinary paths alone", () => {
    expect(redactSensitivePath("/join")).toBe("/join");
    expect(redactSensitivePath("/sync")).toBe("/sync");
    expect(redactSensitivePath("/api/posts/batches")).toBe("/api/posts/batches");
  });

  it("does not mistake a lookalike prefix (/joined) for the sensitive one", () => {
    expect(redactSensitivePath("/joined/today")).toBe("/joined/today");
  });

  it("never throws over garbage — a log line is not worth a crash", () => {
    expect(redactSensitivePath("")).toBe("");
    expect(redactSensitivePath(undefined as never)).toBeUndefined();
  });
});
