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
 * "Nguồn dữ liệu" card of the sync screen: WHICH Drive folder and WHICH Sheet
 * tab this tenant reads from (`tenant_integration`, provider google) — or, since
 * onboarding phase 3, which uploaded CSV, in which case the Google coordinates
 * may legitimately be empty and the file was set by `POST /api/catalog/file`.
 * Thin by contract (docs/07 §3.3): validate -> usecase -> map errors.
 *
 * A tenant with no integration row is NOT an error — it is a tenant nobody has
 * configured yet. The usecase answers `null` and this route turns it into a 200
 * with `state: "not_configured"`, so the screen shows an empty state with the
 * one sentence an operator needs instead of a red box they cannot act on.
 *
 * Auth (M1.3b, doc 10 §4.1): GET = viewer, tier R. PUT = admin, tier S —
 * changing the source is what the NEXT sync deletes the old catalog for, so the
 * membership is read fresh, never from a cache. The tenant comes from
 * `requireTenantContext`; a `tenantId` an old UI build still sends is stripped
 * and ignored (transition rule, docs/11 §3.2).
 */

const ROUTE = "GET /api/catalog/source";
const ROUTE_PUT = "PUT /api/catalog/source";

/**
 * A pasted browser URL and a bare id are both accepted — the USECASE parses
 * them (one parser, shared with any other caller). This schema only enforces
 * what is true of both: present, not blank, not absurdly long.
 */
const MAX_SOURCE_REF = 512;

/** Same ceilings the mapping body uses for a single header. */
const MAX_COLUMN_NAME = 200;
const MAX_SHEET_COLUMNS = 200;

/**
 * The three Google coordinates.
 *
 * EMPTY IS ALLOWED HERE, and that is a deliberate move of a decision, not a
 * loosening. They carried `.min(1)` until onboarding phase 3, which made this
 * route the thing that decided the Google fields were mandatory — and since
 * phase 3 that depends on something only the usecase knows: WHICH source the
 * tenant reads after the save (what was just sent, or what is already stored).
 * A tenant on an uploaded CSV has no spreadsheet id at all and could not save a
 * column mapping, because a 400 was raised here before `updateCatalogSource`
 * ever ran.
 *
 * Nothing is weaker as a result: `requireGoogleRef` inside the usecase still
 * refuses a blank one for a Google tenant, with an `issues` entry naming the
 * very same field, so the form still places the message on the right box.
 * What this schema keeps is what is true of BOTH kinds — a string, not absurdly
 * long.
 */
const UpdateBodySchema = z.object({
  driveFolder: z
    .string({ error: "Thư mục Drive phải là chuỗi ký tự." })
    .trim()
    .max(MAX_SOURCE_REF, "Link thư mục Drive quá dài.")
    .optional(),
  spreadsheet: z
    .string({ error: "Bảng Sheet phải là chuỗi ký tự." })
    .trim()
    .max(MAX_SOURCE_REF, "Link bảng Sheet quá dài.")
    .optional(),
  sheetName: z
    .string({ error: "Tên tab phải là chuỗi ký tự." })
    .trim()
    .max(128, "Tên tab quá dài.")
    .optional(),
  /**
   * Onboarding phase 1. ABSENT means "giữ nguyên cái đang lưu" all the way down
   * to `saveCatalogSource` — a save that only moves the Drive folder must not
   * wipe a mapping somebody spent an onboarding session building. Sending them
   * replaces them wholesale.
   */
  fieldMap: FieldMapBodySchema.nullish(),
  stockPolicy: StockPolicyBodySchema.nullish(),
  /**
   * Onboarding phase 2 — where this tenant's photos live. Same contract as the
   * two above: absent means "giữ nguyên cái đang lưu" all the way down to
   * `saveCatalogSource`, so the sync screen's "Đổi nguồn" form cannot wipe a
   * layout it does not know about.
   */
  mediaProfile: MediaProfileBodySchema.nullish(),
  /**
   * WHICH table this tenant reads from now on (onboarding phase 3).
   *
   * ABSENT means "giữ nguyên cái đang lưu", like every other key here — a save
   * that only fixes a column mapping must not repoint the source. PRESENT means
   * the operator deliberately switched, and this is the ONLY way back from an
   * uploaded CSV to a Google tab: without this key the usecase always resolved
   * the stored `file` kind, so a tenant on a CSV could fill in a spreadsheet
   * link, press Lưu, get a 200 — and still be reading the old file. A no-op that
   * answers 200 is the exact shape business rule 5 forbids.
   *
   * ONLY `google_sheet` is accepted, and that is a boundary decision rather than
   * a copy of the domain union: switching TO a file means producing a stored
   * file, which only `POST /api/catalog/file` can do (it reads the bytes, then
   * mints the storage key). Accepting `{kind:"file", storageKey}` here would let
   * a caller point a tenant at a key they invented, or at another tenant's.
   */
  textConfig: z.object({ kind: z.literal("google_sheet") }).nullish(),
  /**
   * The tenant's real header row, when the caller has one. Given it, the usecase
   * refuses a map pointing at a column that no longer exists — the check the
   * client also runs, repeated here because a client check is a convenience and
   * never a guarantee (CLAUDE.md technical rule 2).
   *
   * `.min(1)`: an EMPTY array is refused rather than forwarded. The domain reads
   * an empty column list as "the caller has no header row" and skips the check,
   * so accepting `[]` would let a caller silently disable a validation while the
   * audit trail says it ran.
   */
  sheetColumns: z
    .array(z.string().trim().min(1).max(MAX_COLUMN_NAME))
    .min(1, "Danh sách cột rỗng — không gửi còn hơn gửi danh sách trống.")
    .max(MAX_SHEET_COLUMNS, "Bảng tính có quá nhiều cột.")
    .nullish(),
});

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    // --- Edge case first: no membership, no answer (doc 10 §3) --------------
    const { ctx } = await requireTenantContext(request, {
      surface: `api:${ROUTE}`,
      tier: "R",
      minRole: "viewer",
    });

    const source = await container.usecases.getCatalogSource({ tenantId: ctx.tenantId });

    // `not_configured` is a 200 EMPTY STATE, and stays distinct from the 404 of
    // "no membership" — the two meanings must never be merged (doc 10 §3).
    if (!source) {
      return Response.json({ state: "not_configured", tenantId: ctx.tenantId });
    }

    return Response.json({ state: "configured", tenantId: ctx.tenantId, source });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}

/**
 * Points a tenant at another Drive folder / Sheet tab.
 *
 * PUT, not POST: the whole source is replaced and sending it twice leaves the
 * same state. The actor's e-mail is taken from the SESSION, never from the body
 * — a caller must not be able to write someone else's name into the audit trail.
 *
 * This route decides nothing: which URL forms are valid, and what a change does
 * to already-synced rows, belong to the usecase. The screen is responsible for
 * warning the operator that the next sync will delete what no longer belongs to
 * the new source.
 */
export async function PUT(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    // Authorise BEFORE reading the body: tier S, so the membership is the fresh
    // row and an editor gets 403 without the payload ever being parsed.
    const { ctx, session } = await requireTenantContext(request, {
      surface: `api:${ROUTE_PUT}`,
      tier: "S",
      minRole: "admin",
    });
    const body = await readJsonBody(request, UpdateBodySchema, { route: ROUTE_PUT });

    const source = await container.usecases.updateCatalogSource({
      tenantId: ctx.tenantId,
      /*
       * ABSENT and "" are different requests, and only `undefined` means "giữ
       * nguyên toạ độ đang lưu". The mapping wizard sends neither key, so a save
       * that only fixes a column cannot revert a Drive folder somebody moved
       * while the wizard was open (F3/N1 — the lost update). Clearing a
       * coordinate stays possible, and stays explicit: send "".
       */
      driveFolder: body.driveFolder,
      spreadsheet: body.spreadsheet,
      sheetName: body.sheetName,
      // ABSENT and ALL-NULL are different answers ("giữ nguyên cái đang lưu" vs
      // "không map cột nào"), and only `undefined` means the first one.
      fieldMap: body.fieldMap ?? undefined,
      stockPolicy: body.stockPolicy ?? undefined,
      mediaProfile: body.mediaProfile ?? undefined,
      // Same contract as the keys above: only `undefined` means "giữ nguyên".
      textConfig: body.textConfig ?? undefined,
      sheetColumns: body.sheetColumns ?? undefined,
      actorEmail: session.email,
    });

    return Response.json({ state: "configured", tenantId: ctx.tenantId, source });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE_PUT } });
  }
}
