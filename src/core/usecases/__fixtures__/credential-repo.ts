import type {
  CredentialRepo,
  PasswordCredentialRecord,
  RegisterCredentialRecord,
} from "@/core/ports/credential-repo";
import type { PasswordHasher } from "@/core/ports/password-hasher";
import { AppError } from "@/core/domain/errors";
import type { LogBindings, Logger } from "@/core/ports/infra";

/**
 * In-memory `credential` store + a fake hasher, for the password usecase tests.
 * Mirrors the real repo's contracts that the usecase actually depends on:
 * case-folded lookup, AUTH_EMAIL_TAKEN on a duplicate address, and
 * `replacePasswordHash` answering false for an account with no credential.
 */

export interface FakeCredentialRepo extends CredentialRepo {
  rows: Map<string, PasswordCredentialRecord>;
  /** Every failed-attempt write, in order — the lock-out test reads this. */
  attemptWrites: { credentialId: string; failedAttempts: number; lockedUntil: Date | null }[];
  clearedIds: string[];
}

export function credentialRow(
  overrides: Partial<PasswordCredentialRecord> = {},
): PasswordCredentialRecord {
  const email = overrides.email ?? "worker@mysp.vn";
  return {
    credentialId: "cred-1",
    accountId: "acc-1",
    email,
    // The fake hasher below treats "hash:<password>" as the digest of <password>.
    passwordHash: "hash:Str0ng!pass",
    failedAttempts: 0,
    lockedUntil: null,
    accountStatus: "active",
    sessionEmail: email,
    displayName: "Worker",
    ...overrides,
  };
}

export function makeFakeCredentialRepo(seed: PasswordCredentialRecord[] = []): FakeCredentialRepo {
  const rows = new Map<string, PasswordCredentialRecord>(
    seed.map((row) => [row.email.toLowerCase(), row]),
  );
  const attemptWrites: FakeCredentialRepo["attemptWrites"] = [];
  const clearedIds: string[] = [];

  const byId = (credentialId: string): PasswordCredentialRecord | undefined => {
    for (const row of rows.values()) if (row.credentialId === credentialId) return row;
    return undefined;
  };

  return {
    rows,
    attemptWrites,
    clearedIds,

    async findByEmail(email) {
      return rows.get(email.trim().toLowerCase()) ?? null;
    },

    async register(input: RegisterCredentialRecord) {
      const email = input.email.trim().toLowerCase();
      // Mirrors the unique index: the repo refuses, it does not overwrite.
      if (rows.has(email)) {
        throw new AppError("AUTH_EMAIL_TAKEN", {
          message: "An identity already exists for this e-mail address",
          context: { provider: "password", field: "email" },
        });
      }
      const accountId = `acc-${rows.size + 1}`;
      const credentialId = `cred-${rows.size + 1}`;
      rows.set(
        email,
        credentialRow({
          credentialId,
          accountId,
          email,
          sessionEmail: email,
          passwordHash: input.passwordHash,
          displayName: input.displayName,
        }),
      );
      return { accountId, credentialId, sessionEmail: email, displayName: input.displayName };
    },

    async recordFailedAttempt(input) {
      attemptWrites.push({ ...input });
      const row = byId(input.credentialId);
      if (!row) return;
      rows.set(row.email, {
        ...row,
        failedAttempts: input.failedAttempts,
        lockedUntil: input.lockedUntil,
      });
    },

    async clearFailedAttempts(credentialId) {
      clearedIds.push(credentialId);
      const row = byId(credentialId);
      if (!row) return;
      rows.set(row.email, { ...row, failedAttempts: 0, lockedUntil: null });
    },

    async replacePasswordHash(input) {
      for (const row of rows.values()) {
        if (row.accountId !== input.targetAccountId) continue;
        rows.set(row.email, {
          ...row,
          passwordHash: input.passwordHash,
          failedAttempts: 0,
          lockedUntil: null,
        });
        return true;
      }
      return false; // an OAuth-only account
    },
  };
}

/**
 * A hasher with the same CONTRACT and none of the cost: `hash(x) = "hash:" + x`.
 * The usecase tests are about ORDER and STATE (is the lock checked before the
 * hash, is the counter written, is the burn called) — spending 100 ms of real
 * scrypt per assertion would make them useless to run. The real algorithm has
 * its own suite in adapters/auth.
 */
export interface FakePasswordHasher extends PasswordHasher {
  burnCount: number;
}

export function makeFakePasswordHasher(): FakePasswordHasher {
  const hasher = {
    burnCount: 0,
    async hash(plain: string) {
      return `hash:${plain}`;
    },
    async verify(plain: string, stored: string) {
      return stored === `hash:${plain}`;
    },
    async burn() {
      hasher.burnCount += 1;
    },
  };
  return hasher;
}

export function silentLogger(): Logger {
  const logger: Logger = {
    child: (_bindings: LogBindings) => logger,
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  return logger;
}

/** A clock frozen at a chosen instant, movable by the test. */
export function fixedClock(startMs: number) {
  let nowMs = startMs;
  return {
    clock: {
      now: () => new Date(nowMs),
      nowMs: () => nowMs,
    },
    advance(ms: number) {
      nowMs += ms;
    },
  };
}
