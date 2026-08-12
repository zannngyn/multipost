import { describe, expect, it } from "vitest";

import { AppError } from "@/core/domain/errors";

import { isPgError, pgErrorCode, wrapDbError, PG_INVALID_TEXT_REPRESENTATION } from "./db-errors";

/**
 * Edge cases first: the point of this helper is that a CALLER mistake (22P02)
 * and a DATABASE outage stop sharing one error code — 400 vs 503.
 */

/** What postgres.js actually throws (fields captured from a real 22P02). */
function pgError(overrides: Record<string, unknown> = {}) {
  return Object.assign(new Error('invalid input syntax for type uuid: "not-a-uuid"'), {
    name: "PostgresError",
    code: PG_INVALID_TEXT_REPRESENTATION,
    severity: "ERROR",
    routine: "string_to_uuid",
    where: "unnamed portal parameter $1 = '...'",
    ...overrides,
  });
}

/** What drizzle actually throws: the PostgresError is hidden in `cause`. */
function drizzleError(cause: unknown) {
  return Object.assign(
    new Error('Failed query: delete from "product" where ... params: not-a-uuid'),
    { name: "DrizzleQueryError", query: "delete from product", params: [], cause },
  );
}

describe("pgErrorCode / isPgError — edge cases first", () => {
  it.each([[null], [undefined], ["22P02"], [42], [new Error("plain")]])(
    "returns null for a non-driver value (%s)",
    (value) => {
      expect(pgErrorCode(value)).toBeNull();
      expect(isPgError(value, PG_INVALID_TEXT_REPRESENTATION)).toBe(false);
    },
  );

  it("reads the SQLSTATE of a driver error", () => {
    expect(pgErrorCode(pgError())).toBe("22P02");
    expect(isPgError(pgError({ code: "23505" }), PG_INVALID_TEXT_REPRESENTATION)).toBe(false);
  });

  it("digs the SQLSTATE out of the drizzle wrapper (its own code is undefined)", () => {
    expect(pgErrorCode(drizzleError(pgError()))).toBe("22P02");
    expect(pgErrorCode(drizzleError(new Error("no sqlstate here")))).toBeNull();
  });

  it("stops instead of looping on a self-referencing cause chain", () => {
    const looping: { cause?: unknown } = {};
    looping.cause = looping;
    expect(pgErrorCode(looping)).toBeNull();
  });
});

describe("wrapDbError", () => {
  it("maps 22P02 to INVALID_INPUT (400) instead of DB_ERROR (503)", () => {
    const wrapped = wrapDbError(pgError(), {
      operation: "product.deleteStale",
      tenant_id: "00000000-0000-0000-0000-000000000001",
      field: "syncRunId",
      sync_run_id: "not-a-uuid",
    });

    expect(wrapped.code).toBe("INVALID_INPUT");
    expect(wrapped.context).toMatchObject({
      operation: "product.deleteStale",
      field: "syncRunId",
      pg_code: "22P02",
      pg_routine: "string_to_uuid",
      invalid_type: "uuid",
    });
    expect(wrapped.userMessage).toContain("syncRunId");
  });

  it("maps a drizzle-wrapped 22P02 the same way", () => {
    const wrapped = wrapDbError(drizzleError(pgError()), {
      operation: "media.deleteStale",
      field: "syncRunId",
    });

    expect(wrapped.code).toBe("INVALID_INPUT");
    expect(wrapped.context).toMatchObject({
      pg_code: "22P02",
      pg_routine: "string_to_uuid",
      invalid_type: "uuid",
    });
  });

  it("never copies the offending value into the message", () => {
    const wrapped = wrapDbError(pgError(), { operation: "syncRun.finish", field: "syncRunId" });
    expect(wrapped.message).not.toContain("not-a-uuid");
    // The driver error stays reachable as the cause, for logs only.
    expect(String(wrapped.cause)).toContain("not-a-uuid");
  });

  it("falls back to a neutral message when no field name was passed", () => {
    const wrapped = wrapDbError(pgError(), { operation: "tenant.findById" });
    expect(wrapped.code).toBe("INVALID_INPUT");
    expect(wrapped.userMessage).toBe("Dữ liệu gửi lên không đúng định dạng.");
    expect(wrapped.context).toMatchObject({ pg_code: "22P02" });
  });

  it("still reports a real driver failure as DB_ERROR", () => {
    const wrapped = wrapDbError(pgError({ code: "57P01", message: "terminating connection" }), {
      operation: "product.findByCode",
    });
    expect(wrapped.code).toBe("DB_ERROR");
  });

  it.each([
    ["a plain Error", new Error("connection refused")],
    ["a thrown string", "boom"],
    ["undefined", undefined],
  ])("reports %s as DB_ERROR with the operation context", (_label, thrown) => {
    const wrapped = wrapDbError(thrown, { operation: "media.upsertMany", tenant_id: "t" });
    expect(wrapped.code).toBe("DB_ERROR");
    expect(wrapped.context).toMatchObject({ operation: "media.upsertMany" });
  });

  it("keeps the code of an AppError thrown inside the try block", () => {
    const wrapped = wrapDbError(new AppError("OUT_OF_STOCK", { message: "blocked" }), {
      operation: "product.findByCode",
    });
    expect(wrapped.code).toBe("OUT_OF_STOCK");
    expect(wrapped.context).toMatchObject({ operation: "product.findByCode" });
  });

  it("does not treat a 22P02-looking string as a driver error", () => {
    const wrapped = wrapDbError("22P02", { operation: "media.deleteStale" });
    expect(wrapped.code).toBe("DB_ERROR");
  });
});
