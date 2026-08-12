import { createHmac } from "node:crypto";

import { AppError } from "@/core/domain/errors";
import type { SignatureFn } from "@/core/domain/media-url";

/**
 * HMAC-SHA256 for signed media URLs (core/domain/media-url owns the payload).
 *
 * It lives in an adapter because node:crypto is I/O-layer by the dependency law
 * (docs/07 section 2): core declares `SignatureFn`, this file implements it.
 *
 * The secret is read through a callback so a process that never signs a media
 * URL boots without MEDIA_SIGNING_SECRET — the failure then lands on the first
 * request, naming the variable, instead of at container build.
 */

/** Shorter keys make the MAC guessable; the config schema enforces it too. */
const MIN_SECRET_LENGTH = 32;

export interface MediaSignerDeps {
  /** Returns the raw secret. Called on every sign — cache upstream, not here. */
  readSecret: () => string | undefined;
}

export function makeMediaSigner(deps: MediaSignerDeps): SignatureFn {
  return function signMediaPayload(payload: string): string {
    // --- Edge cases first ----------------------------------------------------
    if (typeof payload !== "string" || payload.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "Media signature payload must be a non-empty string",
        userMessage: "Không tạo được liên kết ảnh — dữ liệu ký không hợp lệ.",
        context: { scope: "media-signing", reason: "EMPTY_PAYLOAD" },
      });
    }

    let secret: string | undefined;
    try {
      secret = deps.readSecret();
    } catch (error) {
      // Config loaders throw AppError('INVALID_INPUT'); keep the code, add scope.
      throw AppError.from(error, "INVALID_INPUT", {
        scope: "media-signing",
        reason: "SECRET_UNREADABLE",
      });
    }

    if (typeof secret !== "string" || secret.trim().length < MIN_SECRET_LENGTH) {
      // The value itself never reaches the context — only its absence/length.
      throw new AppError("INVALID_INPUT", {
        message: `MEDIA_SIGNING_SECRET is missing or shorter than ${MIN_SECRET_LENGTH} chars`,
        userMessage: "Hệ thống chưa cấu hình khoá ký liên kết ảnh. Vui lòng liên hệ quản trị viên.",
        context: {
          scope: "media-signing",
          reason: typeof secret === "string" ? "SECRET_TOO_SHORT" : "SECRET_MISSING",
        },
      });
    }

    try {
      return createHmac("sha256", secret.trim()).update(payload, "utf8").digest("hex");
    } catch (error) {
      throw AppError.from(error, "INTERNAL", {
        scope: "media-signing",
        reason: "HMAC_FAILED",
      });
    }
  };
}
