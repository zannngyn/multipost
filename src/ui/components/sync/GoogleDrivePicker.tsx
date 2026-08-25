"use client";

import { useEffect, useId, useRef, useState } from "react";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { EmptyState } from "@/ui/components/feedback/EmptyState";
import { PickerList, PickerListSkeleton, type PickerRow } from "@/ui/components/sync/PickerList";
import { Button } from "@/ui/components/ui/button";
import { Input } from "@/ui/components/ui/input";
import { useDebouncedValue } from "@/ui/hooks/useDebouncedValue";
import { useDelayedFlag } from "@/ui/hooks/useDelayedFlag";
import { useUpdateCatalogSource } from "@/ui/hooks/useCatalogProducts";
import {
  isNotConnectedError,
  useDriveFolders,
  useDriveSpreadsheets,
  useRefreshGoogleConnection,
  useSpreadsheetTabs,
} from "@/ui/hooks/useGoogleDrive";
import { CatalogSourceFormSchema, shortenId } from "@/ui/schemas/catalog.schema";
import {
  GOOGLE_DRIVE_ROOT_ID,
  GOOGLE_DRIVE_ROOT_NAME,
  currentFolder,
  driveItemLabel,
  type DriveItem,
} from "@/ui/schemas/google-drive.schema";
import { ApiError } from "@/ui/services/api-error";

/**
 * "Chọn thư mục và bảng ngay trong app" — the primary way to point a tenant at
 * its Drive folder and Sheet tab once Google is connected. Three steps in one
 * panel: thư mục ảnh -> bảng Sheet -> tab, then a summary and the SAME
 * confirmation the manual form uses.
 *
 * Boundaries this component keeps (docs/07 §4.1):
 *  - it never talks to Drive: every list comes from an internal API route via
 *    `useGoogleDrive`, which holds the tenant's token server-side;
 *  - it does not invent a save contract: the three ids go into the existing
 *    `PUT /api/catalog/source` through `useUpdateCatalogSource`, validated by
 *    the same `CatalogSourceFormSchema` the typed form uses;
 *  - a 409 GOOGLE_NOT_CONNECTED is not rendered as a red box: it means the
 *    token is gone, so the status query is re-read and the card above flips
 *    back to "chưa kết nối" with the reason.
 *
 * Every list carries the four states: loading (skeleton, delayed 300ms) / data
 * / empty (and "thư mục này không có thư mục con" is NOT the same sentence as
 * "không tìm thấy") / error with a retry.
 */

type PickerStep = "folder" | "spreadsheet" | "tab" | "review";

const STEP_LABELS: { step: PickerStep; label: string }[] = [
  { step: "folder", label: "Thư mục ảnh" },
  { step: "spreadsheet", label: "Bảng Sheet" },
  { step: "tab", label: "Tab dữ liệu" },
];

export function GoogleDrivePicker({
  onSaved,
  onCancel,
}: {
  /** Called after the source was saved (the card closes the picker). */
  onSaved: () => void;
  onCancel: () => void;
}) {
  const fieldId = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);

  const [step, setStep] = useState<PickerStep>("folder");
  const [parentId, setParentId] = useState<string>(GOOGLE_DRIVE_ROOT_ID);
  const [folderSearch, setFolderSearch] = useState("");
  const [sheetSearch, setSheetSearch] = useState("");
  const [pickedFolder, setPickedFolder] = useState<DriveItem | null>(null);
  const [pickedSheet, setPickedSheet] = useState<DriveItem | null>(null);
  const [pickedTab, setPickedTab] = useState<string | null>(null);
  const [isConfirming, setIsConfirming] = useState(false);
  const [saveIssue, setSaveIssue] = useState<string | null>(null);

  const folderQuery = useDebouncedValue(folderSearch.trim());
  const sheetQuery = useDebouncedValue(sheetSearch.trim());

  const folders = useDriveFolders({
    parentId,
    q: folderQuery,
    enabled: step === "folder",
  });
  const spreadsheets = useDriveSpreadsheets({
    q: sheetQuery,
    enabled: step === "spreadsheet",
  });
  const tabs = useSpreadsheetTabs(pickedSheet?.id ?? null);
  const update = useUpdateCatalogSource();

  /**
   * The token died mid-session (revoked in Google's own settings, or never
   * stored). Re-reading the status is what makes the card above tell the truth;
   * without it the operator would keep clicking into a tree that cannot load.
   */
  const refreshConnection = useRefreshGoogleConnection();
  const lostConnection =
    isNotConnectedError(folders.error) ||
    isNotConnectedError(spreadsheets.error) ||
    isNotConnectedError(tabs.error);

  useEffect(() => {
    if (lostConnection) refreshConnection();
  }, [lostConnection, refreshConnection]);

  // Focus lands on the decision, not on the panel behind it.
  useEffect(() => {
    if (isConfirming) confirmRef.current?.focus();
  }, [isConfirming]);

  const breadcrumb = folders.data?.pages[0]?.breadcrumb ?? [];
  const here = currentFolder(breadcrumb);
  const isAtRoot = here.id === GOOGLE_DRIVE_ROOT_ID;

  function openFolder(item: DriveItem) {
    setParentId(item.id);
    // A search that survived the navigation would filter the new listing too,
    // and the operator would read the empty result as "thư mục trống".
    setFolderSearch("");
  }

  function chooseFolder() {
    if (isAtRoot) return;
    setPickedFolder(here);
    setStep("spreadsheet");
  }

  function chooseSpreadsheet(item: DriveItem) {
    setPickedSheet(item);
    setPickedTab(null);
    setStep("tab");
  }

  function chooseTab(name: string) {
    setPickedTab(name);
    setStep("review");
  }

  function restart() {
    setStep("folder");
    setParentId(pickedFolder?.id ?? GOOGLE_DRIVE_ROOT_ID);
    setIsConfirming(false);
    setSaveIssue(null);
    update.reset();
  }

  function save() {
    setIsConfirming(false);

    // Validate at the boundary with the SAME schema the typed form uses: the
    // server must never be asked to store a half-made selection.
    const parsed = CatalogSourceFormSchema.safeParse({
      driveFolder: pickedFolder?.id ?? "",
      spreadsheet: pickedSheet?.id ?? "",
      sheetName: pickedTab ?? "",
    });

    if (!parsed.success) {
      setSaveIssue(
        parsed.error.issues[0]?.message ??
          "Chọn đủ thư mục ảnh, bảng Sheet và tab trước khi lưu nguồn.",
      );
      setStep("folder");
      return;
    }

    setSaveIssue(null);
    update.mutate(
      {
        ...parsed.data,
        /*
         * Picking a folder and a tab IS choosing a Google source, so the save
         * says so. Same reason as `CatalogSourceForm`: without this key the
         * usecase keeps whatever kind is stored, and a tenant on an uploaded CSV
         * would pick a spreadsheet here, see a success, and go on reading the
         * old file (business rule 5 — no silent no-op).
         */
        textConfig: { kind: "google_sheet" as const },
      },
      { onSuccess: onSaved },
    );
  }

  if (lostConnection) {
    return (
      <div className="space-y-3">
        <p role="alert" className="text-sm">
          Kết nối Google không còn hiệu lực nên không đọc được Drive nữa. Hãy kết nối lại ở khối
          phía trên, rồi chọn thư mục và bảng.
        </p>
        <Button type="button" variant="outline" onClick={onCancel}>
          Đóng
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <StepIndicator step={step} />

      {/* Progress is announced without stealing focus from the list. */}
      <p className="sr-only" role="status" aria-live="polite">
        {update.isPending ? "Đang lưu nguồn dữ liệu" : stepAnnouncement(step)}
      </p>

      {step === "folder" ? (
        <section aria-label="Bước 1 — chọn thư mục ảnh" className="space-y-3">
          <FolderBreadcrumb
            breadcrumb={breadcrumb.length > 0 ? breadcrumb : [here]}
            onNavigate={(item) => openFolder(item)}
          />

          <SearchField
            id={`${fieldId}-folder-search`}
            label="Tìm thư mục theo tên"
            hint="Bỏ trống để xem toàn bộ thư mục con của thư mục đang mở."
            value={folderSearch}
            onChange={setFolderSearch}
            placeholder="Ví dụ: Ảnh sản phẩm"
          />

          <ListBody
            query={folders}
            ariaLabel="Thư mục con"
            rows={flattenFolders(folders.data?.pages)}
            onSelect={(id) => {
              const item = findItem(flattenItems(folders.data?.pages), id);
              if (item) openFolder(item);
            }}
            empty={
              folderQuery.length > 0 ? (
                <EmptyState
                  kind="no-result"
                  title="Không có thư mục nào khớp"
                  description={`Không tìm thấy thư mục nào có tên chứa “${folderQuery}”.`}
                  action={
                    <Button type="button" variant="outline" onClick={() => setFolderSearch("")}>
                      Xoá từ khoá
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  kind="done"
                  title="Thư mục này không có thư mục con"
                  description="Nếu đây đúng là thư mục chứa ảnh, bấm “Chọn thư mục này”. Nếu không, quay lại theo đường dẫn phía trên."
                />
              )
            }
          />

          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" onClick={chooseFolder} disabled={isAtRoot}>
              Chọn thư mục này
            </Button>
            <LoadMoreButton query={folders} label="Tải thêm thư mục" />
            <Button type="button" variant="ghost" onClick={onCancel}>
              Huỷ
            </Button>
          </div>

          {isAtRoot ? (
            <p className="text-muted-foreground text-xs">
              Đang ở gốc Drive — mở một thư mục con trước, hệ thống không đọc cả Drive.
            </p>
          ) : (
            <p className="text-muted-foreground text-xs">
              Sẽ chọn thư mục <span className="text-foreground font-medium">{here.name}</span>.
            </p>
          )}
        </section>
      ) : null}

      {step === "spreadsheet" ? (
        <section aria-label="Bước 2 — chọn bảng Google Sheet" className="space-y-3">
          <SearchField
            id={`${fieldId}-sheet-search`}
            label="Tìm bảng Google Sheet theo tên"
            hint="Bỏ trống để xem các bảng sửa gần đây nhất trong Drive."
            value={sheetSearch}
            onChange={setSheetSearch}
            placeholder="Ví dụ: Bảng sản phẩm 2026"
          />

          <ListBody
            query={spreadsheets}
            ariaLabel="Bảng Google Sheet"
            rows={flattenSheets(spreadsheets.data?.pages, pickedSheet)}
            onSelect={(id) => {
              const item = findItem(flattenItems(spreadsheets.data?.pages), id);
              if (item) chooseSpreadsheet(item);
            }}
            empty={
              sheetQuery.length > 0 ? (
                <EmptyState
                  kind="no-result"
                  title="Không có bảng nào khớp"
                  description={`Không tìm thấy bảng Google Sheet nào có tên chứa “${sheetQuery}”.`}
                  action={
                    <Button type="button" variant="outline" onClick={() => setSheetSearch("")}>
                      Xoá từ khoá
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  kind="first-run"
                  title="Chưa thấy bảng Google Sheet nào"
                  description="Tài khoản Google đang kết nối không có bảng nào mà ứng dụng đọc được. Kiểm tra bạn đã kết nối đúng tài khoản, hoặc chia sẻ bảng cho tài khoản đó."
                />
              )
            }
          />

          <div className="flex flex-wrap items-center gap-2">
            <LoadMoreButton query={spreadsheets} label="Tải thêm bảng" />
            <Button type="button" variant="outline" onClick={() => setStep("folder")}>
              Quay lại thư mục
            </Button>
            <Button type="button" variant="ghost" onClick={onCancel}>
              Huỷ
            </Button>
          </div>
        </section>
      ) : null}

      {step === "tab" ? (
        <section aria-label="Bước 3 — chọn tab của bảng" className="space-y-3">
          <p className="text-muted-foreground text-sm">
            Bảng đã chọn:{" "}
            <span className="text-foreground font-medium">
              {pickedSheet ? driveItemLabel(pickedSheet) : "—"}
            </span>
            . Chọn tab chứa danh sách sản phẩm.
          </p>

          <TabListBody
            query={tabs}
            pickedTab={pickedTab}
            onSelect={chooseTab}
            onBack={() => setStep("spreadsheet")}
          />

          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" onClick={() => setStep("spreadsheet")}>
              Chọn bảng khác
            </Button>
            <Button type="button" variant="ghost" onClick={onCancel}>
              Huỷ
            </Button>
          </div>
        </section>
      ) : null}

      {step === "review" ? (
        <section aria-label="Xem lại nguồn sẽ lưu" className="space-y-3">
          <dl className="border-border divide-border bg-card divide-y rounded-xl border">
            <SummaryRow
              label="Thư mục ảnh"
              value={pickedFolder ? driveItemLabel(pickedFolder) : "—"}
              id={pickedFolder?.id}
            />
            <SummaryRow
              label="Bảng Sheet"
              value={pickedSheet ? driveItemLabel(pickedSheet) : "—"}
              id={pickedSheet?.id}
            />
            <SummaryRow label="Tab dữ liệu" value={pickedTab ?? "—"} />
          </dl>

          {isConfirming ? (
            <div
              role="group"
              aria-label="Xác nhận lưu nguồn dữ liệu"
              onKeyDown={(event) => {
                if (event.key === "Escape") setIsConfirming(false);
              }}
              className="border-warning/40 bg-warning/5 space-y-3 rounded-xl border p-4"
            >
              <p className="text-sm font-medium">Lưu nguồn dữ liệu cho đơn vị này?</p>
              <p className="text-muted-foreground text-sm">
                Lưu xong cần bấm <span className="text-foreground font-medium">Chạy đồng bộ</span>{" "}
                lại. Lần đồng bộ kế tiếp sẽ xoá sản phẩm/ảnh không còn thuộc nguồn mới.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button ref={confirmRef} type="button" onClick={save}>
                  Lưu nguồn
                </Button>
                <Button type="button" variant="outline" onClick={() => setIsConfirming(false)}>
                  Xem lại
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                onClick={() => setIsConfirming(true)}
                disabled={update.isPending}
              >
                {update.isPending ? "Đang lưu…" : "Lưu nguồn"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={restart}
                disabled={update.isPending}
              >
                Chọn lại
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={onCancel}
                disabled={update.isPending}
              >
                Huỷ
              </Button>
            </div>
          )}
        </section>
      ) : null}

      {saveIssue ? (
        <p role="alert" className="text-destructive text-sm">
          {saveIssue}
        </p>
      ) : null}

      {/* The save failed on the server: shown in full, never swallowed. */}
      {update.isError ? <ApiErrorNotice error={update.error} /> : null}
    </div>
  );
}

// --- Steps -------------------------------------------------------------------

function stepAnnouncement(step: PickerStep): string {
  if (step === "folder") return "Bước 1: chọn thư mục ảnh";
  if (step === "spreadsheet") return "Bước 2: chọn bảng Google Sheet";
  if (step === "tab") return "Bước 3: chọn tab của bảng";
  return "Xem lại nguồn trước khi lưu";
}

function StepIndicator({ step }: { step: PickerStep }) {
  const activeIndex = STEP_LABELS.findIndex((item) => item.step === step);
  // The review screen belongs to the last step, not to none of them.
  const current = activeIndex === -1 ? STEP_LABELS.length - 1 : activeIndex;

  return (
    <nav aria-label="Các bước chọn nguồn">
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        {STEP_LABELS.map((item, index) => (
          <li key={item.step} className="flex items-center gap-2">
            <span
              aria-current={index === current ? "step" : undefined}
              className={
                index === current
                  ? "text-foreground font-medium"
                  : index < current
                    ? "text-muted-foreground"
                    : "text-muted-foreground/70"
              }
            >
              {index + 1}. {item.label}
              {index < current ? <span className="sr-only"> (đã chọn xong)</span> : null}
            </span>
            {index < STEP_LABELS.length - 1 ? (
              <span aria-hidden="true" className="text-muted-foreground/50">
                ›
              </span>
            ) : null}
          </li>
        ))}
      </ol>
    </nav>
  );
}

function FolderBreadcrumb({
  breadcrumb,
  onNavigate,
}: {
  breadcrumb: readonly DriveItem[];
  onNavigate: (item: DriveItem) => void;
}) {
  return (
    <nav aria-label="Đường dẫn thư mục">
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
        {breadcrumb.map((item, index) => {
          const isLast = index === breadcrumb.length - 1;
          const label = item.id === GOOGLE_DRIVE_ROOT_ID ? GOOGLE_DRIVE_ROOT_NAME : driveItemLabel(item);

          return (
            <li key={`${item.id}-${index}`} className="flex items-center gap-1.5">
              {isLast ? (
                // aria-current="location": this crumb IS the folder on screen.
                <span aria-current="location" className="text-foreground font-medium">
                  {label}
                </span>
              ) : (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto px-0"
                  onClick={() => onNavigate(item)}
                >
                  {label}
                </Button>
              )}
              {isLast ? null : (
                <span aria-hidden="true" className="text-muted-foreground">
                  /
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function SummaryRow({ label, value, id }: { label: string; value: string; id?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-baseline gap-x-3">
        <span className="text-sm font-medium break-all">{value}</span>
        {id ? (
          <span className="text-muted-foreground font-mono text-xs" title={id}>
            {shortenId(id)}
          </span>
        ) : null}
      </dd>
    </div>
  );
}

function SearchField({
  id,
  label,
  hint,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  const hintId = `${id}-hint`;

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <Input
        id={id}
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-describedby={hintId}
        autoComplete="off"
        spellCheck={false}
      />
      <p id={hintId} className="text-muted-foreground text-xs">
        {hint}
      </p>
    </div>
  );
}

// --- List bodies (the four states live here) ---------------------------------

/** The subset of an infinite query this file needs — no `any` in sight. */
interface ListQueryLike {
  isPending: boolean;
  fetchStatus: "fetching" | "paused" | "idle";
  isError: boolean;
  error: ApiError | null;
  isFetching: boolean;
  isFetchingNextPage: boolean;
  hasNextPage: boolean;
  refetch: () => unknown;
  fetchNextPage: () => unknown;
}

function ListBody({
  query,
  ariaLabel,
  rows,
  onSelect,
  empty,
}: {
  query: ListQueryLike;
  ariaLabel: string;
  rows: readonly PickerRow[];
  onSelect: (key: string) => void;
  empty: React.ReactNode;
}) {
  const isFirstLoad = query.isPending && query.fetchStatus === "fetching";
  const showSkeleton = useDelayedFlag(isFirstLoad);

  // --- Loading (delayed so a fast answer does not flash) -------------------
  if (isFirstLoad) return showSkeleton ? <PickerListSkeleton /> : null;

  // --- Error ----------------------------------------------------------------
  if (query.isError) {
    return <ApiErrorNotice error={query.error} onRetry={() => void query.refetch()} />;
  }

  // --- Empty ----------------------------------------------------------------
  if (rows.length === 0) return <>{empty}</>;

  // --- Data (a background page load mutes the list, never hides it) ---------
  return (
    <PickerList
      ariaLabel={ariaLabel}
      rows={rows}
      onSelect={onSelect}
      isBusy={query.isFetching && !isFirstLoad}
    />
  );
}

function LoadMoreButton({ query, label }: { query: ListQueryLike; label: string }) {
  if (!query.hasNextPage) return null;

  return (
    <Button
      type="button"
      variant="outline"
      onClick={() => void query.fetchNextPage()}
      disabled={query.isFetchingNextPage}
    >
      {query.isFetchingNextPage ? "Đang tải thêm…" : label}
    </Button>
  );
}

function TabListBody({
  query,
  pickedTab,
  onSelect,
  onBack,
}: {
  query: {
    isPending: boolean;
    fetchStatus: "fetching" | "paused" | "idle";
    isError: boolean;
    error: ApiError | null;
    data?: { tabs: string[] };
    refetch: () => unknown;
  };
  pickedTab: string | null;
  onSelect: (name: string) => void;
  onBack: () => void;
}) {
  const isFirstLoad = query.isPending && query.fetchStatus === "fetching";
  const showSkeleton = useDelayedFlag(isFirstLoad);

  if (isFirstLoad) return showSkeleton ? <PickerListSkeleton rows={3} /> : null;

  if (query.isError) {
    return <ApiErrorNotice error={query.error} onRetry={() => void query.refetch()} />;
  }

  const tabs = query.data?.tabs ?? [];

  if (tabs.length === 0) {
    return (
      <EmptyState
        kind="done"
        title="Bảng này không đọc được tab nào"
        description="Có thể bảng vừa bị đổi quyền chia sẻ, hoặc đây không phải bảng Google Sheet. Hãy chọn bảng khác."
        action={
          <Button type="button" variant="outline" onClick={onBack}>
            Chọn bảng khác
          </Button>
        }
      />
    );
  }

  return (
    <PickerList
      ariaLabel="Tab của bảng"
      rows={tabs.map((name) => ({ key: name, label: name, isSelected: name === pickedTab }))}
      onSelect={onSelect}
    />
  );
}

// --- Page flattening ---------------------------------------------------------

function flattenItems(pages: readonly { items: DriveItem[] }[] | undefined): DriveItem[] {
  return pages?.flatMap((page) => page.items) ?? [];
}

function findItem(items: readonly DriveItem[], id: string): DriveItem | undefined {
  return items.find((item) => item.id === id);
}

function flattenFolders(pages: readonly { items: DriveItem[] }[] | undefined): PickerRow[] {
  return flattenItems(pages).map((item) => ({
    key: item.id,
    label: driveItemLabel(item),
    hint: shortenId(item.id),
  }));
}

function flattenSheets(
  pages: readonly { items: DriveItem[] }[] | undefined,
  picked: DriveItem | null,
): PickerRow[] {
  return flattenItems(pages).map((item) => ({
    key: item.id,
    label: driveItemLabel(item),
    hint: shortenId(item.id),
    isSelected: item.id === picked?.id,
  }));
}
