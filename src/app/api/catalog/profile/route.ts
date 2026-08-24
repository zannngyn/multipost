import { z } from "zod";

import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { readJsonBody } from "@/app/api/_lib/read-json-body";
import { requireTenantContext } from "@/app/api/_lib/require-tenant-context";
import {
  FieldMapBodySchema,
  MediaProfileBodySchema,
  StockPolicyBodySchema,
} from "@/app/api/catalog/_lib/mapping-body";
import { getContainer } from "@/composition/container";

/**
 * "Báo cáo tương thích" — dry-run this tenant's product table and photo folder
 * and report how much of it the tool can actually use. The screen a customer and
 * a salesperson look at together during onboarding (docs/05, productised).
 *
 * The table may be a Google tab OR a CSV the tenant uploaded (onboarding phase
 * 3); `textConfig` below is what tells the usecase which, and the report echoes
 * it back so the screen cannot read a file report as a sheet one.
 *
 * READ-ONLY: `profileCatalogSource` writes nothing, changes no config and never
 * syncs, so a tenant may run it against a spreadsheet they are still fixing. The
 * optional `fieldMap` / `stockPolicy` in the body are a PREVIEW of what the
 * operator is editing on step 3 — they are used to compute the numbers and are
 * NOT stored. Saving goes through `PUT /api/catalog/source`.
 *
 * Thin by contract (docs/07 §3.3): validate -> two usecase calls -> map errors.
 * The second call needs the tenant's stored coordinates, which is why
 * `getCatalogSource` runs first; no decision is taken here.
 *
 * A tenant with no integration row is NOT an error — it is step 1 not finished.
 * It answers 200 `{ state: "not_configured" }` so the wizard shows its empty
 * state instead of a red box nobody can act on (same stance as
 * `GET /api/catalog/source`).
 *
 * Auth (doc 10 §4.1): admin, tier S. It is a configuration surface, and it burns
 * Google API quota on the tenant's behalf — not something a viewer should be
 * able to fire repeatedly.
 */

const ROUTE = "POST /api/catalog/profile";

const BodySchema = z.object({
  /** Absent = report against the map the server infers from the header row. */
  fieldMap: FieldMapBodySchema.nullish(),
  /** Absent = `numeric`, the safe default (stock is still checked). */
  stockPolicy: StockPolicyBodySchema.nullish(),
  /** Absent = `code-color-seq`, the internal convention. */
  mediaProfile: MediaProfileBodySchema.nullish(),
});

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    // Authorise BEFORE reading the body: an editor gets 403 without the payload
    // ever being parsed.
    const { ctx } = await requireTenantContext(request, {
      surface: `api:${ROUTE}`,
      tier: "S",
      minRole: "admin",
    });
    const body = await readJsonBody(request, BodySchema, { route: ROUTE });

    const source = await container.usecases.getCatalogSource({ tenantId: ctx.tenantId });
    if (!source) {
      return Response.json({ state: "not_configured", tenantId: ctx.tenantId });
    }

    const report = await container.usecases.profileCatalogSource({
      tenantId: ctx.tenantId,
      /*
       * WHICH source to read (onboarding phase 3). Forwarded, not inferred: a
       * tenant reading an uploaded CSV has no spreadsheet id at all, so without
       * this the usecase would fall back to the Google branch and either refuse
       * outright or — worse — report numbers about a tab nobody syncs.
       *
       * `undefined` when the tenant never declared one, which the usecase reads
       * as "bảng tính Google", the behaviour every caller had before phase 3.
       */
      textConfig: source.textSource ?? undefined,
      spreadsheetId: source.spreadsheetId,
      sheetName: source.sheetName,
      driveFolderId: source.driveFolderId,
      /*
       * Three-way, and the order is the whole contract:
       *   1. a map in the BODY   -> the operator is previewing an edit;
       *   2. else the STORED map -> the report describes what actually runs
       *      today, so the numbers on screen are this tenant's real numbers;
       *   3. else `undefined`    -> the tenant never declared one, and the
       *      usecase infers a suggestion from the header row.
       *
       * Step 2 is what makes `report.fieldMap.source === "tenant"` truthful, and
       * that flag is what stops the wizard offering to overwrite a mapping
       * somebody built. `null` is never forwarded: the usecase reads absent as
       * "đoán giúp tôi", and a null would be a value it must defend against.
       */
      fieldMap: body.fieldMap ?? source.fieldMap ?? undefined,
      stockPolicy: body.stockPolicy ?? source.stockPolicy ?? undefined,
      /*
       * The same three-way ladder, now complete: `CatalogSourceView` carries
       * `mediaProfile` since phase 2, so a baseline report measures the layout
       * this tenant DECLARED instead of the default convention. The note that
       * used to sit here ("core drops the key") stopped being true then.
       *
       * The candidates — the numbers the operator picks a layout from — are
       * scored on every run whatever this value is.
       */
      mediaProfile: body.mediaProfile ?? source.mediaProfile ?? undefined,
    });

    return Response.json({ state: "profiled", report });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
