import { describe, expect, it, vi } from "vitest";

/**
 * M2.4 — the approval queue is retired: every caller gets the SAME 410, so an
 * old UI fails loudly instead of pretending to decide. GET (history) is
 * covered by the admin-guard tests and stays alive.
 */

const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };

vi.mock("@/composition/container", () => ({
  getContainer: () => ({ logger, config: { NODE_ENV: "test" }, usecases: {} }),
}));

const { POST } = await import("../route");

describe("POST /api/access-requests/decide — retired", () => {
  it("answers 410 RETIRED with the invite-link pointer, touching nothing", async () => {
    const response = await POST();

    expect(response.status).toBe(410);
    const body = await response.json();
    expect(body.code).toBe("RETIRED");
    expect(body.message).toContain("link mời");
  });
});
