"use client";

import {
  Banner,
  BreadcrumbItem,
  Breadcrumbs,
  Button,
  EmptyState,
  HStack,
  MetadataList,
  MetadataListItem,
  Stack,
  StatusDot,
  Text,
  TextInput,
  VisuallyHidden,
} from "@astryxdesign/core";
import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { PickerList, PickerListSkeleton, type PickerRow } from "@/ui/components/sync/PickerList";
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
    update.mutate(parsed.data, { onSuccess: onSaved });
  }

  if (lostConnection) {
    return (
      <Stack direction="vertical" gap={3}>
        <Banner
          role="alert"
          status="error"
          title="Kết nối Google không còn hiệu lực"
          description="Không đọc được Drive nữa. Hãy kết nối lại ở khối phía trên, rồi chọn thư mục và bảng."
          endContent={<Button variant="secondary" label="Đóng" onClick={onCancel} />}
        />
      </Stack>
    );
  }

  return (
    <Stack direction="vertical" gap={4}>
      <StepIndicator step={step} />

      {/* Progress is announced without stealing focus from the list. */}
      <VisuallyHidden as="div" role="status" aria-live="polite">
        {update.isPending ? "Đang lưu nguồn dữ liệu" : stepAnnouncement(step)}
      </VisuallyHidden>

      {step === "folder" ? (
        <Stack as="section" direction="vertical" gap={3} aria-label="Bước 1 — chọn thư mục ảnh">
          <FolderBreadcrumb
            breadcrumb={breadcrumb.length > 0 ? breadcrumb : [here]}
            onNavigate={(item) => openFolder(item)}
          />

          <TextInput
            label="Tìm thư mục theo tên"
            description="Bỏ trống để xem toàn bộ thư mục con của thư mục đang mở."
            value={folderSearch}
            onChange={setFolderSearch}
            placeholder="Ví dụ: Ảnh sản phẩm"
            startIcon={Search}
            size="sm"
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
                  headingLevel={4}
                  isCompact
                  title="Không có thư mục nào khớp"
                  description={`Không tìm thấy thư mục nào có tên chứa “${folderQuery}”.`}
                  actions={
                    <Button
                      variant="secondary"
                      label="Xoá từ khoá"
                      onClick={() => setFolderSearch("")}
                    />
                  }
                />
              ) : (
                <EmptyState
                  headingLevel={4}
                  isCompact
                  title="Thư mục này không có thư mục con"
                  description="Nếu đây đúng là thư mục chứa ảnh, bấm “Chọn thư mục này”. Nếu không, quay lại theo đường dẫn phía trên."
                />
              )
            }
          />

          <Stack direction="vertical" gap={1}>
            <HStack gap={2} align="center" wrap="wrap">
              <Button
                variant="primary"
                label="Chọn thư mục này"
                isDisabled={isAtRoot}
                onClick={chooseFolder}
              />
              <LoadMoreButton query={folders} label="Tải thêm thư mục" />
              <Button variant="ghost" label="Huỷ" onClick={onCancel} />
            </HStack>

            <Text type="supporting" size="2xs">
              {isAtRoot
                ? "Đang ở gốc Drive — mở một thư mục con trước, hệ thống không đọc cả Drive."
                : `Sẽ chọn thư mục ${here.name}.`}
            </Text>
          </Stack>
        </Stack>
      ) : null}

      {step === "spreadsheet" ? (
        <Stack
          as="section"
          direction="vertical"
          gap={3}
          aria-label="Bước 2 — chọn bảng Google Sheet"
        >
          <TextInput
            label="Tìm bảng Google Sheet theo tên"
            description="Bỏ trống để xem các bảng sửa gần đây nhất trong Drive."
            value={sheetSearch}
            onChange={setSheetSearch}
            placeholder="Ví dụ: Bảng sản phẩm 2026"
            startIcon={Search}
            size="sm"
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
                  headingLevel={4}
                  isCompact
                  title="Không có bảng nào khớp"
                  description={`Không tìm thấy bảng Google Sheet nào có tên chứa “${sheetQuery}”.`}
                  actions={
                    <Button
                      variant="secondary"
                      label="Xoá từ khoá"
                      onClick={() => setSheetSearch("")}
                    />
                  }
                />
              ) : (
                <EmptyState
                  headingLevel={4}
                  isCompact
                  title="Chưa thấy bảng Google Sheet nào"
                  description="Tài khoản Google đang kết nối không có bảng nào mà ứng dụng đọc được. Kiểm tra bạn đã kết nối đúng tài khoản, hoặc chia sẻ bảng cho tài khoản đó."
                />
              )
            }
          />

          <HStack gap={2} align="center" wrap="wrap">
            <LoadMoreButton query={spreadsheets} label="Tải thêm bảng" />
            <Button
              variant="secondary"
              label="Quay lại thư mục"
              onClick={() => setStep("folder")}
            />
            <Button variant="ghost" label="Huỷ" onClick={onCancel} />
          </HStack>
        </Stack>
      ) : null}

      {step === "tab" ? (
        <Stack as="section" direction="vertical" gap={3} aria-label="Bước 3 — chọn tab của bảng">
          <Text type="supporting">
            Bảng đã chọn:{" "}
            <Text color="primary" weight="medium">
              {pickedSheet ? driveItemLabel(pickedSheet) : "—"}
            </Text>
            . Chọn tab chứa danh sách sản phẩm.
          </Text>

          <TabListBody
            query={tabs}
            pickedTab={pickedTab}
            onSelect={chooseTab}
            onBack={() => setStep("spreadsheet")}
          />

          <HStack gap={2} align="center" wrap="wrap">
            <Button
              variant="secondary"
              label="Chọn bảng khác"
              onClick={() => setStep("spreadsheet")}
            />
            <Button variant="ghost" label="Huỷ" onClick={onCancel} />
          </HStack>
        </Stack>
      ) : null}

      {step === "review" ? (
        <Stack as="section" direction="vertical" gap={3} aria-label="Xem lại nguồn sẽ lưu">
          <MetadataList label={{ position: "start", width: 128 }}>
            <MetadataListItem label="Thư mục ảnh">
              <SummaryValue
                value={pickedFolder ? driveItemLabel(pickedFolder) : "—"}
                id={pickedFolder?.id}
              />
            </MetadataListItem>
            <MetadataListItem label="Bảng Sheet">
              <SummaryValue
                value={pickedSheet ? driveItemLabel(pickedSheet) : "—"}
                id={pickedSheet?.id}
              />
            </MetadataListItem>
            <MetadataListItem label="Tab dữ liệu">
              <SummaryValue value={pickedTab ?? "—"} />
            </MetadataListItem>
          </MetadataList>

          {isConfirming ? (
            <Stack
              direction="vertical"
              role="group"
              aria-label="Xác nhận lưu nguồn dữ liệu"
              onKeyDown={(event) => {
                if (event.key === "Escape") setIsConfirming(false);
              }}
            >
              <Banner
                status="warning"
                title="Lưu nguồn dữ liệu cho đơn vị này?"
                description="Lưu xong cần bấm “Chạy đồng bộ” lại. Lần đồng bộ kế tiếp sẽ xoá sản phẩm/ảnh không còn thuộc nguồn mới."
                endContent={
                  <HStack gap={2} align="center" wrap="wrap">
                    <Button ref={confirmRef} variant="primary" label="Lưu nguồn" onClick={save} />
                    <Button
                      variant="secondary"
                      label="Xem lại"
                      onClick={() => setIsConfirming(false)}
                    />
                  </HStack>
                }
              />
            </Stack>
          ) : (
            <HStack gap={2} align="center" wrap="wrap">
              <Button
                variant="primary"
                label={update.isPending ? "Đang lưu…" : "Lưu nguồn"}
                isLoading={update.isPending}
                isDisabled={update.isPending}
                onClick={() => setIsConfirming(true)}
              />
              <Button
                variant="secondary"
                label="Chọn lại"
                isDisabled={update.isPending}
                onClick={restart}
              />
              <Button
                variant="ghost"
                label="Huỷ"
                isDisabled={update.isPending}
                onClick={onCancel}
              />
            </HStack>
          )}
        </Stack>
      ) : null}

      {saveIssue ? <Banner role="alert" status="error" title={saveIssue} /> : null}

      {/* The save failed on the server: shown in full, never swallowed. */}
      {update.isError ? <ApiErrorNotice error={update.error} /> : null}
    </Stack>
  );
}

// --- Steps -------------------------------------------------------------------

function stepAnnouncement(step: PickerStep): string {
  if (step === "folder") return "Bước 1: chọn thư mục ảnh";
  if (step === "spreadsheet") return "Bước 2: chọn bảng Google Sheet";
  if (step === "tab") return "Bước 3: chọn tab của bảng";
  return "Xem lại nguồn trước khi lưu";
}

/**
 * Same dot-and-word vocabulary as the batch screen's stepper, so "đang làm" is
 * one visual idea across the app rather than one per screen.
 */
function StepIndicator({ step }: { step: PickerStep }) {
  const activeIndex = STEP_LABELS.findIndex((item) => item.step === step);
  // The review screen belongs to the last step, not to none of them.
  const current = activeIndex === -1 ? STEP_LABELS.length - 1 : activeIndex;

  return (
    <HStack as="ol" aria-label="Các bước chọn nguồn" gap={3} wrap="wrap" align="center">
      {STEP_LABELS.map((item, index) => {
        const isCurrent = index === current;
        const isDone = index < current;

        return (
          <HStack
            as="li"
            key={item.step}
            gap={1.5}
            align="center"
            aria-current={isCurrent ? "step" : undefined}
          >
            <StatusDot
              variant={isDone ? "success" : isCurrent ? "accent" : "neutral"}
              label={isDone ? "đã chọn xong" : isCurrent ? "đang làm" : "chưa tới"}
              isPulsing={isCurrent}
            />
            <Text
              size="2xs"
              weight={isCurrent ? "medium" : "normal"}
              color={isCurrent ? "primary" : isDone ? "secondary" : "placeholder"}
            >
              {index + 1}. {item.label}
            </Text>
          </HStack>
        );
      })}
    </HStack>
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
    <Breadcrumbs variant="supporting" label="Đường dẫn thư mục">
      {breadcrumb.map((item, index) => {
        const isLast = index === breadcrumb.length - 1;
        const label =
          item.id === GOOGLE_DRIVE_ROOT_ID ? GOOGLE_DRIVE_ROOT_NAME : driveItemLabel(item);

        return (
          <BreadcrumbItem
            key={`${item.id}-${index}`}
            isCurrent={isLast}
            onClick={isLast ? undefined : () => onNavigate(item)}
          >
            {label}
          </BreadcrumbItem>
        );
      })}
    </Breadcrumbs>
  );
}

function SummaryValue({ value, id }: { value: string; id?: string }) {
  return (
    // `center`: Astryx has no baseline alignment. The two runs are close in
    // size, so bottom-aligning would drop the tiny id into the descender space
    // of the name and read as sunken.
    <HStack gap={3} align="center" wrap="wrap">
      <Text weight="medium" wordBreak="break-all">
        {value}
      </Text>
      {id ? (
        <Text type="code" size="2xs" color="secondary" maxLines={1} wordBreak="break-all">
          {shortenId(id)}
        </Text>
      ) : null}
    </HStack>
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
      variant="secondary"
      label={query.isFetchingNextPage ? "Đang tải thêm…" : label}
      isDisabled={query.isFetchingNextPage}
      onClick={() => void query.fetchNextPage()}
    />
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
        headingLevel={4}
        isCompact
        title="Bảng này không đọc được tab nào"
        description="Có thể bảng vừa bị đổi quyền chia sẻ, hoặc đây không phải bảng Google Sheet. Hãy chọn bảng khác."
        actions={<Button variant="secondary" label="Chọn bảng khác" onClick={onBack} />}
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
