import { describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";
import { POST_DRAFT_MAX_BYTES, POST_DRAFT_SCHEMA_VERSION } from "@/core/domain/post-draft";
import type { Logger } from "@/core/ports/infra";

import {
  dbOutage,
  expectPersisted,
  makeInMemoryPostDraftRepo,
  makeInMemoryUserRepo,
  validComposeDraftPayload,
} from "./__fixtures__/post-draft";
import { makeSavePostDraft } from "./save-post-draft";

const TENANT = "00000000-0000-0000-0000-000000000001";
const OTHER_TENANT = "00000000-0000-0000-0000-000000000002";
const OWNER = "00000000-0000-0000-0000-0000000000aa";
const OWNER_EMAIL = "van@mysp.vn";

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
  users.add(OTHER_TENANT, OWNER_EMAIL, OWNER);
  const logger = makeLogger();
  const save = vi.spyOn(drafts, "save");
  return { run: makeSavePostDraft({ drafts, users, logger }), drafts, users, logger, save };
}

describe("savePostDraft — edge cases first", () => {
  it.each([
    ["empty", ""],
    ["blank", "   "],
    ["malformed", "not-a-uuid"],
  ])("rejects tenant id %s before touching the repo", async (_label, tenantId) => {
    const harness = makeHarness();

    await expect(
      harness.run({ tenantId, ownerUserId: OWNER, payload: validComposeDraftPayload() }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(harness.save).not.toHaveBeenCalled();
  });

  // Blank counts as GIVEN: falling back to the e-mail path there would turn a
  // broken caller into a draft that quietly stops being stored.
  it.each(["not-a-uuid", "", "   "])(
    "rejects an owner user id that is given but malformed (%j) — that is a caller bug",
    async (ownerUserId) => {
      const harness = makeHarness();

      await expect(
        harness.run({ tenantId: TENANT, ownerUserId, payload: validComposeDraftPayload() }),
      ).rejects.toMatchObject({
        code: "INVALID_INPUT",
        context: { reason: "INVALID_OWNER_USER_ID" },
      });
      expect(harness.save).not.toHaveBeenCalled();
    },
  );

  it("rejects a missing input object instead of throwing TypeError", async () => {
    const harness = makeHarness();
    await expect(harness.run(undefined as never)).rejects.toBeInstanceOf(AppError);
    expect(harness.save).not.toHaveBeenCalled();
  });

  it.each(["price", "stock", "signedUrl", "luu_y"])(
    "refuses (never strips) a payload carrying %s and logs why",
    async (key) => {
      const harness = makeHarness();

      await expect(
        harness.run({
          tenantId: TENANT,
          ownerUserId: OWNER,
          payload: { ...validComposeDraftPayload(), [key]: "leak" },
        }),
      ).rejects.toMatchObject({
        code: "DRAFT_PAYLOAD_REJECTED",
        context: { reason: "FORBIDDEN_KEY", key },
      });

      expect(harness.save).not.toHaveBeenCalled();
      expect(harness.logger.warn).toHaveBeenCalledWith(
        "Draft save refused: payload failed validation",
        expect.objectContaining({ code: "DRAFT_PAYLOAD_REJECTED" }),
      );
    },
  );

  it("refuses an oversized payload with DRAFT_TOO_LARGE", async () => {
    const harness = makeHarness();

    await expect(
      harness.run({
        tenantId: TENANT,
        ownerUserId: OWNER,
        payload: validComposeDraftPayload({
          captions: { facebook: "x".repeat(POST_DRAFT_MAX_BYTES + 1) },
        }),
      }),
    ).rejects.toMatchObject({ code: "DRAFT_TOO_LARGE" });
    expect(harness.save).not.toHaveBeenCalled();
  });

  it("refuses a payload that is not an object at all", async () => {
    const harness = makeHarness();

    await expect(
      harness.run({ tenantId: TENANT, ownerUserId: OWNER, payload: "{}" }),
    ).rejects.toMatchObject({ code: "DRAFT_PAYLOAD_REJECTED" });
    expect(harness.save).not.toHaveBeenCalled();
  });

  it("propagates a repo DB_ERROR untouched", async () => {
    const harness = makeHarness();
    harness.drafts.failNext("save", dbOutage());

    await expect(
      harness.run({ tenantId: TENANT, ownerUserId: OWNER, payload: validComposeDraftPayload() }),
    ).rejects.toMatchObject({ code: "DB_ERROR" });
  });

  it("rejects a malformed kind instead of silently writing 'compose'", async () => {
    const harness = makeHarness();

    await expect(
      harness.run({
        tenantId: TENANT,
        ownerUserId: OWNER,
        kind: "compose draft",
        payload: validComposeDraftPayload(),
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(harness.save).not.toHaveBeenCalled();
  });
});

describe("savePostDraft — owner resolution (NO_USER is an answer, not a failure)", () => {
  it.each([
    ["no identity at all", {}],
    ["a blank e-mail", { ownerEmail: "   " }],
    ["a null e-mail", { ownerEmail: null }],
    ["a null owner id with no e-mail", { ownerUserId: null }],
    ["an e-mail no app_user row matches", { ownerEmail: "khach@mysp.vn" }],
  ])("answers persisted:false / NO_USER for %s, and writes nothing", async (_label, owner) => {
    const harness = makeHarness();

    await expect(
      harness.run({ tenantId: TENANT, ...owner, payload: validComposeDraftPayload() }),
    ).resolves.toEqual({ persisted: false, reason: "NO_USER" });
    expect(harness.save).not.toHaveBeenCalled();
  });

  it("logs why the draft stayed in the browser", async () => {
    const harness = makeHarness();

    await harness.run({
      tenantId: TENANT,
      ownerEmail: "khach@mysp.vn",
      payload: validComposeDraftPayload(),
    });

    expect(harness.logger.warn).toHaveBeenCalledWith(
      "Draft is not server-side: no app_user matches this operator",
      expect.objectContaining({ reason: "NO_USER", persisted: false }),
    );
  });

  it("does not turn a lookup outage into a fake save", async () => {
    const harness = makeHarness();
    harness.users.failNext(dbOutage());

    await expect(
      harness.run({
        tenantId: TENANT,
        ownerEmail: OWNER_EMAIL,
        payload: validComposeDraftPayload(),
      }),
    ).resolves.toEqual({ persisted: false, reason: "NO_USER" });
    expect(harness.save).not.toHaveBeenCalled();
    // Same answer as NO_USER (the draft is safe in the browser either way), but
    // the log must not claim the operator has no account.
    expect(harness.logger.warn).toHaveBeenCalledWith(
      "Draft owner lookup failed — this draft cannot be addressed",
      expect.objectContaining({ reason: "LOOKUP_FAILED", persisted: false }),
    );
  });

  it("stores under the app_user resolved from the session e-mail", async () => {
    const harness = makeHarness();

    const result = expectPersisted(
      await harness.run({
        tenantId: TENANT,
        ownerEmail: OWNER_EMAIL.toUpperCase(),
        payload: validComposeDraftPayload(),
      }),
    );

    expect(result.ownerUserId).toBe(OWNER);
    expect(harness.save).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, ownerUserId: OWNER }),
    );
  });

  it("prefers an explicit owner id and never asks the user repo", async () => {
    const harness = makeHarness();

    await harness.run({
      tenantId: TENANT,
      ownerUserId: OWNER,
      ownerEmail: "someone-else@mysp.vn",
      payload: validComposeDraftPayload(),
    });

    expect(harness.users.calls()).toHaveLength(0);
    expect(harness.save).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId: OWNER }));
  });

  it("keeps the same e-mail in two tenants apart", async () => {
    const harness = makeHarness();
    harness.users.add(OTHER_TENANT, OWNER_EMAIL, "00000000-0000-0000-0000-0000000000bb");

    const here = expectPersisted(
      await harness.run({
        tenantId: TENANT,
        ownerEmail: OWNER_EMAIL,
        payload: validComposeDraftPayload(),
      }),
    );
    const there = expectPersisted(
      await harness.run({
        tenantId: OTHER_TENANT,
        ownerEmail: OWNER_EMAIL,
        payload: validComposeDraftPayload(),
      }),
    );

    expect(here.ownerUserId).not.toBe(there.ownerUserId);
    expect(harness.drafts.rows()).toHaveLength(2);
  });
});

describe("savePostDraft — happy path", () => {
  it("stamps the current schema version and returns an ISO updatedAt", async () => {
    const harness = makeHarness();
    const payload = validComposeDraftPayload();

    const result = expectPersisted(
      await harness.run({ tenantId: TENANT, ownerUserId: OWNER, payload }),
    );

    expect(result.schemaVersion).toBe(POST_DRAFT_SCHEMA_VERSION);
    expect(new Date(result.updatedAt).toISOString()).toBe(result.updatedAt);
    expect(harness.save).toHaveBeenCalledWith({
      tenantId: TENANT,
      ownerUserId: OWNER,
      kind: "compose",
      payload,
      schemaVersion: POST_DRAFT_SCHEMA_VERSION,
    });
  });

  it("keeps ONE row when autosave fires repeatedly", async () => {
    const harness = makeHarness();

    await harness.run({
      tenantId: TENANT,
      ownerUserId: OWNER,
      payload: validComposeDraftPayload({ productCode: "AB123" }),
    });
    await harness.run({
      tenantId: TENANT,
      ownerUserId: OWNER,
      payload: validComposeDraftPayload({ productCode: "AB124" }),
    });
    const third = expectPersisted(
      await harness.run({
        tenantId: TENANT,
        ownerUserId: OWNER,
        payload: validComposeDraftPayload({ productCode: "AB125" }),
      }),
    );

    const rows = harness.drafts.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0].row.payload).toMatchObject({ productCode: "AB125" });
    expect(rows[0].row.updatedAt.toISOString()).toBe(third.updatedAt);
  });

  it("keeps drafts of the same operator in two tenants apart", async () => {
    const harness = makeHarness();

    await harness.run({
      tenantId: TENANT,
      ownerUserId: OWNER,
      payload: validComposeDraftPayload({ productCode: "AB123" }),
    });
    await harness.run({
      tenantId: OTHER_TENANT,
      ownerUserId: OWNER,
      payload: validComposeDraftPayload({ productCode: "ZZ999" }),
    });

    expect(harness.drafts.rows()).toHaveLength(2);
  });

  it("accepts a half-filled draft: autosave starts before step 1 is complete", async () => {
    const harness = makeHarness();

    await expect(
      harness.run({
        tenantId: ` ${TENANT} `,
        ownerUserId: ` ${OWNER} `,
        payload: validComposeDraftPayload({
          step: "san-pham",
          composeKey: "",
          productCode: "",
          color: "",
          captions: {},
          captionOverrides: {},
          albumOrder: [],
          selectedChannelIds: [],
        }),
      }),
    ).resolves.toMatchObject({ schemaVersion: POST_DRAFT_SCHEMA_VERSION });
    // The trimmed ids are what reached the repo.
    expect(harness.save).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, ownerUserId: OWNER }),
    );
  });
});
