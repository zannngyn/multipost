import { describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";
import type { Clock, LogBindings, LogContext, Logger } from "@/core/ports/infra";
import type { CheckOperatorAccess, OperatorAccessState } from "@/core/usecases/check-operator-access";

import { makeOperatorAccessGate } from "./operator-access-gate";

/**
 * The cache is what makes a per-request status check affordable — and what
 * would make "Chặn" arrive late if it were never dropped. Both halves tested.
 */

const TENANT = "00000000-0000-0000-0000-000000000001";
const EMAIL = "fb-992710700450296@facebook.local";

const APPROVED: OperatorAccessState = { status: "approved", role: "editor", displayName: "A" };
const BLOCKED: OperatorAccessState = { status: "blocked", role: null, displayName: "A" };

function silentLogger(): Logger {
  const logger: Logger = {
    child: (_bindings: LogBindings) => logger,
    debug: (_message: string, _context?: LogContext) => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  return logger;
}

function harness(states: OperatorAccessState[] = [APPROVED, BLOCKED]) {
  let nowMs = 1_000;
  const clock: Clock = { now: () => new Date(nowMs), nowMs: () => nowMs };
  const queue = [...states];
  const statusForSessionEmail = vi.fn(async () => queue.shift() ?? BLOCKED);
  const access: CheckOperatorAccess = {
    statusForSessionEmail,
    registerAndCheck: vi.fn(async () => APPROVED),
  };

  const gate = makeOperatorAccessGate({ access, clock, logger: silentLogger(), ttlMs: 60_000 });
  return { gate, access, statusForSessionEmail, advance: (ms: number) => (nowMs += ms) };
}

describe("operator access gate", () => {
  it("reads the status once and serves the rest of the minute from memory", async () => {
    const { gate, statusForSessionEmail } = harness();

    await gate.readState(TENANT, EMAIL);
    await gate.readState(TENANT, EMAIL);

    expect(statusForSessionEmail).toHaveBeenCalledTimes(1);
  });

  it("re-reads once the TTL has passed", async () => {
    const { gate, statusForSessionEmail, advance } = harness();

    expect((await gate.readState(TENANT, EMAIL)).status).toBe("approved");
    advance(60_001);
    expect((await gate.readState(TENANT, EMAIL)).status).toBe("blocked");
    expect(statusForSessionEmail).toHaveBeenCalledTimes(2);
  });

  it("drops the cache the moment a decision is written — a block is felt now, not in a minute", async () => {
    const { gate, statusForSessionEmail } = harness();

    expect((await gate.readState(TENANT, EMAIL)).status).toBe("approved");
    gate.invalidateAll();
    expect((await gate.readState(TENANT, EMAIL)).status).toBe("blocked");
    expect(statusForSessionEmail).toHaveBeenCalledTimes(2);
  });

  it("caches per identity, not globally", async () => {
    const { gate, statusForSessionEmail } = harness();

    await gate.readState(TENANT, EMAIL);
    await gate.readState(TENANT, "someone.else@mysp.vn");

    expect(statusForSessionEmail).toHaveBeenCalledTimes(2);
  });

  // --- Edge cases -----------------------------------------------------------

  it("denies an empty address without asking the database", async () => {
    const { gate, statusForSessionEmail } = harness();
    expect(await gate.readState(TENANT, "   ")).toEqual({
      status: "unknown",
      role: null,
      displayName: null,
    });
    expect(statusForSessionEmail).not.toHaveBeenCalled();
  });

  it("denies (never throws) when the registry cannot be read, and caches nothing", async () => {
    let calls = 0;
    const access: CheckOperatorAccess = {
      registerAndCheck: vi.fn(),
      statusForSessionEmail: vi.fn(async () => {
        calls += 1;
        throw new AppError("DB_ERROR", { message: "connection refused" });
      }),
    };
    const gate = makeOperatorAccessGate({
      access,
      clock: { now: () => new Date(0), nowMs: () => 0 },
      logger: silentLogger(),
    });

    expect((await gate.readState(TENANT, EMAIL)).status).toBe("unknown");
    expect((await gate.readState(TENANT, EMAIL)).status).toBe("unknown");
    expect(calls).toBe(2);
  });

  it("clears the cache when a new identity signs in", async () => {
    const { gate, statusForSessionEmail } = harness();

    await gate.readState(TENANT, EMAIL);
    await gate.register({ tenantId: TENANT, provider: "facebook", providerAccountId: "1" });
    await gate.readState(TENANT, EMAIL);

    expect(statusForSessionEmail).toHaveBeenCalledTimes(2);
  });
});
