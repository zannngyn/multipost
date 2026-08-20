import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { roleAtLeast } from "@/core/domain/account";
import { AppError } from "@/core/domain/errors";
import { testTenantId } from "@/core/domain/tenant-context.testing";
import type { OperatorRole } from "@/shared/operator-access";

/**
 * The ownership contract of `/api/posts/drafts`.
 *
 * DELIBERATE CHANGE (doc 10 §4.2, last field-level TODO): the draft owner is
 * the ACCOUNT, not the session e-mail. An address is an attribute of an
 * identity (docs/09 §3.1) — key ownership on it and an operator who changes
 * e-mail silently loses their work, while a colleague who inherits the old
 * address inherits the drafts. These tests assert the account key and assert
 * that the e-mail is no longer consulted at all.
 *
 * The other half of the contract is negative and is the point of the route: it
 * takes NO parameter naming another owner, so no role — admin, owner included —
 * can read or delete someone else's draft. That is proven here by the absence
 * of any such input, and by the owner always coming from the session.
 */

const findDraftOwnerUserId = vi.fn();
const loadPostDraft = vi.fn();
const savePostDraft = vi.fn();
const discardPostDraft = vi.fn();
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
const getOperatorSession = vi.fn();
const requireTenant = vi.fn();

vi.mock("@/composition/container", () => ({
  getContainer: () => ({
    logger,
    config: { NODE_ENV: "test" },
    usecases: {
      findDraftOwnerUserId,
      loadPostDraft,
      savePostDraft,
      discardPostDraft,
      requireTenant,
    },
  }),
}));

vi.mock("@/app/_auth/session", () => ({
  getOperatorSession: (...args: unknown[]) => getOperatorSession(...(args as [])),
}));

const { GET, PUT, POST, DELETE } = await import("./route");
const { ACTIVE_TENANT_COOKIE } = await import("@/app/_lib/active-tenant-cookie");

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");
const OTHER_TENANT = "00000000-0000-0000-0000-0000000000ff";
const ACCOUNT = "acc-1";
const USER_ID = "user-1";
const PAYLOAD = { step: 2, productCode: "MGKVX6310" };

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

function signIn(accountId: string | null, email = "staff@shop.vn"): void {
  getOperatorSession.mockResolvedValue({ email, accountId, platformRole: null });
}

function request(
  method: string,
  cookieTenantId: string | null = TENANT,
  body?: unknown,
): Request {
  const headers = new Headers();
  if (cookieTenantId) headers.set("cookie", `${ACTIVE_TENANT_COOKIE}=${cookieTenantId}`);
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  }
  return new Request("http://localhost/api/posts/drafts", init);
}

beforeEach(() => {
  vi.clearAllMocks();
  claim = {};
  signIn(ACCOUNT);
  findDraftOwnerUserId.mockResolvedValue(USER_ID);
  loadPostDraft.mockResolvedValue({ payload: PAYLOAD, updatedAt: "2026-08-20T03:00:00.000Z" });
  savePostDraft.mockResolvedValue({ updatedAt: "2026-08-20T03:00:00.000Z", schemaVersion: 1 });
  discardPostDraft.mockResolvedValue(undefined);
  grantRole("editor");
});

// --- Edge cases first ---------------------------------------------------------

describe("/api/posts/drafts — refusals", () => {
  it("401s every verb without a session", async () => {
    getOperatorSession.mockResolvedValue(null);

    for (const [verb, response] of [
      ["GET", await GET(request("GET"))],
      ["PUT", await PUT(request("PUT", TENANT, { payload: PAYLOAD }))],
      ["DELETE", await DELETE(request("DELETE"))],
    ] as const) {
      expect(response.status, verb).toBe(401);
    }
    expect(findDraftOwnerUserId).not.toHaveBeenCalled();
  });

  it("404s a selector cookie pointing at a company the account is not in", async () => {
    const response = await GET(request("GET", OTHER_TENANT));

    expect(response.status).toBe(404);
    expect(findDraftOwnerUserId).not.toHaveBeenCalled();
  });

  it("403s a viewer — a draft belongs to someone who composes", async () => {
    grantRole("viewer");

    const response = await GET(request("GET"));

    expect(response.status).toBe(403);
    expect(loadPostDraft).not.toHaveBeenCalled();
  });

  it("claims tier R to read and tier M to write, editor either way", async () => {
    await GET(request("GET"));
    expect(claim).toEqual({ tier: "R", minRole: "editor" });

    await PUT(request("PUT", TENANT, { payload: PAYLOAD }));
    expect(claim).toEqual({ tier: "M", minRole: "editor" });

    await DELETE(request("DELETE"));
    expect(claim).toEqual({ tier: "M", minRole: "editor" });
  });

  it("422s a payload core refuses, instead of storing internal data", async () => {
    savePostDraft.mockRejectedValue(new AppError("DRAFT_PAYLOAD_REJECTED"));

    const response = await PUT(request("PUT", TENANT, { payload: { stock: 5 } }));

    expect(response.status).toBe(422);
  });
});

describe("/api/posts/drafts — the owner is the ACCOUNT, not the e-mail", () => {
  it("addresses the draft by (tenant, accountId)", async () => {
    await GET(request("GET"));

    expect(findDraftOwnerUserId).toHaveBeenCalledWith(TENANT, ACCOUNT);
  });

  it("never passes the session e-mail as the ownership key", async () => {
    signIn(ACCOUNT, "someone@shop.vn");

    await GET(request("GET"));

    expect(findDraftOwnerUserId).not.toHaveBeenCalledWith(TENANT, "someone@shop.vn");
    expect(findDraftOwnerUserId).toHaveBeenCalledWith(TENANT, ACCOUNT);
  });

  it("gives the SAME draft to one account whose e-mail changed", async () => {
    // The regression the account key exists to prevent.
    await GET(request("GET"));
    signIn(ACCOUNT, "new.address@shop.vn");
    await GET(request("GET"));

    expect(findDraftOwnerUserId.mock.calls).toEqual([
      [TENANT, ACCOUNT],
      [TENANT, ACCOUNT],
    ]);
  });

  it("keeps two accounts on two buckets even under one address", async () => {
    signIn("acc-A");
    await GET(request("GET"));
    signIn("acc-B");
    await GET(request("GET"));

    expect(findDraftOwnerUserId.mock.calls).toEqual([
      [TENANT, "acc-A"],
      [TENANT, "acc-B"],
    ]);
  });

  it("scopes the browser's ownerKey to (tenant, app_user.id)", async () => {
    const expected = createHash("sha256")
      .update(`${TENANT}:${USER_ID}`)
      .digest("hex")
      .slice(0, 16);

    await expect((await GET(request("GET"))).json()).resolves.toMatchObject({
      ownerKey: expected,
      persisted: true,
    });
  });
});

describe("/api/posts/drafts — no server-side home is not a failure", () => {
  it("answers persisted:false when the account has no app_user row", async () => {
    // Includes the M1.1 backfill leftover whose `account_id` stayed NULL: the
    // row exists but is not reachable by account, so the draft goes local-only.
    findDraftOwnerUserId.mockResolvedValue(null);

    const response = await GET(request("GET"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      draft: null,
      updatedAt: null,
      persisted: false,
      ownerKey: null,
    });
    expect(loadPostDraft).not.toHaveBeenCalled();
  });

  it("answers 200 persisted:false on autosave rather than pretending it saved", async () => {
    findDraftOwnerUserId.mockResolvedValue(null);

    const response = await PUT(request("PUT", TENANT, { payload: PAYLOAD }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      updatedAt: null,
      persisted: false,
      reason: "NO_USER",
    });
    expect(savePostDraft).not.toHaveBeenCalled();
  });

  it("does not query at all for a session with no accountId (the dev bypass)", async () => {
    signIn(null);

    const response = await GET(request("GET"));

    expect(response.status).toBe(200);
    expect(findDraftOwnerUserId).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ persisted: false });
  });

  it("still answers 204 on discard when there is no owner", async () => {
    findDraftOwnerUserId.mockResolvedValue(null);

    const response = await DELETE(request("DELETE"));

    expect(response.status).toBe(204);
    expect(discardPostDraft).not.toHaveBeenCalled();
  });
});

describe("/api/posts/drafts — the round trip", () => {
  it("saves under the resolved owner", async () => {
    const response = await PUT(request("PUT", TENANT, { payload: PAYLOAD }));

    expect(response.status).toBe(200);
    expect(savePostDraft).toHaveBeenCalledWith({
      tenantId: TENANT,
      ownerUserId: USER_ID,
      payload: PAYLOAD,
    });
  });

  it("POST is the same handler, for sendBeacon on tab close", async () => {
    expect(POST).toBe(PUT);
  });

  it("discards under the resolved owner", async () => {
    const response = await DELETE(request("DELETE"));

    expect(response.status).toBe(204);
    expect(discardPostDraft).toHaveBeenCalledWith({ tenantId: TENANT, ownerUserId: USER_ID });
  });
});
