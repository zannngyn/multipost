import { beforeEach, describe, expect, it, vi } from "vitest";

import { roleAtLeast } from "@/core/domain/account";
import { AppError } from "@/core/domain/errors";
import { testTenantId } from "@/core/domain/tenant-context.testing";
import type { OperatorRole } from "@/shared/operator-access";

/**
 * M1.3b — the authorisation boundary of `POST /api/posts/uploads`.
 *
 * This route writes files into a tenant's storage, so it is editor / tier M —
 * and the check happens BEFORE the multipart body is read, because buffering
 * an unauthorised caller's megabytes is the cheapest denial of service there is.
 *
 * The `tenantId` FORM FIELD is gone (doc 10 §8.12). It was the multipart twin
 * of the query/body tenant id and exactly as forgeable; a client that still
 * sends it is ignored, not refused (docs/11 §3.2).
 */

const uploadMedia = vi.fn();
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
const getOperatorSession = vi.fn();
const requireTenant = vi.fn();

vi.mock("@/composition/container", async (importOriginal) => {
  // The real module is kept for MAX_UPLOAD_BYTES / MAX_UPLOADS_PER_POST, which
  // `read-upload-form` reads at import time; only the container is swapped.
  const actual = await importOriginal<typeof import("@/composition/container")>();
  return {
    ...actual,
    getContainer: () => ({
      logger,
      config: { NODE_ENV: "test" },
      usecases: { uploadMedia, requireTenant },
    }),
  };
});

vi.mock("@/app/_auth/session", () => ({
  getOperatorSession: (...args: unknown[]) => getOperatorSession(...(args as [])),
}));

const { POST } = await import("./route");
const { ACTIVE_TENANT_COOKIE } = await import("@/app/_lib/active-tenant-cookie");

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");
const OTHER_TENANT = "00000000-0000-0000-0000-0000000000ff";

const RESULT = {
  accepted: [
    {
      driveFileId: "upload-1",
      fileName: "a.jpg",
      kind: "image",
      sequence: 1,
      sizeBytes: 12,
    },
  ],
  rejected: [],
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

function upload(
  build: (form: FormData) => void = () => {},
  cookieTenantId: string | null = TENANT,
): Request {
  const form = new FormData();
  form.set("productCode", "MGKVX6310");
  form.append("files", new File([new Uint8Array(12)], "a.jpg", { type: "image/jpeg" }));
  build(form);

  const headers = new Headers();
  if (cookieTenantId) headers.set("cookie", `${ACTIVE_TENANT_COOKIE}=${cookieTenantId}`);
  return new Request("http://localhost/api/posts/uploads", {
    method: "POST",
    headers,
    body: form,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  claim = {};
  getOperatorSession.mockResolvedValue({ email: "staff@shop.vn", accountId: "acc-1" });
  uploadMedia.mockResolvedValue(RESULT);
  grantRole("editor");
});

// --- Edge cases first ---------------------------------------------------------

describe("POST /api/posts/uploads — refusals", () => {
  it("401s without a session, and stores nothing", async () => {
    getOperatorSession.mockResolvedValue(null);

    const response = await POST(upload());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "UNAUTHORIZED" });
    expect(requireTenant).not.toHaveBeenCalled();
    expect(uploadMedia).not.toHaveBeenCalled();
  });

  it("404s a selector cookie pointing at a company the account is not in", async () => {
    const response = await POST(upload(() => {}, OTHER_TENANT));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "TENANT_NOT_FOUND" });
    expect(uploadMedia).not.toHaveBeenCalled();
  });

  it("403s a viewer: uploading writes into the tenant's storage", async () => {
    grantRole("viewer");

    const response = await POST(upload());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "FORBIDDEN" });
    expect(uploadMedia).not.toHaveBeenCalled();
  });

  it("claims tier M + editor", async () => {
    await POST(upload());

    expect(claim).toEqual({ tier: "M", minRole: "editor" });
  });

  it("refuses an unauthorised caller BEFORE reading their body", async () => {
    // A body that would fail the multipart parser: if the 403 still comes back
    // (rather than a 400 about the body), the guard ran first — which is the
    // whole point of putting it above `readUploadForm`.
    grantRole("viewer");
    const response = await POST(
      new Request("http://localhost/api/posts/uploads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `${ACTIVE_TENANT_COOKIE}=${TENANT}`,
        },
        body: "{}",
      }),
    );

    expect(response.status).toBe(403);
  });

  it("400s a non-multipart body once the caller IS allowed", async () => {
    const response = await POST(
      new Request("http://localhost/api/posts/uploads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `${ACTIVE_TENANT_COOKIE}=${TENANT}`,
        },
        body: "{}",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("POST /api/posts/uploads — the intake", () => {
  it("stores under the MEMBERSHIP tenant, ignoring a forged form field", async () => {
    const response = await POST(upload((form) => form.set("tenantId", OTHER_TENANT)));

    expect(response.status).toBe(200);
    expect(uploadMedia).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, productCode: "MGKVX6310" }),
    );
  });

  it("keeps the response shape the upload screen parses", async () => {
    const response = await POST(upload());

    await expect(response.json()).resolves.toEqual({
      accepted: [
        { assetId: "upload-1", fileName: "a.jpg", kind: "image", sequence: 1, sizeBytes: 12 },
      ],
      rejected: [],
    });
  });
});
