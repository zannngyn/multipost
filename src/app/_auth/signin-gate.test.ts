import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testTenantId } from "@/core/domain/tenant-context.testing";

/**
 * Who gets in, and on whose authority (E1.4).
 *
 * The rule this file exists to keep: AUTH_ALLOWED_DOMAINS is a FILTER, not a
 * grant. A domain covers an open-ended set of people, so matching it must leave
 * the operator in the approval queue — anything else makes every colleague an
 * admin nobody can block. Only the exact-address / exact-id lists grant.
 */

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");

const ENV = {
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
  AUTH_ALLOWED_DOMAINS: "mysp.vn",
  AUTH_BOOTSTRAP_ADMINS: "boss@mysp.vn",
  AUTH_FACEBOOK_ALLOWED_USER_IDS: "992710700450296",
  SESSION_SECRET: "x".repeat(40),
};

interface LogLine {
  level: string;
  message: string;
  context?: Record<string, unknown>;
}

type AccountKind = "unknown" | "suspended" | "no_membership" | "member";

function harness(
  status = "pending",
  options: { failing?: boolean; account?: AccountKind } = {},
) {
  const lines: LogLine[] = [];
  const register = vi.fn(async () => {
    if (options.failing) throw new Error("connection refused");
    return { status };
  });
  // M1.2: the account tables answer first; `unknown` falls through to the
  // legacy registry flow, which is what the pre-M1.2 tests exercised.
  const signInAccount = vi.fn(async (): Promise<{ kind: AccountKind }> => {
    if (options.failing) throw new Error("connection refused");
    return { kind: options.account ?? "unknown" };
  });
  const deps = {
    tenantId: TENANT,
    signInAccount,
    register,
    logger: {
      warn: (message: string, context?: Record<string, unknown>) =>
        lines.push({ level: "warn", message, context }),
      error: (message: string, context?: Record<string, unknown>) =>
        lines.push({ level: "error", message, context }),
    },
  };
  return { deps, register, signInAccount, lines };
}

const googleUser = {
  provider: "google",
  providerAccountId: "sub-1",
  email: "worker@mysp.vn",
  emailVerified: true,
  displayName: "Worker",
};

async function loadGate() {
  // Fresh import per test: auth.config caches the parsed env per module load.
  const gateModule = await import("./signin-gate");
  return gateModule.decideSignIn;
}

beforeEach(() => {
  vi.resetModules();
  for (const [key, value] of Object.entries(ENV)) vi.stubEnv(key, value);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// --- The domain list grants nothing -----------------------------------------

describe("AUTH_ALLOWED_DOMAINS is a filter, not a grant", () => {
  it("holds a domain match that is not in the registry, and FILES it for approval", async () => {
    const { deps, register } = harness("pending");
    const decideSignIn = await loadGate();

    // The redirect code the sign-in screen reads (src/app/signin/page.tsx).
    await expect(decideSignIn(deps, googleUser)).resolves.toBe("/signin?error=pending_approval");
    // Filed, so the admin has a row to act on instead of hunting a log line.
    expect(register).toHaveBeenCalledWith({
      tenantId: TENANT,
      provider: "google",
      providerAccountId: "sub-1",
      email: "worker@mysp.vn",
      displayName: "Worker",
    });
  });

  it("lets a domain match in once they hold an active membership", async () => {
    // Post-M1.2 an approval WRITES a membership (decide wiring), so "approved"
    // manifests as the account tables answering `member`.
    const { deps, register } = harness("approved", { account: "member" });
    const decideSignIn = await loadGate();
    await expect(decideSignIn(deps, googleUser)).resolves.toBe(true);
    // The membership decided — the legacy registry was not even consulted.
    expect(register).not.toHaveBeenCalled();
  });

  it("holds at the door when the registry says approved but no membership exists (drift)", async () => {
    // Pre-M1.2 approval the backfill missed / a failed provision: letting them
    // in would mint a session getOperatorSession refuses — a redirect loop.
    const { deps, lines } = harness("approved", { account: "unknown" });
    const decideSignIn = await loadGate();
    await expect(decideSignIn(deps, googleUser)).resolves.toBe("/signin?error=pending_approval");
    expect(lines.some((line) => line.level === "error")).toBe(true);
  });

  it("refuses a suspended account outright — the registry cannot rescue it", async () => {
    const { deps, register } = harness("approved", { account: "suspended" });
    const decideSignIn = await loadGate();
    await expect(decideSignIn(deps, googleUser)).resolves.toBe(false);
    expect(register).not.toHaveBeenCalled();
  });

  it("refuses a domain match the registry has blocked", async () => {
    const { deps, lines } = harness("blocked");
    const decideSignIn = await loadGate();

    await expect(decideSignIn(deps, googleUser)).resolves.toBe(false);
    expect(lines.some((line) => line.context?.access_status === "blocked")).toBe(true);
  });

  it("refuses an address outside the domain filter — before any registry call", async () => {
    const { deps, register } = harness("approved");
    const decideSignIn = await loadGate();

    await expect(
      decideSignIn(deps, { ...googleUser, email: "stranger@elsewhere.com" }),
    ).resolves.toBe(false);
    expect(register).not.toHaveBeenCalled();
  });

  it("applies NO domain filter when the list is blank — the membership decides", async () => {
    vi.stubEnv("AUTH_ALLOWED_DOMAINS", "");
    const { deps } = harness("approved", { account: "member" });
    const decideSignIn = await loadGate();

    await expect(
      decideSignIn(deps, { ...googleUser, email: "outsider@gmail.com" }),
    ).resolves.toBe(true);
  });

  it("still holds an unknown identity when there is no domain filter", async () => {
    vi.stubEnv("AUTH_ALLOWED_DOMAINS", "");
    const { deps } = harness("pending");
    const decideSignIn = await loadGate();

    await expect(
      decideSignIn(deps, { ...googleUser, email: "outsider@gmail.com" }),
    ).resolves.toBe("/signin?error=pending_approval");
  });
});

// --- The escape hatch --------------------------------------------------------

describe("AUTH_BOOTSTRAP_ADMINS is the escape hatch", () => {
  it("lets an exact address in with an EMPTY registry", async () => {
    const { deps } = harness("pending");
    const decideSignIn = await loadGate();

    await expect(decideSignIn(deps, { ...googleUser, email: "boss@mysp.vn" })).resolves.toBe(true);
  });

  it("files the bootstrap admin too, so the approval screen lists everyone", async () => {
    const { deps, register } = harness("pending");
    const decideSignIn = await loadGate();

    await decideSignIn(deps, { ...googleUser, email: "Boss@MYSP.vn" });
    expect(register).toHaveBeenCalledTimes(1);
  });

  it("lets the bootstrap admin in even when the registry cannot be reached", async () => {
    const { deps, lines } = harness("pending", { failing: true });
    const decideSignIn = await loadGate();

    await expect(decideSignIn(deps, { ...googleUser, email: "boss@mysp.vn" })).resolves.toBe(true);
    // Loud, never silent: the row could not be written.
    expect(lines.some((line) => line.level === "error")).toBe(true);
  });

  it("lets an allow-listed Facebook id in without a registry row", async () => {
    const { deps } = harness("pending");
    const decideSignIn = await loadGate();

    await expect(
      decideSignIn(deps, {
        provider: "facebook",
        providerAccountId: "992710700450296",
        email: null,
        emailVerified: undefined,
        displayName: "Boss FB",
      }),
    ).resolves.toBe(true);
  });

  it("holds another Facebook account for approval", async () => {
    const { deps } = harness("pending");
    const decideSignIn = await loadGate();

    await expect(
      decideSignIn(deps, {
        provider: "facebook",
        providerAccountId: "111222333",
        email: null,
        emailVerified: undefined,
        displayName: "",
      }),
    ).resolves.toBe("/signin?error=pending_approval");
  });
});

// --- Refusals ----------------------------------------------------------------

describe("sign-in refusals", () => {
  it("refuses an unverified Google e-mail even inside the domain", async () => {
    const { deps, register } = harness("approved");
    const decideSignIn = await loadGate();

    await expect(decideSignIn(deps, { ...googleUser, emailVerified: false })).resolves.toBe(false);
    expect(register).not.toHaveBeenCalled();
  });

  it("refuses an unsupported provider", async () => {
    const { deps } = harness("approved");
    const decideSignIn = await loadGate();

    await expect(decideSignIn(deps, { ...googleUser, provider: "github" })).resolves.toBe(false);
  });

  it("refuses a payload with no provider account id — nothing can be filed", async () => {
    const { deps, register } = harness("approved");
    const decideSignIn = await loadGate();

    await expect(decideSignIn(deps, { ...googleUser, providerAccountId: "" })).resolves.toBe(false);
    expect(register).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED when the registry cannot be read for a non-bootstrap operator", async () => {
    const { deps, lines } = harness("approved", { failing: true });
    const decideSignIn = await loadGate();

    await expect(decideSignIn(deps, googleUser)).resolves.toBe(false);
    expect(lines.some((line) => line.level === "error")).toBe(true);
  });
});
