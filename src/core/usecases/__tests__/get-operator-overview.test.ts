import { describe, expect, it } from "vitest";

import type { LogBindings, Logger } from "@/core/ports/infra";

import { accountRecord, makeFakeAccountRepo, membershipRow, TENANT_X, TENANT_Y } from "../__fixtures__/account-repo";
import { makeGetOperatorOverview } from "../get-operator-overview";

/**
 * `GET /api/me`'s brain. The N6 case this file exists for: two sessions can
 * both answer `{account: null, tenants: []}` — a bootstrap admin (env grant,
 * app shell) and a genuinely new person (create-or-join screen). The
 * `isBootstrapAdmin` flag is what lets the UI tell them apart, and it must
 * survive every return path.
 */

function silentLogger(): Logger {
  const logger: Logger = {
    child: (_bindings: LogBindings) => logger,
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  return logger;
}

function harness(records = [accountRecord()]) {
  const accounts = makeFakeAccountRepo(records);
  return makeGetOperatorOverview({ accounts, logger: silentLogger() });
}

// --- The N6 distinction, on every return path --------------------------------

describe("getOperatorOverview — isBootstrapAdmin survives every branch", () => {
  it("bootstrap admin with NO account row: flag true, empty overview", async () => {
    const overview = await harness([])({
      sessionEmail: "boss@mysp.vn",
      isBootstrapAdmin: true,
    });
    expect(overview).toEqual({
      isBootstrapAdmin: true,
      account: null,
      tenants: [],
      activeTenantId: null,
    });
  });

  it("genuinely new person: SAME empty overview, flag false", async () => {
    const overview = await harness([])({
      sessionEmail: "newcomer@gmail.com",
      isBootstrapAdmin: false,
    });
    expect(overview).toMatchObject({ isBootstrapAdmin: false, account: null, tenants: [] });
  });

  it("member: flag travels alongside the account", async () => {
    const overview = await harness()({
      sessionEmail: "worker@gmail.com",
      isBootstrapAdmin: false,
    });
    expect(overview.isBootstrapAdmin).toBe(false);
    expect(overview.account).toMatchObject({ id: "acc-1" });
  });

  it("bootstrap admin WITH an account row keeps both facts", async () => {
    const overview = await harness()({
      sessionEmail: "worker@gmail.com",
      isBootstrapAdmin: true,
    });
    expect(overview).toMatchObject({ isBootstrapAdmin: true, account: { id: "acc-1" } });
  });

  it("treats a non-boolean as false — the flag is a grant, never defaulted on", async () => {
    const overview = await harness([])({
      sessionEmail: "x@y.vn",
      isBootstrapAdmin: "yes" as never,
    });
    expect(overview.isBootstrapAdmin).toBe(false);
  });
});

// --- Existing behaviour, still pinned ----------------------------------------

describe("getOperatorOverview — tenants and active selection", () => {
  it("auto-activates the single company; cookie wins only when it points at a member tenant", async () => {
    const overview = await harness()({
      sessionEmail: "worker@gmail.com",
      isBootstrapAdmin: false,
      cookieTenantId: TENANT_Y, // not a member there — ignored
    });
    expect(overview.activeTenantId).toBe(TENANT_X);
  });

  it("filters out suspended tenants", async () => {
    const overview = await harness([
      accountRecord({
        memberships: [
          membershipRow(),
          membershipRow({ tenantId: TENANT_Y, tenantStatus: "suspended" }),
        ],
      }),
    ])({ sessionEmail: "worker@gmail.com", isBootstrapAdmin: false });
    expect(overview.tenants).toHaveLength(1);
    expect(overview.tenants[0].id).toBe(TENANT_X);
  });
});
