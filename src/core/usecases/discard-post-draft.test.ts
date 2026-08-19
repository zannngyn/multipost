import { describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";
import type { Logger } from "@/core/ports/infra";

import {
  dbOutage,
  makeInMemoryPostDraftRepo,
  makeInMemoryUserRepo,
  seedRawDraft,
  validComposeDraftPayload,
} from "./__fixtures__/post-draft";
import { makeDiscardPostDraft } from "./discard-post-draft";

const TENANT = "00000000-0000-0000-0000-000000000001";
const OTHER_TENANT = "00000000-0000-0000-0000-000000000002";
const OWNER = "00000000-0000-0000-0000-0000000000aa";
const OWNER_EMAIL = "van@mysp.vn";
const KIND = "compose";

function makeLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const logger = {
    child: () => logger,
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
  } as unknown as Logger & { warn: ReturnType<typeof vi.fn> };
  return logger;
}

function makeHarness() {
  const drafts = makeInMemoryPostDraftRepo();
  const users = makeInMemoryUserRepo();
  users.add(TENANT, OWNER_EMAIL, OWNER);
  const logger = makeLogger();
  const discard = vi.spyOn(drafts, "discard");
  return { run: makeDiscardPostDraft({ drafts, users, logger }), drafts, users, logger, discard };
}

describe("discardPostDraft — edge cases first", () => {
  it.each(["", "   ", "not-a-uuid"])("rejects tenant id %s before deleting", async (tenantId) => {
    const harness = makeHarness();
    await expect(harness.run({ tenantId, ownerUserId: OWNER })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(harness.discard).not.toHaveBeenCalled();
  });

  // Blank counts as GIVEN: a caller that sends an owner field it could not fill
  // is broken, and degrading it to "no owner" would hide the bug behind a 204.
  it.each(["not-a-uuid", "", "   "])(
    "rejects an owner user id that is given but malformed (%j)",
    async (ownerUserId) => {
      const harness = makeHarness();
      await expect(harness.run({ tenantId: TENANT, ownerUserId })).rejects.toMatchObject({
        code: "INVALID_INPUT",
        context: { reason: "INVALID_OWNER_USER_ID" },
      });
      expect(harness.discard).not.toHaveBeenCalled();
    },
  );

  it("rejects a missing input object instead of throwing TypeError", async () => {
    const harness = makeHarness();
    await expect(harness.run(undefined as never)).rejects.toBeInstanceOf(AppError);
  });

  it("is a no-op when there is no draft — discarding twice is not an error", async () => {
    const harness = makeHarness();
    await seedRawDraft(harness.drafts, {
      tenantId: TENANT,
      ownerUserId: OWNER,
      kind: KIND,
      payload: validComposeDraftPayload(),
    });

    await expect(harness.run({ tenantId: TENANT, ownerUserId: OWNER })).resolves.toEqual({
      persisted: true,
      ownerUserId: OWNER,
    });
    await expect(harness.run({ tenantId: TENANT, ownerUserId: OWNER })).resolves.toEqual({
      persisted: true,
      ownerUserId: OWNER,
    });
    expect(harness.drafts.rows()).toHaveLength(0);
  });

  it("propagates a repo DB_ERROR — a draft that survives would come back on mount", async () => {
    const harness = makeHarness();
    harness.drafts.failNext("discard", dbOutage());

    await expect(harness.run({ tenantId: TENANT, ownerUserId: OWNER })).rejects.toMatchObject({
      code: "DB_ERROR",
    });
  });
});

describe("discardPostDraft — owner resolution (NO_USER is an answer, not a failure)", () => {
  it.each([
    ["no identity at all", {}],
    ["a blank e-mail", { ownerEmail: "   " }],
    ["a null e-mail", { ownerEmail: null }],
    ["a null owner id with no e-mail", { ownerUserId: null }],
    ["an e-mail no app_user row matches", { ownerEmail: "khach@mysp.vn" }],
  ])("answers persisted:false / NO_USER for %s, and deletes nothing", async (_label, owner) => {
    const harness = makeHarness();
    await seedRawDraft(harness.drafts, {
      tenantId: TENANT,
      ownerUserId: OWNER,
      kind: KIND,
      payload: validComposeDraftPayload(),
    });

    await expect(harness.run({ tenantId: TENANT, ...owner })).resolves.toEqual({
      persisted: false,
      reason: "NO_USER",
    });
    // The decisive assertion: an unowned discard must NOT delete by tenant.
    expect(harness.discard).not.toHaveBeenCalled();
    expect(harness.drafts.rows()).toHaveLength(1);
  });

  it("logs why nothing was deleted on the server", async () => {
    const harness = makeHarness();

    await harness.run({ tenantId: TENANT, ownerEmail: "khach@mysp.vn" });

    expect(harness.logger.warn).toHaveBeenCalledWith(
      "Draft is not server-side: no app_user matches this operator",
      expect.objectContaining({ reason: "NO_USER", persisted: false }),
    );
  });

  // The dangerous branch: a DB outage during the OWNER lookup used to come back
  // as NO_USER -> persisted:false -> HTTP 204. The client would then drop its
  // pending-discard marker while the row is still on the server, and the draft
  // the operator deleted would be offered again on the next mount.
  it("does not turn a lookup outage into a fake discard", async () => {
    const harness = makeHarness();
    await seedRawDraft(harness.drafts, {
      tenantId: TENANT,
      ownerUserId: OWNER,
      kind: KIND,
      payload: validComposeDraftPayload(),
    });
    harness.users.failNext(dbOutage());

    await expect(
      harness.run({ tenantId: TENANT, ownerEmail: OWNER_EMAIL }),
    ).rejects.toMatchObject({ code: "DB_ERROR" });

    // Nothing was deleted, and nothing pretended it was.
    expect(harness.discard).not.toHaveBeenCalled();
    expect(harness.drafts.rows()).toHaveLength(1);
  });

  it("keeps the lookup failure apart from NO_USER in the log", async () => {
    const harness = makeHarness();
    harness.users.failNext(dbOutage());

    await expect(harness.run({ tenantId: TENANT, ownerEmail: OWNER_EMAIL })).rejects.toBeInstanceOf(
      AppError,
    );

    expect(harness.logger.warn).toHaveBeenCalledWith(
      "Draft owner lookup failed — this draft cannot be addressed",
      expect.objectContaining({ reason: "LOOKUP_FAILED", persisted: false }),
    );
    expect(harness.logger.warn).not.toHaveBeenCalledWith(
      "Draft is not server-side: no app_user matches this operator",
      expect.anything(),
    );
  });

  it("deletes the draft of the app_user resolved from the session e-mail", async () => {
    const harness = makeHarness();
    await seedRawDraft(harness.drafts, {
      tenantId: TENANT,
      ownerUserId: OWNER,
      kind: KIND,
      payload: validComposeDraftPayload(),
    });

    await expect(
      harness.run({ tenantId: TENANT, ownerEmail: OWNER_EMAIL.toUpperCase() }),
    ).resolves.toEqual({ persisted: true, ownerUserId: OWNER });
    expect(harness.drafts.rows()).toHaveLength(0);
  });
});

describe("discardPostDraft — happy path", () => {
  it("removes only the addressed draft", async () => {
    const harness = makeHarness();
    await seedRawDraft(harness.drafts, {
      tenantId: TENANT,
      ownerUserId: OWNER,
      kind: KIND,
      payload: validComposeDraftPayload({ productCode: "AB123" }),
    });
    await seedRawDraft(harness.drafts, {
      tenantId: OTHER_TENANT,
      ownerUserId: OWNER,
      kind: KIND,
      payload: validComposeDraftPayload({ productCode: "ZZ999" }),
    });

    await harness.run({ tenantId: ` ${TENANT} `, ownerUserId: OWNER });

    const rows = harness.drafts.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toContain(OTHER_TENANT);
    expect(harness.discard).toHaveBeenCalledWith(TENANT, OWNER, KIND);
  });
});
