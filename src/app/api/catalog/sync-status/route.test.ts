import { beforeEach, describe, expect, it, vi } from "vitest";
import { testTenantId } from "@/core/domain/tenant-context.testing";

/**
 * The query-string boundary of GET /api/catalog/sync-status (docs/07 §3.3): a
 * bad `recentLimit` must become a 400 with a Vietnamese message HERE, before the
 * usecase and the database see it.
 *
 * The composition root is mocked because this test is about parsing, not wiring;
 * the usecase itself re-checks the range and has its own tests.
 */

const getSyncStatus = vi.fn();
const logger = { warn: vi.fn(), error: vi.fn() };

vi.mock("@/composition/container", () => ({
  getContainer: () => ({ logger, usecases: { getSyncStatus } }),
}));

const { GET } = await import("./route");

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");

function request(query: string): Request {
  return new Request(`http://localhost/api/catalog/sync-status${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  getSyncStatus.mockResolvedValue(null);
});

describe("GET /api/catalog/sync-status — recentLimit boundary", () => {
  // The literals mirror MAX_RECENT_RUNS = 20 in core/usecases/get-sync-status.ts.
  it.each([
    ["?tenantId=" + TENANT + "&recentLimit=", "empty string"],
    ["?tenantId=" + TENANT + "&recentLimit=abc", "not a number"],
    ["?tenantId=" + TENANT + "&recentLimit=0", "below the range"],
    ["?tenantId=" + TENANT + "&recentLimit=21", "above the range"],
    ["?tenantId=" + TENANT + "&recentLimit=-3", "negative"],
    ["?tenantId=" + TENANT + "&recentLimit=2.5", "fractional"],
  ])("rejects %s (%s) with 400 before calling the usecase", async (query) => {
    const response = await GET(request(query));

    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe("INVALID_INPUT");
    expect(body.message.length).toBeGreaterThan(0);
    expect(getSyncStatus).not.toHaveBeenCalled();
  });

  it.each([1, 5, 6, 20])("passes a valid recentLimit=%s straight through", async (limit) => {
    const response = await GET(request(`?tenantId=${TENANT}&recentLimit=${limit}`));

    expect(response.status).toBe(200);
    expect(getSyncStatus).toHaveBeenCalledWith({ tenantId: TENANT, recentLimit: limit });
  });

  it("omits recentLimit entirely when the caller does not ask for one", async () => {
    const response = await GET(request(`?tenantId=${TENANT}`));

    expect(response.status).toBe(200);
    // `undefined`, not 0 or 5: the DEFAULT belongs to the usecase, not here.
    expect(getSyncStatus).toHaveBeenCalledWith({ tenantId: TENANT, recentLimit: undefined });
  });

  it("still rejects a missing tenantId, whatever recentLimit says", async () => {
    const response = await GET(request("?recentLimit=5"));

    expect(response.status).toBe(400);
    expect(getSyncStatus).not.toHaveBeenCalled();
  });
});

describe("GET /api/catalog/sync-status — answers", () => {
  it("turns 'never synced' into a 200 empty state, not an error", async () => {
    getSyncStatus.mockResolvedValue(null);

    const response = await GET(request(`?tenantId=${TENANT}`));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ state: "never_synced", tenantId: TENANT });
  });

  it("returns the run as-is, including a null issueGroups", async () => {
    getSyncStatus.mockResolvedValue({ syncRunId: "run-1", issueGroups: null, recentRuns: [] });

    const response = await GET(request(`?tenantId=${TENANT}`));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      state: "has_run",
      run: { syncRunId: "run-1", issueGroups: null, recentRuns: [] },
    });
  });
});
