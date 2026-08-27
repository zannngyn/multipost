import { describe, expect, it } from "vitest";

import type { GenerationLogEntry } from "@/core/ports/ai";
import type { LogBindings, LogContext, Logger } from "@/core/ports/infra";

import { makeDrizzleGenerationLog } from "../ai-generation-log.drizzle";
import type { Database } from "../client";
import { testTenantId } from "@/core/domain/tenant-context.testing";

/**
 * Row MAPPING without a database: the derivations that decide what a dashboard
 * query sees (status, validation_stage_failed) are the part a real Postgres
 * would not check for us.
 */

const TENANT = testTenantId("66666666-6666-6666-6666-666666666666");

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

/** Captures what would have been inserted; optionally fails like a dead DB. */
function stubDb(captured: Array<Record<string, unknown>>, failWith?: Error): Database {
  return {
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        if (failWith) throw failWith;
        captured.push(row);
      },
    }),
  } as unknown as Database;
}

function entry(overrides: Partial<GenerationLogEntry> = {}): GenerationLogEntry {
  return {
    generationId: "gen-1",
    attemptNo: 1,
    tenantId: TENANT,
    task: "facebook_content",
    promptTemplateId: "facebook-product-content",
    promptVersion: 1,
    provider: "google",
    model: "gemini-test-flash-lite",
    tier: "cheap",
    fallbackUsed: false,
    escalationFrom: null,
    inputHash: "hash-1",
    inputTokens: 1200,
    outputTokens: 400,
    cachedTokens: 0,
    latencyMs: 900,
    estimatedCostUsd: 0.00136,
    success: true,
    validationPassed: true,
    createdAt: "2026-08-13T02:00:00.000Z",
    ...overrides,
  };
}

describe("drizzle ai_generation log", () => {
  it("refuses an entry without a generationId", async () => {
    const log = makeDrizzleGenerationLog({
      db: stubDb([]),
      logger: recordingLogger([]),
      newId: () => "row-1",
    });
    await expect(log.record(entry({ generationId: "" }))).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("logs with full context and rethrows when the insert fails", async () => {
    const lines: LogLine[] = [];
    const log = makeDrizzleGenerationLog({
      db: stubDb([], new Error("connection terminated")),
      logger: recordingLogger(lines),
      newId: () => "row-1",
    });

    await expect(log.record(entry())).rejects.toMatchObject({ code: "DB_ERROR" });

    const error = lines.find((line) => line.level === "error");
    expect(error?.context?.generation_id).toBe("gen-1");
    expect(error?.context?.model).toBe("gemini-test-flash-lite");
    expect(error?.context?.tenant_id).toBe(TENANT);
  });

  it("writes status=provider_error for a failed call, with zero usage", async () => {
    const rows: Array<Record<string, unknown>> = [];
    const log = makeDrizzleGenerationLog({
      db: stubDb(rows),
      logger: recordingLogger([]),
      newId: () => "row-1",
    });

    await log.record(
      entry({
        success: false,
        validationPassed: undefined,
        errorCode: "AI_RATE_LIMITED",
        failureKind: "rate_limited",
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
      }),
    );

    expect(rows[0]).toMatchObject({
      status: "provider_error",
      failureKind: "rate_limited",
      errorCode: "AI_RATE_LIMITED",
      costUsd: 0,
      validationStageFailed: null,
    });
  });

  it("writes status=validation_failed with the FIRST failed stage", async () => {
    const rows: Array<Record<string, unknown>> = [];
    const log = makeDrizzleGenerationLog({
      db: stubDb(rows),
      logger: recordingLogger([]),
      newId: () => "row-2",
    });

    await log.record(
      entry({
        attemptNo: 2,
        escalationFrom: 1,
        validationPassed: false,
        validationFailures: [
          { stage: 4, rule: "policy.price_like_number", message: "có số giống giá" },
          { stage: 2, rule: "business.name_missing", message: "thiếu tên" },
        ],
      }),
    );

    expect(rows[0]).toMatchObject({
      status: "validation_failed",
      validationStageFailed: 2,
      escalationFrom: 1,
      attemptNo: 2,
    });
  });

  it("stores the business context (batch/product/channel) and the tenant stamp", async () => {
    const rows: Array<Record<string, unknown>> = [];
    const log = makeDrizzleGenerationLog({
      db: stubDb(rows),
      logger: recordingLogger([]),
      newId: () => "row-3",
    });

    await log.record(
      entry({
        batchId: "batch-9",
        productCode: "MG0SV6055",
        channelId: "fbpage-a",
        postJobId: "job-1",
        output: { title: "TIÊU ĐỀ" },
      }),
    );

    expect(rows[0]).toMatchObject({
      tenantId: TENANT,
      batchId: "batch-9",
      productCode: "MG0SV6055",
      channelId: "fbpage-a",
      postJobId: "job-1",
      status: "passed",
      validationStageFailed: null,
    });
  });

  it("replaces an unparseable createdAt instead of inserting Invalid Date", async () => {
    const rows: Array<Record<string, unknown>> = [];
    const log = makeDrizzleGenerationLog({
      db: stubDb(rows),
      logger: recordingLogger([]),
      newId: () => "row-4",
    });

    await log.record(entry({ createdAt: "not-a-date" }));
    expect(Number.isNaN((rows[0].createdAt as Date).getTime())).toBe(false);
  });
});

/**
 * Measured live on 15/08/2026: gpt-4.1-mini returned mojibake containing U+0000.
 * Postgres refuses that byte in text and jsonb ("unsupported Unicode escape
 * sequence"), so the whole INSERT failed and the row explaining why the post was
 * blocked was lost — the opposite of business rule 5.
 */
describe("drizzle ai_generation log — NUL in model output", () => {
  const NUL = "\u0000";

  it("still writes the row when the output carries a NUL", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const log = makeDrizzleGenerationLog({
      db: stubDb(captured),
      logger: recordingLogger([]),
      newId: () => "row-1",
    });

    await log.record(
      entry({
        success: true,
        validationPassed: false,
        output: { title: `MÙA${NUL} HÈ`, claims: [{ sourceText: `lụa${NUL} mềm` }] },
        validationFailures: [
          { stage: 3, rule: "claim.source_not_found", message: `nguồn "${NUL}lụa" không có` },
        ],
      }),
    );

    const row = captured[0];
    const serialised = JSON.stringify([row?.output, row?.validationFailures]);
    expect(captured).toHaveLength(1);
    expect(serialised).not.toContain("\\u0000");
    // The text either side of the stripped byte is kept — this is a repair, not
    // a redaction: the operator still gets a readable reason.
    expect(serialised).toContain("MÙA HÈ");
    expect(serialised).toContain("claim.source_not_found");
  });

  it("leaves ordinary output untouched", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const log = makeDrizzleGenerationLog({
      db: stubDb(captured),
      logger: recordingLogger([]),
      newId: () => "row-1",
    });
    const output = { title: "MÙA HÈ", body: "Dòng 1\nDòng 2\tcó tab", hashtags: ["#a"] };

    await log.record(entry({ output }));

    expect(captured[0]?.output).toEqual(output);
  });
});
