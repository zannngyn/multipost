import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";

import { importChannelsFromSignIn, type SignInImportDeps } from "../signin-channel-import";

/**
 * M1.4 — the sign-in Page import no longer pins the demo tenant: the target is
 * the person's OWN (single) membership, admin-checked fresh. Every ambiguous
 * or under-privileged case SKIPS — a credential must never land in a guessed
 * company, and a failure must never block the sign-in itself.
 */

const TENANT = "00000000-0000-0000-0000-000000000001";
const OTHER = "00000000-0000-0000-0000-0000000000ff";

interface LogLine {
  level: string;
  message: string;
  context?: Record<string, unknown>;
}

function harness(overrides: Partial<SignInImportDeps> = {}) {
  const lines: LogLine[] = [];
  const logger: SignInImportDeps["logger"] = {
    child: () => logger,
    info: (message, context) => lines.push({ level: "info", message, context }),
    warn: (message, context) => lines.push({ level: "warn", message, context }),
    error: (message, context) => lines.push({ level: "error", message, context }),
  };
  const deps: SignInImportDeps = {
    resolveAccount: vi.fn(async () => ({
      accountId: "acc-1",
      activeMemberships: [{ tenantId: TENANT }],
    })),
    requireTenant: vi.fn(async (_session, selector) => ({
      tenantId: selector as never,
    })),
    importChannels: vi.fn(async () => ({ imported: 2, updated: 0, skipped: 1 })),
    logger,
    ...overrides,
  };
  return { deps, lines };
}

const INPUT = {
  userAccessToken: "user-token-secret",
  sessionEmail: "fb-992710700450296@facebook.local",
  facebookUserId: "992710700450296",
};

beforeEach(() => vi.clearAllMocks());

// --- Edge cases first ---------------------------------------------------------

describe("importChannelsFromSignIn — skips", () => {
  it("skips when the person has no account row (bootstrap FB admin)", async () => {
    const { deps, lines } = harness({ resolveAccount: vi.fn(async () => null) });

    await importChannelsFromSignIn(deps, INPUT);

    expect(deps.importChannels).not.toHaveBeenCalled();
    expect(lines.some((line) => line.context?.reason === "NO_MEMBERSHIP")).toBe(true);
  });

  it("skips when the account holds no active membership", async () => {
    const { deps } = harness({
      resolveAccount: vi.fn(async () => ({ accountId: "acc-1", activeMemberships: [] })),
    });

    await importChannelsFromSignIn(deps, INPUT);

    expect(deps.importChannels).not.toHaveBeenCalled();
  });

  it("refuses to GUESS between several companies", async () => {
    const { deps, lines } = harness({
      resolveAccount: vi.fn(async () => ({
        accountId: "acc-1",
        activeMemberships: [{ tenantId: TENANT }, { tenantId: OTHER }],
      })),
    });

    await importChannelsFromSignIn(deps, INPUT);

    expect(deps.requireTenant).not.toHaveBeenCalled();
    expect(deps.importChannels).not.toHaveBeenCalled();
    expect(lines.some((line) => line.context?.reason === "AMBIGUOUS_TENANT")).toBe(true);
  });

  it("skips (does not throw) when the person is below admin — sign-in stands", async () => {
    const { deps, lines } = harness({
      requireTenant: vi.fn(async () => {
        throw new AppError("FORBIDDEN");
      }),
    });

    await expect(importChannelsFromSignIn(deps, INPUT)).resolves.toBeUndefined();

    expect(deps.importChannels).not.toHaveBeenCalled();
    expect(lines.some((line) => line.context?.reason === "ROLE_BELOW_ADMIN")).toBe(true);
    expect(lines.some((line) => line.level === "error")).toBe(false);
  });

  it("logs (never throws) when the import itself fails", async () => {
    const { deps, lines } = harness({
      importChannels: vi.fn(async () => {
        throw new AppError("META_ERROR");
      }),
    });

    await expect(importChannelsFromSignIn(deps, INPUT)).resolves.toBeUndefined();
    expect(lines.some((line) => line.level === "error")).toBe(true);
  });
});

// --- Happy path ---------------------------------------------------------------

describe("importChannelsFromSignIn — the one-company case", () => {
  it("imports into the person's OWN tenant, admin-checked fresh, without an e-mail", async () => {
    const { deps, lines } = harness();

    await importChannelsFromSignIn(deps, INPUT);

    expect(deps.requireTenant).toHaveBeenCalledWith(
      { accountId: "acc-1", email: INPUT.sessionEmail },
      TENANT,
      { tier: "S", minRole: "admin" },
    );
    expect(deps.importChannels).toHaveBeenCalledWith({
      tenantId: TENANT,
      userAccessToken: "user-token-secret",
      actorEmail: null,
    });
    // The skipped count travels into the log (business rule 5 — never silent).
    expect(
      lines.some((line) => line.level === "info" && line.context?.skipped === 1),
    ).toBe(true);
  });
});
