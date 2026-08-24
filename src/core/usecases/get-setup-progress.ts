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
 * It exists because the answer used to be scattered across five screens: an
 * operator had to visit /sync, /channels and /posts to work out why nothing
 * could be published yet. Every flag here is a READ of state those screens
 * already own; nothing is stored, so the dock can never disagree with the
 * screen it links to.
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
 * goal as a setup step would make a fully wired tenant read "4/6" and look
 * broken to the operator who just finished wiring it.
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
  /**
   * The REPO, not `connectGoogleDrive.getGoogleConnection`: the usecase needs
   * the OAuth client config and throws GOOGLE_OAUTH_NOT_CONFIGURED on a
   * deployment that has none, which would take down a dock that only wanted to
   * know whether a row exists. This reads the row.
   */
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
     * Five independent reads, so they go together. Deliberately NOT
     * `allSettled`: a repo that failed has not told us the step is unfinished,
     * and answering "chưa xong" on a dead database would send the operator off
     * to reconnect something that is already connected (CLAUDE.md rule 5 —
     * never swallow, and never invent a default on a failed read).
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
