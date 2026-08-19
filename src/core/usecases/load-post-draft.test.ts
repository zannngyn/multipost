import { describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";
import { POST_DRAFT_SCHEMA_VERSION } from "@/core/domain/post-draft";
import type { Logger } from "@/core/ports/infra";

import {
  dbOutage,
  expectPersisted,
  makeInMemoryPostDraftRepo,
  makeInMemoryUserRepo,
  seedRawDraft,
  validComposeDraftPayload,
} from "./__fixtures__/post-draft";
import { makeLoadPostDraft } from "./load-post-draft";

const TENANT = "00000000-0000-0000-0000-000000000001";
const OTHER_TENANT = "00000000-0000-0000-0000-000000000002";
const OWNER = "00000000-0000-0000-0000-0000000000aa";
const OTHER_OWNER = "00000000-0000-0000-0000-0000000000bb";
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
  const load = vi.spyOn(drafts, "load");
  return { run: makeLoadPostDraft({ drafts, users, logger }), drafts, users, logger, load };
}

describe("loadPostDraft — edge cases first", () => {
  it.each(["", "   ", "not-a-uuid"])(
    "rejects tenant id %s before touching the repo",
    async (tenantId) => {
      const harness = makeHarness();
      await expect(harness.run({ tenantId, ownerUserId: OWNER })).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
      expect(harness.load).not.toHaveBeenCalled();
    },
  );

  // Blank counts as GIVEN — see the same case in save/discard.
  it.each(["not-a-uuid", "", "   "])(
    "rejects an owner user id that is given but malformed (%j)",
    async (ownerUserId) => {
      const harness = makeHarness();
      await expect(harness.run({ tenantId: TENANT, ownerUserId })).rejects.toMatchObject({
        code: "INVALID_INPUT",
        context: { reason: "INVALID_OWNER_USER_ID" },
      });
      expect(harness.load).not.toHaveBeenCalled();
    },
  );

  it("rejects a missing input object instead of throwing TypeError", async () => {
    const harness = makeHarness();
    await expect(harness.run(undefined as never)).rejects.toBeInstanceOf(AppError);
  });

  it("says the operator has storage but no draft when nothing was ever saved", async () => {
    const harness = makeHarness();
    await expect(
      harness.run({ tenantId: TENANT, ownerUserId: OWNER }),
    ).resolves.toMatchObject({ persisted: true, draft: null });
  });

  it("ignores a draft written by another schema version, with a warn", async () => {
    const harness = makeHarness();
    await seedRawDraft(harness.drafts, {
      tenantId: TENANT,
      ownerUserId: OWNER,
      kind: KIND,
      payload: validComposeDraftPayload(),
      schemaVersion: POST_DRAFT_SCHEMA_VERSION + 1,
    });

    await expect(
      harness.run({ tenantId: TENANT, ownerUserId: OWNER }),
    ).resolves.toMatchObject({ persisted: true, draft: null });
    expect(harness.logger.warn).toHaveBeenCalledWith(
      "Stored draft ignored: schema version does not match",
      expect.objectContaining({
        reason: "SCHEMA_VERSION_MISMATCH",
        stored_schema_version: POST_DRAFT_SCHEMA_VERSION + 1,
        expected_schema_version: POST_DRAFT_SCHEMA_VERSION,
      }),
    );
  });

  it("ignores a stored payload that no longer matches the shape, with a warn", async () => {
    const harness = makeHarness();
    await seedRawDraft(harness.drafts, {
      tenantId: TENANT,
      ownerUserId: OWNER,
      kind: KIND,
      payload: { step: "caption" },
    });

    await expect(
      harness.run({ tenantId: TENANT, ownerUserId: OWNER }),
    ).resolves.toMatchObject({ persisted: true, draft: null });
    expect(harness.logger.warn).toHaveBeenCalledWith(
      "Stored draft ignored: payload no longer matches the draft shape",
      expect.objectContaining({ code: "DRAFT_PAYLOAD_REJECTED" }),
    );
  });

  it("ignores a hand-edited row that smuggled a forbidden key in", async () => {
    const harness = makeHarness();
    await seedRawDraft(harness.drafts, {
      tenantId: TENANT,
      ownerUserId: OWNER,
      kind: KIND,
      payload: { ...validComposeDraftPayload(), price: 120000 },
    });

    await expect(
      harness.run({ tenantId: TENANT, ownerUserId: OWNER }),
    ).resolves.toMatchObject({ persisted: true, draft: null });
    expect(harness.logger.warn).toHaveBeenCalledWith(
      "Stored draft ignored: payload no longer matches the draft shape",
      expect.objectContaining({ context: expect.objectContaining({ reason: "FORBIDDEN_KEY" }) }),
    );
  });

  it("propagates a repo DB_ERROR instead of pretending there is no draft", async () => {
    const harness = makeHarness();
    harness.drafts.failNext("load", dbOutage());

    await expect(harness.run({ tenantId: TENANT, ownerUserId: OWNER })).rejects.toMatchObject({
      code: "DB_ERROR",
    });
  });
});

describe("loadPostDraft — tenant and owner isolation (business rule 7)", () => {
  it("does not return a draft belonging to another tenant", async () => {
    const harness = makeHarness();
    await seedRawDraft(harness.drafts, {
      tenantId: TENANT,
      ownerUserId: OWNER,
      kind: KIND,
      payload: validComposeDraftPayload({ productCode: "AB123" }),
    });

    await expect(
      harness.run({ tenantId: OTHER_TENANT, ownerUserId: OWNER }),
    ).resolves.toMatchObject({ persisted: true, draft: null });
  });

  it("does not return a draft belonging to another operator", async () => {
    const harness = makeHarness();
    await seedRawDraft(harness.drafts, {
      tenantId: TENANT,
      ownerUserId: OWNER,
      kind: KIND,
      payload: validComposeDraftPayload({ productCode: "AB123" }),
    });

    await expect(
      harness.run({ tenantId: TENANT, ownerUserId: OTHER_OWNER }),
    ).resolves.toMatchObject({ persisted: true, draft: null });
  });
});

describe("loadPostDraft — owner resolution (NO_USER is an answer, not a failure)", () => {
  it.each([
    ["no identity at all", {}],
    ["a blank e-mail", { ownerEmail: "   " }],
    ["a null e-mail", { ownerEmail: null }],
    ["a null owner id with no e-mail", { ownerUserId: null }],
    ["an e-mail no app_user row matches", { ownerEmail: "khach@mysp.vn" }],
  ])("answers persisted:false / NO_USER for %s, and reads nothing", async (_label, owner) => {
    const harness = makeHarness();

    await expect(harness.run({ tenantId: TENANT, ...owner })).resolves.toEqual({
      persisted: false,
      reason: "NO_USER",
    });
    expect(harness.load).not.toHaveBeenCalled();
  });

  it("tells 'no storage' apart from 'storage, no draft'", async () => {
    const harness = makeHarness();

    const anonymous = await harness.run({ tenantId: TENANT, ownerEmail: "khach@mysp.vn" });
    const known = await harness.run({ tenantId: TENANT, ownerEmail: OWNER_EMAIL });

    expect(anonymous).toEqual({ persisted: false, reason: "NO_USER" });
    expect(known).toEqual({ persisted: true, ownerUserId: OWNER, draft: null });
  });

  it("logs why nothing was read from the server", async () => {
    const harness = makeHarness();

    await harness.run({ tenantId: TENANT, ownerEmail: "khach@mysp.vn" });

    expect(harness.logger.warn).toHaveBeenCalledWith(
      "Draft is not server-side: no app_user matches this operator",
      expect.objectContaining({ reason: "NO_USER", persisted: false }),
    );
  });

  // Unlike discard, a failed lookup here is NOT escalated: not opening a server
  // draft costs retyping, throwing would block the compose screen. The log still
  // names the real reason so the outage is not invisible.
  it("degrades to the browser buffer on a lookup outage, and says LOOKUP_FAILED", async () => {
    const harness = makeHarness();
    harness.users.failNext(dbOutage());

    await expect(harness.run({ tenantId: TENANT, ownerEmail: OWNER_EMAIL })).resolves.toEqual({
      persisted: false,
      reason: "NO_USER",
    });
    expect(harness.load).not.toHaveBeenCalled();
    expect(harness.logger.warn).toHaveBeenCalledWith(
      "Draft owner lookup failed — this draft cannot be addressed",
      expect.objectContaining({ reason: "LOOKUP_FAILED", persisted: false }),
    );
  });

  it("reads the draft of the app_user resolved from the session e-mail", async () => {
    const harness = makeHarness();
    const payload = validComposeDraftPayload({ productCode: "AB123" });
    await seedRawDraft(harness.drafts, {
      tenantId: TENANT,
      ownerUserId: OWNER,
      kind: KIND,
      payload,
    });

    const result = expectPersisted(
      await harness.run({ tenantId: TENANT, ownerEmail: OWNER_EMAIL.toUpperCase() }),
    );

    expect(result.ownerUserId).toBe(OWNER);
    expect(result.draft?.payload).toEqual(payload);
  });
});

describe("loadPostDraft — happy path", () => {
  it("returns the payload as typed plus an ISO updatedAt", async () => {
    const harness = makeHarness();
    const payload = validComposeDraftPayload();
    await seedRawDraft(harness.drafts, {
      tenantId: TENANT,
      ownerUserId: OWNER,
      kind: KIND,
      payload,
    });

    const result = expectPersisted(
      await harness.run({ tenantId: ` ${TENANT} `, ownerUserId: OWNER }),
    );

    expect(result.ownerUserId).toBe(OWNER);
    expect(result.draft).toMatchObject({ payload, schemaVersion: POST_DRAFT_SCHEMA_VERSION });
    expect(new Date(result.draft?.updatedAt ?? "").toISOString()).toBe(result.draft?.updatedAt);
    expect(harness.load).toHaveBeenCalledWith(TENANT, OWNER, KIND);
  });
});
