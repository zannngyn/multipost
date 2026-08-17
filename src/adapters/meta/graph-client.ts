import { z } from "zod";

import { AppError } from "@/core/domain/errors";
import type { Logger } from "@/core/ports/infra";

import { mapGraphError, type GraphErrorBody } from "./graph-error-map";

/**
 * Minimal Graph API transport: a form-encoded POST (publishing) and a query
 * GET (the connect flow of E5.1), JSON back. It owns every HTTP concern
 * (timeout, status, error shape) so the publisher above it reads like the
 * business steps of E5.2.
 *
 * VERSION — Graph API is versioned in the path (`/v23.0/{page-id}/photos`) and
 * a version is supported for ~2 years. It is configurable (META_GRAPH_VERSION)
 * and NOT verified against Meta's changelog from this machine: confirm the
 * current version before the first real Page test.
 */

export const DEFAULT_GRAPH_VERSION = "v23.0";
const DEFAULT_BASE_URL = "https://graph.facebook.com";
const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * Uploads get their own, longer budget. A photo post sends up to 10 files of
 * several MB each and a measured real upload took ~3.8s for 7.75MB on a good
 * link; a hotel wifi is an order of magnitude slower, and killing a 9MB upload
 * at 30s would re-create the very failure this transport exists to remove.
 */
const DEFAULT_UPLOAD_TIMEOUT_MS = 180_000;
/** Content type for a part whose source reported none (606 files have no extension). */
const FALLBACK_PART_MIME = "application/octet-stream";

/**
 * Hosts `postAbsolute` may send a Page token to.
 *
 * The URL it posts to comes from Graph's OWN ANSWER (`upload_url` of the Reels
 * start phase), and the request carries `Authorization: OAuth <page token>`.
 * Without this list, whoever can shape that answer picks where our token goes.
 *
 * Exactly one entry, on purpose: `rupload.facebook.com` is the only upload host
 * this code has ever used (see REELS_UPLOAD_BASE_URL in facebook-publisher).
 * Do NOT add hosts from memory — check Meta's docs, then add with a comment.
 */
export const ALLOWED_UPLOAD_HOSTS: readonly string[] = ["rupload.facebook.com"];

/** Graph answers errors as { error: {...} } with an HTTP 4xx/5xx. */
const GraphErrorEnvelopeSchema = z.object({
  error: z
    .object({
      code: z.number().optional(),
      error_subcode: z.number().optional(),
      type: z.string().optional(),
      message: z.string().optional(),
      fbtrace_id: z.string().optional(),
      error_user_title: z.string().optional(),
      error_user_msg: z.string().optional(),
      // Meta's retry hint; dropping it here would make every flagged error
      // permanent. `.catch` because a hint is worth less than the error itself:
      // a value of an unexpected type loses THIS field, not `code`/`message`.
      is_transient: z.boolean().optional().catch(undefined),
    })
    .optional(),
});

/** Top-level keys of an answer, for a log line that names a shape without quoting it. */
function shapeOf(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return [];
  if (Array.isArray(value)) return ["<array>"];
  return Object.entries(value).flatMap(([key, nested]) =>
    key === "error" && typeof nested === "object" && nested !== null && !Array.isArray(nested)
      ? [key, ...Object.keys(nested).map((inner) => `error.${inner}`)]
      : [key],
  );
}

export interface GraphClientDeps {
  logger: Logger;
  version?: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Budget for a multipart upload; defaults to 180s, not the 30s of a form POST. */
  uploadTimeoutMs?: number;
  /** Injection seam for tests; production uses global fetch. */
  fetchImpl?: typeof fetch;
}

export interface GraphPostInput {
  /** Path without version, e.g. "1234567890/photos". */
  readonly path: string;
  /** Form fields. Values are stringified; never put a token here. */
  readonly params: Readonly<Record<string, string>>;
  readonly accessToken: string;
  /** Log-only context (tenant, job, channel). NEVER a token. */
  readonly context?: Record<string, unknown>;
}

/** One file part of a multipart POST, e.g. the `source` field of /photos. */
export interface GraphFilePart {
  /** Form field name Graph expects — `source` for a photo. */
  readonly field: string;
  /** Sent as the part's filename; Graph uses it for nothing but diagnostics. */
  readonly fileName: string;
  readonly bytes: Uint8Array;
  /** Null falls back to application/octet-stream. */
  readonly mimeType: string | null;
}

/**
 * A multipart POST on the Graph host: the same form fields as `post`, plus file
 * parts carrying the bytes.
 *
 * It exists because `url=` makes Facebook fetch the file and abandon it around
 * 30s (error 324). With `source=` we do the waiting, which is the difference
 * between 4/10 and 10/10 photos on the same real Page test.
 */
export interface GraphMultipartPostInput {
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly files: readonly GraphFilePart[];
  readonly accessToken: string;
  /** Log-only context (tenant, job, channel). NEVER a token. */
  readonly context?: Record<string, unknown>;
  /** Per-call override of the upload budget. */
  readonly timeoutMs?: number;
}

/**
 * A POST to an ABSOLUTE url that is not the Graph host — today only Meta's
 * upload host (`rupload.facebook.com`) used by the Reels flow, which takes its
 * parameters as HEADERS and carries no form body.
 *
 * The URL comes from Graph's answer, so it is checked against
 * ALLOWED_UPLOAD_HOSTS before the Page token in `headers` is sent anywhere.
 */
export interface GraphAbsolutePostInput {
  readonly url: string;
  /** Includes `Authorization: OAuth <token>`; never logged. */
  readonly headers: Readonly<Record<string, string>>;
  readonly context?: Record<string, unknown>;
}

/**
 * A GET on the Graph host. Used by the connect flow (E5.1): the OAuth token
 * exchange and `/me/accounts` are both GET-only endpoints.
 *
 * A GET has no body, so every parameter — including credentials — travels in
 * the query string. That is Meta's documented contract for these endpoints; the
 * URL is therefore NEVER logged (only `path`), and callers must not put a token
 * into `context` either.
 */
export interface GraphGetInput {
  /** Path without version, e.g. "me/accounts" or "oauth/access_token". */
  readonly path: string;
  readonly params?: Readonly<Record<string, string>>;
  /** Optional: the OAuth exchange authenticates with client_id + client_secret. */
  readonly accessToken?: string;
  /** Log-only context (tenant, step). NEVER a token. */
  readonly context?: Record<string, unknown>;
}

export interface GraphClient {
  get(input: GraphGetInput): Promise<Record<string, unknown>>;
  post(input: GraphPostInput): Promise<Record<string, unknown>>;
  /** Same endpoint vocabulary as `post`, with the file bytes in the body. */
  postMultipart(input: GraphMultipartPostInput): Promise<Record<string, unknown>>;
  postAbsolute(input: GraphAbsolutePostInput): Promise<Record<string, unknown>>;
}

export function makeGraphClient(deps: GraphClientDeps): GraphClient {
  const version = (deps.version ?? DEFAULT_GRAPH_VERSION).trim() || DEFAULT_GRAPH_VERSION;
  const baseUrl = (deps.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const uploadTimeoutMs = positiveMs(deps.uploadTimeoutMs) ?? DEFAULT_UPLOAD_TIMEOUT_MS;
  const doFetch = deps.fetchImpl ?? globalThis.fetch;
  const logger = deps.logger.child({ component: "graph-client", graph_version: version });

  if (typeof doFetch !== "function") {
    throw new AppError("INTERNAL", {
      message: "No fetch implementation available for the Graph client",
      context: { node_version: process.version },
    });
  }

  /**
   * Everything that happens AFTER an HTTP answer arrives: status, JSON, Meta's
   * error envelope. One copy for every verb, so "a non-JSON body is not a
   * success" cannot drift between the publish path and the connect path.
   */
  async function readAnswer(
    response: Response,
    options: {
      readonly startedAt: number;
      readonly context: Record<string, unknown>;
      /** What the log lines call this request, e.g. "Graph request". */
      readonly label: string;
      /** The upload host answers an empty body on success; nothing else does. */
      readonly lenientBody?: boolean;
      /**
       * Whether the first 200 bytes of a NON-JSON answer may be logged. False
       * for every GET: a GET carries its credentials in the query string, and a
       * proxy/WAF error page that echoes the request line would put an app
       * secret or a token into the log forever.
       */
      readonly bodyPreview: boolean;
    },
  ): Promise<Record<string, unknown>> {
    const durationMs = Date.now() - options.startedAt;
    const rawText = await response.text();

    let parsedBody: unknown = null;
    try {
      parsedBody = rawText.length > 0 ? JSON.parse(rawText) : options.lenientBody ? {} : null;
    } catch (error) {
      // HTML error page / truncated answer — never guess success from it.
      const appError = mapGraphError({
        httpStatus: response.status,
        cause: error,
        context: {
          ...options.context,
          ...(options.bodyPreview
            ? { body_preview: rawText.slice(0, 200) }
            : { body_preview_omitted: "credentials travel in this URL", body_bytes: rawText.length }),
        },
      });
      logger.error(`${options.label} answered with a non-JSON body`, {
        err: appError,
        error_code: appError.code,
        http_status: response.status,
        duration_ms: durationMs,
      });
      throw appError;
    }

    const envelope = GraphErrorEnvelopeSchema.safeParse(parsedBody ?? {});
    if (!envelope.success) {
      // Never silent: an unparsable envelope drops Meta's `code` and the answer
      // falls back to a generic HTTP mapping, which is exactly the case an
      // operator cannot diagnose. Keys only — values may hold anything.
      logger.warn(`${options.label} returned an error envelope this schema cannot read`, {
        ...options.context,
        http_status: response.status,
        body_keys: shapeOf(parsedBody),
        schema_issue_paths: envelope.error.issues.map((issue) => issue.path.join(".")),
      });
    }
    const graphError: GraphErrorBody | null = envelope.success ? (envelope.data.error ?? null) : null;

    if (!response.ok || graphError) {
      const appError = mapGraphError({
        error: graphError,
        httpStatus: response.status,
        context: {
          ...options.context,
          // Meta's throttling header — the reason behind a rate-limit error.
          business_use_case_usage: response.headers.get("x-business-use-case-usage"),
        },
      });
      logger.error(`${options.label} returned an error`, {
        err: appError,
        error_code: appError.code,
        http_status: response.status,
        duration_ms: durationMs,
      });
      throw appError;
    }

    if (typeof parsedBody !== "object" || parsedBody === null || Array.isArray(parsedBody)) {
      if (options.lenientBody) return {};
      const appError = new AppError("META_ERROR", {
        message: "Graph returned a body that is not a JSON object",
        userMessage: "Facebook trả về dữ liệu không hợp lệ — không xác nhận được kết quả đăng.",
        context: { ...options.context, http_status: response.status, retryable: false },
      });
      logger.error(`${options.label} returned an unusable body`, {
        err: appError,
        error_code: "META_ERROR",
      });
      throw appError;
    }

    logger.debug(`${options.label} ok`, {
      ...options.context,
      http_status: response.status,
      duration_ms: durationMs,
    });
    return parsedBody as Record<string, unknown>;
  }

  return {
    async get(input: GraphGetInput): Promise<Record<string, unknown>> {
      // --- Edge cases first ------------------------------------------------
      const path = typeof input?.path === "string" ? input.path.replace(/^\/+/, "").trim() : "";
      if (path.length === 0) {
        throw new AppError("INVALID_INPUT", {
          message: "Graph GET requires a path",
          userMessage: "Thiếu thông tin kết nối tới Facebook — không gửi được yêu cầu.",
          context: { ...(input?.context ?? {}), path: null },
        });
      }

      const url = new URL(`${baseUrl}/${version}/${path}`);
      for (const [key, value] of Object.entries(input.params ?? {})) {
        if (value === undefined || value === null) continue;
        url.searchParams.set(key, String(value));
      }
      const token = typeof input?.accessToken === "string" ? input.accessToken.trim() : "";
      // A GET has no body: Meta's own contract puts the credential here. The
      // full URL is never logged — only `path` reaches a log line.
      if (token.length > 0) url.searchParams.set("access_token", token);

      const startedAt = Date.now();
      let response: Response;
      try {
        response = await doFetch(url.toString(), {
          method: "GET",
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        // Transport failure: no HTTP answer at all -> retryable META_ERROR.
        const appError = mapGraphError({
          cause: error,
          context: { ...(input.context ?? {}), path, timeout_ms: timeoutMs },
        });
        logger.error("Graph request failed before an answer", {
          err: appError,
          error_code: appError.code,
          path,
          duration_ms: Date.now() - startedAt,
        });
        throw appError;
      }

      return readAnswer(response, {
        startedAt,
        label: "Graph request",
        context: { ...(input.context ?? {}), path },
        // GET puts the token (and, on the OAuth exchange, the app secret) in the
        // URL: an echoed error page must never reach the log.
        bodyPreview: false,
      });
    },

    async post(input: GraphPostInput): Promise<Record<string, unknown>> {
      // --- Edge cases first ------------------------------------------------
      const path = typeof input?.path === "string" ? input.path.replace(/^\/+/, "").trim() : "";
      const token = typeof input?.accessToken === "string" ? input.accessToken.trim() : "";
      if (path.length === 0 || token.length === 0) {
        throw new AppError("INVALID_INPUT", {
          message: "Graph POST requires a path and an access token",
          userMessage: "Thiếu thông tin kết nối tới Facebook — không gửi được yêu cầu.",
          context: { ...(input?.context ?? {}), path: path || null, has_token: token.length > 0 },
        });
      }

      const url = `${baseUrl}/${version}/${path}`;
      const body = new URLSearchParams();
      for (const [key, value] of Object.entries(input.params ?? {})) {
        if (value === undefined || value === null) continue;
        body.set(key, String(value));
      }
      // In the body, not the query string: a URL ends up in access logs.
      body.set("access_token", token);

      const startedAt = Date.now();
      let response: Response;
      try {
        response = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        // Transport failure: no HTTP answer at all -> retryable META_ERROR.
        const appError = mapGraphError({
          cause: error,
          context: { ...(input.context ?? {}), path, timeout_ms: timeoutMs },
        });
        logger.error("Graph request failed before an answer", {
          err: appError,
          error_code: appError.code,
          path,
          duration_ms: Date.now() - startedAt,
        });
        throw appError;
      }

      return readAnswer(response, {
        startedAt,
        label: "Graph request",
        context: { ...(input.context ?? {}), path },
        // POST keeps its credentials in the form body, so an echoed error page
        // is diagnostic rather than dangerous.
        bodyPreview: true,
      });
    },

    /**
     * Multipart sibling of `post`: same URL, same error handling, same "the
     * token lives in the body, never in the query string, never in a log" rule.
     * Only the encoding and the timeout differ — bytes take longer than a form.
     */
    async postMultipart(input: GraphMultipartPostInput): Promise<Record<string, unknown>> {
      // --- Edge cases first ------------------------------------------------
      const path = typeof input?.path === "string" ? input.path.replace(/^\/+/, "").trim() : "";
      const token = typeof input?.accessToken === "string" ? input.accessToken.trim() : "";
      if (path.length === 0 || token.length === 0) {
        throw new AppError("INVALID_INPUT", {
          message: "Graph multipart POST requires a path and an access token",
          userMessage: "Thiếu thông tin kết nối tới Facebook — không gửi được yêu cầu.",
          context: { ...(input?.context ?? {}), path: path || null, has_token: token.length > 0 },
        });
      }
      const files = Array.isArray(input?.files) ? input.files : [];
      if (files.length === 0) {
        throw new AppError("INVALID_INPUT", {
          message: "Graph multipart POST requires at least one file part",
          userMessage: "Không có dữ liệu ảnh để gửi lên Facebook.",
          context: { ...(input?.context ?? {}), path, reason: "NO_FILE_PART" },
        });
      }

      const form = new FormData();
      for (const [key, value] of Object.entries(input.params ?? {})) {
        if (value === undefined || value === null) continue;
        form.set(key, String(value));
      }
      for (const file of files) {
        const bytes = file?.bytes;
        // An empty part comes back from Graph as an opaque "invalid image file";
        // refusing here keeps the reason readable and saves a round trip.
        if (!bytes || bytes.length === 0) {
          throw new AppError("INVALID_INPUT", {
            message: "Refusing to upload an empty file part",
            userMessage: "File ảnh rỗng — không gửi lên Facebook.",
            context: {
              ...(input.context ?? {}),
              path,
              field: file?.field ?? null,
              file_name: file?.fileName ?? null,
              reason: "EMPTY_FILE_PART",
              retryable: false,
            },
          });
        }
        const blob = new Blob([toArrayBuffer(bytes)], {
          type: cleanMime(file.mimeType) ?? FALLBACK_PART_MIME,
        });
        form.append(file.field, blob, file.fileName || "upload.bin");
      }
      // In the body like the form POST, and after the parts so a caller cannot
      // overwrite it with a `params` entry.
      form.set("access_token", token);

      const callTimeoutMs = positiveMs(input?.timeoutMs) ?? uploadTimeoutMs;
      const totalBytes = files.reduce((sum, file) => sum + (file?.bytes?.length ?? 0), 0);
      const startedAt = Date.now();
      let response: Response;
      try {
        response = await doFetch(`${baseUrl}/${version}/${path}`, {
          method: "POST",
          // No content-type header: fetch must set the multipart boundary.
          body: form,
          signal: AbortSignal.timeout(callTimeoutMs),
        });
      } catch (error) {
        const appError = mapGraphError({
          cause: error,
          context: {
            ...(input.context ?? {}),
            path,
            timeout_ms: callTimeoutMs,
            upload_bytes: totalBytes,
          },
        });
        logger.error("Graph upload failed before an answer", {
          err: appError,
          error_code: appError.code,
          path,
          upload_bytes: totalBytes,
          duration_ms: Date.now() - startedAt,
        });
        throw appError;
      }

      return readAnswer(response, {
        startedAt,
        label: "Graph upload",
        context: { ...(input.context ?? {}), path, upload_bytes: totalBytes },
        // Credentials are in the multipart body, so an echoed error page is
        // diagnostic rather than dangerous — same call as the form POST.
        bodyPreview: true,
      });
    },

    /**
     * Same failure vocabulary as `post`, different transport: absolute URL, no
     * form body, credentials in a header. Kept in this file so ONE place owns
     * timeouts, error mapping and "a non-JSON body is not a success".
     */
    async postAbsolute(input: GraphAbsolutePostInput): Promise<Record<string, unknown>> {
      const url = typeof input?.url === "string" ? input.url.trim() : "";
      if (!/^https:\/\/\S+$/i.test(url)) {
        throw new AppError("INVALID_INPUT", {
          message: "Graph upload requires an absolute https URL",
          userMessage: "Thiếu địa chỉ tải video lên Facebook — không gửi được yêu cầu.",
          context: { ...(input?.context ?? {}), url: url || null },
        });
      }

      // --- The token only ever leaves for a host we named ourselves ----------
      const host = uploadHostOf(url);
      if (!host || !ALLOWED_UPLOAD_HOSTS.includes(host)) {
        const appError = new AppError("UPLOAD_HOST_NOT_ALLOWED", {
          message: `Refused to send a Page token to ${host ?? "an unparsable host"}`,
          userMessage:
            "Facebook trả về địa chỉ tải lên lạ — đã dừng để không gửi token của Trang đi nơi khác.",
          context: {
            ...(input?.context ?? {}),
            // The HOST, never the full URL: the path may carry an upload id.
            host: host ?? null,
            allowed_hosts: ALLOWED_UPLOAD_HOSTS,
            reason: "UPLOAD_HOST_NOT_ALLOWED",
            retryable: false,
          },
        });
        // Logged here because this is where the error stops being about Graph
        // and starts being about us refusing: it must be visible even if a
        // caller decides to swallow it.
        logger.error("Refused an upload URL outside the allowlist", {
          err: appError,
          error_code: appError.code,
          host: host ?? null,
        });
        throw appError;
      }

      const startedAt = Date.now();
      let response: Response;
      try {
        response = await doFetch(url, {
          method: "POST",
          headers: { ...(input.headers ?? {}) },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const appError = mapGraphError({
          cause: error,
          context: { ...(input.context ?? {}), timeout_ms: timeoutMs },
        });
        logger.error("Graph upload failed before an answer", {
          err: appError,
          error_code: appError.code,
          duration_ms: Date.now() - startedAt,
        });
        throw appError;
      }

      return readAnswer(response, {
        startedAt,
        label: "Graph upload",
        context: { ...(input.context ?? {}) },
        lenientBody: true,
        // The credential is in a header, and a proxy error page that echoes the
        // request headers would put the Page token in the log with it.
        bodyPreview: false,
      });
    },
  };
}

/**
 * Lowercased hostname of an upload URL, or null when it does not parse.
 * `new URL()` and not a regex: userinfo tricks like
 * `https://rupload.facebook.com@evil.example/x` must resolve to `evil.example`,
 * which a naive "contains rupload.facebook.com" check would happily accept.
 */
/**
 * Copy of the bytes as a plain ArrayBuffer.
 *
 * A Uint8Array can be a VIEW into a bigger buffer (Node hands those out when it
 * slices a read); passing the view's `.buffer` straight to Blob would upload the
 * whole underlying buffer — someone else's bytes included.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

function cleanMime(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const mime = value.split(";")[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mime) ? mime : null;
}

function positiveMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function uploadHostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    // Unparsable is refused by the caller with the same error; there is nothing
    // to log here that the refusal does not already say.
    return null;
  }
}
