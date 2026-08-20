import { makeGoogleDriveBrowser } from "@/adapters/google/drive-browser.google";
import { makeGoogleDriveSource } from "@/adapters/google/drive-source.google";
import { makeGoogleOAuthClient } from "@/adapters/google/google-oauth";
import { makeGoogleAuth } from "@/adapters/google/service-account";
import { makeGoogleSheetSource } from "@/adapters/google/sheet-source.google";
import { makeTenantGoogleAuth, type TenantGoogleAuth } from "@/adapters/google/tenant-google-auth";
import type { DriveSource } from "@/core/ports/drive-source";
import type {
  GoogleDriveBrowser,
  GoogleOAuthClient,
  GoogleOAuthRepo,
} from "@/core/ports/google-oauth";
import type { Logger } from "@/core/ports/infra";
import type { SheetSource } from "@/core/ports/sheet-source";

import { loadGoogleConfig, loadGoogleOAuthConfig, type EnvRecord } from "./config";

/**
 * Drive/Sheet wiring, per tenant.
 *
 * Credentials are read on the FIRST call, not at container build: a web process
 * (or `next build`) must boot without a Service Account AND without a Google
 * OAuth app, and a tenant that never syncs must force neither. The failure then
 * lands on the sync/connect request, with a message naming the missing
 * variable, instead of at process start.
 *
 * WHICH identity is used is decided per tenant by `makeTenantGoogleAuth`: the
 * tenant's own OAuth connection when they connected one, the Service Account
 * otherwise (unchanged behaviour for every tenant that never presses connect).
 */
export interface GoogleSources {
  drive: DriveSource;
  sheet: SheetSource;
  /** E2 — the in-app folder picker. OAuth only; it has no Service Account mode. */
  browser: GoogleDriveBrowser;
  /** E2 — the OAuth round trip itself (authorize URL, code exchange, revoke). */
  oauthClient: GoogleOAuthClient;
  /** Dropped on connect/disconnect so no call reuses the previous account. */
  auth: TenantGoogleAuth;
}

export function makeLazyGoogleSources(deps: {
  logger: Logger;
  oauth: GoogleOAuthRepo;
  env?: EnvRecord;
}): GoogleSources {
  const readCredentials = () => {
    const config = loadGoogleOAuthConfig(deps.env);
    return {
      clientId: config.GOOGLE_CLIENT_ID ?? null,
      clientSecret: config.GOOGLE_CLIENT_SECRET ?? null,
      redirectUri: config.GOOGLE_OAUTH_REDIRECT_URI ?? null,
    };
  };

  const auth = makeTenantGoogleAuth({
    logger: deps.logger,
    oauth: deps.oauth,
    readCredentials,
    // Read on first use by a tenant that has no OAuth connection.
    serviceAccountAuth: () => {
      const config = loadGoogleConfig(deps.env);
      return makeGoogleAuth({
        serviceAccountJson: config.GOOGLE_SERVICE_ACCOUNT_JSON,
        credentialsPath: config.GOOGLE_APPLICATION_CREDENTIALS,
      });
    },
  });

  return {
    auth,
    drive: makeGoogleDriveSource({ auth, logger: deps.logger }),
    sheet: makeGoogleSheetSource({ auth, logger: deps.logger }),
    browser: makeGoogleDriveBrowser({ auth, logger: deps.logger }),
    oauthClient: makeGoogleOAuthClient({ logger: deps.logger, readCredentials }),
  };
}
