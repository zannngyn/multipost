import { describe, expect, it, vi } from "vitest";

import { testTenantId } from "@/core/domain/tenant-context.testing";
import type { CatalogConfigRepo } from "@/core/ports/drive-source";
import type { GoogleOAuthRepo } from "@/core/ports/google-oauth";
import type { Logger } from "@/core/ports/infra";
import type { PostJobRepo } from "@/core/ports/post-job-repo";
import type { ChannelConfigRepo, ChannelGroupRepo } from "@/core/ports/publisher";

import { makeGetSetupProgress } from "./get-setup-progress";

/**
 * First-run: "còn mấy bước nữa thì đăng được bài?".
 *
 * Every flag is a READ of state some screen already owns, so the interesting
 * cases are the ones where a half-finished tenant must not be reported as
 * ready — and the one where a repo is down and the honest answer is an error,
 * not "chưa xong".
 */

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");

function silentLogger(): Logger {
  const self: Logger = {
    child: () => self,
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  return self;
}

interface HarnessOptions {
  readonly googleConnected?: boolean;
  readonly googleStatus?: "active" | "error";
  readonly hasSource?: boolean;
  readonly channelCount?: number;
  readonly groupCount?: number;
  readonly publishedCount?: number;
}

function harness(options: HarnessOptions = {}) {
  const {
    googleConnected = false,
    googleStatus = "active",
    hasSource = false,
    channelCount = 0,
    groupCount = 0,
    publishedCount = 0,
  } = options;

  const jobQueries: unknown[] = [];

  const google = {
    findConnection: vi.fn(async () =>
      googleConnected
        ? {
            email: "shop@gmail.com",
            scopes: [],
            connectedAt: "2026-08-01T00:00:00.000Z",
            connectedByUserId: null,
            status: googleStatus,
            sourceAccess: null,
          }
        : null,
    ),
  } as unknown as GoogleOAuthRepo;

  const catalogConfig = {
    findCatalogSource: vi.fn(async () =>
      hasSource ? { driveFolderId: "folder-1", spreadsheetId: "sheet-1", sheetName: "Tab 1" } : null,
    ),
  } as unknown as CatalogConfigRepo;

  const channels = {
    listChannels: vi.fn(async () =>
      Array.from({ length: channelCount }, (_, index) => ({ id: `ch-${index}` })),
    ),
  } as unknown as ChannelConfigRepo;

  const groups = {
    listGroups: vi.fn(async () =>
      Array.from({ length: groupCount }, (_, index) => ({ id: `g-${index}` })),
    ),
  } as unknown as ChannelGroupRepo;

  const postJobs = {
    listJobs: vi.fn(async (query: unknown) => {
      jobQueries.push(query);
      return {
        items: Array.from({ length: publishedCount }, (_, index) => ({ postJobId: `job-${index}` })),
        nextCursor: null,
      };
    }),
  } as unknown as PostJobRepo;

  return {
    getSetupProgress: makeGetSetupProgress({
      google,
      catalogConfig,
      channels,
      groups,
      postJobs,
      logger: silentLogger(),
    }),
    google,
    catalogConfig,
    channels,
    groups,
    postJobs,
    jobQueries,
  };
}

function flagOf(progress: { steps: readonly { id: string; isDone: boolean }[] }, id: string) {
  return progress.steps.find((step) => step.id === id)?.isDone;
}

// --- Edge cases first -------------------------------------------------------

describe("getSetupProgress — rejected calls", () => {
  it.each([
    ["empty string", ""],
    ["whitespace only", "   "],
    ["not a uuid", "tenant-1"],
  ])("rejects %s with INVALID_INPUT before touching any repo", async (_label, raw) => {
    const h = harness();
    await expect(h.getSetupProgress({ tenantId: testTenantId(raw) })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(h.google.findConnection).not.toHaveBeenCalled();
    expect(h.postJobs.listJobs).not.toHaveBeenCalled();
  });

  it("rejects a missing input object instead of throwing TypeError", async () => {
    const h = harness();
    await expect(
      h.getSetupProgress(undefined as unknown as { tenantId: ReturnType<typeof testTenantId> }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("lets a repo failure through instead of reporting the step as not done", async () => {
    const h = harness();
    (h.channels.listChannels as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("db is down"),
    );
    await expect(h.getSetupProgress({ tenantId: TENANT })).rejects.toThrow("db is down");
  });
});

// --- Flags ------------------------------------------------------------------

describe("getSetupProgress — per-step flags", () => {
  it("reports a brand new tenant as 1/5 with only `tenant` done", async () => {
    const { getSetupProgress } = harness();
    const progress = await getSetupProgress({ tenantId: TENANT });

    expect(progress.steps.map((step) => step.id)).toEqual([
      "tenant",
      "google",
      "source",
      "facebook",
      "group",
      "firstPost",
    ]);
    expect(flagOf(progress, "tenant")).toBe(true);
    expect(flagOf(progress, "google")).toBe(false);
    expect(progress.doneCount).toBe(1);
    expect(progress.requiredCount).toBe(5);
    expect(progress.isReady).toBe(false);
  });

  it("treats a google connection parked in `error` as NOT connected", async () => {
    const { getSetupProgress } = harness({ googleConnected: true, googleStatus: "error" });
    const progress = await getSetupProgress({ tenantId: TENANT });
    expect(flagOf(progress, "google")).toBe(false);
  });

  it("counts an active google connection as done", async () => {
    const { getSetupProgress } = harness({ googleConnected: true });
    const progress = await getSetupProgress({ tenantId: TENANT });
    expect(flagOf(progress, "google")).toBe(true);
    expect(progress.doneCount).toBe(2);
  });

  it("asks the job log for exactly one published row", async () => {
    const { getSetupProgress, jobQueries } = harness({ publishedCount: 1 });
    const progress = await getSetupProgress({ tenantId: TENANT });
    expect(jobQueries).toEqual([{ tenantId: TENANT, status: "published", limit: 1 }]);
    expect(flagOf(progress, "firstPost")).toBe(true);
  });

  it("does NOT count firstPost towards doneCount — the goal is not a setup step", async () => {
    const { getSetupProgress } = harness({ publishedCount: 1 });
    const progress = await getSetupProgress({ tenantId: TENANT });
    expect(progress.doneCount).toBe(1);
  });

  it("is ready once the sheet source and a Fanpage both exist", async () => {
    const { getSetupProgress } = harness({ hasSource: true, channelCount: 2 });
    const progress = await getSetupProgress({ tenantId: TENANT });
    expect(progress.isReady).toBe(true);
  });

  it("is NOT ready with a Fanpage but no sheet source", async () => {
    const { getSetupProgress } = harness({ channelCount: 2 });
    const progress = await getSetupProgress({ tenantId: TENANT });
    expect(progress.isReady).toBe(false);
  });

  it("reports a fully configured tenant as 5/5 with every step done", async () => {
    const { getSetupProgress } = harness({
      googleConnected: true,
      hasSource: true,
      channelCount: 1,
      groupCount: 1,
      publishedCount: 1,
    });
    const progress = await getSetupProgress({ tenantId: TENANT });
    expect(progress.doneCount).toBe(5);
    expect(progress.steps.every((step) => step.isDone)).toBe(true);
  });

  it("trims a padded tenant id before it reaches the repos", async () => {
    const h = harness();
    const progress = await h.getSetupProgress({ tenantId: testTenantId(` ${TENANT} `) });
    expect(progress.tenantId).toBe(TENANT);
    expect(h.google.findConnection).toHaveBeenCalledWith(TENANT);
  });
});
