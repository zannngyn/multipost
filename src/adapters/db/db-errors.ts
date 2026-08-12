import { AppError } from "@/core/domain/errors";

/**
 * One translation point from driver failure -> AppError for every repo in
 * adapters/db. Repos call `wrapDbError` instead of `AppError.from(..., "DB_ERROR")`
 * so that a caller mistake and an infrastructure outage stop looking the same.
 *
 * The distinction that matters: SQLSTATE 22P02 (invalid_text_representation) is
 * raised when Postgres cannot parse a PARAMETER — "not-a-uuid" sent as a uuid.
 * Nothing is wrong with the database; the caller sent garbage. Reporting it as
 * DB_ERROR (HTTP 503) tells the operator "database down" and hides a 400.
 *
 * Values are never copied into the error message: the driver text embeds the
 * offending value (`invalid input syntax for type uuid: "..."`), and that value
 * is caller input which must not travel into a user-facing message.
 */

/** invalid_text_representation — a parameter did not parse as its column type. */
export const PG_INVALID_TEXT_REPRESENTATION = "22P02";

/** Shape of a `postgres` (postgres.js) driver error, minus everything unused. */
interface PostgresErrorLike {
  code?: unknown;
  routine?: unknown;
  message?: unknown;
}

export interface DbErrorContext {
  /** Repo method that failed, e.g. "product.deleteStale". Always set it. */
  readonly operation: string;
  readonly tenant_id?: string | null;
  /**
   * Caller-facing name of the parameter Postgres could not parse, e.g.
   * "syncRunId". Postgres does not name it (`unnamed portal parameter $1`), so
   * only the repo knows — pass it on any statement that binds a uuid/number
   * coming from outside.
   */
  readonly field?: string;
  readonly [key: string]: unknown;
}

/** Drizzle throws DrizzleQueryError and hides the PostgresError in `cause`. */
const MAX_CAUSE_DEPTH = 5;

/**
 * The driver error inside whatever wrapper threw it. Walking `cause` is not
 * optional: drizzle wraps every failure in a DrizzleQueryError whose own `code`
 * is undefined, so a top-level-only check sees no SQLSTATE and misses 22P02.
 */
export function findPgError(error: unknown): PostgresErrorLike | null {
  let current: unknown = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) return null;
    const code = (current as PostgresErrorLike).code;
    if (typeof code === "string" && code.length > 0) return current as PostgresErrorLike;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** SQLSTATE of a driver error (own or wrapped), or null when there is none. */
export function pgErrorCode(error: unknown): string | null {
  const pgError = findPgError(error);
  return pgError ? (pgError.code as string) : null;
}

export function isPgError(error: unknown, sqlState: string): boolean {
  return pgErrorCode(error) === sqlState;
}

/** The type name Postgres failed to parse into ("uuid", "integer", ...). */
function invalidTypeOf(error: PostgresErrorLike | null): string | null {
  const message = error?.message;
  if (typeof message !== "string") return null;
  const match = /invalid input syntax for type (\w+)/i.exec(message);
  return match ? match[1] : null;
}

/**
 * Wraps anything thrown by a statement.
 *
 * - 22P02                -> AppError('INVALID_INPUT')  (HTTP 400)
 * - an AppError already  -> kept with its own code, context merged
 * - anything else        -> AppError('DB_ERROR')       (HTTP 503)
 */
export function wrapDbError(error: unknown, context: DbErrorContext): AppError {
  const pgError = findPgError(error);

  if (pgError?.code === PG_INVALID_TEXT_REPRESENTATION) {
    const invalidType = invalidTypeOf(pgError);
    const routine = pgError.routine;
    const field = typeof context.field === "string" ? context.field : null;

    return new AppError("INVALID_INPUT", {
      // No value, no driver text: the raw message embeds caller input.
      message: `Postgres rejected a parameter as malformed (${PG_INVALID_TEXT_REPRESENTATION}) in ${context.operation}`,
      userMessage: field
        ? `Giá trị của trường '${field}' không đúng định dạng.`
        : "Dữ liệu gửi lên không đúng định dạng.",
      context: {
        ...context,
        pg_code: PG_INVALID_TEXT_REPRESENTATION,
        pg_routine: typeof routine === "string" ? routine : null,
        invalid_type: invalidType,
      },
      cause: error,
    });
  }

  // Business errors thrown inside the try block keep their own code; only a
  // real driver failure becomes DB_ERROR.
  return AppError.from(error, "DB_ERROR", context);
}
