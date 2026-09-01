/**
 * The three steps of "Kết nối dữ liệu" as data.
 *
 * The current step lives in the URL (`?buoc=…`), never in component state
 * (core-wizard: bước ở URL) — Back walks the flow instead of leaving it, and F5
 * lands where the operator was. What does NOT go in the URL is anything typed:
 * the spreadsheet id, the column map and the stock reason are sent to the server,
 * never to the address bar (web-wizard: query string rò qua lịch sử và Referer).
 *
 * Progress is therefore SERVER-side and needs no draft store: step 1 is done once
 * `tenant_integration` holds a source, and step 3 is a save of its own. Jumping
 * straight to `?buoc=anh-xa` on a tenant with no source is bounced back to step 1
 * by `resolveStep`, which is the "kiểm tra bước trước" the skill requires.
 *
 * Pure module — the screen renders what it returns, and every branch is testable
 * in the node environment the repo already runs.
 */

export const DATA_MAPPING_STEP_PARAM = "buoc";

export const DATA_MAPPING_STEPS = [
  {
    key: "nguon",
    label: "1. Nguồn dữ liệu",
    summary: "Bảng sản phẩm (Google Sheet hoặc CSV) & Thư mục ảnh Drive",
  },
  {
    key: "anh-xa",
    label: "2. Ánh xạ cột & Quy tắc",
    summary: "Ghép cột bảng tính vào trường MYSP, quy tắc tồn kho & nguồn ảnh",
  },
  {
    key: "bao-cao",
    label: "3. Báo cáo tương thích",
    summary: "Xem trước số mã hợp lệ sẵn sàng đăng bài",
  },
] as const;

export type DataMappingStep = (typeof DATA_MAPPING_STEPS)[number]["key"];

export const FIRST_STEP: DataMappingStep = "nguon";

export function isDataMappingStep(value: unknown): value is DataMappingStep {
  return DATA_MAPPING_STEPS.some((step) => step.key === value);
}

export function stepIndex(step: DataMappingStep): number {
  return DATA_MAPPING_STEPS.findIndex((entry) => entry.key === step);
}

export function stepLabel(step: DataMappingStep): string {
  return DATA_MAPPING_STEPS[stepIndex(step)]?.label ?? "";
}

/** `/data-mapping?buoc=bao-cao`. The first step keeps the bare path. */
export function stepHref(step: DataMappingStep, pathname = "/data-mapping"): string {
  if (step === FIRST_STEP) return pathname;
  return `${pathname}?${DATA_MAPPING_STEP_PARAM}=${step}`;
}

export interface StepGate {
  /**
   * `null` while `/api/catalog/source` has not answered. Nothing is redirected
   * on an unknown answer — bouncing an operator to step 1 because a query is
   * still in flight is the "nhảy về đầu luồng" bug, not a guard.
   */
  readonly hasSource: boolean | null;
}

export interface ResolvedStep {
  readonly step: DataMappingStep;
  /**
   * Set when the requested step was refused. The screen SAYS so — silently
   * moving somebody to another step is the same class of bug as silently
   * restoring a draft (core-wizard).
   */
  readonly refusedStep: DataMappingStep | null;
}

/**
 * Which step to render for a `?buoc=` value.
 *
 * Edge cases first: an unknown or missing value is step 1 (not an error — a
 * hand-typed URL must not produce a broken screen), and steps 2–3 need a stored
 * source because both of them read the tenant's real spreadsheet.
 */
export function resolveStep(requested: string | null, gate: StepGate): ResolvedStep {
  if (!isDataMappingStep(requested)) return { step: FIRST_STEP, refusedStep: null };
  if (requested === FIRST_STEP) return { step: FIRST_STEP, refusedStep: null };
  if (gate.hasSource === false) return { step: FIRST_STEP, refusedStep: requested };
  return { step: requested, refusedStep: null };
}

export type StepStatus = "done" | "current" | "todo";

/**
 * The state of each dot in the rail. "done" is not a guess about the operator's
 * intent: a step behind the current one has been walked past, and step 1 is
 * genuinely finished once a source is stored.
 */
export function stepStatuses(
  current: DataMappingStep,
  gate: StepGate,
): Record<DataMappingStep, StepStatus> {
  const currentIndex = stepIndex(current);
  const statuses = {} as Record<DataMappingStep, StepStatus>;

  for (const entry of DATA_MAPPING_STEPS) {
    const index = stepIndex(entry.key);
    if (entry.key === current) {
      statuses[entry.key] = "current";
      continue;
    }
    if (entry.key === FIRST_STEP) {
      statuses[entry.key] = gate.hasSource ? "done" : "todo";
      continue;
    }
    statuses[entry.key] = index < currentIndex ? "done" : "todo";
  }

  return statuses;
}

/** A step the operator may jump to from the rail. Refused steps are not links. */
export function canVisitStep(step: DataMappingStep, gate: StepGate): boolean {
  if (step === FIRST_STEP) return true;
  return gate.hasSource === true;
}
