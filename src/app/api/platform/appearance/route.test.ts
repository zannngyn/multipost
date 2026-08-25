import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";

/**
 * M3.4 — boundary contract of /api/platform/appearance: support may READ,
 * only super_admin may REPAINT, and a body that is not one of the known
 * presets never reaches the usecase.
 */

const get = vi.fn();
const set = vi.fn();
const requirePlatformAdmin = vi.fn();
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
const getOperatorSession = vi.fn();

vi.mock("@/composition/container", () => ({
  getContainer: () => ({
    logger,
    config: { NODE_ENV: "test" },
    usecases: { platformAppearance: { get, set }, requirePlatformAdmin },
  }),
}));

vi.mock("@/app/_auth/session", () => ({
  getOperatorSession: (...args: unknown[]) => getOperatorSession(...(args as [])),
}));

const { GET, PUT } = await import("./route");

const getRequest = () => new Request("http://localhost/api/platform/appearance");
const putRequest = (body: unknown) =>
  new Request("http://localhost/api/platform/appearance", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  getOperatorSession.mockResolvedValue({ email: "root@mysp.vn", accountId: "acc-root" });
  requirePlatformAdmin.mockResolvedValue({ accountId: "acc-root", platformRole: "super_admin" });
  get.mockResolvedValue({ presetId: "cham", isDefault: true });
  set.mockResolvedValue({ presetId: "reu", already: false });
});

// --- Refusals first -----------------------------------------------------------

describe("refusals", () => {
  it("GET refuses an account with no platform role", async () => {
    requirePlatformAdmin.mockRejectedValue(
      new AppError("FORBIDDEN", { message: "Account holds no active platform role" }),
    );

    const response = await GET(getRequest());

    expect(response.status).toBe(403);
    expect(get).not.toHaveBeenCalled();
  });

  it("GET refuses with no session at all", async () => {
    getOperatorSession.mockResolvedValue(null);
    requirePlatformAdmin.mockRejectedValue(
      new AppError("UNAUTHORIZED", { message: "no session" }),
    );

    expect((await GET(getRequest())).status).toBe(401);
  });

  it("PUT demands super_admin, not support", async () => {
    await PUT(putRequest({ presetId: "reu" }));

    expect(requirePlatformAdmin).toHaveBeenCalledWith(expect.anything(), {
      minRole: "super_admin",
    });
  });

  it("PUT refuses a support-only account", async () => {
    requirePlatformAdmin.mockRejectedValue(
      new AppError("FORBIDDEN", { message: "role below the required minimum" }),
    );

    const response = await PUT(putRequest({ presetId: "reu" }));

    expect(response.status).toBe(403);
    expect(set).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown preset", { presetId: "neon-pink" }],
    ["an empty id", { presetId: "" }],
    ["a missing field", {}],
    ["the wrong type", { presetId: 7 }],
    ["null", null],
    ["an array", ["reu"]],
  ])("PUT rejects %s at the boundary", async (_label, body) => {
    const response = await PUT(putRequest(body));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "INVALID_INPUT" });
    expect(set).not.toHaveBeenCalled();
  });

  it("PUT rejects a body that is not JSON", async () => {
    const response = await PUT(
      new Request("http://localhost/api/platform/appearance", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{ not json",
      }),
    );

    expect(response.status).toBe(400);
    expect(set).not.toHaveBeenCalled();
  });

  it("surfaces a database failure as 503, not as a colour", async () => {
    get.mockRejectedValue(new AppError("DB_ERROR", { message: "connection refused" }));

    expect((await GET(getRequest())).status).toBe(503);
  });
});

// --- Happy path ---------------------------------------------------------------

describe("reading", () => {
  it("lets support read the current preset", async () => {
    const response = await GET(getRequest());

    expect(requirePlatformAdmin).toHaveBeenCalledWith(expect.anything(), { minRole: "support" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ presetId: "cham", isDefault: true });
  });

  it("reports a chosen preset as chosen", async () => {
    get.mockResolvedValue({ presetId: "man", isDefault: false });

    await expect((await GET(getRequest())).json()).resolves.toEqual({
      presetId: "man",
      isDefault: false,
    });
  });
});

describe("writing", () => {
  it("passes the choice and the actor down", async () => {
    const response = await PUT(putRequest({ presetId: "reu" }));

    expect(response.status).toBe(200);
    expect(set).toHaveBeenCalledWith({
      presetId: "reu",
      actorAccountId: "acc-root",
      actorEmail: "root@mysp.vn",
    });
    await expect(response.json()).resolves.toEqual({ presetId: "reu", already: false });
  });

  it("takes the actor from the AUTHORISER, never from the body", async () => {
    requirePlatformAdmin.mockResolvedValue({
      accountId: "acc-real",
      platformRole: "super_admin",
    });

    await PUT(putRequest({ presetId: "reu", actorAccountId: "acc-forged" }));

    expect(set).toHaveBeenCalledWith(expect.objectContaining({ actorAccountId: "acc-real" }));
  });

  it("reports an unchanged save honestly", async () => {
    set.mockResolvedValue({ presetId: "reu", already: true });

    await expect((await PUT(putRequest({ presetId: "reu" }))).json()).resolves.toEqual({
      presetId: "reu",
      already: true,
    });
  });

  it("accepts every preset the table declares", async () => {
    const { APPEARANCE_PRESET_IDS } = await import("@/shared/appearance-presets");

    for (const presetId of APPEARANCE_PRESET_IDS) {
      set.mockResolvedValue({ presetId, already: false });
      expect((await PUT(putRequest({ presetId }))).status, presetId).toBe(200);
    }
  });
});
