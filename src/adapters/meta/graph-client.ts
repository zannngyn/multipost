import { z } from "zod";

import { AppError } from "@/core/domain/errors";
import type { Logger } from "@/core/ports/infra";

import { mapGraphError, type GraphErrorBody } from "./graph-error-map";

/**
 * Minimal Graph API transport: one POST, form-encoded, JSON back.
 * It owns every HTTP concern (timeout, status, error shape) so the publisher
 * above it reads like the business steps of E5.2.
 *
 * VERSION — Graph API is versioned in the path (`/v23.0/{page-id}/photos`) and
 * a version is supported for ~2 years. It is configurable (META_GRAPH_VERSION)
 * and NOT verified against Meta's changelog from this machine: confirm the
 * current version before the first real Page test.
 */

export const DEFAULT_GRAPH_VERSION = "v23.0";
const DEFAULT_BASE_URL = "https://graph.facebook.com";
const DEFAULT_TIMEOUT_MS = 30_000;

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
    })
    .optional(),
});

export interface GraphClientDeps {
  logger: Logger;
  version?: string;
  baseUrl?: string;
  timeoutMs?: number;
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

export interface GraphClient {
  post(input: GraphPostInput): Promise<Record<string, unknown>>;
}

export function makeGraphClient(deps: GraphClientDeps): GraphClient {
  const version = (deps.version ?? DEFAULT_GRAPH_VERSION).trim() || DEFAULT_GRAPH_VERSION;
  const baseUrl = (deps.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = deps.fetchImpl ?? globalThis.fetch;
  const logger = deps.logger.child({ component: "graph-client", graph_version: version });

  if (typeof doFetch !== "function") {
    throw new AppError("INTERNAL", {
      message: "No fetch implementation available for the Graph client",
      context: { node_version: process.version },
    });
  }

  return {
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

      const durationMs = Date.now() - startedAt;
      const rawText = await response.text();
      let parsedBody: unknown = null;
      try {
        parsedBody = rawText.length > 0 ? JSON.parse(rawText) : null;
      } catch (error) {
        // HTML error page / truncated answer — never guess success from it.
        const appError = mapGraphError({
          httpStatus: response.status,
          cause: error,
          context: {
            ...(input.context ?? {}),
            path,
            body_preview: rawText.slice(0, 200),
          },
        });
        logger.error("Graph answered with a non-JSON body", {
          err: appError,
          error_code: appError.code,
          http_status: response.status,
          duration_ms: durationMs,
        });
        throw appError;
      }

      const envelope = GraphErrorEnvelopeSchema.safeParse(parsedBody ?? {});
      const graphError: GraphErrorBody | null = envelope.success ? (envelope.data.error ?? null) : null;

      if (!response.ok || graphError) {
        const appError = mapGraphError({
          error: graphError,
          httpStatus: response.status,
          context: {
            ...(input.context ?? {}),
            path,
            // Meta's throttling header — the reason behind a rate-limit error.
            business_use_case_usage: response.headers.get("x-business-use-case-usage"),
          },
        });
        logger.error("Graph returned an error", {
          err: appError,
          error_code: appError.code,
          http_status: response.status,
          duration_ms: durationMs,
        });
        throw appError;
      }

      if (typeof parsedBody !== "object" || parsedBody === null || Array.isArray(parsedBody)) {
        const appError = new AppError("META_ERROR", {
          message: "Graph returned a body that is not a JSON object",
          userMessage: "Facebook trả về dữ liệu không hợp lệ — không xác nhận được kết quả đăng.",
          context: { ...(input.context ?? {}), path, http_status: response.status, retryable: false },
        });
        logger.error("Graph returned an unusable body", { err: appError, error_code: "META_ERROR" });
        throw appError;
      }

      logger.debug("Graph request ok", { path, http_status: response.status, duration_ms: durationMs });
      return parsedBody as Record<string, unknown>;
    },
  };
}
