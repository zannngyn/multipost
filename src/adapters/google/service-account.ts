import { readFileSync } from "node:fs";

import { google } from "googleapis";
import { z } from "zod";

import { AppError } from "@/core/domain/errors";

/**
 * Service Account auth for Drive + Sheets (docs/02 section 2).
 * Read-only scopes: this tool never writes to the customer's Drive or Sheet.
 *
 * Credentials come from ONE of:
 *   GOOGLE_SERVICE_ACCOUNT_JSON        — the key file inlined (Docker secret)
 *   GOOGLE_APPLICATION_CREDENTIALS     — path to the key file (local dev)
 */

const SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
];

/** Only the fields we actually need; extra fields of the key file are ignored. */
const ServiceAccountKeySchema = z.object({
  type: z.literal("service_account").optional(),
  client_email: z.string().min(1, "client_email missing in service account key"),
  private_key: z.string().min(1, "private_key missing in service account key"),
});

export interface GoogleCredentialsSource {
  /** Raw JSON of the key file. */
  readonly serviceAccountJson?: string;
  /** Path to the key file. Used only when `serviceAccountJson` is absent. */
  readonly credentialsPath?: string;
}

function parseKey(rawJson: string, origin: string): z.infer<typeof ServiceAccountKeySchema> {
  let candidate: unknown;
  try {
    candidate = JSON.parse(rawJson);
  } catch (error) {
    throw new AppError("INVALID_INPUT", {
      message: `Service account key from ${origin} is not valid JSON`,
      userMessage: "Khoá Service Account của Google không đúng định dạng JSON.",
      context: { origin },
      cause: error,
    });
  }

  const parsed = ServiceAccountKeySchema.safeParse(candidate);
  if (!parsed.success) {
    throw new AppError("INVALID_INPUT", {
      message: `Service account key from ${origin} is missing required fields`,
      userMessage: "Khoá Service Account của Google thiếu trường bắt buộc.",
      context: { origin, issues: parsed.error.issues.map((issue) => issue.path.join(".")) },
    });
  }
  return parsed.data;
}

/** JWT client type, taken from googleapis so no extra package is imported. */
export type GoogleAuthClient = InstanceType<typeof google.auth.JWT>;

/** Builds an authenticated JWT client. Throws before any API call on bad input. */
export function makeGoogleAuth(source: GoogleCredentialsSource): GoogleAuthClient {
  // --- Edge cases first ----------------------------------------------------
  const inline = source?.serviceAccountJson?.trim();
  const path = source?.credentialsPath?.trim();
  if (!inline && !path) {
    throw new AppError("INVALID_INPUT", {
      message: "No Google service account credentials configured",
      userMessage:
        "Chưa cấu hình khoá Service Account của Google (GOOGLE_SERVICE_ACCOUNT_JSON hoặc GOOGLE_APPLICATION_CREDENTIALS).",
    });
  }

  let rawJson: string;
  let origin: string;
  if (inline) {
    rawJson = inline;
    origin = "GOOGLE_SERVICE_ACCOUNT_JSON";
  } else {
    origin = `GOOGLE_APPLICATION_CREDENTIALS (${path})`;
    try {
      rawJson = readFileSync(path as string, "utf8");
    } catch (error) {
      throw new AppError("INVALID_INPUT", {
        message: `Cannot read service account key file at ${path}`,
        userMessage: "Không đọc được file khoá Service Account của Google.",
        context: { path },
        cause: error,
      });
    }
  }

  const key = parseKey(rawJson, origin);
  // Docker/env round-trips turn newlines into the two characters \n.
  const privateKey = key.private_key.replace(/\\n/g, "\n");

  return new google.auth.JWT({ email: key.client_email, key: privateKey, scopes: SCOPES });
}
