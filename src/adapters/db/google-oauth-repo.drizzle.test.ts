import { describe, expect, it } from "vitest";

import type { LogBindings, LogContext, Logger } from "@/core/ports/infra";

import type { Database } from "./client";
import { DrizzleGoogleOAuthRepo } from "./google-oauth-repo.drizzle";
import { makeSecretBox } from "./secret-box";
import { testTenantId } from "@/core/domain/tenant-context.testing";

/**
 * The read path of the Google connection, without a database: the query builder
 * is stubbed, the SECRET BOX is real — encryption is exactly the part a fake
 * would make meaningless.
 *
 * The write path (upsert + audit inside one transaction, behind the advisory
 * lock) is covered by the integration suite, like every other writer of
 * tenant_integration.
 */

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");
/** 32 bytes, base64. Test-only key. */
const TEST_KEY = Buffer.alloc(32, 5).toString("base64");

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

function stubDb(
  rows: Array<{ config: Record<string, unknown>; status: string }>,
  updates: Array<Record<string, unknown>>,
): Database {
  return {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) }),
    // Enough of the builder for the ONE statement that needs no transaction
    // (markConnectionExpired). Everything transactional stays in the
    // integration suite.
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          updates.push(values);
        },
      }),
    }),
  } as unknown as Database;
}

function build(
  rows: Array<{ config: Record<string, unknown>; status: string }>,
  lines: LogLine[] = [],
) {
  const box = makeSecretBox({ logger: recordingLogger(lines), readKey: () => TEST_KEY });
  const updates: Array<Record<string, unknown>> = [];
  const repo = new DrizzleGoogleOAuthRepo(stubDb(rows, updates), {
    box,
    logger: recordingLogger(lines),
  });
  return { repo, box, lines, updates };
}

function connectionConfig(
  refreshToken: string,
  sourceAccess: unknown = undefined,
): Record<string, unknown> {
  return {
    driveFolderId: "folder-1",
    spreadsheetId: "sheet-1",
    sheetName: "Mẫu 2026",
    oauth: {
      refreshToken,
      email: "shop@gmail.com",
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      connectedAt: "2026-08-19T03:00:00.000Z",
      connectedByUserId: null,
      ...(sourceAccess === undefined ? {} : { sourceAccess }),
    },
  };
}

describe("findConnection", () => {
  it("answers null when the tenant has no integration row at all", async () => {
    const { repo } = build([]);
    await expect(repo.findConnection(TENANT)).resolves.toBeNull();
  });

  it("answers null when the row exists but was never connected", async () => {
    const { repo } = build([
      { config: { driveFolderId: "f", spreadsheetId: "s", sheetName: "t" }, status: "active" },
    ]);
    await expect(repo.findConnection(TENANT)).resolves.toBeNull();
  });

  it("treats a hand-edited oauth blob as unconnected, and says so in the log", async () => {
    const lines: LogLine[] = [];
    const { repo } = build([{ config: { oauth: { email: "shop@gmail.com" } }, status: "active" }], lines);

    await expect(repo.findConnection(TENANT)).resolves.toBeNull();
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: "warn",
        context: expect.objectContaining({ reason: "OAUTH_BLOB_INVALID" }),
      }),
    );
  });

  it("reports status 'error' as such — the screen must say 'kết nối lại', not 'chưa kết nối'", async () => {
    const { box } = build([]);
    const sealed = box.sealSecret("refresh-1");
    const { repo } = build([{ config: connectionConfig(sealed), status: "error" }]);

    await expect(repo.findConnection(TENANT)).resolves.toMatchObject({
      email: "shop@gmail.com",
      status: "error",
    });
  });

  it("never returns the token, sealed or not", async () => {
    const { box } = build([]);
    const sealed = box.sealSecret("refresh-1");
    const { repo } = build([{ config: connectionConfig(sealed), status: "active" }]);

    const connection = await repo.findConnection(TENANT);
    expect(connection).toEqual({
      email: "shop@gmail.com",
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      connectedAt: "2026-08-19T03:00:00.000Z",
      connectedByUserId: null,
      status: "active",
      // Never checked on this row: null, which reads as "unknown" upstream.
      sourceAccess: null,
    });
    expect(JSON.stringify(connection)).not.toContain("refresh-1");
    expect(JSON.stringify(connection)).not.toContain(sealed);
  });
});

describe("findRefreshToken", () => {
  it("answers null for a tenant with no connection, so the caller falls back to the Service Account", async () => {
    const { repo } = build([{ config: {}, status: "active" }]);
    await expect(repo.findRefreshToken(TENANT)).resolves.toBeNull();
  });

  it("opens the sealed envelope", async () => {
    const { box } = build([]);
    const sealed = box.sealSecret("refresh-1");
    expect(sealed.startsWith("enc:v1:")).toBe(true);

    const { repo } = build([{ config: connectionConfig(sealed), status: "active" }]);
    await expect(repo.findRefreshToken(TENANT)).resolves.toBe("refresh-1");
  });

  it("refuses to guess when the envelope cannot be opened (rotated key)", async () => {
    const otherBox = makeSecretBox({
      logger: recordingLogger([]),
      readKey: () => Buffer.alloc(32, 9).toString("base64"),
    });
    const sealedElsewhere = otherBox.sealSecret("refresh-1");
    const { repo } = build([{ config: connectionConfig(sealedElsewhere), status: "active" }]);

    await expect(repo.findRefreshToken(TENANT)).rejects.toMatchObject({
      code: "INVALID_INPUT",
      context: { reason: "DECRYPT_FAILED" },
    });
  });

  it("still reads a legacy plaintext token, but makes it visible in the log", async () => {
    const lines: LogLine[] = [];
    const { repo } = build([{ config: connectionConfig("plain-refresh"), status: "active" }], lines);

    await expect(repo.findRefreshToken(TENANT)).resolves.toBe("plain-refresh");
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: "warn",
        context: expect.objectContaining({ reason: "PLAINTEXT_LEGACY" }),
      }),
    );
    // The warning names the field, never the value.
    expect(JSON.stringify(lines)).not.toContain("plain-refresh");
  });
});

describe("findConnection — the source-access verdict", () => {
  it("returns the stored verdict, so /status never has to call Drive", async () => {
    const { box } = build([]);
    const config = connectionConfig(box.sealSecret("refresh-1"), {
      state: "drive_unreadable",
      checkedAt: "2026-08-19T04:00:00.000Z",
    });
    const { repo } = build([{ config, status: "active" }]);

    await expect(repo.findConnection(TENANT)).resolves.toMatchObject({
      sourceAccess: { state: "drive_unreadable", checkedAt: "2026-08-19T04:00:00.000Z" },
    });
  });

  it("treats a hand-edited verdict as 'never checked' instead of trusting it", async () => {
    const { box } = build([]);
    const config = connectionConfig(box.sealSecret("refresh-1"), {
      state: "fine",
      checkedAt: "",
    });
    const { repo } = build([{ config, status: "active" }]);

    // Still a usable connection — only the unreadable verdict is dropped.
    await expect(repo.findConnection(TENANT)).resolves.toMatchObject({
      email: "shop@gmail.com",
      sourceAccess: null,
    });
  });
});

describe("markConnectionExpired", () => {
  it("parks the row when there IS a connection to park", async () => {
    const lines: LogLine[] = [];
    const { box } = build([]);
    const { repo, updates } = build(
      [{ config: connectionConfig(box.sealSecret("refresh-1")), status: "active" }],
      lines,
    );

    await repo.markConnectionExpired(TENANT, "REFRESH_REJECTED");

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ status: "error" });
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: "warn",
        context: expect.objectContaining({ error_code: "GOOGLE_AUTH_EXPIRED" }),
      }),
    );
  });

  /**
   * The row survives a disconnect (it still holds the Drive folder id), the
   * oauth blob does not. Writing `error` here would ask a tenant who is simply
   * NOT CONNECTED to "kết nối lại", and would park a Service Account tenant for
   * a failure that is not theirs.
   */
  it("writes nothing when the connection was already removed", async () => {
    const { repo, updates } = build([{ config: { driveFolderId: "folder-1" }, status: "active" }]);

    await repo.markConnectionExpired(TENANT, "REFRESH_REJECTED");
    expect(updates).toEqual([]);
  });

  it("writes nothing when the tenant has no integration row at all", async () => {
    const { repo, updates } = build([]);

    await repo.markConnectionExpired(TENANT, "HTTP_UNAUTHORIZED");
    expect(updates).toEqual([]);
  });
});

describe("saveSourceAccess — validation at the boundary", () => {
  it("refuses a state the contract does not know, before touching the database", async () => {
    const { repo } = build([]);
    await expect(
      repo.saveSourceAccess({
        tenantId: TENANT,
        state: "probably_fine" as never,
        checkedAt: "2026-08-19T04:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("refuses a missing timestamp", async () => {
    const { repo } = build([]);
    await expect(
      repo.saveSourceAccess({ tenantId: TENANT, state: "ok", checkedAt: "  " }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
