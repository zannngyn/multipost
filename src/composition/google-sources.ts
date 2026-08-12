import { makeGoogleDriveSource } from "@/adapters/google/drive-source.google";
import { makeGoogleSheetSource } from "@/adapters/google/sheet-source.google";
import { makeGoogleAuth } from "@/adapters/google/service-account";
import type { DriveSource, ListDriveFilesInput } from "@/core/ports/drive-source";
import type { Logger } from "@/core/ports/infra";
import type { ReadSheetInput, SheetSource } from "@/core/ports/sheet-source";

import { loadGoogleConfig, type EnvRecord } from "./config";

/**
 * Lazy Drive/Sheet wiring.
 *
 * Credentials are read on the FIRST call, not at container build: a web process
 * (or `next build`) must boot without a Service Account, and a tenant that never
 * syncs must not force one. The failure then lands on the sync request, with a
 * message naming the missing variable, instead of at process start.
 */
export function makeLazyGoogleSources(deps: { logger: Logger; env?: EnvRecord }): {
  drive: DriveSource;
  sheet: SheetSource;
} {
  let cached: { drive: DriveSource; sheet: SheetSource } | null = null;

  const build = () => {
    if (cached) return cached;
    const config = loadGoogleConfig(deps.env);
    const auth = makeGoogleAuth({
      serviceAccountJson: config.GOOGLE_SERVICE_ACCOUNT_JSON,
      credentialsPath: config.GOOGLE_APPLICATION_CREDENTIALS,
    });
    cached = {
      drive: makeGoogleDriveSource({ auth, logger: deps.logger }),
      sheet: makeGoogleSheetSource({ auth, logger: deps.logger }),
    };
    return cached;
  };

  return {
    drive: {
      listFiles: (input: ListDriveFilesInput) => build().drive.listFiles(input),
    },
    sheet: {
      readRows: (input: ReadSheetInput) => build().sheet.readRows(input),
    },
  };
}
