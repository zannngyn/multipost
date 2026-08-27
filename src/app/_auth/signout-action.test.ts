import { beforeEach, describe, expect, it, vi } from "vitest";

import { ACTIVE_TENANT_COOKIE } from "@/app/_lib/active-tenant-cookie";

/**
 * Signing out must take the active-tenant SELECTOR with it.
 *
 * The cookie is not a credential and lives 30 days, so leaving it behind handed
 * the NEXT account signing in on this browser a company it has never been in —
 * and every tenant-scoped route answered 404 at once. The order matters as much
 * as the deletion: `signOut()` throws NEXT_REDIRECT, so anything sequenced
 * after it never runs.
 */

const calls: string[] = [];
const deleteMock = vi.fn((...args: unknown[]) => {
  calls.push("delete");
  return args;
});
const signOutMock = vi.fn(async (_options: { redirectTo: string }) => {
  calls.push("signOut");
});

vi.mock("next/headers", () => ({
  cookies: async () => ({ delete: deleteMock }),
}));

vi.mock("@/app/_auth/auth", () => ({
  signOut: (options: { redirectTo: string }) => signOutMock(options),
}));

const { signOutOperator } = await import("./signout-action");

beforeEach(() => {
  calls.length = 0;
  deleteMock.mockClear();
  signOutMock.mockClear();
  signOutMock.mockImplementation(async () => {
    calls.push("signOut");
  });
});

describe("signOutOperator", () => {
  // --- Edge case first: the normal path IS an exception ----------------------
  it("clears the selector even though signOut throws NEXT_REDIRECT, and lets the signal travel", async () => {
    const redirectSignal = new Error("NEXT_REDIRECT");
    signOutMock.mockImplementation(async () => {
      calls.push("signOut");
      throw redirectSignal;
    });

    await expect(signOutOperator()).rejects.toBe(redirectSignal);
    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["delete", "signOut"]);
  });

  it("deletes the selector by name and path — not a rewrite with an empty value", async () => {
    await signOutOperator();
    expect(deleteMock).toHaveBeenCalledWith({ name: ACTIVE_TENANT_COOKIE, path: "/" });
  });

  it("sends the operator to /signin", async () => {
    await signOutOperator();
    expect(signOutMock).toHaveBeenCalledWith({ redirectTo: "/signin" });
  });
});
