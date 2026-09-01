# First-run modal 2 bước + dock 6 bước — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Khách mới đăng nhập ở lại route tổng quan, gặp modal 2 bước (tạo công ty → mời người), xong là app chạy ngay không cần F5, rồi một dock góc dưới phải cho biết còn bước nào để đăng được bài.

**Architecture:** Một usecase core mới tổng hợp 6 cờ thiết lập từ 5 port sẵn có, phơi qua một API route mỏng. UI: `TenantBoundary` đổi từ "thay cả màn hình" sang "render tổng quan thật + phủ mờ + dialog `purpose=required`"; một `SetupDock` gắn trong app shell đọc endpoint mới.

**Tech Stack:** Next.js App Router · TypeScript · Astryx `@astryxdesign/core` · TanStack Query · react-hook-form + zod · vitest

**Spec:** `docs/superpowers/specs/2026-08-24-first-run-modal-dock-design.md`

## Global Constraints

- Luật phụ thuộc một chiều: `app/ui → composition → adapters → core`. `core/` không import lib I/O. Cưỡng chế bằng `pnpm depcruise`.
- Comment và tên định danh trong code: tiếng Anh. Chuỗi hiển thị cho người vận hành: tiếng Việt.
- Không `<div>` cho layout — dùng component Astryx. Không hex/px thô; dùng token qua utility (`bg-surface`, `text-muted-foreground`, `rounded-lg`).
- Edge case trước, happy path sau. Guard clause + early return.
- Cấm nuốt lỗi: mọi `catch` phải log có context rồi rethrow, hoặc chuyển trạng thái kèm lý do.
- Mọi animation `motion-safe:` và không lặp vô hạn (ngoại lệ: skeleton `aria-hidden` trong lúc query đang bay).
- Không thêm dependency mới. Không migration DB.
- `requiredCount` = 5. Bước thứ 6 (`firstPost`) là đích, không tính vào tiến độ thiết lập.
- Lệnh verify của repo: `pnpm verify` = `typecheck && lint && depcruise && theme:check && test && build`.

---

### Task 1: Usecase `getSetupProgress` trong core

**Files:**
- Create: `src/core/usecases/get-setup-progress.ts`
- Test: `src/core/usecases/get-setup-progress.test.ts`

**Interfaces:**
- Consumes: `GoogleOAuthRepo.findConnection`, `CatalogConfigRepo.findCatalogSource`, `ChannelConfigRepo.listChannels`, `ChannelGroupRepo.listGroups`, `PostJobRepo.listJobs` — tất cả đã tồn tại trong `src/core/ports/`.
- Produces:
  ```ts
  export const SETUP_STEP_IDS = ["tenant","google","source","facebook","group","firstPost"] as const;
  export type SetupStepId = (typeof SETUP_STEP_IDS)[number];
  export interface SetupStepFlag { readonly id: SetupStepId; readonly isDone: boolean }
  export interface SetupProgress {
    readonly tenantId: TenantId;
    readonly steps: readonly SetupStepFlag[];
    readonly doneCount: number;
    readonly requiredCount: number;
    readonly isReady: boolean;
  }
  export interface GetSetupProgressInput { readonly tenantId: TenantId }
  export type GetSetupProgress = (input: GetSetupProgressInput) => Promise<SetupProgress>;
  export function makeGetSetupProgress(deps: GetSetupProgressDeps): GetSetupProgress
  ```

**Luật:**
- `tenant` — luôn `true` (gọi được usecase nghĩa là tenant tồn tại và người gọi là thành viên).
- `google` — `findConnection()` khác null VÀ `status === "active"`. Dùng repo chứ không dùng usecase `connectGoogleDrive.getGoogleConnection`, vì repo chỉ đọc DB nên không phụ thuộc biến môi trường OAuth.
- `source` — `findCatalogSource()` khác null.
- `facebook` — `listChannels()` có ≥1 phần tử.
- `group` — `listGroups()` có ≥1 phần tử.
- `firstPost` — `listJobs({ tenantId, status: "published", limit: 1 })` trả ≥1 phần tử.
- `requiredCount` = 5, `doneCount` = số bước xong trong 5 bước đầu, `isReady` = `source && facebook`.
- Năm lệnh đọc chạy song song bằng `Promise.all`. Không nuốt lỗi nào.

- [ ] **Step 1: Viết test thất bại**

Tạo `src/core/usecases/get-setup-progress.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import { testTenantId } from "@/core/domain/tenant-context.testing";
import type { CatalogConfigRepo } from "@/core/ports/drive-source";
import type { GoogleOAuthRepo } from "@/core/ports/google-oauth";
import type { Logger } from "@/core/ports/infra";
import type { PostJobRepo } from "@/core/ports/post-job-repo";
import type { ChannelConfigRepo, ChannelGroupRepo } from "@/core/ports/publisher";

import { makeGetSetupProgress } from "./get-setup-progress";

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
      hasSource
        ? { driveFolderId: "folder-1", spreadsheetId: "sheet-1", sheetName: "Tab 1" }
        : null,
    ),
  } as unknown as CatalogConfigRepo;

  const channels = {
    listChannels: vi.fn(async () => Array.from({ length: channelCount }, (_, i) => ({ id: `ch-${i}` }))),
  } as unknown as ChannelConfigRepo;

  const groups = {
    listGroups: vi.fn(async () => Array.from({ length: groupCount }, (_, i) => ({ id: `g-${i}` }))),
  } as unknown as ChannelGroupRepo;

  const postJobs = {
    listJobs: vi.fn(async (query: unknown) => {
      jobQueries.push(query);
      return {
        items: Array.from({ length: publishedCount }, (_, i) => ({ postJobId: `job-${i}` })),
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
```

- [ ] **Step 2: Chạy test, xác nhận FAIL**

Run: `pnpm exec vitest run src/core/usecases/get-setup-progress.test.ts`
Expected: FAIL — `Failed to resolve import "./get-setup-progress"`.

- [ ] **Step 3: Viết implementation**

Tạo `src/core/usecases/get-setup-progress.ts`:

```ts
import { AppError } from "@/core/domain/errors";
import { isTenantId } from "@/core/domain/tenant";
import { normalizeTenantId, type TenantId } from "@/core/domain/tenant-context";
import type { CatalogConfigRepo } from "@/core/ports/drive-source";
import type { GoogleOAuthRepo } from "@/core/ports/google-oauth";
import type { Logger } from "@/core/ports/infra";
import type { PostJobRepo } from "@/core/ports/post-job-repo";
import type { ChannelConfigRepo, ChannelGroupRepo } from "@/core/ports/publisher";

/**
 * "Còn mấy bước nữa thì đăng được bài?" — the one source of truth behind the
 * first-run checklist and the setup dock.
 *
 * It exists because the answer was scattered across five screens: the operator
 * had to visit /sync, /channels and /posts to work out why nothing could be
 * published yet. Every flag here is a READ of state those screens already own;
 * nothing is stored, so the dock can never disagree with the screen it links to.
 */

export const SETUP_STEP_IDS = [
  "tenant",
  "google",
  "source",
  "facebook",
  "group",
  "firstPost",
] as const;

export type SetupStepId = (typeof SETUP_STEP_IDS)[number];

/**
 * The first five are SETUP; `firstPost` is the goal they unlock. Counting the
 * goal as a setup step would make a tenant that is fully wired read "4/6" and
 * look broken.
 */
export const REQUIRED_SETUP_STEP_IDS: readonly SetupStepId[] = [
  "tenant",
  "google",
  "source",
  "facebook",
  "group",
];

export interface SetupStepFlag {
  readonly id: SetupStepId;
  readonly isDone: boolean;
}

export interface SetupProgress {
  readonly tenantId: TenantId;
  readonly steps: readonly SetupStepFlag[];
  readonly doneCount: number;
  readonly requiredCount: number;
  /** Sheet source + at least one Fanpage — enough to compose a post. */
  readonly isReady: boolean;
}

export interface GetSetupProgressInput {
  readonly tenantId: TenantId;
}

export interface GetSetupProgressDeps {
  google: GoogleOAuthRepo;
  catalogConfig: CatalogConfigRepo;
  channels: ChannelConfigRepo;
  groups: ChannelGroupRepo;
  postJobs: PostJobRepo;
  logger: Logger;
}

export type GetSetupProgress = (input: GetSetupProgressInput) => Promise<SetupProgress>;

export function makeGetSetupProgress(deps: GetSetupProgressDeps): GetSetupProgress {
  return async function getSetupProgress(input) {
    // --- Edge cases first (CLAUDE.md technical rule 1) ----------------------
    const rawTenantId = typeof input?.tenantId === "string" ? input.tenantId.trim() : "";
    if (!isTenantId(rawTenantId)) {
      throw new AppError("INVALID_INPUT", {
        message: "getSetupProgress requires a tenant UUID",
        userMessage: "Mã đơn vị (tenant) không hợp lệ.",
        context: { tenant_id: rawTenantId || null },
      });
    }
    const tenantId = normalizeTenantId(input.tenantId);

    /**
     * Five independent reads, so they go together. No `allSettled`: a repo that
     * failed has NOT told us the step is unfinished, and answering "chưa xong"
     * on a dead database would send the operator to reconnect something that is
     * already connected (CLAUDE.md rule 5 — never swallow).
     */
    const [connection, source, channels, groups, publishedPage] = await Promise.all([
      deps.google.findConnection(tenantId),
      deps.catalogConfig.findCatalogSource(tenantId),
      deps.channels.listChannels(tenantId),
      deps.groups.listGroups(tenantId),
      deps.postJobs.listJobs({ tenantId, status: "published", limit: 1 }),
    ]);

    /**
     * `error` means Google rejected the stored refresh token: the row is still
     * there, but nothing can be read with it. Reporting that as "đã kết nối"
     * would leave the operator staring at a finished step that does not work.
     */
    const isGoogleConnected = connection !== null && connection.status === "active";

    const flags: Record<SetupStepId, boolean> = {
      // Reaching this usecase already required a membership in this tenant.
      tenant: true,
      google: isGoogleConnected,
      source: source !== null,
      facebook: channels.length > 0,
      group: groups.length > 0,
      firstPost: publishedPage.items.length > 0,
    };

    const steps = SETUP_STEP_IDS.map((id) => ({ id, isDone: flags[id] }));
    const doneCount = REQUIRED_SETUP_STEP_IDS.filter((id) => flags[id]).length;
    const isReady = flags.source && flags.facebook;

    deps.logger.debug("Setup progress read", {
      tenant_id: tenantId,
      done_count: doneCount,
      required_count: REQUIRED_SETUP_STEP_IDS.length,
      is_ready: isReady,
    });

    return {
      tenantId,
      steps,
      doneCount,
      requiredCount: REQUIRED_SETUP_STEP_IDS.length,
      isReady,
    };
  };
}
```

- [ ] **Step 4: Chạy test, xác nhận PASS**

Run: `pnpm exec vitest run src/core/usecases/get-setup-progress.test.ts`
Expected: PASS, 12 test.

- [ ] **Step 5: Commit**

```bash
git add src/core/usecases/get-setup-progress.ts src/core/usecases/get-setup-progress.test.ts
git commit -m "feat(onboarding): add getSetupProgress usecase for the six first-run steps"
```

---

### Task 2: Nối container + API route

**Files:**
- Modify: `src/composition/container.ts` (thêm vào `interface Usecases` và `makeUsecases`)
- Create: `src/app/api/tenants/setup-progress/route.ts`
- Test: `src/app/api/tenants/setup-progress/route.test.ts`

**Interfaces:**
- Consumes: `makeGetSetupProgress`, `GetSetupProgress` từ Task 1.
- Produces: `container.usecases.getSetupProgress`; endpoint `GET /api/tenants/setup-progress` trả `SetupProgress` dạng JSON.

- [ ] **Step 1: Đăng ký usecase trong container**

Trong `src/composition/container.ts`:

1. Thêm import cạnh các import usecase khác:
```ts
import { makeGetSetupProgress, type GetSetupProgress } from "@/core/usecases/get-setup-progress";
```

2. Thêm vào `interface Usecases`, ngay dưới dòng `getCatalogSource`:
```ts
  /** First-run: sáu cờ thiết lập cho checklist và dock (một request, tier R). */
  getSetupProgress: GetSetupProgress;
```

3. Trong `makeUsecases`, thêm vào object trả về, dùng đúng tên biến repo mà các usecase lân cận đang dùng (đọc `makeUsecases` để lấy tên thật của google oauth repo, catalog config repo, channel config repo, channel group repo, post job repo trước khi viết):
```ts
    getSetupProgress: makeGetSetupProgress({
      google: <googleOAuthRepo>,
      catalogConfig: <catalogConfigRepo>,
      channels: <channelConfigRepo>,
      groups: <channelGroupRepo>,
      postJobs: <postJobRepo>,
      logger,
    }),
```

- [ ] **Step 2: Viết test route thất bại**

Đọc `src/app/api/tenants/route.test.ts` để lấy đúng khuôn mock (`vi.mock` cho `@/composition/container` và `@/app/api/_lib/require-tenant-context`), rồi tạo `src/app/api/tenants/setup-progress/route.test.ts` theo khuôn đó, phủ:

1. trả 200 kèm payload của usecase khi `requireTenantContext` cho qua;
2. gọi `requireTenantContext` với `{ tier: "R", minRole: "admin" }`;
3. `AppError("FORBIDDEN")` từ `requireTenantContext` được map thành 403 và usecase KHÔNG được gọi;
4. `AppError("DB_ERROR")` từ usecase được map thành 5xx, thân lỗi có `code`.

- [ ] **Step 3: Chạy test, xác nhận FAIL**

Run: `pnpm exec vitest run src/app/api/tenants/setup-progress/route.test.ts`
Expected: FAIL — chưa có module route.

- [ ] **Step 4: Viết route**

Tạo `src/app/api/tenants/setup-progress/route.ts`:

```ts
import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { requireTenantContext } from "@/app/api/_lib/require-tenant-context";
import { getContainer } from "@/composition/container";

/**
 * First-run: "còn mấy bước nữa thì đăng được bài?" in ONE request.
 *
 * Thin by contract (docs/07 §3.3): authorise, delegate, map errors.
 *
 * `minRole: "admin"`: every step behind this list is an admin action (connect
 * Google, choose a sheet, connect a Fanpage), so an editor asking would get a
 * list of things they cannot do. The dock is not rendered for them either.
 */

const ROUTE = "GET /api/tenants/setup-progress";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    const { ctx } = await requireTenantContext(request, {
      surface: `api:${ROUTE}`,
      tier: "R",
      minRole: "admin",
    });

    const progress = await container.usecases.getSetupProgress({ tenantId: ctx.tenantId });
    return Response.json(progress);
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
```

- [ ] **Step 5: Chạy test + typecheck, xác nhận PASS**

Run: `pnpm exec vitest run src/app/api/tenants/setup-progress/route.test.ts && pnpm typecheck`
Expected: PASS + typecheck sạch.

- [ ] **Step 6: Commit**

```bash
git add src/composition/container.ts src/app/api/tenants/setup-progress/
git commit -m "feat(onboarding): expose GET /api/tenants/setup-progress"
```

---

### Task 3: Tầng UI data — schema, service, hooks

**Files:**
- Create: `src/ui/schemas/setup-progress.schema.ts`
- Create: `src/ui/services/setup-progress.api.ts`
- Create: `src/ui/hooks/useSetupProgress.ts`
- Create: `src/ui/hooks/useSetupDockState.ts`
- Test: `src/ui/schemas/setup-progress.schema.test.ts`

**Interfaces:**
- Consumes: hợp đồng JSON của route ở Task 2; `apiRequest` từ `@/ui/services/http-client`; `useActiveTenant` từ `@/ui/hooks/useMe`.
- Produces:
  ```ts
  // setup-progress.schema.ts
  export const SETUP_STEP_IDS: readonly ["tenant","google","source","facebook","group","firstPost"];
  export type SetupStepId = (typeof SETUP_STEP_IDS)[number];
  export const SetupProgressSchema: z.ZodType<SetupProgress>;
  export interface SetupProgress { tenantId; steps: {id: SetupStepId; isDone: boolean}[]; doneCount; requiredCount; isReady }
  export function isSetupFinished(progress: SetupProgress): boolean;
  export function stepFlag(progress: SetupProgress, id: SetupStepId): boolean;

  // setup-progress.api.ts
  export const setupKeys: { progress: (tenantKey: string) => readonly ["setup", string, "progress"] };
  export function fetchSetupProgress(signal?: AbortSignal): Promise<SetupProgress>;

  // useSetupProgress.ts
  export function useSetupProgress(): UseQueryResult<SetupProgress, ApiError>;

  // useSetupDockState.ts
  export type DockState = "expanded" | "collapsed";
  export function useSetupDockState(tenantKey: string): { state: DockState; setState: (next: DockState) => void };
  ```

- [ ] **Step 1: Viết test schema thất bại**

Tạo `src/ui/schemas/setup-progress.schema.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  SetupProgressSchema,
  isSetupFinished,
  stepFlag,
  type SetupProgress,
} from "./setup-progress.schema";

const VALID = {
  tenantId: "00000000-0000-0000-0000-000000000001",
  steps: [
    { id: "tenant", isDone: true },
    { id: "google", isDone: true },
    { id: "source", isDone: true },
    { id: "facebook", isDone: true },
    { id: "group", isDone: true },
    { id: "firstPost", isDone: false },
  ],
  doneCount: 5,
  requiredCount: 5,
  isReady: true,
};

describe("SetupProgressSchema — refusals", () => {
  it("rejects an unknown step id instead of rendering it", () => {
    const payload = { ...VALID, steps: [{ id: "billing", isDone: true }] };
    expect(SetupProgressSchema.safeParse(payload).success).toBe(false);
  });

  it("rejects a missing isDone flag", () => {
    const payload = { ...VALID, steps: [{ id: "tenant" }] };
    expect(SetupProgressSchema.safeParse(payload).success).toBe(false);
  });

  it("rejects a negative doneCount", () => {
    expect(SetupProgressSchema.safeParse({ ...VALID, doneCount: -1 }).success).toBe(false);
  });

  it("accepts the shape the route actually sends", () => {
    expect(SetupProgressSchema.safeParse(VALID).success).toBe(true);
  });
});

describe("isSetupFinished", () => {
  it("is false while the goal step is still open", () => {
    expect(isSetupFinished(VALID as SetupProgress)).toBe(false);
  });

  it("is true only when EVERY step including firstPost is done", () => {
    const done = {
      ...VALID,
      steps: VALID.steps.map((step) => ({ ...step, isDone: true })),
    } as SetupProgress;
    expect(isSetupFinished(done)).toBe(true);
  });
});

describe("stepFlag", () => {
  it("reads one step by id", () => {
    expect(stepFlag(VALID as SetupProgress, "firstPost")).toBe(false);
    expect(stepFlag(VALID as SetupProgress, "google")).toBe(true);
  });

  it("answers false for a step the payload does not carry", () => {
    const partial = { ...VALID, steps: [] } as unknown as SetupProgress;
    expect(stepFlag(partial, "google")).toBe(false);
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận FAIL**

Run: `pnpm exec vitest run src/ui/schemas/setup-progress.schema.test.ts`
Expected: FAIL — chưa có module.

- [ ] **Step 3: Viết schema**

Tạo `src/ui/schemas/setup-progress.schema.ts`:

```ts
import { z } from "zod";

/**
 * Contract of `GET /api/tenants/setup-progress`.
 *
 * NOTE: `ui/` may not import `core/` (one-way dependency law, docs/07 §2), so
 * this mirrors `core/usecases/get-setup-progress.ts`. Any change there must be
 * reflected here.
 */

export const SETUP_STEP_IDS = [
  "tenant",
  "google",
  "source",
  "facebook",
  "group",
  "firstPost",
] as const;

export type SetupStepId = (typeof SETUP_STEP_IDS)[number];

export const SetupProgressSchema = z.object({
  tenantId: z.string().min(1),
  steps: z.array(z.object({ id: z.enum(SETUP_STEP_IDS), isDone: z.boolean() })),
  doneCount: z.number().int().min(0),
  requiredCount: z.number().int().min(1),
  isReady: z.boolean(),
});

export type SetupProgress = z.infer<typeof SetupProgressSchema>;

/** One step by id. A step the payload omits reads as NOT done, never as true. */
export function stepFlag(progress: SetupProgress, id: SetupStepId): boolean {
  return progress.steps.find((step) => step.id === id)?.isDone ?? false;
}

/**
 * Every step, the goal included — the dock disappears on this and nothing else.
 * `doneCount === requiredCount` is deliberately NOT enough: that is "wired up",
 * while the dock keeps pointing at "Đăng bài đầu tiên" until a post has gone out.
 */
export function isSetupFinished(progress: SetupProgress): boolean {
  return SETUP_STEP_IDS.every((id) => stepFlag(progress, id));
}
```

- [ ] **Step 4: Chạy test, xác nhận PASS**

Run: `pnpm exec vitest run src/ui/schemas/setup-progress.schema.test.ts`
Expected: PASS, 8 test.

- [ ] **Step 5: Viết service**

Tạo `src/ui/services/setup-progress.api.ts`:

```ts
import { SetupProgressSchema, type SetupProgress } from "@/ui/schemas/setup-progress.schema";

import { apiRequest } from "./http-client";

/**
 * Data layer of the first-run checklist and the setup dock (docs/07 §4.1).
 * Transport and error normalisation live in `http-client.ts`.
 */

/** Query keys carry the tenant key so cached data can never leak across tenants. */
export const setupKeys = {
  progress: (tenantKey: string) => ["setup", tenantKey, "progress"] as const,
};

export async function fetchSetupProgress(signal?: AbortSignal): Promise<SetupProgress> {
  return apiRequest("/api/tenants/setup-progress", {
    schema: SetupProgressSchema,
    signal,
    malformedMessage:
      "Dữ liệu tiến trình thiết lập không đúng định dạng. Hãy báo quản trị viên kiểm tra máy chủ.",
  });
}
```

- [ ] **Step 6: Viết hook đọc tiến trình**

Tạo `src/ui/hooks/useSetupProgress.ts`:

```ts
"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { useActiveTenant } from "@/ui/hooks/useMe";
import type { SetupProgress } from "@/ui/schemas/setup-progress.schema";
import { ApiError } from "@/ui/services/api-error";
import { fetchSetupProgress, setupKeys } from "@/ui/services/setup-progress.api";

/**
 * Logic layer of the setup dock (docs/07 §4.1).
 *
 * The dock rides in the app shell, so this query would otherwise fire on EVERY
 * screen for EVERY operator. Two gates keep that honest:
 *   - only owner/admin ask at all — the endpoint answers 403 to anyone else,
 *     and an editor has no button for a single one of these steps;
 *   - `staleTime` 30s, so moving between screens re-reads the cache, not the API.
 */
export function useSetupProgress(): UseQueryResult<SetupProgress, ApiError> {
  const { tenantKey, isResolved, role } = useActiveTenant();
  const canSee = role === "owner" || role === "admin";

  return useQuery<SetupProgress, ApiError>({
    queryKey: setupKeys.progress(tenantKey),
    queryFn: ({ signal }) => fetchSetupProgress(signal),
    enabled: isResolved && canSee,
    // A 4xx repeats the same bad request — retrying only hides it.
    retry: (failureCount, error) =>
      ApiError.is(error) && error.isRetryable ? failureCount < 2 : false,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 5_000),
    staleTime: 30_000,
  });
}
```

- [ ] **Step 7: Viết hook nhớ trạng thái dock**

Tạo `src/ui/hooks/useSetupDockState.ts`:

```ts
"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Bung hay thu — remembered per company, on this machine.
 *
 * localStorage rather than a column: closing the dock is a preference of one
 * browser, not a fact about the company, and a wrong click must not follow the
 * operator to every device they own.
 *
 * Every access is wrapped: Safari in private mode THROWS on `localStorage`
 * rather than returning null, and a dock that crashes the shell to remember a
 * preference is worse than a dock that forgets it (CLAUDE.md rule 5 — the catch
 * logs and falls back, it does not go silent).
 */

export type DockState = "expanded" | "collapsed";

const PREFIX = "mysp.setup-dock.";

function readStored(tenantKey: string): DockState | null {
  try {
    const raw = window.localStorage.getItem(`${PREFIX}${tenantKey}`);
    return raw === "collapsed" || raw === "expanded" ? raw : null;
  } catch (error) {
    console.warn("[setup-dock] could not read the stored dock state", error);
    return null;
  }
}

export function useSetupDockState(tenantKey: string): {
  state: DockState;
  setState: (next: DockState) => void;
} {
  /**
   * Starts expanded and reads storage in an effect, NOT in the initialiser:
   * this component renders on the server too, and touching `window` there is a
   * hydration mismatch waiting to happen.
   */
  const [state, setLocalState] = useState<DockState>("expanded");

  useEffect(() => {
    const stored = readStored(tenantKey);
    if (stored) setLocalState(stored);
  }, [tenantKey]);

  const setState = useCallback(
    (next: DockState) => {
      setLocalState(next);
      try {
        window.localStorage.setItem(`${PREFIX}${tenantKey}`, next);
      } catch (error) {
        // The dock still moves — only the memory of it is lost.
        console.warn("[setup-dock] could not persist the dock state", error);
      }
    },
    [tenantKey],
  );

  return { state, setState };
}
```

- [ ] **Step 8: Typecheck + lint**

Run: `pnpm typecheck && pnpm exec eslint src/ui/schemas/setup-progress.schema.ts src/ui/services/setup-progress.api.ts src/ui/hooks/useSetupProgress.ts src/ui/hooks/useSetupDockState.ts`
Expected: sạch.

- [ ] **Step 9: Commit**

```bash
git add src/ui/schemas/setup-progress.schema.ts src/ui/schemas/setup-progress.schema.test.ts src/ui/services/setup-progress.api.ts src/ui/hooks/useSetupProgress.ts src/ui/hooks/useSetupDockState.ts
git commit -m "feat(onboarding): add setup-progress schema, service and hooks"
```

---

### Task 4: Bộ 6 bước dạng view — `setup-steps.ts`

**Files:**
- Modify: `src/ui/components/onboarding/first-run.types.ts`
- Create: `src/ui/components/onboarding/setup-steps.ts`
- Test: `src/ui/components/onboarding/setup-steps.test.ts`

**Interfaces:**
- Consumes: `SetupProgress`, `SetupStepId`, `stepFlag` từ Task 3.
- Produces:
  ```ts
  export interface SetupStepPresentation {
    readonly id: SetupStepId;
    readonly ordinal: 1|2|3|4|5|6;
    readonly title: string;
    readonly description: string;
    readonly minutes: number;
    readonly href: string;
  }
  export const SETUP_STEP_PRESENTATION: readonly SetupStepPresentation[];
  export function buildStepViews(progress: SetupProgress): readonly StepView[];
  ```

`first-run.types.ts` đổi: `StepId` thành `SetupStepId` (6 giá trị), `ordinal` thành `1|2|3|4|5|6`. Giữ nguyên `StepState`, `StepAction`, `StepView`, `FirstRunChecklistProps`, `WaitingSignal`, `OperatorWaitingProps` — chỉ đổi kiểu `id` và `ordinal`.

Nhãn (khớp thiết kế):

| id | title | href | minutes |
|---|---|---|---|
| tenant | Tạo tổ chức | `/` | 1 |
| google | Kết nối Google Drive | `/sync` | 2 |
| source | Nối Google Sheet sản phẩm | `/sync` | 2 |
| facebook | Kết nối trang Facebook | `/channels` | 3 |
| group | Tạo nhóm kênh | `/channels/groups` | 1 |
| firstPost | Đăng bài đầu tiên | `/compose` | 2 |

Luật `state` cho từng bước, theo thứ tự xét:
1. `isDone` → `"done"`.
2. bị khoá (xem bảng phụ thuộc ở spec §4) → `"locked"`, `action.disabledReason` là câu lý do.
3. bước chưa xong ĐẦU TIÊN không bị khoá → `"current"`.
4. còn lại → `"locked"` với `disabledReason` null? Không — dùng `"current"` cho mọi bước mở, `"locked"` chỉ cho bước có phụ thuộc chưa thoả. Bước mở nhưng không phải bước tiếp theo vẫn là `"current"` (bấm được).

Câu lý do khoá:
- `source`: `"Cần kết nối Google Drive trước."`
- `group`: `"Cần kết nối ít nhất một trang Facebook trước."`
- `firstPost`: `"Cần nối Google Sheet sản phẩm và kết nối trang Facebook trước."`

- [ ] **Step 1: Viết test thất bại**

Tạo `src/ui/components/onboarding/setup-steps.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { SetupProgress, SetupStepId } from "@/ui/schemas/setup-progress.schema";

import { buildStepViews } from "./setup-steps";

function progressOf(done: Partial<Record<SetupStepId, boolean>>): SetupProgress {
  const ids: SetupStepId[] = ["tenant", "google", "source", "facebook", "group", "firstPost"];
  const steps = ids.map((id) => ({ id, isDone: done[id] ?? false }));
  const required: SetupStepId[] = ["tenant", "google", "source", "facebook", "group"];
  return {
    tenantId: "00000000-0000-0000-0000-000000000001",
    steps,
    doneCount: required.filter((id) => done[id]).length,
    requiredCount: 5,
    isReady: Boolean(done.source && done.facebook),
  };
}

describe("buildStepViews — shape", () => {
  it("returns the six steps in order with their ordinals", () => {
    const views = buildStepViews(progressOf({ tenant: true }));
    expect(views.map((view) => view.id)).toEqual([
      "tenant",
      "google",
      "source",
      "facebook",
      "group",
      "firstPost",
    ]);
    expect(views.map((view) => view.ordinal)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("carries the Vietnamese labels of the design", () => {
    const views = buildStepViews(progressOf({ tenant: true }));
    expect(views[0]?.title).toBe("Tạo tổ chức");
    expect(views[1]?.title).toBe("Kết nối Google Drive");
    expect(views[5]?.title).toBe("Đăng bài đầu tiên");
  });
});

describe("buildStepViews — locking", () => {
  it("locks the sheet step until Google Drive is connected, and says why", () => {
    const views = buildStepViews(progressOf({ tenant: true }));
    const source = views.find((view) => view.id === "source");
    expect(source?.state).toBe("locked");
    expect(source?.action?.disabledReason).toBe("Cần kết nối Google Drive trước.");
  });

  it("unlocks the sheet step once Google Drive is connected", () => {
    const views = buildStepViews(progressOf({ tenant: true, google: true }));
    const source = views.find((view) => view.id === "source");
    expect(source?.state).toBe("current");
    expect(source?.action?.disabledReason).toBeNull();
  });

  it("locks the channel group until a Fanpage exists", () => {
    const views = buildStepViews(progressOf({ tenant: true, google: true }));
    const group = views.find((view) => view.id === "group");
    expect(group?.state).toBe("locked");
    expect(group?.action?.disabledReason).toBe(
      "Cần kết nối ít nhất một trang Facebook trước.",
    );
  });

  it("locks the first post until BOTH the sheet source and a Fanpage exist", () => {
    const onlySheet = buildStepViews(progressOf({ tenant: true, google: true, source: true }));
    expect(onlySheet.find((view) => view.id === "firstPost")?.state).toBe("locked");

    const both = buildStepViews(
      progressOf({ tenant: true, google: true, source: true, facebook: true }),
    );
    expect(both.find((view) => view.id === "firstPost")?.state).toBe("current");
  });

  it("never locks a step that is already done", () => {
    const views = buildStepViews(
      progressOf({ tenant: true, source: true, group: true, firstPost: true }),
    );
    for (const id of ["source", "group", "firstPost"] as SetupStepId[]) {
      expect(views.find((view) => view.id === id)?.state).toBe("done");
    }
  });
});

describe("buildStepViews — detail line", () => {
  it("explains a locked step in its detail line, not only on the dead button", () => {
    const views = buildStepViews(progressOf({ tenant: true }));
    expect(views.find((view) => view.id === "source")?.detail).toBe(
      "Cần kết nối Google Drive trước.",
    );
  });

  it("marks a finished step as done in its detail line", () => {
    const views = buildStepViews(progressOf({ tenant: true }));
    expect(views[0]?.detail).toBe("Đã xong");
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận FAIL**

Run: `pnpm exec vitest run src/ui/components/onboarding/setup-steps.test.ts`
Expected: FAIL — chưa có module.

- [ ] **Step 3: Sửa `first-run.types.ts` sang bộ 6**

Trong `src/ui/components/onboarding/first-run.types.ts`, thay hai dòng kiểu:

```ts
import type { SetupStepId } from "@/ui/schemas/setup-progress.schema";

/** Sáu bước của luồng first-run — trùng SETUP_STEP_IDS ở tầng schema. */
export type StepId = SetupStepId;
```

và trong `interface StepView` đổi `readonly ordinal: 1 | 2 | 3 | 4 | 5;` thành
`readonly ordinal: 1 | 2 | 3 | 4 | 5 | 6;`. Giữ nguyên phần còn lại của file.

- [ ] **Step 4: Viết `setup-steps.ts`**

Tạo `src/ui/components/onboarding/setup-steps.ts`:

```ts
import {
  stepFlag,
  type SetupProgress,
  type SetupStepId,
} from "@/ui/schemas/setup-progress.schema";

import type { StepState, StepView } from "./first-run.types";

/**
 * Six flags -> six rows on the screen. A PURE function on purpose: every rule
 * about what is locked, what comes next and what the operator is told lives
 * here, testable without rendering anything, and the dock and the full
 * checklist read the same answer instead of each deciding for itself.
 */

export interface SetupStepPresentation {
  readonly id: SetupStepId;
  readonly ordinal: 1 | 2 | 3 | 4 | 5 | 6;
  readonly title: string;
  readonly description: string;
  /** Rough minutes, shown as "2 ph" — an estimate, never a promise. */
  readonly minutes: number;
  /** Screen that OWNS this step. Clicking a row goes here. */
  readonly href: string;
  /** Steps that must be done first. Empty = always open. */
  readonly requires: readonly SetupStepId[];
  /** Shown when `requires` is not satisfied. */
  readonly lockedReason: string | null;
}

export const SETUP_STEP_PRESENTATION: readonly SetupStepPresentation[] = [
  {
    id: "tenant",
    ordinal: 1,
    title: "Tạo tổ chức",
    description: "Công ty sở hữu toàn bộ sản phẩm, kênh và nhật ký đăng bài.",
    minutes: 1,
    href: "/",
    requires: [],
    lockedReason: null,
  },
  {
    id: "google",
    ordinal: 2,
    title: "Kết nối Google Drive",
    description: "Cho MYSP đọc kho ảnh sản phẩm trong Drive của bạn.",
    minutes: 2,
    href: "/sync",
    requires: [],
    lockedReason: null,
  },
  {
    id: "source",
    ordinal: 3,
    title: "Nối Google Sheet sản phẩm",
    description: "Chọn thư mục ảnh và bảng tính chứa tên, mô tả, tồn kho.",
    minutes: 2,
    href: "/sync",
    requires: ["google"],
    lockedReason: "Cần kết nối Google Drive trước.",
  },
  {
    id: "facebook",
    ordinal: 4,
    title: "Kết nối trang Facebook",
    description: "Fanpage sẽ nhận bài đăng. Kết nối được nhiều trang.",
    minutes: 3,
    href: "/channels",
    requires: [],
    lockedReason: null,
  },
  {
    id: "group",
    ordinal: 5,
    title: "Tạo nhóm kênh",
    description: "Gom các trang hay đăng cùng nhau để chọn một lần.",
    minutes: 1,
    href: "/channels/groups",
    requires: ["facebook"],
    lockedReason: "Cần kết nối ít nhất một trang Facebook trước.",
  },
  {
    id: "firstPost",
    ordinal: 6,
    title: "Đăng bài đầu tiên",
    description: "Chọn sản phẩm, để AI viết caption, duyệt rồi đăng.",
    minutes: 2,
    href: "/compose",
    requires: ["source", "facebook"],
    lockedReason: "Cần nối Google Sheet sản phẩm và kết nối trang Facebook trước.",
  },
];

/**
 * `action.onAction` is left as a no-op here: navigation belongs to the
 * component that has a router. The presentation carries `href`, so a row can
 * be a link rather than a button pretending to be one.
 */
export function buildStepViews(progress: SetupProgress): readonly StepView[] {
  return SETUP_STEP_PRESENTATION.map((step) => {
    const isDone = stepFlag(progress, step.id);
    const isLocked = !isDone && step.requires.some((id) => !stepFlag(progress, id));
    const state: StepState = isDone ? "done" : isLocked ? "locked" : "current";

    // A locked button with no sentence beside it teaches the operator nothing
    // (Named Status Rule) — the reason is on the row AND on the action.
    const reason = isLocked ? step.lockedReason : null;

    return {
      id: step.id,
      ordinal: step.ordinal,
      title: step.title,
      description: step.description,
      state,
      detail: isDone ? "Đã xong" : (reason ?? `${step.minutes} ph`),
      isOptional: false,
      action: {
        label: isDone ? "Xem lại" : "Mở bước này",
        onAction: () => {},
        isBusy: false,
        disabledReason: reason,
      },
    } satisfies StepView;
  });
}
```

- [ ] **Step 5: Chạy test, xác nhận PASS**

Run: `pnpm exec vitest run src/ui/components/onboarding/setup-steps.test.ts`
Expected: PASS, 10 test.

- [ ] **Step 6: Commit**

```bash
git add src/ui/components/onboarding/first-run.types.ts src/ui/components/onboarding/setup-steps.ts src/ui/components/onboarding/setup-steps.test.ts
git commit -m "feat(onboarding): map the six setup flags to step views"
```

---

### Task 5: `FirstRunChecklist` + fixtures sang bộ 6

**Files:**
- Modify: `src/ui/components/onboarding/first-run.fixtures.ts`
- Modify: `src/ui/components/onboarding/FirstRunChecklist.tsx`
- Modify: `src/ui/components/onboarding/FirstRunStepRow.tsx`

**Interfaces:**
- Consumes: `StepView` (đã đổi ở Task 4), `SETUP_STEP_PRESENTATION`.
- Produces: `FirstRunChecklist` nhận thêm prop `onOpenStep: (href: string) => void` để hàng bước điều hướng được; `FirstRunStepRow` nhận `href` qua `StepView.action`.

- [ ] **Step 1: Đọc ba file để nắm hiện trạng**

Run: `sed -n 1,200p src/ui/components/onboarding/first-run.fixtures.ts`
Run: `sed -n 1,200p src/ui/components/onboarding/FirstRunStepRow.tsx`

- [ ] **Step 2: Đổi fixtures sang 6 bước**

Mọi mảng `steps` trong `first-run.fixtures.ts` phải dùng đúng 6 id mới (`tenant`, `google`, `source`, `facebook`, `group`, `firstPost`) và `ordinal` 1..6, `requiredCount: 5`. Cách rẻ nhất và không lệch với thật: dựng fixture từ `buildStepViews` với các `SetupProgress` giả, rồi chỉ ghi đè thủ công những biến thể mà `buildStepViews` không sinh ra được (`running`, `error`).

- [ ] **Step 3: Cập nhật `FirstRunChecklist`/`FirstRunStepRow` theo bộ 6**

Đổi số bước trong skeleton từ 5 khối lên 6. Thêm prop `onOpenStep` và cho `FirstRunStepRow` gọi nó. Không đổi bố cục ngoài phần đó.

- [ ] **Step 4: Typecheck + chạy toàn bộ test**

Run: `pnpm typecheck && pnpm exec vitest run src/ui`
Expected: sạch, mọi test pass.

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/onboarding/
git commit -m "refactor(onboarding): move the checklist to the six-step set"
```

---

### Task 6: `SetupDock` + gắn vào app shell

**Files:**
- Create: `src/ui/components/onboarding/SetupDock.tsx`
- Modify: `src/ui/components/shell/AppFrame.tsx`

**Interfaces:**
- Consumes: `useSetupProgress`, `useSetupDockState`, `buildStepViews`, `SETUP_STEP_PRESENTATION`, `isSetupFinished`.
- Produces: `export function SetupDock(): ReactNode` — tự quyết định có hiện hay không, không nhận prop.

**Hành vi:**
- Không render gì khi: query `enabled` false (không phải owner/admin, hoặc chưa có tenant), đang `isPending`, `isError`, hoặc `isSetupFinished(data)`.
- `state === "collapsed"` → pill tròn góc dưới phải, nhãn `Còn N bước`.
- `state === "expanded"` → thẻ như thiết kế: eyebrow `THIẾT LẬP` + `01 / 06` + nút X, tiêu đề `Còn N bước nữa`, thanh tiến độ, 6 hàng bấm được, chân thẻ `Bấm một dòng để mở bước đó.` + `Mở đầy đủ ›`.
- Bấm một hàng → `router.push(href)` của bước đó.
- `Mở đầy đủ ›` → `router.push("/#thiet-lap")`.
- Ẩn ở `/compose` và `/bulk`? KHÔNG — PM chốt hiện ở mọi trang.

- [ ] **Step 1: Viết `SetupDock.tsx`**

Dùng component Astryx (`Card`, `Stack`, `Text`, `Heading`, `ProgressBar`, `Button`), không `<div>` layout, không hex thô. Animation: `motion-safe:animate-in motion-safe:slide-in-from-bottom-4 motion-safe:fade-in` khi hiện; thu/bung đổi bằng transform.

- [ ] **Step 2: Gắn vào `AppFrame`**

Đọc `src/ui/components/shell/AppFrame.tsx`, thêm `<SetupDock />` ở cuối vùng nội dung (sau `{children}`), trong cùng lớp fixed-position mà dock tự dựng.

- [ ] **Step 3: Typecheck + lint + depcruise**

Run: `pnpm typecheck && pnpm lint && pnpm depcruise`
Expected: sạch.

- [ ] **Step 4: Commit**

```bash
git add src/ui/components/onboarding/SetupDock.tsx src/ui/components/shell/AppFrame.tsx
git commit -m "feat(onboarding): add the setup dock to the app shell"
```

---

### Task 7: Modal 2 bước `FirstRunWizard`

**Files:**
- Create: `src/ui/components/onboarding/FirstRunWizard.tsx`
- Create: `src/ui/components/onboarding/WizardRail.tsx`
- Create: `src/ui/components/onboarding/WizardStepCreate.tsx`
- Create: `src/ui/components/onboarding/WizardStepInvite.tsx`
- Modify: `src/ui/components/tenant/CreateTenantForm.tsx` (thêm prop `slugDisplay`)

**Interfaces:**
- Consumes: `useCreateTenant`, `useJoinTenant` (`@/ui/hooks/useTenantOnboarding`), `useCreateInvite` (`@/ui/hooks/useInvites`), `CreateTenantForm`, `JoinInviteForm`.
- Produces:
  ```ts
  export function FirstRunWizard({ signOutAction }: { signOutAction?: () => void }): ReactNode
  ```

**Chi tiết:**

- `Dialog` với `purpose="required"`, `width="min(1100px, 94vw)"`, `maxHeight="86vh"`.
- Hai cột: dưới `md` xếp dọc, rail thành header.
- **Rail** (`WizardRail`): brand `MYSP`; câu dẫn `Dữ liệu trong MYSP luôn thuộc về một công ty. Tạo công ty rồi mời người vào là xong phần khung — hai phút.`; hai mốc (`Tạo công ty` / `Mời nhân viên`) với chấm tròn → ✓; khối `Đã có người mời bạn?` bọc `JoinInviteForm`; cuối rail dòng `Đăng xuất`.
- **Bước 01** (`WizardStepCreate`): eyebrow `BƯỚC 01 / 02`, tiêu đề `Công ty của bạn tên gì?`, `CreateTenantForm` với `slugDisplay="inline"` và `submitLabel="Tạo công ty và tiếp tục"`. KHÔNG có chip ngành nghề.
- **Bước 02** (`WizardStepInvite`): eyebrow `BƯỚC 02 / 02`, tiêu đề `Ai đăng bài cùng bạn?`; chọn vai trò (`Quản lý nội dung`=`admin`, `Người đăng`=`editor`, `Chỉ xem`=`viewer`) + câu mô tả quyền đổi theo vai; nút `Tạo link mời`; danh sách link đã tạo kèm `Chép link`; nút chính `Vào MYSP`, nút phụ `Mời sau, vào làm việc trước`.
- `CreateTenantForm` thêm prop `slugDisplay?: "field" | "inline"` (mặc định `"field"` — dialog "Tạo công ty mới…" trong switcher giữ nguyên hành vi cũ). `"inline"` vẽ dòng `Đường dẫn mysp.vn/<slug> · tự sinh từ tên` thay cho ô nhập, vẫn giữ nguyên logic slugify và việc gán lỗi `SLUG_TAKEN` lên trường `slug`.
- Chuyển sang bước 02 xảy ra trong `onSuccess` của `create.mutate` — lúc đó `adopt()` đã chạy, tenant đã hoạt động, nên `useCreateInvite` gọi được ngay.

- [ ] **Step 1: Thêm `slugDisplay` vào `CreateTenantForm`**

- [ ] **Step 2: Viết `WizardRail.tsx`**

- [ ] **Step 3: Viết `WizardStepCreate.tsx` và `WizardStepInvite.tsx`**

- [ ] **Step 4: Viết `FirstRunWizard.tsx` ghép ba mảnh**

- [ ] **Step 5: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: sạch.

- [ ] **Step 6: Commit**

```bash
git add src/ui/components/onboarding/ src/ui/components/tenant/CreateTenantForm.tsx
git commit -m "feat(onboarding): add the two-step first-run wizard"
```

---

### Task 8: Nối wizard vào `TenantBoundary`, bỏ `OnboardingPanel`

**Files:**
- Modify: `src/ui/components/tenant/TenantBoundary.tsx`
- Delete: `src/ui/components/tenant/OnboardingPanel.tsx`
- Test: `src/ui/hooks/tenant-scoped-queries.test.ts` (mới)

**Interfaces:**
- Consumes: `FirstRunWizard` từ Task 7.
- Produces: nhánh `hasNoMembership` của boundary render `{children}` + lớp phủ + wizard.

- [ ] **Step 1: Viết test canh bất biến "không query nào chạy khi chưa có tenant"**

Tạo `src/ui/hooks/tenant-scoped-queries.test.ts`: đọc mọi file `src/ui/hooks/use*.ts` bằng `node:fs`, với mỗi file có `useQuery`/`useInfiniteQuery` VÀ dùng `useActiveTenant`, khẳng định file đó có chuỗi `enabled`. Danh sách miễn trừ khai báo tường minh trong test (`useMe.ts` — chính nó là nguồn), kèm lý do.

- [ ] **Step 2: Chạy test, xác nhận PASS hoặc chỉ ra hook thiếu `enabled`**

Run: `pnpm exec vitest run src/ui/hooks/tenant-scoped-queries.test.ts`
Nếu FAIL: sửa hook bị chỉ mặt (thêm `enabled: isResolved`), đừng sửa test.

- [ ] **Step 3: Sửa `TenantBoundary`**

Thay khối `if (hasNoMembership)` bằng:

```tsx
  // --- Empty: signed in, but a member of no company -------------------------
  // The overview stays on screen behind the wizard (M2.4). It is SAFE: with no
  // active tenant `useActiveTenant().isResolved` is false, and every
  // tenant-scoped hook is `enabled: isResolved`, so not one request goes out —
  // the screen renders its own frame and nothing else.
  if (hasNoMembership) {
    return (
      <>
        <div aria-hidden="true" inert className="pointer-events-none blur-sm select-none">
          {children}
        </div>
        <FirstRunWizard />
      </>
    );
  }
```

(`<div>` ở đây là lớp phủ kỹ thuật, không phải layout — Astryx không có primitive cho `inert` + `blur`.)

- [ ] **Step 4: Xoá `OnboardingPanel.tsx` và mọi import tới nó**

Run: `grep -rn "OnboardingPanel" src` — phải không còn kết quả nào ngoài file sắp xoá.
Run: `git rm src/ui/components/tenant/OnboardingPanel.tsx`

- [ ] **Step 5: Typecheck + test + lint**

Run: `pnpm typecheck && pnpm exec vitest run && pnpm lint`
Expected: sạch.

- [ ] **Step 6: Commit**

```bash
git add -A src/ui
git commit -m "feat(onboarding): show the wizard over the overview instead of replacing it"
```

---

### Task 9: Checklist đầy đủ trên tổng quan + trang dev preview

**Files:**
- Modify: `src/ui/components/overview/OverviewScreen.tsx`
- Modify: `src/app/(dev)/onboarding-preview/page.tsx`

**Interfaces:**
- Consumes: `useSetupProgress`, `buildStepViews`, `FirstRunChecklist`, `FirstRunWizard`, `SetupDock`.
- Produces: khối `<section id="thiet-lap">` trên đầu tổng quan, chỉ hiện khi `useSetupProgress` có dữ liệu và `!isSetupFinished(data)`.

- [ ] **Step 1: Chèn checklist vào `OverviewScreen`**

Ngay trong `LayoutContent`, TRƯỚC dải thống kê. Neo `id="thiet-lap"` để `Mở đầy đủ ›` của dock nhảy tới được.

- [ ] **Step 2: Thêm wizard + dock vào trang dev preview**

Thêm hai mục vào `(dev)/onboarding-preview/page.tsx` để xem thử không cần tài khoản thật.

- [ ] **Step 3: Typecheck + lint + test**

Run: `pnpm typecheck && pnpm lint && pnpm exec vitest run`
Expected: sạch.

- [ ] **Step 4: Commit**

```bash
git add src/ui/components/overview/OverviewScreen.tsx "src/app/(dev)/onboarding-preview/page.tsx"
git commit -m "feat(onboarding): surface the full checklist on the overview"
```

---

### Task 10: Verify đầy đủ + ảnh chụp thật

**Files:** không sửa file nguồn nào (trừ khi verify chỉ ra lỗi).

- [ ] **Step 1: Chạy verify đầy đủ**

Run: `pnpm verify`
Expected: exit 0. Dán output thật vào báo cáo. Nếu FAIL — sửa code, KHÔNG sửa test cho pass.

- [ ] **Step 2: Kiểm artifact build thật**

Run: `ls -la .next/BUILD_ID`
Expected: file tồn tại (exit 0 của build chưa chắc đã sinh artifact).

- [ ] **Step 3: Dựng dev server và chụp ba trạng thái**

```bash
PORT=3123 pnpm dev &
DEV_PID=$!
```

Lưu `$DEV_PID`, KHÔNG dùng `pkill`. Chụp: bước 01 · bước 02 · dock ở tổng quan. Xong thì `kill "$DEV_PID"`.

- [ ] **Step 4: Commit ảnh nếu có, rồi push nhánh**

```bash
git push -u origin worktree-first-run-modal-dock
```

---

## Self-Review

**Spec coverage:**
- §4 sáu bước + nguồn sự thật → Task 1
- §5.2 route → Task 2
- §5.3 schema/service/hooks → Task 3; `setup-steps` → Task 4; checklist → Task 5; dock → Task 6; wizard → Task 7; boundary → Task 8; tổng quan + dev preview → Task 9
- §6 bất biến "không query nào chạy" → Task 8 Step 1
- §7 không F5 → Task 7 Step 4 (chuyển bước trong `onSuccess`, sau `adopt()`)
- §8 lối thoát đăng xuất → Task 7 Step 2 (rail)
- §9 chuyển động → Task 6 Step 1, Task 7
- §10 rủi ro → đã có task tương ứng cho từng dòng
- §11 kiểm chứng → Task 10

**Điểm lệch so với spec, đã sửa trong plan:** spec §5.1 lo `GOOGLE_OAUTH_NOT_CONFIGURED` làm sập dock. Plan dùng `GoogleOAuthRepo.findConnection` (đọc DB thuần) thay vì usecase `getGoogleConnection` (cần biến môi trường OAuth), nên rủi ro đó biến mất — không cần khối `catch` riêng.

**Type consistency:** `SetupStepId` khai báo hai lần có chủ đích (core và ui), vì `ui/` không được import `core/` — cùng sáu giá trị, đã ghi chú ở cả hai file. `stepFlag`/`isSetupFinished` chỉ sống ở tầng ui. `StepView` giữ nguyên tên và hình dạng, chỉ nới `ordinal`.
