import { describe, expect, it } from "vitest";

import type { LogBindings, Logger } from "@/core/ports/infra";

import { accountRecord, makeFakeAccountRepo, membershipRow } from "./__fixtures__/account-repo";
import { makeResolveOperatorAccount } from "./resolve-operator-account";
import { testTenantId } from "@/core/domain/tenant-context.testing";

/** M1.2 — the account source of "được vào", including the placeholder patch. */

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
  const usecase = makeResolveOperatorAccount({ accounts, logger: silentLogger() });
  return { usecase, accounts };
}

const GOOGLE_SIGNIN = {
  provider: "google",
  providerAccountId: "real-google-sub-123",
  email: "worker@gmail.com",
};

// --- Edge cases first ---------------------------------------------------------

describe("forSignIn — refusals", () => {
  it("refuses an unsupported provider", async () => {
    const { usecase } = harness();
    await expect(
      usecase.forSignIn({ provider: "github", providerAccountId: "1" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("refuses a missing provider account id", async () => {
    const { usecase } = harness();
    await expect(
      usecase.forSignIn({ provider: "google", providerAccountId: "", email: "a@b.co" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("refuses Google without a usable e-mail — there is no session key", async () => {
    const { usecase } = harness();
    await expect(
      usecase.forSignIn({ provider: "google", providerAccountId: "sub-1", email: null }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("refuses to ADOPT an identity stored under another provider", async () => {
    // A facebook payload whose synthetic address somehow matches a google row —
    // adopting it would be the account-linking hijack; the answer is `unknown`.
    const { usecase, accounts } = harness([
      accountRecord({ sessionEmail: "fb-111@facebook.local", providerAccountId: "gsub" }),
    ]);
    const verdict = await usecase.forSignIn({ provider: "facebook", providerAccountId: "111" });
    expect(verdict.kind).toBe("unknown");
    expect(accounts.patches).toHaveLength(0);
  });
});

// --- The M1.1 obligation ------------------------------------------------------

describe("forSignIn — placeholder patch", () => {
  it("REFUSES when the stored sub is REAL and differs — recycled-address takeover", async () => {
    // Alice's identity holds her real sub; her old address was re-issued to a
    // different person, whose sign-in arrives with a different real sub.
    // Overwriting would hand them Alice's account and every membership on it.
    const { usecase, accounts } = harness([
      accountRecord({ providerAccountId: "REAL-SUB-AAA" }),
    ]);

    const verdict = await usecase.forSignIn({
      provider: "google",
      providerAccountId: "REAL-SUB-BBB",
      email: "worker@gmail.com",
    });

    expect(verdict).toEqual({ kind: "unknown" }); // no session, no adoption
    expect(accounts.patches).toHaveLength(0); // and NOTHING was overwritten
  });

  it("refuses the session when the repo could not claim the row (patch returned false)", async () => {
    const { usecase, accounts } = harness();
    // Simulate the repo refusing (row changed / sub already owned elsewhere).
    accounts.attachProviderAccountId = async () => false;

    const verdict = await usecase.forSignIn(GOOGLE_SIGNIN);

    expect(verdict).toEqual({ kind: "unknown" });
  });

  it("patches a seed:* placeholder too — same rule as legacy-app-user:*", async () => {
    const { usecase, accounts } = harness([
      accountRecord({ providerAccountId: "seed:dev-bypass" }),
    ]);

    const verdict = await usecase.forSignIn(GOOGLE_SIGNIN);

    expect(verdict.kind).toBe("member");
    expect(accounts.patches).toHaveLength(1);
  });

  it("patches a legacy-app-user placeholder with the real sub, in place", async () => {
    const { usecase, accounts } = harness();

    const verdict = await usecase.forSignIn(GOOGLE_SIGNIN);

    expect(verdict.kind).toBe("member");
    expect(accounts.patches).toEqual([
      {
        provider: "google",
        sessionEmail: "worker@gmail.com",
        providerAccountId: "real-google-sub-123",
      },
    ]);
    // Patched, not inserted: still exactly one record.
    expect(accounts.records.size).toBe(1);
  });

  it("does not touch an identity whose sub already matches", async () => {
    const { usecase, accounts } = harness([
      accountRecord({ providerAccountId: "real-google-sub-123" }),
    ]);
    await usecase.forSignIn(GOOGLE_SIGNIN);
    expect(accounts.patches).toHaveLength(0);
  });

  it("patches even when the account is then refused (suspended)", async () => {
    // The first sign-in is the only moment both address and sub are in hand —
    // a refusal must not waste it.
    const { usecase, accounts } = harness([accountRecord({ status: "suspended" })]);
    const verdict = await usecase.forSignIn(GOOGLE_SIGNIN);
    expect(verdict.kind).toBe("suspended");
    expect(accounts.patches).toHaveLength(1);
  });
});

// --- Verdicts -----------------------------------------------------------------

describe("forSignIn — verdicts", () => {
  it("answers unknown for an address nobody owns", async () => {
    const { usecase } = harness([]);
    await expect(usecase.forSignIn(GOOGLE_SIGNIN)).resolves.toEqual({ kind: "unknown" });
  });

  it("answers no_membership for an active account with zero memberships", async () => {
    const { usecase } = harness([accountRecord({ memberships: [] })]);
    const verdict = await usecase.forSignIn(GOOGLE_SIGNIN);
    expect(verdict.kind).toBe("no_membership");
  });

  it("answers member with the account attached", async () => {
    const { usecase } = harness();
    const verdict = await usecase.forSignIn(GOOGLE_SIGNIN);
    expect(verdict).toMatchObject({
      kind: "member",
      account: { accountId: "acc-1", status: "active" },
    });
  });
});

// --- Session path -------------------------------------------------------------

describe("forSession", () => {
  it("answers null for an empty or oversized address without querying", async () => {
    const { usecase } = harness();
    await expect(usecase.forSession("")).resolves.toBeNull();
    await expect(usecase.forSession("x".repeat(400))).resolves.toBeNull();
  });

  it("folds case before the lookup", async () => {
    const { usecase } = harness();
    const state = await usecase.forSession("  Worker@Gmail.COM ");
    expect(state).toMatchObject({ accountId: "acc-1" });
  });

  it("carries only ACTIVE memberships", async () => {
    const { usecase } = harness([
      accountRecord({
        memberships: [membershipRow(), membershipRow({ tenantId: testTenantId("00000000-0000-0000-0000-00000000000b"), status: "removed" })],
      }),
    ]);
    const state = await usecase.forSession("worker@gmail.com");
    expect(state?.activeMemberships).toHaveLength(1);
  });
});
