import { beforeEach, describe, expect, it, vi } from "vitest";

import { roleAtLeast } from "@/core/domain/account";
import { AppError } from "@/core/domain/errors";
import { testTenantId } from "@/core/domain/tenant-context.testing";
import type { OperatorRole } from "@/shared/operator-access";

/**
 * M1.3b — the authorisation boundary of `/api/catalog/source`.
 *
 * What is being proved: the tenant comes from the MEMBERSHIP, never from the
 * request, and PUT (tier S, admin) refuses before it parses a payload. A
 * `tenantId` an old UI build still sends must be ignored in silence, not
 * rejected — the UI only lands in M1.4 (docs/11 §3.2).
 */

const getCatalogSource = vi.fn();
const updateCatalogSource = vi.fn();
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
const getOperatorSession = vi.fn();
const requireTenant = vi.fn();

vi.mock("@/composition/container", () => ({
  getContainer: () => ({
    logger,
    config: { NODE_ENV: "test" },
    usecases: { getCatalogSource, updateCatalogSource, requireTenant },
  }),
}));

vi.mock("@/app/_auth/session", () => ({
  getOperatorSession: (...args: unknown[]) => getOperatorSession(...(args as [])),
}));

const { GET, PUT } = await import("../route");
const { ACTIVE_TENANT_COOKIE } = await import("@/app/_lib/active-tenant-cookie");

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");
/** The company the caller is NOT a member of — the forged selector. */
const OTHER_TENANT = "00000000-0000-0000-0000-0000000000ff";

const SOURCE = { driveFolderId: "folder-1", spreadsheetId: "sheet-1", sheetName: "Mẫu 2026" };

/** Captured so a test can assert WHICH claim the route made (tier + minRole). */
let claim: { tier?: string; minRole?: string } = {};

/**
 * Stands in for the real gate: same order of refusals (doc 10 §3), so a route
 * declaring the wrong `minRole` fails here instead of in production.
 */
function grantRole(role: OperatorRole): void {
  requireTenant.mockImplementation(
    (
      _session: unknown,
      cookieTenantId: string | null,
      options: { tier: string; minRole?: OperatorRole },
    ) => {
      claim = { tier: options.tier, ...(options.minRole ? { minRole: options.minRole } : {}) };
      if (cookieTenantId && cookieTenantId !== TENANT) {
        throw new AppError("TENANT_NOT_FOUND", { context: { tenant_id: cookieTenantId } });
      }
      if (options.minRole && !roleAtLeast(role, options.minRole)) {
        throw new AppError("FORBIDDEN", { context: { required_role: options.minRole } });
      }
      return Promise.resolve({ tenantId: TENANT, role, membershipVersion: 1 });
    },
  );
}

function get(query = "", cookieTenantId: string | null = TENANT): Request {
  const headers = new Headers();
  if (cookieTenantId) headers.set("cookie", `${ACTIVE_TENANT_COOKIE}=${cookieTenantId}`);
  return new Request(`http://localhost/api/catalog/source${query}`, { headers });
}

function put(body: unknown, cookieTenantId: string | null = TENANT): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (cookieTenantId) headers.set("cookie", `${ACTIVE_TENANT_COOKIE}=${cookieTenantId}`);
  return new Request("http://localhost/api/catalog/source", {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  driveFolder: "https://drive.google.com/drive/folders/folder-1",
  spreadsheet: "https://docs.google.com/spreadsheets/d/sheet-1/edit",
  sheetName: "Mẫu 2026",
};

beforeEach(() => {
  vi.clearAllMocks();
  claim = {};
  getOperatorSession.mockResolvedValue({ email: "boss@shop.vn", accountId: "acc-1" });
  getCatalogSource.mockResolvedValue(SOURCE);
  updateCatalogSource.mockResolvedValue(SOURCE);
  grantRole("admin");
});

// --- Edge cases first ---------------------------------------------------------

describe("PUT /api/catalog/source — refusals", () => {
  it("401s without a session, before the body is read", async () => {
    getOperatorSession.mockResolvedValue(null);

    const response = await PUT(put(VALID_BODY));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "UNAUTHORIZED" });
    expect(requireTenant).not.toHaveBeenCalled();
    expect(updateCatalogSource).not.toHaveBeenCalled();
  });

  it("404s a selector cookie pointing at a company the account is not in", async () => {
    const response = await PUT(put(VALID_BODY, OTHER_TENANT));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "TENANT_NOT_FOUND" });
    expect(updateCatalogSource).not.toHaveBeenCalled();
  });

  it("403s an editor: changing the source is admin work (doc 10 §4.1)", async () => {
    grantRole("editor");

    const response = await PUT(put(VALID_BODY));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "FORBIDDEN" });
    expect(updateCatalogSource).not.toHaveBeenCalled();
  });

  it("claims tier S + admin — the membership is never served from a cache", async () => {
    await PUT(put(VALID_BODY));

    expect(claim).toEqual({ tier: "S", minRole: "admin" });
  });

  /**
   * CONTRACT CHANGE, onboarding phase 3 — this assertion moved one layer down
   * on purpose, it was not weakened.
   *
   * This route used to refuse a blank `sheetName` itself. It cannot any more:
   * whether the Google coordinates are required depends on WHICH source the
   * tenant reads after the save, and only `updateCatalogSource` knows that (what
   * was just sent, or what is already stored). A tenant reading an uploaded CSV
   * has no tab name at all, and the old `.min(1)` made this route refuse them a
   * column-mapping save the API is happy to accept.
   *
   * The refusal itself is unchanged and still tested where it now lives:
   * `requireGoogleRef` throws INVALID_INPUT with an `issues` entry naming the
   * field, so the form still puts the message on the right box.
   */
  it("forwards a blank sheet name instead of deciding — the usecase owns that rule now", async () => {
    const response = await PUT(put({ ...VALID_BODY, sheetName: "  " }));

    expect(response.status).toBe(200);
    expect(updateCatalogSource).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, sheetName: "" }),
    );
  });

  /**
   * P2 — the LAST unlocked link in the "vắng = giữ nguyên" chain.
   *
   * The other three links each have their own guard (the browser body, the
   * usecase input, the repo merge). This one was a bare pass-through, and since
   * `UpdateCatalogSourceInput.driveFolder` became `string | undefined`, adding
   * `?? ""` to those three lines would typecheck cleanly and leave every other
   * test green — while turning every mapping save back into a request to blank
   * the tenant's Drive folder. That is the exact silent regression this sprint
   * hit three times.
   *
   * The assertion is on the VALUE, not on key presence, and the difference from
   * the browser-side test is real rather than stylistic. There, the key must be
   * absent from the JSON body. Here the route builds an object literal, so the
   * key is always present — `"driveFolder" in call` is true whatever the value
   * is, and asserting otherwise would test the shape of a literal instead of the
   * meaning of the request. `toBeUndefined()` compares exactly, so it separates
   * `undefined` ("giữ nguyên") from `""` ("xoá"), which is the whole point.
   */
  it("forwards absent coordinates as undefined, never as an empty string", async () => {
    // Exactly what the mapping wizard sends: the map, and nothing about the source.
    const response = await PUT(put({ fieldMap: null, stockPolicy: null }));

    expect(response.status).toBe(200);
    const [input] = updateCatalogSource.mock.calls[0] as [Record<string, unknown>];
    expect(input.driveFolder).toBeUndefined();
    expect(input.spreadsheet).toBeUndefined();
    expect(input.sheetName).toBeUndefined();
  });

  /**
   * F1 — the switch BACK from an uploaded CSV to a Google tab.
   *
   * Without `textConfig` on the wire, the usecase resolved the STORED kind for
   * ever: a tenant on a CSV could paste a spreadsheet link, press Lưu, get a 200
   * and a reset form, and still be reading the old file. A write that answers
   * 200 and does nothing is worse than a refusal, because the operator walks
   * away believing it (business rule 5).
   */
  it("forwards textConfig so a tenant can switch back to a Google tab", async () => {
    const response = await PUT(put({ ...VALID_BODY, textConfig: { kind: "google_sheet" } }));

    expect(response.status).toBe(200);
    expect(updateCatalogSource).toHaveBeenCalledWith(
      expect.objectContaining({ textConfig: { kind: "google_sheet" } }),
    );
  });

  it("omits textConfig entirely when none was sent — absent means 'giữ nguyên'", async () => {
    // A save that only fixes a column mapping must not repoint the source.
    await PUT(put(VALID_BODY));

    const [input] = updateCatalogSource.mock.calls[0] as [Record<string, unknown>];
    expect(input.textConfig).toBeUndefined();
  });

  /**
   * Switching TO a file means producing a stored file, and only
   * `POST /api/catalog/file` can do that — it reads the bytes, then mints the
   * key. Accepting one here would let a caller point a tenant at a storage key
   * they invented, or at another tenant's.
   */
  it("refuses a file textConfig: a browser has no business minting a storage key", async () => {
    const response = await PUT(
      put({ ...VALID_BODY, textConfig: { kind: "file", storageKey: "other-tenant/secret" } }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "INVALID_INPUT" });
    expect(updateCatalogSource).not.toHaveBeenCalled();
  });

  /**
   * What this route still refuses on its own: a value that is not a string at
   * all. That is a transport fact, true of both source kinds, and it must never
   * reach a usecase that expects text.
   */
  it("400s a body whose fields are not strings, and writes nothing", async () => {
    const response = await PUT(put({ ...VALID_BODY, sheetName: 42 }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "INVALID_INPUT" });
    expect(updateCatalogSource).not.toHaveBeenCalled();
  });
});

describe("PUT /api/catalog/source — the write", () => {
  it("uses the membership tenant and the session e-mail, ignoring both in the body", async () => {
    const response = await PUT(put({ ...VALID_BODY, tenantId: OTHER_TENANT, actorEmail: "evil@x" }));

    expect(response.status).toBe(200);
    expect(updateCatalogSource).toHaveBeenCalledWith({
      tenantId: TENANT,
      driveFolder: VALID_BODY.driveFolder,
      spreadsheet: VALID_BODY.spreadsheet,
      sheetName: VALID_BODY.sheetName,
      actorEmail: "boss@shop.vn",
    });
  });

  it("keeps the response shape, echoing the AUTHORISED tenant", async () => {
    const response = await PUT(put(VALID_BODY));

    await expect(response.json()).resolves.toEqual({
      state: "configured",
      tenantId: TENANT,
      source: SOURCE,
    });
  });
});

/**
 * Onboarding phase 2. The contract being proved is the one that decides whether
 * a tenant loses their configuration: ABSENT must reach the usecase as
 * `undefined` ("giữ nguyên cái đang lưu"), never as a value this route invented.
 */
describe("PUT /api/catalog/source — media profile", () => {
  const FIELD_MAP = {
    code: "Mã sản phẩm",
    name: "Tên sản phẩm",
    description: null,
    category: null,
    season: null,
    stock: null,
    note: null,
    colors: null,
  };

  it("does not send a media profile the caller did not send", async () => {
    await PUT(put(VALID_BODY));

    const call = updateCatalogSource.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.mediaProfile).toBeUndefined();
  });

  it("forwards a declared layout, colour vocabulary included", async () => {
    const mediaProfile = {
      kind: "folder-per-code",
      colors: { canonical: ["XANH THAN"], includeDefaults: false },
    };

    const response = await PUT(put({ ...VALID_BODY, mediaProfile }));

    expect(response.status).toBe(200);
    const call = updateCatalogSource.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.mediaProfile).toEqual(mediaProfile);
  });

  it("400s an unknown layout instead of falling back to the default", async () => {
    // Silently defaulting would store "MÃ-Màu (số)" for a tenant who asked for
    // something else, and nothing downstream could tell the two apart.
    const response = await PUT(put({ ...VALID_BODY, mediaProfile: { kind: "whatever" } }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "INVALID_INPUT" });
    expect(updateCatalogSource).not.toHaveBeenCalled();
  });

  it("carries the link column of the field map instead of dropping it", async () => {
    const response = await PUT(
      put({
        ...VALID_BODY,
        fieldMap: { ...FIELD_MAP, mediaLink: "Link ảnh" },
        mediaProfile: { kind: "sheet-column" },
      }),
    );

    expect(response.status).toBe(200);
    const call = updateCatalogSource.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.fieldMap).toMatchObject({ mediaLink: "Link ảnh" });
  });

  it("still accepts a field map from a caller that predates the link slot", async () => {
    const response = await PUT(put({ ...VALID_BODY, fieldMap: FIELD_MAP }));

    expect(response.status).toBe(200);
    const call = updateCatalogSource.mock.calls[0]?.[0] as Record<string, unknown>;
    expect((call.fieldMap as Record<string, unknown>).mediaLink).toBeUndefined();
  });
});

describe("GET /api/catalog/source", () => {
  it("401s without a session", async () => {
    getOperatorSession.mockResolvedValue(null);

    const response = await GET(get());

    expect(response.status).toBe(401);
    expect(getCatalogSource).not.toHaveBeenCalled();
  });

  it("404s a forged selector cookie", async () => {
    const response = await GET(get("", OTHER_TENANT));

    expect(response.status).toBe(404);
    expect(getCatalogSource).not.toHaveBeenCalled();
  });

  it("claims tier R + viewer, and reads the membership tenant", async () => {
    grantRole("viewer");

    const response = await GET(get(`?tenantId=${OTHER_TENANT}`));

    expect(response.status).toBe(200);
    expect(claim).toEqual({ tier: "R", minRole: "viewer" });
    // The query string still carries a tenant id from the old UI: ignored.
    expect(getCatalogSource).toHaveBeenCalledWith({ tenantId: TENANT });
  });

  it("keeps 'not_configured' a 200 empty state — never the 404 of a missing membership", async () => {
    getCatalogSource.mockResolvedValue(null);

    const response = await GET(get());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      state: "not_configured",
      tenantId: TENANT,
    });
  });
});
