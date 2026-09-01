import { describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";
import type { Logger } from "@/core/ports/infra";

import {
  dbOutage,
  makeInMemoryPostDraftRepo,
  seedRawDraft,
  validComposeDraftPayload,
} from "../__fixtures__/post-draft";
import { makeDiscardPostDraft } from "../discard-post-draft";
import { testTenantId } from "@/core/domain/tenant-context.testing";

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");
const OTHER_TENANT = testTenantId("00000000-0000-0000-0000-000000000002");
const OWNER = "00000000-0000-0000-0000-0000000000aa";
const KIND = "compose";

function makeLogger(): Logger {
  const logger: Logger = {
    child: () => logger,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

function makeHarness() {
  const drafts = makeInMemoryPostDraftRepo();
  const logger = makeLogger();
  const discard = vi.spyOn(drafts, "discard");
  return { run: makeDiscardPostDraft({ drafts, logger }), drafts, logger, discard };
}

describe("discardPostDraft — edge cases first", () => {
  it.each(["", "   ", "not-a-uuid"])("rejects tenant id %s before deleting", async (tenantId) => {
    const harness = makeHarness();
    await expect(harness.run({ tenantId: testTenantId(tenantId), ownerUserId: OWNER })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(harness.discard).not.toHaveBeenCalled();
  });

  it("rejects a missing owner user id — it must not wipe someone else's draft", async () => {
    const harness = makeHarness();
    await expect(harness.run({ tenantId: TENANT, ownerUserId: "" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      context: { reason: "INVALID_OWNER_USER_ID" },
    });
    expect(harness.discard).not.toHaveBeenCalled();
  });

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

    await expect(harness.run({ tenantId: TENANT, ownerUserId: OWNER })).resolves.toBeUndefined();
    await expect(harness.run({ tenantId: TENANT, ownerUserId: OWNER })).resolves.toBeUndefined();
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

    await harness.run({ tenantId: testTenantId(` ${TENANT} `), ownerUserId: OWNER });

    const rows = harness.drafts.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toContain(OTHER_TENANT);
    expect(harness.discard).toHaveBeenCalledWith(TENANT, OWNER, KIND);
  });
});
