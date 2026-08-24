import { SetupProgressSchema, type SetupProgress } from "@/ui/schemas/setup-progress.schema";

import { apiRequest } from "./http-client";

/**
 * Data layer of the first-run checklist and the setup dock (docs/07 §4.1):
 * talks to the internal HTTP API and nothing else. Transport, timeout and
 * error normalisation live in `http-client.ts`.
 */

/** Query keys carry the tenant key so cached data can never leak across tenants. */
export const setupKeys = {
  progress: (tenantKey: string) => ["setup", tenantKey, "progress"] as const,
};

export async function fetchSetupProgress(signal?: AbortSignal): Promise<SetupProgress> {
  return apiRequest("/api/tenants/setup-progress", {
    schema: SetupProgressSchema,
    signal,
    malformedMessage:
      "Dữ liệu tiến trình thiết lập không đúng định dạng. Hãy báo quản trị viên kiểm tra máy chủ.",
  });
}
