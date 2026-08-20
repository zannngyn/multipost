import { and, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import type { LogBindings, LogContext, Logger } from "@/core/ports/infra";

import { makeDbHandle } from "./client";
import { accounts, identities, memberships, tenants, users } from "./schema";
import { seed } from "./seed";
import { DEMO_TENANT_ID, DEMO_USER_EMAIL, DEV_BYPASS_EMAIL } from "./seed-constants";

/**
 * The seed writes to the REAL demo tenant — it cannot be rolled back, because
 * `seed()` owns its own transaction. That is fine: converging the demo tenant is
 * what the seed is for, and every assertion here describes the state a developer
 * wants the database left in.
 *
 * What is being proven is the M1.1 half: the demo tenant is on the `internal`
 * plan, and BOTH logins (`demo@mysp.local` and the dev bypass `dev@localhost`)
 * come out with account -> identity -> membership -> app_user wired end to end.
 * Without that chain, M1.2 turns the dev bypass into a session that can do
 * nothing (docs/08 debt B-8).
 *
 *   TEST_DATABASE_URL=postgres://... pnpm vitest run src/adapters/db/seed.write.integration.test.ts
 */

const url = process.env.TEST_DATABASE_URL;

function silentLogger(): Logger {
  const make = (): Logger => ({
    child: (_bindings: LogBindings) => make(),
    debug: (_message: string, _context?: LogContext) => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  });
  return make();
}

describe.skipIf(!url)("seed — M1.1 identity chain", () => {
  const handle = makeDbHandle({ url: url ?? "postgres://unused", maxPoolSize: 3 });

  afterAll(async () => {
    await handle.close();
  });

  const chain = async () =>
    handle.db
      .select({
        email: users.email,
        userRole: users.role,
        accountId: users.accountId,
        accountStatus: accounts.status,
        provider: identities.provider,
        sessionEmail: identities.sessionEmail,
        membershipRole: memberships.role,
        membershipStatus: memberships.status,
        membershipVersion: memberships.version,
      })
      .from(users)
      .innerJoin(accounts, eq(accounts.id, users.accountId))
      .innerJoin(identities, eq(identities.accountId, accounts.id))
      .innerJoin(
        memberships,
        and(
          eq(memberships.accountId, accounts.id),
          // Scoped to the SEEDED tenant: on a live dev database the same
          // accounts legitimately hold memberships in self-service companies
          // (M2.1), and an unscoped join fans out. The invariant this test
          // pins is "owner of the DEMO tenant", nothing broader.
          eq(memberships.tenantId, DEMO_TENANT_ID),
        ),
      )
      // Same scoping for app_user: self-service companies (M2.1) mint their
      // own rows for these addresses on a live dev database.
      .where(
        and(
          inArray(users.email, [DEMO_USER_EMAIL, DEV_BYPASS_EMAIL]),
          eq(users.tenantId, DEMO_TENANT_ID),
        ),
      )
      .orderBy(users.email);

  it("wires both demo logins from identity to app_user and stays put on a second run", async () => {
    const first = await seed(handle.db, silentLogger());
    expect(first.operators.map((operator) => operator.email)).toEqual([
      DEMO_USER_EMAIL,
      DEV_BYPASS_EMAIL,
    ]);

    const afterFirst = await chain();
    expect(afterFirst).toHaveLength(2);
    for (const row of afterFirst) {
      expect(row.accountStatus).toBe("active");
      expect(row.provider).toBe("google");
      expect(row.sessionEmail).toBe(row.email);
      expect(row.userRole).toBe("owner");
      expect(row.membershipRole).toBe("owner");
      expect(row.membershipStatus).toBe("active");
    }

    const tenantRow = await handle.db
      .select({ plan: tenants.plan, slug: tenants.slug, status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, DEMO_TENANT_ID));
    // MYSP's own tenant: no AI spend ceiling (doc 10 §8.9).
    expect(tenantRow[0]?.plan).toBe("internal");
    expect(tenantRow[0]?.slug).toBe("demo");
    expect(tenantRow[0]?.status).toBe("active");

    // Second run: same rows, and crucially the SAME membership version — a seed
    // that bumped it every time would flush the authorization cache of every
    // process on every developer restart.
    const second = await seed(handle.db, silentLogger());
    expect(second.tenant).toBe("updated");
    expect(second.operators.every((operator) => operator.account === "updated")).toBe(true);
    expect(await chain()).toEqual(afterFirst);
  });
});
