import type { z } from "zod";

import { AppError } from "@/core/domain/errors";

/**
 * Reads and validates a JSON request body at the boundary (CLAUDE.md technical
 * rule 2). Shared by every POST route so a malformed body always produces the
 * same 400 shape, with per-field issues the UI can show inline.
 *
 * Never trusts the caller: a body that is not JSON at all, or JSON of the wrong
 * shape, both fail here — before any usecase or DB call.
 */
export async function readJsonBody<T>(
  request: Request,
  schema: z.ZodType<T>,
  context: { route: string },
): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch (cause) {
    throw new AppError("INVALID_INPUT", {
      message: "Request body is not valid JSON",
      userMessage: "Nội dung gửi lên không đọc được. Vui lòng thử lại.",
      context: { route: context.route },
      cause,
    });
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError("INVALID_INPUT", {
      message: `Invalid request body for ${context.route}`,
      userMessage: "Dữ liệu gửi lên không hợp lệ. Vui lòng kiểm tra lại.",
      context: {
        route: context.route,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join(".") || "(root)",
          message: issue.message,
        })),
      },
    });
  }

  return parsed.data;
}
