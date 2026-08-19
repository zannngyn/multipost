import { describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";
import { POST_DRAFT_SCHEMA_VERSION } from "@/core/domain/post-draft";
import type { Logger } from "@/core/ports/infra";

import {
  dbOutage,
  makeInMemoryPostDraftRepo,
  seedRawDraft,
  validComposeDraftPayload,
} from "./__fixtures__/post-draft";
import { makeLoadPostDraft } from "./load-post-draft";

const TENANT = "00000000-0000-0000-0000-000000000001";
const OTHER_TENANT = "00000000-0000-0000-0000-000000000002";
const OWNER = "00000000-0000-0000-0000-0000000000aa";
const OTHER_OWNER = "00000000-0000-0000-0000-0000000000bb";
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
  const logger = makeLogger();
  const load = vi.spyOn(drafts, "load");
  return { run: makeLoadPostDraft({ drafts, logger }), drafts, logger, load };
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

  it("rejects a missing owner user id", async () => {
    const harness = makeHarness();
    await expect(harness.run({ tenantId: TENANT, ownerUserId: "" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      context: { reason: "INVALID_OWNER_USER_ID" },
    });
    expect(harness.load).not.toHaveBeenCalled();
  });

  it("rejects a missing input object instead of throwing TypeError", async () => {
    const harness = makeHarness();
    await expect(harness.run(undefined as never)).rejects.toBeInstanceOf(AppError);
  });

  it("returns null when nothing was ever saved", async () => {
    const harness = makeHarness();
    await expect(harness.run({ tenantId: TENANT, ownerUserId: OWNER })).resolves.toBeNull();
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

    await expect(harness.run({ tenantId: TENANT, ownerUserId: OWNER })).resolves.toBeNull();
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

    await expect(harness.run({ tenantId: TENANT, ownerUserId: OWNER })).resolves.toBeNull();
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

    await expect(harness.run({ tenantId: TENANT, ownerUserId: OWNER })).resolves.toBeNull();
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

    await expect(harness.run({ tenantId: OTHER_TENANT, ownerUserId: OWNER })).resolves.toBeNull();
  });

  it("does not return a draft belonging to another operator", async () => {
    const harness = makeHarness();
    await seedRawDraft(harness.drafts, {
      tenantId: TENANT,
      ownerUserId: OWNER,
      kind: KIND,
      payload: validComposeDraftPayload({ productCode: "AB123" }),
    });

    await expect(harness.run({ tenantId: TENANT, ownerUserId: OTHER_OWNER })).resolves.toBeNull();
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

    const result = await harness.run({ tenantId: ` ${TENANT} `, ownerUserId: OWNER });

    expect(result).toMatchObject({ payload, schemaVersion: POST_DRAFT_SCHEMA_VERSION });
    expect(new Date(result?.updatedAt ?? "").toISOString()).toBe(result?.updatedAt);
    expect(harness.load).toHaveBeenCalledWith(TENANT, OWNER, KIND);
  });
});
