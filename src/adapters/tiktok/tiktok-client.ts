import { AppError } from "@/core/domain/errors";
import type { Logger } from "@/core/ports/infra";

import { isTikTokOk, mapTikTokError, type TikTokErrorBody } from "./tiktok-error-map";

/**
 * Minimal TikTok Content Posting API transport: one POST, JSON in, JSON out.
 * Same shape and the same rules as adapters/meta/graph-client — one place owns
 * timeouts, HTTP status, the error envelope and "a body we cannot read is NOT
 * a success".
 *
 * Two differences from Graph, both from TikTok's docs:
 *   - the token is a Bearer HEADER, not a form field;
 *   - success is NOT just HTTP 200: the body carries `error.code`, which is the
 *     string "ok" when nothing went wrong. A 200 with
 *     `error.code = "spam_risk_too_many_posts"` is a failure.
 */

export const TIKTOK_BASE_URL = "https://open.tiktokapis.com/v2";
const DEFAULT_TIMEOUT_MS = 30_000;
/** Content-Type is spelled out in the docs, charset included. */
const JSON_CONTENT_TYPE = "application/json; charset=UTF-8";

export interface TikTokClientDeps {
  logger: Logger;
  baseUrl?: string;
  timeoutMs?: number;
  /** Injection seam for tests; production uses global fetch. */
  fetchImpl?: typeof fetch;
}

export interface TikTokPostInput {
  /** Path under the base URL, e.g. "post/publish/video/init/". */
  readonly path: string;
  readonly body: Readonly<Record<string, unknown>>;
  /** User access token; sent as `Authorization: Bearer ...`, never logged. */
  readonly accessToken: string;
  /** Log-only context (tenant, job, channel). NEVER a token. */
  readonly context?: Record<string, unknown>;
}

export interface TikTokResponse {
  readonly data: Record<string, unknown>;
  readonly error: TikTokErrorBody | null;
}

export interface TikTokClient {
  post(input: TikTokPostInput): Promise<TikTokResponse>;
}

export function makeTikTokClient(deps: TikTokClientDeps): TikTokClient {
  const baseUrl = (deps.baseUrl ?? TIKTOK_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = deps.fetchImpl ?? globalThis.fetch;
  const logger = deps.logger.child({ component: "tiktok-client" });

  if (typeof doFetch !== "function") {
    throw new AppError("INTERNAL", {
      message: "No fetch implementation available for the TikTok client",
      context: { node_version: process.version },
    });
  }

  return {
    async post(input: TikTokPostInput): Promise<TikTokResponse> {
      // --- Edge cases first --------------------------------------------------
      const path = typeof input?.path === "string" ? input.path.replace(/^\/+/, "").trim() : "";
      const token = typeof input?.accessToken === "string" ? input.accessToken.trim() : "";
      if (path.length === 0 || token.length === 0) {
        throw new AppError("INVALID_INPUT", {
          message: "TikTok POST requires a path and an access token",
          userMessage: "Thiếu thông tin kết nối tới TikTok — không gửi được yêu cầu.",
          context: { ...(input?.context ?? {}), path: path || null, has_token: token.length > 0 },
        });
      }

      const url = `${baseUrl}/${path}`;
      const startedAt = Date.now();
      let response: Response;
      try {
        response = await doFetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": JSON_CONTENT_TYPE,
          },
          body: JSON.stringify(input.body ?? {}),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const appError = mapTikTokError({
          cause: error,
          context: { ...(input.context ?? {}), path, timeout_ms: timeoutMs },
        });
        logger.error("TikTok request failed before an answer", {
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
        parsedBody = rawText.length > 0 ? JSON.parse(rawText) : {};
      } catch (error) {
        const appError = mapTikTokError({
          httpStatus: response.status,
          cause: error,
          context: { ...(input.context ?? {}), path, body_preview: rawText.slice(0, 200) },
        });
        logger.error("TikTok answered with a non-JSON body", {
          err: appError,
          error_code: appError.code,
          http_status: response.status,
          duration_ms: durationMs,
        });
        throw appError;
      }

      const envelope = (
        typeof parsedBody === "object" && parsedBody !== null ? parsedBody : {}
      ) as { data?: unknown; error?: TikTokErrorBody };
      const error = envelope.error ?? null;

      // Both gates matter: a non-2xx, and a 200 whose envelope says otherwise.
      if (!response.ok || !isTikTokOk(error)) {
        const appError = mapTikTokError({
          error,
          httpStatus: response.status,
          context: { ...(input.context ?? {}), path },
        });
        logger.error("TikTok returned an error", {
          err: appError,
          error_code: appError.code,
          tiktok_code: error?.code ?? null,
          http_status: response.status,
          duration_ms: durationMs,
        });
        throw appError;
      }

      const data =
        typeof envelope.data === "object" && envelope.data !== null && !Array.isArray(envelope.data)
          ? (envelope.data as Record<string, unknown>)
          : {};

      logger.debug("TikTok request ok", { path, http_status: response.status, duration_ms: durationMs });
      return { data, error };
    },
  };
}
