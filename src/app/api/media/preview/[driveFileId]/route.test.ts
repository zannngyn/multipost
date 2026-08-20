import { beforeEach, describe, expect, it, vi } from "vitest";

import { roleAtLeast } from "@/core/domain/account";
import { AppError } from "@/core/domain/errors";
import { testTenantId } from "@/core/domain/tenant-context.testing";
import type { OperatorRole } from "@/shared/operator-access";

/**
 * E3.6b — the boundary of the SESSION-backed preview.
 *
 * The property under test is that this door is nothing like the tier-P one: no
 * signature is accepted or minted, the tenant comes from the membership, and the
 * bytes never become cacheable by anything shared.
 */

const getMediaPreview = vi.fn();
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
const getOperatorSession = vi.fn();
const requireTenant = vi.fn();

vi.mock("@/composition/container", () => ({
  getContainer: () => ({
    logger,
    config: { NODE_ENV: "test" },
    usecases: { getMediaPreview, requireTenant },
  }),
}));

vi.mock("@/app/_auth/session", () => ({
  getOperatorSession: (...args: unknown[]) => getOperatorSession(...(args as [])),
}));

const { GET } = await import("./route");
const { ACTIVE_TENANT_COOKIE } = await import("@/app/_lib/active-tenant-cookie");

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");
const OTHER_TENANT = "00000000-0000-0000-0000-0000000000ff";
const ASSET_ID = "1a2b3c-drive-file-id";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

const PREVIEW = {
  driveFileId: ASSET_ID,
  fileName: "AB123-TRẮNG (1).jpg",
  productCode: "AB123",
  kind: "image" as const,
  mimeType: "image/jpeg",
  sizeBytes: JPEG.length,
  bytes: JPEG,
  cacheSeconds: 300,
};

let claim: { tier?: string; minRole?: string } = {};

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

function call(
  assetId = ASSET_ID,
  cookieTenantId: string | null = TENANT,
): Promise<Response> {
  const headers = new Headers();
  if (cookieTenantId) headers.set("cookie", `${ACTIVE_TENANT_COOKIE}=${cookieTenantId}`);
  const request = new Request(
    `http://localhost/api/media/preview/${encodeURIComponent(assetId)}`,
    { headers },
  );
  return GET(request, { params: Promise.resolve({ driveFileId: assetId }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  claim = {};
  getOperatorSession.mockResolvedValue({ email: "staff@shop.vn", accountId: "acc-1" });
  getMediaPreview.mockResolvedValue(PREVIEW);
  grantRole("viewer");
});

// --- Edge cases first ---------------------------------------------------------

describe("GET /api/media/preview/[driveFileId] — refusals", () => {
  it("401s with no session, and never reads a byte", async () => {
    getOperatorSession.mockResolvedValue(null);

    const response = await call();

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "UNAUTHORIZED" });
    expect(getMediaPreview).not.toHaveBeenCalled();
  });

  it("404s when the selector cookie names a company the account is not in", async () => {
    const response = await call(ASSET_ID, OTHER_TENANT);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "TENANT_NOT_FOUND" });
    expect(getMediaPreview).not.toHaveBeenCalled();
  });

  it("404s an asset that belongs to another tenant, exactly like one that does not exist", async () => {
    getMediaPreview.mockRejectedValue(
      new AppError("MEDIA_NOT_FOUND", {
        message: "No synced media asset with this Drive file id for this tenant",
      }),
    );

    const response = await call("someone-elses-asset");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "MEDIA_NOT_FOUND" });
  });

  it("404s a video: previews are images only (Phase 2 owns the poster frame)", async () => {
    getMediaPreview.mockRejectedValue(
      new AppError("MEDIA_NOT_FOUND", {
        message: "Preview is images only; this asset is a video",
        context: { reason: "PREVIEW_KIND_UNSUPPORTED" },
      }),
    );

    const response = await call("clip-asset");

    expect(response.status).toBe(404);
    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe("MEDIA_NOT_FOUND");
    // The operator gets a sentence, not a stack trace.
    expect(body.message.length).toBeGreaterThan(0);
  });

  it("503s a Drive outage rather than serving an empty image", async () => {
    getMediaPreview.mockRejectedValue(new AppError("DRIVE_ERROR"));

    expect((await call()).status).toBe(503);
  });
});

describe("GET /api/media/preview/[driveFileId] — serving", () => {
  it("claims tier R + viewer: an image is post content every member may see", async () => {
    await call();

    expect(claim).toEqual({ tier: "R", minRole: "viewer" });
  });

  it("reads the asset under the MEMBERSHIP tenant, not one from the URL", async () => {
    await call();

    expect(getMediaPreview).toHaveBeenCalledWith({
      tenantId: TENANT,
      mediaAssetId: ASSET_ID,
    });
  });

  it("returns the bytes with the asset's content type", async () => {
    const response = await call();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("content-length")).toBe(String(JPEG.length));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(JPEG);
  });

  it("caches privately for 300s and forbids mime sniffing — never a shared cache", async () => {
    const response = await call();

    expect(response.headers.get("cache-control")).toBe("private, max-age=300");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("carries no signature anywhere: this door mints no bearer token", async () => {
    const response = await call();

    const headers = JSON.stringify([...response.headers.entries()]);
    expect(headers).not.toContain("sig");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("serves an editor and an admin the same image as a viewer", async () => {
    grantRole("admin");

    const response = await call();

    expect(response.status).toBe(200);
    expect(getMediaPreview).toHaveBeenCalledWith({ tenantId: TENANT, mediaAssetId: ASSET_ID });
  });
});
