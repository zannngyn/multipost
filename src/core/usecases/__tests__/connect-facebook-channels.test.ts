import { describe, expect, it } from "vitest";

import { AppError } from "@/core/domain/errors";
import type { LogBindings, LogContext, Logger } from "@/core/ports/infra";
import type {
  ChannelConfig,
  ChannelConfigRepo,
  ChannelConnectClient,
  ListRemoteChannelsResult,
  UpsertChannelsInput,
  UpsertChannelsResult,
  UserAccessToken,
} from "@/core/ports/publisher";

import { facebookChannelId, makeConnectFacebookChannels } from "../connect-facebook-channels";
import { testTenantId } from "@/core/domain/tenant-context.testing";

/**
 * E5.1 — both doors of "Kết nối Fanpage" with in-memory ports.
 *
 * The rules being protected: the CSRF state decides before anything is fetched,
 * a Page the operator switched OFF stays off across a re-import, and no token
 * ever reaches a log line or a returned channel.
 */

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");
const OTHER_TENANT = testTenantId("00000000-0000-0000-0000-000000000002");
const STATE = "a".repeat(64);
const USER_TOKEN = "USER-TOKEN-SECRET";

interface LogLine {
  level: string;
  message: string;
  context?: LogContext;
}

function recordingLogger(lines: LogLine[]): Logger {
  const make = (): Logger => ({
    child: (_bindings: LogBindings) => make(),
    debug: (message, context) => lines.push({ level: "debug", message, context }),
    info: (message, context) => lines.push({ level: "info", message, context }),
    warn: (message, context) => lines.push({ level: "warn", message, context }),
    error: (message, context) => lines.push({ level: "error", message, context }),
  });
  return make();
}

/**
 * In-memory twin of DrizzleChannelConfigRepo, with the two write rules that
 * matter: a new channel is ACTIVE, an existing one KEEPS its status.
 */
function makeChannelRepo(seed: ChannelConfig[] = [], storedUserToken: string | null = null) {
  const byTenant = new Map<string, ChannelConfig[]>([[TENANT, [...seed]]]);
  const tokens = new Map<string, string>(storedUserToken ? [[TENANT, storedUserToken]] : []);

  const repo: ChannelConfigRepo & { tokens: typeof tokens; byTenant: typeof byTenant } = {
    tokens,
    byTenant,
    async findChannel(tenantId, channelId) {
      return (byTenant.get(tenantId) ?? []).find((c) => c.channelId === channelId) ?? null;
    },
    async listChannels(tenantId) {
      return byTenant.get(tenantId) ?? [];
    },
    async getPublishSettings() {
      return { spacingMs: 0, retryBackoffMs: 0, maxAttempts: 3 };
    },
    async upsertChannels(input: UpsertChannelsInput): Promise<UpsertChannelsResult> {
      if (input.channels.length === 0) {
        throw new AppError("INVALID_INPUT", { message: "empty", context: { field: "channels" } });
      }
      const current = [...(byTenant.get(input.tenantId) ?? [])];
      const added: string[] = [];
      const updated: string[] = [];
      for (const channel of input.channels) {
        const index = current.findIndex((c) => c.channelId === channel.channelId);
        if (index < 0) {
          current.push({ ...channel, status: "active" });
          added.push(channel.channelId);
          continue;
        }
        current[index] = { ...channel, status: current[index].status };
        updated.push(channel.channelId);
      }
      byTenant.set(input.tenantId, current);
      if (input.userAccessToken) tokens.set(input.tenantId, input.userAccessToken);
      return { added, updated };
    },
    async findUserAccessToken(tenantId) {
      return tokens.get(tenantId) ?? null;
    },
    async setChannelStatus() {
      throw new AppError("INTERNAL", { message: "unused here" });
    },
    async removeChannel() {
      throw new AppError("INTERNAL", { message: "unused here" });
    },
  };
  return repo;
}

interface ConnectStub {
  accounts?: ListRemoteChannelsResult;
  listFails?: AppError;
  extended?: boolean;
  exchanged?: string;
}

function makeConnectClient(stub: ConnectStub = {}) {
  const calls: { listedWith: string[]; extendedWith: string[]; exchangedCodes: string[] } = {
    listedWith: [],
    extendedWith: [],
    exchangedCodes: [],
  };
  const client: ChannelConnectClient = {
    buildAuthorizeUrl: ({ state }) => `https://www.facebook.com/v23.0/dialog/oauth?state=${state}`,
    async exchangeCodeForUserToken({ code }): Promise<UserAccessToken> {
      calls.exchangedCodes.push(code);
      return {
        userAccessToken: stub.exchanged ?? USER_TOKEN,
        expiresAt: null,
        extended: stub.extended ?? true,
      };
    },
    async extendUserToken({ userAccessToken }): Promise<UserAccessToken> {
      calls.extendedWith.push(userAccessToken);
      return { userAccessToken, expiresAt: null, extended: stub.extended ?? true };
    },
    async listAccounts({ userAccessToken }): Promise<ListRemoteChannelsResult> {
      calls.listedWith.push(userAccessToken);
      if (stub.listFails) throw stub.listFails;
      return (
        stub.accounts ?? {
          accounts: [
            {
              externalId: "111",
              name: "Shop A",
              accessToken: "page-token-a",
              tokenExpiresAt: null,
            },
          ],
          skipped: [],
        }
      );
    },
  };
  return { client, calls };
}

function harness(options: { seed?: ChannelConfig[]; storedToken?: string | null } & ConnectStub = {}) {
  const { seed, storedToken, ...stub } = options;
  const lines: LogLine[] = [];
  const channels = makeChannelRepo(seed ?? [], storedToken ?? null);
  const { client, calls } = makeConnectClient(stub);
  const usecases = makeConnectFacebookChannels({
    channels,
    connect: client,
    logger: recordingLogger(lines),
    newState: () => STATE,
  });
  return { ...usecases, channels, calls, lines };
}

/** Asserts the promise rejected with an AppError, and hands it over typed. */
async function expectAppError(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(() => null).catch((e: unknown) => e);
  expect(AppError.is(error)).toBe(true);
  return error as AppError;
}

function fbChannel(channelId: string, status: ChannelConfig["status"]): ChannelConfig {
  return {
    channelId,
    platform: "facebook",
    name: "Tên cũ",
    externalId: channelId.replace("fb-", ""),
    accessToken: "old-page-token",
    status,
    tokenExpiresAt: null,
  };
}

// --- Edge cases first -------------------------------------------------------

describe("connect facebook — the CSRF gate decides before any network call", () => {
  it("refuses a callback with NO state cookie (expired or cookies blocked)", async () => {
    const usecases = harness();
    await expect(
      usecases.completeFacebookConnect({
        tenantId: TENANT,
        code: "the-code",
        state: STATE,
        expectedState: "",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { reason: "STATE_MISSING" } });
    expect(usecases.calls.exchangedCodes).toEqual([]);
  });

  it("refuses a callback whose state does not match the cookie", async () => {
    const usecases = harness();
    await expect(
      usecases.completeFacebookConnect({
        tenantId: TENANT,
        code: "the-code",
        state: "b".repeat(64),
        expectedState: STATE,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { reason: "STATE_MISMATCH" } });
    expect(usecases.calls.exchangedCodes).toEqual([]);
  });

  it("refuses a callback with a matching state but no code", async () => {
    const usecases = harness();
    await expect(
      usecases.completeFacebookConnect({
        tenantId: TENANT,
        code: "",
        state: STATE,
        expectedState: STATE,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { reason: "CODE_MISSING" } });
  });

  it("refuses a tenant id that is not a UUID, on every entry point", async () => {
    const usecases = harness();
    await expect(usecases.startFacebookConnect({ tenantId: testTenantId("nope") })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(
      usecases.importChannels({ tenantId: testTenantId("nope"), userAccessToken: USER_TOKEN }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(usecases.refreshChannels({ tenantId: testTenantId("nope") })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(usecases.calls.listedWith).toEqual([]);
  });
});

describe("connect facebook — refused imports", () => {
  it("refuses an empty user token before touching Facebook", async () => {
    const usecases = harness();
    await expect(
      usecases.importChannels({ tenantId: TENANT, userAccessToken: "   " }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { reason: "EMPTY" } });
    expect(usecases.calls.listedWith).toEqual([]);
  });

  it("never reports success for a token that manages no Page", async () => {
    const usecases = harness({ accounts: { accounts: [], skipped: [] } });

    const error = await expectAppError(usecases.importChannels({ tenantId: TENANT, userAccessToken: USER_TOKEN }));

    expect(error.code).toBe("CHANNEL_NOT_CONFIGURED");
    expect(error.context).toMatchObject({ reason: "NO_PAGES" });
    // The message must name the scopes: "0 Trang" alone is not actionable.
    expect(error.userMessage).toContain("pages_show_list");
    expect(await usecases.channels.listChannels(TENANT)).toEqual([]);
  });

  it("passes an expired-token failure through with its own instruction", async () => {
    const listFails = new AppError("TOKEN_EXPIRED", {
      message: "Facebook connect step list_pages failed",
      userMessage: "Token Facebook đã hết hạn hoặc không hợp lệ — hãy lấy User Access Token mới rồi dán lại.",
      context: { step: "list_pages", graph_code: 190 },
    });
    const usecases = harness({ listFails });

    const error = await expectAppError(usecases.importChannels({ tenantId: TENANT, userAccessToken: USER_TOKEN }));

    expect(error.code).toBe("TOKEN_EXPIRED");
    expect(error.userMessage).toContain("hết hạn");
    expect(usecases.channels.tokens.get(TENANT)).toBeUndefined();
  });

  it("tells the operator to paste a token when nothing was ever stored", async () => {
    const usecases = harness({ storedToken: null });

    const error = await expectAppError(usecases.refreshChannels({ tenantId: TENANT }));

    expect(error.code).toBe("CHANNEL_NOT_CONFIGURED");
    expect(error.context).toMatchObject({ reason: "USER_TOKEN_MISSING" });
    expect(error.userMessage).toContain("dán User Access Token");
    expect(usecases.calls.listedWith).toEqual([]);
  });
});

// --- Happy paths ------------------------------------------------------------

describe("connect facebook — importing Pages", () => {
  it("stores a NEW Page as active, with the id rule fb-<pageId>", async () => {
    const usecases = harness();

    const result = await usecases.importChannels({
      tenantId: TENANT,
      userAccessToken: USER_TOKEN,
    });

    expect(result).toMatchObject({ tenantId: TENANT, imported: 1, updated: 0, skipped: 0 });
    expect(result.channels).toEqual([
      {
        channelId: "fb-111",
        platform: "facebook",
        name: "Shop A",
        externalId: "111",
        status: "active",
        tokenExpiresAt: null,
      },
    ]);
    expect(facebookChannelId("111")).toBe("fb-111");
  });

  it("never returns a token, and never logs one", async () => {
    const usecases = harness();

    const result = await usecases.importChannels({
      tenantId: TENANT,
      userAccessToken: USER_TOKEN,
    });

    const serialisedResult = JSON.stringify(result);
    expect(serialisedResult).not.toContain("page-token-a");
    expect(serialisedResult).not.toContain(USER_TOKEN);
    expect(serialisedResult).not.toContain("accessToken");

    const serialisedLogs = JSON.stringify(usecases.lines);
    expect(serialisedLogs).not.toContain("page-token-a");
    expect(serialisedLogs).not.toContain(USER_TOKEN);
  });

  it("refreshes an existing Page but KEEPS the status an operator chose", async () => {
    const usecases = harness({ seed: [fbChannel("fb-111", "disabled")] });

    const result = await usecases.importChannels({
      tenantId: TENANT,
      userAccessToken: USER_TOKEN,
    });

    expect(result).toMatchObject({ imported: 0, updated: 1 });
    const [channel] = await usecases.channels.listChannels(TENANT);
    // Name and token refreshed...
    expect(channel).toMatchObject({ name: "Shop A", accessToken: "page-token-a" });
    // ...status untouched: re-importing must not switch a Page back on.
    expect(channel.status).toBe("disabled");
  });

  it("counts Pages the platform listed without a usable token", async () => {
    const usecases = harness({
      accounts: {
        accounts: [
          { externalId: "111", name: "Shop A", accessToken: "page-token-a", tokenExpiresAt: null },
        ],
        skipped: ["999"],
      },
    });

    const result = await usecases.importChannels({
      tenantId: TENANT,
      userAccessToken: USER_TOKEN,
    });

    expect(result.skipped).toBe(1);
    const warn = usecases.lines.find((line) => line.context?.reason === "PAGE_TOKEN_MISSING");
    expect(warn?.context).toMatchObject({ pages: ["999"] });
  });

  it("warns — and still imports — when the token could not be extended", async () => {
    const usecases = harness({ extended: false });

    const result = await usecases.importChannels({
      tenantId: TENANT,
      userAccessToken: USER_TOKEN,
    });

    expect(result.imported).toBe(1);
    const warn = usecases.lines.find((line) => line.context?.reason === "APP_SECRET_MISSING");
    expect(warn?.level).toBe("warn");
  });

  it("stores the user token so a refresh needs no second paste", async () => {
    const usecases = harness();
    await usecases.importChannels({ tenantId: TENANT, userAccessToken: USER_TOKEN });

    const refreshed = await usecases.refreshChannels({ tenantId: TENANT });

    expect(refreshed).toMatchObject({ imported: 0, updated: 1 });
    expect(usecases.calls.listedWith).toEqual([USER_TOKEN, USER_TOKEN]);
  });

  it("writes into the tenant of the STATE COOKIE, not into another one", async () => {
    const usecases = harness();

    await usecases.completeFacebookConnect({
      tenantId: TENANT,
      code: "the-code",
      state: STATE,
      expectedState: STATE,
    });

    expect(usecases.calls.exchangedCodes).toEqual(["the-code"]);
    expect((await usecases.channels.listChannels(TENANT)).map((c) => c.channelId)).toEqual([
      "fb-111",
    ]);
    expect(await usecases.channels.listChannels(OTHER_TENANT)).toEqual([]);
  });
});

describe("connect facebook — starting the flow", () => {
  it("hands back the authorize URL and the nonce the cookie must carry", async () => {
    const usecases = harness();
    const started = await usecases.startFacebookConnect({ tenantId: TENANT });

    expect(started.state).toBe(STATE);
    expect(started.authorizeUrl).toContain(`state=${STATE}`);
    expect(started.tenantId).toBe(TENANT);
  });

  it("refuses to start with a nonce too short to be a CSRF token", async () => {
    const lines: LogLine[] = [];
    const usecases = makeConnectFacebookChannels({
      channels: makeChannelRepo(),
      connect: makeConnectClient().client,
      logger: recordingLogger(lines),
      newState: () => "short",
    });

    await expect(usecases.startFacebookConnect({ tenantId: TENANT })).rejects.toMatchObject({
      code: "INTERNAL",
    });
  });
});
