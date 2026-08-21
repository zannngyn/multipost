"use client";

import {
  Button,
  Collapsible,
  Divider,
  HStack,
  Heading,
  Link,
  MetadataList,
  MetadataListItem,
  Section,
  Skeleton,
  Stack,
  StackItem,
  Text,
} from "@astryxdesign/core";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useState } from "react";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { ReadOnlyNotice } from "@/ui/components/feedback/ReadOnlyNotice";
import { CatalogSourceForm } from "@/ui/components/sync/CatalogSourceForm";
import { GoogleConnectionPanel } from "@/ui/components/sync/GoogleConnectionPanel";
import { GoogleDrivePicker } from "@/ui/components/sync/GoogleDrivePicker";
import { useCatalogSource } from "@/ui/hooks/useCatalogProducts";
import { useDelayedFlag } from "@/ui/hooks/useDelayedFlag";
import { writeGate } from "@/ui/hooks/read-only-gate";
import { useReadOnlyReason } from "@/ui/hooks/useReadOnlyReason";
import { useGoogleConnection } from "@/ui/hooks/useGoogleDrive";
import { shortenId, type CatalogSource } from "@/ui/schemas/catalog.schema";
import {
  parseGoogleConnectOutcome,
  type GoogleConnectOutcome,
} from "@/ui/schemas/google-drive.schema";

/**
 * "Nguồn đang đọc" — WHICH Drive folder and WHICH Sheet tab this tenant reads,
 * and HOW the tool is allowed to read them.
 *
 * A `Section`, not a Card: this is a page region made of several sub-regions,
 * which is the case Astryx says Section exists for. The regions are separated
 * by dividers instead of nested boxes.
 *
 * The region is stacked in the order an operator sets things up:
 *  1. the Google connection (primary — connect once, then pick in-app);
 *  2. the source itself (facts, or the in-app picker while choosing);
 *  3. "Hoặc nhập link/ID thủ công" — the fallback for a tenant that runs on a
 *     Service Account and never connects OAuth. It is collapsed, never removed:
 *     it is the ONLY way in when the connection is not there, so it opens by
 *     itself when no source is stored, and a "Đổi nguồn" button in the header
 *     opens it when one already is. Without that button the same tenant would
 *     have to guess that a summary it never opened hides its only editor.
 *
 * Four states per region: loading (skeleton) / data / empty (chưa cấu hình) /
 * error. The connection and the source are separate queries on purpose — one
 * failing must not blank the other.
 */
export function CatalogSourceCard({
  onSourceChanged,
}: {
  /** Lets the screen point at "Chạy đồng bộ" right after a source change. */
  onSourceChanged?: () => void;
}) {
  const baseId = useId();
  const headingId = `${baseId}-source`;
  // Lifted out of the disclosure: the "Đổi nguồn" button in the header points
  // at the SAME panel, so both controls need the id.
  const manualPanelId = `${baseId}-manual`;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const source = useCatalogSource();
  const connection = useGoogleConnection();

  /**
   * Support mode is read-only (M3.3). Changing the source is the heaviest write
   * on this screen — the next sync deletes every product that no longer belongs
   * to the new folder — so the picker, the manual form and the button that
   * opens them all go off together.
   */
  const gate = writeGate(useReadOnlyReason());

  const [isPicking, setIsPicking] = useState(false);
  const [isManualOpen, setIsManualOpen] = useState(false);
  const [hasAutoOpenedManual, setHasAutoOpenedManual] = useState(false);

  // --- OAuth callback: `?google=connected|cancelled|error&reason=…` ---------
  const search = searchParams.toString();
  const [lastReadSearch, setLastReadSearch] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<GoogleConnectOutcome | null>(null);

  // Adjusting state during render (the documented React alternative to an
  // effect): the callback is read ONCE, and its message has to survive the URL
  // rewrite below — reading it straight from `searchParams` would make the
  // notice vanish the moment the params are wiped.
  if (lastReadSearch !== search) {
    setLastReadSearch(search);
    const parsed = parseGoogleConnectOutcome(new URLSearchParams(search));
    if (parsed) setOutcome(parsed);
  }

  useEffect(() => {
    const params = new URLSearchParams(search);
    if (parseGoogleConnectOutcome(params) === null) return;

    // Drop only the callback params — anything else in the URL belongs to
    // another feature. The message now lives in state, and a reload must not
    // resurrect "Đã kết nối Google" hours later.
    params.delete("google");
    params.delete("reason");
    const rest = params.toString();
    router.replace(rest.length > 0 ? `${pathname}?${rest}` : pathname, { scroll: false });
  }, [search, pathname, router]);

  const isFirstLoad = source.isPending && source.fetchStatus === "fetching";
  /**
   * The status query is still in flight — so "đã kết nối hay chưa" has NO
   * answer yet, and `connection.data?.state ?? null` must not be read as "no".
   * Every conclusion drawn from it waits for this to be false.
   */
  const isConnectionFirstLoad = connection.isPending && connection.fetchStatus === "fetching";
  const showSkeleton = useDelayedFlag(isFirstLoad || isConnectionFirstLoad);
  const configured = source.data?.state === "configured" ? source.data.source : null;
  const connectionState = connection.data?.state ?? null;
  const isConnected = connectionState === "connected";

  /**
   * A tenant that reads Drive with a Service Account never connects OAuth, so
   * the picker is not for it — the manual link/ID form is its ONLY way to change
   * a source it already has. It stays a secondary action next to the heading:
   * connecting Google is still the primary route for everyone else.
   */
  const needsManualEntry = !isConnectionFirstLoad && !isConnected;

  /**
   * No source, and no working connection to build one with: the manual form is
   * the only way out, so it starts open instead of hiding behind a summary the
   * operator has no reason to suspect.
   */
  const shouldAutoOpenManual =
    configured === null &&
    !isFirstLoad &&
    (connection.isError || (connectionState !== null && connectionState !== "connected"));

  if (!hasAutoOpenedManual && shouldAutoOpenManual) {
    setHasAutoOpenedManual(true);
    setIsManualOpen(true);
  }

  function finishSourceChange() {
    setIsPicking(false);
    setIsManualOpen(false);
    onSourceChanged?.();
  }

  return (
    // `role="region"`: Section renders a plain container, and this block is the
    // one named area of the screen an operator navigates to on purpose.
    <Section padding={0} role="region" aria-labelledby={headingId}>
      <HStack gap={3} paddingInline={4} paddingBlock={2} align="center" wrap="wrap">
        <StackItem size="fill">
          <Heading level={2} id={headingId}>
            Nguồn đang đọc
          </Heading>
        </StackItem>

        {source.isFetching || connection.isFetching ? (
          <Text type="supporting" role="status" aria-live="polite">
            Đang làm mới…
          </Text>
        ) : null}

        {/* Only for the tenants the picker cannot serve, and only once the
            status is known — offering it while the answer is still loading
            would flash a button at everyone. */}
        {configured !== null && needsManualEntry && !isPicking && !gate.isDisabled ? (
          <Button
            variant="secondary"
            size="sm"
            label="Đổi nguồn"
            aria-expanded={isManualOpen}
            aria-controls={manualPanelId}
            onClick={() => setIsManualOpen((open) => !open)}
          />
        ) : null}
      </HStack>

      <Divider />

      <GoogleConnectionPanel
        connection={connection}
        outcome={outcome}
        onDismissOutcome={() => setOutcome(null)}
        onPickSource={() => setIsPicking(true)}
        isPicking={isPicking}
      />

      <Divider />

      {isPicking ? (
        <Stack direction="vertical" gap={3} padding={4}>
          <Text type="supporting">
            Chọn thư mục ảnh, bảng Google Sheet và tab dữ liệu ngay tại đây. Nguồn chỉ được lưu ở
            bước cuối, sau khi bạn xác nhận.
          </Text>
          <GoogleDrivePicker onSaved={finishSourceChange} onCancel={() => setIsPicking(false)} />
        </Stack>
      ) : (
        <SourceRegion
          isFirstLoad={isFirstLoad}
          showSkeleton={showSkeleton}
          isError={source.isError}
          error={source.error}
          onRetry={() => void source.refetch()}
          configured={configured}
          isConnectionPending={isConnectionFirstLoad}
          canPick={isConnected && !gate.isDisabled}
          onPick={() => setIsPicking(true)}
          readOnlyReason={gate.reason}
        />
      )}

      {/* The manual editor is not offered at all in read-only mode: a form
          whose save can only 403 invites typing that gets thrown away. */}
      {gate.isDisabled ? null : (
        <>
          <Divider />
          {/* A bare Collapsible is unpadded by design, so the inset that lines
              it up with the blocks above comes from here. */}
          <Stack direction="vertical" paddingInline={4} paddingBlock={2}>
            <Collapsible
              isOpen={isManualOpen}
              onOpenChange={setIsManualOpen}
              trigger={<Text weight="medium">Hoặc nhập link/ID thủ công</Text>}
            >
              {/* Unmounted when closed on purpose: a hidden form keeps draft
                  values and server errors alive where nobody can see them. */}
              {isManualOpen ? (
                <Stack id={manualPanelId} direction="vertical" gap={3} paddingBlock={2}>
                  <Text type="supporting">
                    Dùng khi đơn vị đọc Drive bằng Service Account, hoặc khi bạn đã có sẵn link/ID.
                    Không cần kết nối Google cho cách này.
                  </Text>
                  <CatalogSourceForm
                    current={configured ?? undefined}
                    onSaved={finishSourceChange}
                    onCancel={() => setIsManualOpen(false)}
                  />
                </Stack>
              ) : null}
            </Collapsible>
          </Stack>
        </>
      )}
    </Section>
  );
}

/** Loading / error / empty / data for the stored source, in that order. */
function SourceRegion({
  isFirstLoad,
  showSkeleton,
  isError,
  error,
  onRetry,
  configured,
  isConnectionPending,
  canPick,
  onPick,
  readOnlyReason = null,
}: {
  isFirstLoad: boolean;
  showSkeleton: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
  configured: CatalogSource | null;
  /** The connection status has not answered yet — `canPick` means nothing. */
  isConnectionPending: boolean;
  /** Only a connected tenant can open the in-app picker. */
  canPick: boolean;
  onPick: () => void;
  /** Set while the app is read-only (support mode, M3.3). */
  readOnlyReason?: string | null;
}) {
  if (isFirstLoad) {
    return showSkeleton ? <SourceFactsSkeleton /> : null;
  }

  if (isError) {
    return (
      <Stack direction="vertical" padding={4}>
        <ApiErrorNotice error={error} onRetry={onRetry} />
      </Stack>
    );
  }

  // Empty: nothing configured yet. The way forward depends on whether the
  // tenant can use the picker at all — offering a dead button would be a lie.
  if (configured === null) {
    // …and while the status is still loading there IS no answer, so nothing is
    // said. Rendering the "chưa kết nối" wording first and swapping it a moment
    // later reads as the screen changing its mind.
    if (isConnectionPending) {
      return showSkeleton ? <SourceEmptySkeleton /> : null;
    }

    return (
      <Stack direction="vertical" gap={3} padding={4}>
        <Text type="supporting">
          Chưa cấu hình nguồn Drive/Sheet cho đơn vị này, nên chưa chạy đồng bộ được.
          {readOnlyReason
            ? ""
            : canPick
              ? " Chọn thư mục ảnh và bảng sản phẩm ngay trong app."
              : " Kết nối Google ở trên, hoặc nhập link/ID thủ công ở phần dưới."}
        </Text>
        {/* In read-only mode the "làm gì tiếp theo" belongs to whoever owns the
            company, not to the person reading over their shoulder. */}
        <ReadOnlyNotice reason={readOnlyReason} />
        {canPick ? (
          <HStack gap={2} align="center">
            <Button variant="primary" label="Chọn thư mục và bảng" onClick={onPick} />
          </HStack>
        ) : null}
      </Stack>
    );
  }

  return <SourceFacts source={configured} />;
}

function SourceFacts({ source }: { source: CatalogSource }) {
  return (
    <Stack direction="vertical" gap={3} padding={4}>
      <MetadataList columns={2} label={{ position: "top" }}>
        <MetadataListItem label="Thư mục Drive">
          <SourceValue
            id={source.driveFolderId}
            href={source.driveFolderUrl}
            linkLabel="Mở thư mục"
          />
        </MetadataListItem>
        <MetadataListItem label={`Bảng Sheet · tab ${source.sheetName}`}>
          <SourceValue id={source.spreadsheetId} href={source.spreadsheetUrl} linkLabel="Mở bảng" />
        </MetadataListItem>
      </MetadataList>

      <Text type="supporting" size="2xs">
        Hệ thống chỉ đọc đúng hai nguồn trên. Đổi nguồn xong phải chạy đồng bộ lại — lần đồng bộ kế
        tiếp sẽ xoá sản phẩm/ảnh không còn thuộc nguồn mới.
      </Text>
    </Stack>
  );
}

function SourceValue({
  id,
  href,
  linkLabel,
}: {
  id: string;
  href: string;
  linkLabel: string;
}) {
  return (
    // `center`: Astryx has no baseline alignment, and the id sits next to a
    // normal-size link, so centring keeps the pair on one optical line.
    <HStack gap={3} align="center" wrap="wrap">
      {/* Shortened, with the truncation tooltip carrying the rest — an operator
          never needs to read 44 characters, only to recognise them. */}
      <Text type="code" size="2xs" color="secondary" maxLines={1} wordBreak="break-all">
        {shortenId(id)}
      </Text>
      {/* External on purpose: an external tab must not get a handle on this one,
          which `isExternalLink` takes care of. */}
      <Link href={href} isExternalLink newTabLabel="(mở tab mới)">
        {linkLabel}
      </Link>
    </HStack>
  );
}

/**
 * Placeholder for the empty state while the connection status decides WHICH
 * empty state it is. Same two lines + button height as the real block, so the
 * answer lands without pushing the region around.
 */
function SourceEmptySkeleton() {
  return (
    <Stack direction="vertical" gap={3} padding={4} aria-hidden="true">
      <Skeleton width="100%" height={16} />
      <Skeleton width="66%" height={16} index={1} />
      <Skeleton width={176} height={32} index={2} />
    </Stack>
  );
}

/** Same shape as the real facts block so nothing jumps (CLS = 0). */
function SourceFactsSkeleton() {
  return (
    <Stack direction="vertical" gap={3} padding={4} aria-hidden="true">
      <HStack gap={4} align="start" wrap="wrap">
        {[0, 1].map((cell) => (
          <StackItem key={cell} size="fill">
            <Stack direction="vertical" gap={1.5}>
              <Skeleton width={112} height={12} index={cell} />
              <Skeleton width={176} height={16} index={cell} />
            </Stack>
          </StackItem>
        ))}
      </HStack>
      <Skeleton width="100%" height={12} index={2} />
    </Stack>
  );
}
