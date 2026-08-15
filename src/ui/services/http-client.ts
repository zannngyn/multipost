import type { z } from "zod";

import { ApiErrorBodySchema } from "@/ui/schemas/tenant-health.schema";

import { ApiError, CLIENT_ERROR_CODES } from "./api-error";

/**
 * THE single low-level network entry point of the UI (core-data-fetching:
 * "một điểm ra vào"). Every `*.api.ts` goes through `apiRequest`; no component,
 * hook or service calls `fetch` on its own.
 *
 * What stops here so the rest of the app never sees it:
 *  - transport failures (offline, DNS, abort, timeout) -> ApiError
 *  - non-JSON bodies from a proxy -> ApiError(MALFORMED_RESPONSE)
 *  - the `{code, message}` error envelope of app/api/_lib/http-errors.ts
 *  - schema validation of the success payload (server data is external data)
 *
 * Fail-soft rule for this codebase: NOTHING here fails soft. Every screen is an
 * operator tool — a swallowed error would show an empty panel and let someone
 * believe a sync ran or a post was composed. Callers decide how to render the
 * error (see core-feedback-states: 4xx = sửa input, 5xx = thử lại).
 */

/** A server that needs longer than this is a server problem, not a slow link. */
const DEFAULT_TIMEOUT_MS = 15_000;

export interface ApiRequestOptions<T> {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /**
   * Serialised as JSON. Omitted when absent (GET, DELETE with query params).
   *
   * A `FormData` body is passed through untouched instead (E9 upload): the
   * browser must set `content-type` itself, because only it knows the multipart
   * boundary — setting the header by hand produces a body no server can parse.
   */
  body?: unknown;
  /** Contract of the success payload — parsed before it reaches React. */
  schema: z.ZodType<T>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Vietnamese message when the payload does not match `schema`. */
  malformedMessage: string;
}

function encodeBody(body: unknown, isForm: boolean): BodyInit | undefined {
  if (body === undefined) return undefined;
  return isForm ? (body as FormData) : JSON.stringify(body);
}

/** Combines the caller's signal with the timeout — cancel must work either way. */
function withTimeout(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** A 502 from a proxy returns HTML; parsing it must not throw a raw SyntaxError. */
async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    throw new ApiError({
      code: CLIENT_ERROR_CODES.MALFORMED_RESPONSE,
      status: response.status,
      message: "Response body is not valid JSON",
      userMessage:
        "Máy chủ trả về dữ liệu không đọc được. Hãy thử lại; nếu vẫn lỗi, báo quản trị viên.",
      cause,
    });
  }
}

/** Maps the shared `{code, message, issues?}` envelope onto ApiError. */
export function toApiErrorBody(status: number, payload: unknown): ApiError {
  const parsed = ApiErrorBodySchema.safeParse(payload);

  // The server always answers with {code, message}; anything else means a proxy
  // or a framework page answered instead — do not invent a friendly message.
  if (!parsed.success) {
    return new ApiError({
      code: CLIENT_ERROR_CODES.MALFORMED_RESPONSE,
      status,
      message: `Unrecognised error body for HTTP ${status}`,
      userMessage: "Máy chủ trả về lỗi không xác định. Hãy thử lại sau ít phút.",
    });
  }

  return new ApiError({
    code: parsed.data.code,
    status,
    userMessage: parsed.data.message,
    message: `${parsed.data.code} (HTTP ${status})`,
    issues: parsed.data.issues,
  });
}

export async function apiRequest<T>(path: string, options: ApiRequestOptions<T>): Promise<T> {
  const method = options.method ?? "GET";

  let response: Response;
  try {
    const isForm = options.body instanceof FormData;
    response = await fetch(path, {
      method,
      headers:
        options.body === undefined || isForm
          ? { accept: "application/json" }
          : { accept: "application/json", "content-type": "application/json" },
      body: encodeBody(options.body, isForm),
      // Session-scoped operator data: never served from an HTTP cache.
      cache: "no-store",
      signal: withTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.signal),
    });
  } catch (cause) {
    // An abort asked for by the caller (component unmounted, query cancelled) is
    // not a failure to report — rethrow it so TanStack Query can drop it.
    if (options.signal?.aborted) throw cause;

    const isTimeout = cause instanceof DOMException && cause.name === "TimeoutError";
    throw new ApiError({
      code: isTimeout ? CLIENT_ERROR_CODES.TIMEOUT : CLIENT_ERROR_CODES.NETWORK,
      status: 0,
      message: cause instanceof Error ? cause.message : String(cause),
      userMessage: isTimeout
        ? "Máy chủ phản hồi quá lâu. Hãy thử lại."
        : "Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.",
      cause,
    });
  }

  const payload = await readJson(response);

  if (!response.ok) throw toApiErrorBody(response.status, payload);

  const parsed = options.schema.safeParse(payload);
  if (!parsed.success) {
    throw new ApiError({
      code: CLIENT_ERROR_CODES.MALFORMED_RESPONSE,
      status: response.status,
      // Paths only: the payload itself may hold operator data we must not log.
      message: `${method} ${path} payload failed validation: ${parsed.error.issues
        .map((issue) => issue.path.join("."))
        .join(", ")}`,
      userMessage: options.malformedMessage,
    });
  }

  return parsed.data;
}
