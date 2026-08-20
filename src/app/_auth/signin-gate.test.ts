import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Who gets in, and on whose authority — M2.4 edition.
 *
 * DELIBERATE BEHAVIOUR CHANGES vs the M1 suite (docs/09 M2.4 — the approval
 * queue is retired; each old test's fate is recorded here):
 *   - "holds a domain match for approval / files it as pending"  → REPLACED:
 *     a stranger now gets an ACCOUNT provisioned and is let in (NoMembership);
 *   - "registry approved → in" / "registry blocked → out"        → REMOVED:
 *     the registry is no longer consulted at sign-in at all; membership and
 *     `account.status` decide;
 *   - "approved-but-no-membership drift → held at the door"      → REMOVED:
 *     no_membership is a VALID signed-in state now;
 *   - "?error=pending_approval redirect"                          → REMOVED:
 *     nothing is pending anymore.
 * UNCHANGED: env reject (domain filter, unverified e-mail, unknown provider),
 * bootstrap escape hatch, suspended ban, the PROVIDER_SUB_MISMATCH guard
 * (`rejected`), fail-closed on DB errors.
 */

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

type AccountKind = "unknown" | "rejected" | "suspended" | "no_membership" | "member";

function harness(options: { account?: AccountKind; failing?: boolean } = {}) {
  const lines: LogLine[] = [];
  const signInAccount = vi.fn(async (): Promise<{ kind: AccountKind }> => {
    if (options.failing) throw new Error("connection refused");
    return { kind: options.account ?? "unknown" };
  });
  const provisionAccount = vi.fn(async () => {
    if (options.failing) throw new Error("connection refused");
    return { accountId: "acc-new" };
  });
  const deps = {
    signInAccount,
    provisionAccount,
    logger: {
      warn: (message: string, context?: Record<string, unknown>) =>
        lines.push({ level: "warn", message, context }),
      error: (message: string, context?: Record<string, unknown>) =>
        lines.push({ level: "error", message, context }),
      info: (message: string, context?: Record<string, unknown>) =>
        lines.push({ level: "info", message, context }),
    },
  };
  return { deps, signInAccount, provisionAccount, lines };
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

// --- The M2.4 core: strangers are provisioned, not queued ----------------------

describe("first sign-in — provisioning replaces the approval queue", () => {
  it("PROVISIONS a brand-new identity and lets them in (NoMembership state)", async () => {
    const { deps, provisionAccount } = harness({ account: "unknown" });
    const decideSignIn = await loadGate();

    await expect(decideSignIn(deps, googleUser)).resolves.toBe(true);
    expect(provisionAccount).toHaveBeenCalledWith({
      provider: "google",
      providerAccountId: "sub-1",
      email: "worker@mysp.vn",
      displayName: "Worker",
    });
  });

  it("lets an account with NO membership in — the lobby is a valid state now", async () => {
    const { deps, provisionAccount } = harness({ account: "no_membership" });
    const decideSignIn = await loadGate();

    await expect(decideSignIn(deps, googleUser)).resolves.toBe(true);
    expect(provisionAccount).not.toHaveBeenCalled(); // already exists
  });

  it("lets a member in without provisioning", async () => {
    const { deps, provisionAccount } = harness({ account: "member" });
    const decideSignIn = await loadGate();
    await expect(decideSignIn(deps, googleUser)).resolves.toBe(true);
    expect(provisionAccount).not.toHaveBeenCalled();
  });

  it("applies NO domain filter when the list is blank — anyone verified may enter the lobby", async () => {
    vi.stubEnv("AUTH_ALLOWED_DOMAINS", "");
    const { deps } = harness({ account: "unknown" });
    const decideSignIn = await loadGate();
    await expect(
      decideSignIn(deps, { ...googleUser, email: "outsider@gmail.com" }),
    ).resolves.toBe(true);
  });
});

// --- Refusals that SURVIVE the retirement --------------------------------------

describe("sign-in refusals — unchanged by M2.4", () => {
  it("refuses a SUSPENDED account — the only ban left until M3.1's platform switch", async () => {
    const { deps, provisionAccount } = harness({ account: "suspended" });
    const decideSignIn = await loadGate();

    await expect(decideSignIn(deps, googleUser)).resolves.toBe(false);
    expect(provisionAccount).not.toHaveBeenCalled();
  });

  it("refuses a REJECTED identity (recycled address, PROVIDER_SUB_MISMATCH) — and never provisions over it", async () => {
    // Provisioning here would collide with identity_session_email_uq — and
    // hand the newcomer the old owner's address row.
    const { deps, provisionAccount } = harness({ account: "rejected" });
    const decideSignIn = await loadGate();

    await expect(decideSignIn(deps, googleUser)).resolves.toBe(false);
    expect(provisionAccount).not.toHaveBeenCalled();
  });

  it("refuses an address outside the domain filter — before any DB call", async () => {
    const { deps, signInAccount } = harness();
    const decideSignIn = await loadGate();

    await expect(
      decideSignIn(deps, { ...googleUser, email: "stranger@elsewhere.com" }),
    ).resolves.toBe(false);
    expect(signInAccount).not.toHaveBeenCalled();
  });

  it("refuses an unverified Google e-mail even inside the domain", async () => {
    const { deps } = harness();
    const decideSignIn = await loadGate();
    await expect(decideSignIn(deps, { ...googleUser, emailVerified: false })).resolves.toBe(false);
  });

  it("refuses an unsupported provider", async () => {
    const { deps } = harness();
    const decideSignIn = await loadGate();
    await expect(decideSignIn(deps, { ...googleUser, provider: "github" })).resolves.toBe(false);
  });

  it("refuses a payload with no provider account id — nothing can be filed", async () => {
    const { deps, signInAccount } = harness();
    const decideSignIn = await loadGate();
    await expect(decideSignIn(deps, { ...googleUser, providerAccountId: "" })).resolves.toBe(false);
    expect(signInAccount).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED when the database cannot be reached", async () => {
    const { deps, lines } = harness({ failing: true });
    const decideSignIn = await loadGate();

    await expect(decideSignIn(deps, googleUser)).resolves.toBe(false);
    expect(lines.some((line) => line.level === "error")).toBe(true);
  });
});

// --- The escape hatch ----------------------------------------------------------

describe("AUTH_BOOTSTRAP_ADMINS is still the escape hatch", () => {
  it("lets an exact address in and FILES them in the account tables", async () => {
    const { deps, provisionAccount } = harness({ account: "unknown" });
    const decideSignIn = await loadGate();

    await expect(decideSignIn(deps, { ...googleUser, email: "boss@mysp.vn" })).resolves.toBe(true);
    expect(provisionAccount).toHaveBeenCalledTimes(1);
  });

  it("lets the bootstrap admin in even when the database is down — loudly", async () => {
    const { deps, lines } = harness({ failing: true });
    const decideSignIn = await loadGate();

    await expect(decideSignIn(deps, { ...googleUser, email: "boss@mysp.vn" })).resolves.toBe(true);
    expect(lines.some((line) => line.level === "error")).toBe(true);
  });

  it("lets an allow-listed Facebook id in through the env, no DB required", async () => {
    const { deps } = harness({ failing: true });
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

  it("an unlisted Facebook id goes through the normal account path", async () => {
    const { deps, provisionAccount } = harness({ account: "unknown" });
    const decideSignIn = await loadGate();

    await expect(
      decideSignIn(deps, {
        provider: "facebook",
        providerAccountId: "111222333",
        email: null,
        emailVerified: undefined,
        displayName: "",
      }),
    ).resolves.toBe(true); // provisioned into the lobby, like everyone else
    expect(provisionAccount).toHaveBeenCalled();
  });
});
