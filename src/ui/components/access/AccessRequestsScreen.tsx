"use client";

import {
  Banner,
  Button,
  EmptyState,
  HStack,
  Heading,
  Layout,
  LayoutContent,
  LayoutHeader,
  SegmentedControl,
  SegmentedControlItem,
  Stack,
  StackItem,
  Text,
} from "@astryxdesign/core";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";

import { AccessRequestTable } from "@/ui/components/access/AccessRequestTable";
import { AccessRequestTableSkeleton } from "@/ui/components/access/AccessRequestTableSkeleton";
import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { presentApiError, toApiError } from "@/ui/components/feedback/present-api-error";
import { useAccessRequests, useDecideAccessRequest } from "@/ui/hooks/useAccessRequests";
import { useDelayedFlag } from "@/ui/hooks/useDelayedFlag";
import {
  ACCESS_FILTER_LABELS,
  ACCESS_FILTER_STATUSES,
  ACCESS_ROLE_LABELS,
  accessRequestDisplayName,
  accessSearchParams,
  parseAccessFilterStatus,
  type AccessDecision,
  type AccessFilterStatus,
  type AccessRequest,
  type AccessRole,
} from "@/ui/schemas/access-request.schema";

/**
 * "Quyền truy cập" (E10): who may sign in to this tenant, and who is waiting.
 *
 * Until now the allow-list lived in env vars, so adding a colleague meant
 * editing `.env` and restarting a container. Here the list is data: an unknown
 * account that signs in leaves a `pending` request, and an admin decides on
 * this screen.
 *
 * Frame (`astryx docs layout`, tracker archetype): header carries the title and
 * the filter, the content region carries the rows edge-to-edge.
 *
 * The filter lives in the URL (core-data-list-query rule 1): `/access?status=
 * blocked` is shareable, survives F5 and makes Back behave. One builder writes
 * it, one parser reads it, and the query key is derived from the same value.
 * The default ("chờ duyệt") is NOT written to the URL.
 *
 * The four mandatory states live in `AccessRequestsBody`:
 *   loading — skeleton with the real columns, delayed 300ms
 *   data    — one row per request, each with duyệt / chặn behind a confirmation
 *   empty   — told apart on purpose: "không có ai chờ duyệt" (good news, the
 *             queue is clear) is a different sentence from "chưa có yêu cầu
 *             nào" (nobody has ever tried to sign in). One box for both would
 *             make an admin think the list was lost
 *   error   — 4xx (không thử lại được) vs 5xx (thử lại), via `presentApiError`
 */
export function AccessRequestsScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const status = useMemo(
    () => parseAccessFilterStatus(new URLSearchParams(searchParams.toString())),
    [searchParams],
  );

  const requests = useAccessRequests(status);
  const decide = useDecideAccessRequest();

  /** What the last decision did — announced, and shown as a banner. */
  const [outcome, setOutcome] = useState<string | null>(null);

  const items = requests.data?.items ?? [];
  const isFirstLoad = requests.isPending && requests.fetchStatus === "fetching";
  const showSkeleton = useDelayedFlag(isFirstLoad);

  const busyId = decide.isPending ? (decide.variables?.id ?? null) : null;

  const selectStatus = useCallback(
    (value: string) => {
      const next = value as AccessFilterStatus;
      const query = accessSearchParams(next).toString();
      // `replace`: switching a filter is not a navigation step to walk back to.
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router],
  );

  function handleDecide(request: AccessRequest, decision: AccessDecision, role: AccessRole) {
    const name = accessRequestDisplayName(request);
    setOutcome(null);
    decide.reset();
    decide.mutate(
      { id: request.id, decision, role },
      {
        onSuccess: (result) => {
          // The server's answer wins over what we sent: if it granted a
          // different role, that is the one now in force.
          const grantedRole = result.role ?? role;
          setOutcome(
            result.status === "approved"
              ? `Đã duyệt ${name} với vai trò ${ACCESS_ROLE_LABELS[grantedRole]}.`
              : `Đã chặn ${name}. Tài khoản này không đăng nhập được nữa.`,
          );
        },
      },
    );
  }

  return (
    <Layout
      height="fill"
      header={
        <LayoutHeader hasDivider>
          <Stack direction="vertical" gap={3} padding={4}>
            <Stack direction="vertical" gap={1}>
              <Heading level={1}>Quyền truy cập</Heading>
              <Text type="supporting">
                Ai được vào hệ thống. Người lạ đăng nhập lần đầu sẽ tự nằm ở “Chờ duyệt” — không ai
                vào được cho tới khi bạn duyệt. Không cần sửa cấu hình máy chủ nữa.
              </Text>
            </Stack>

            <HStack gap={3} align="center" wrap="wrap">
              <SegmentedControl
                label="Lọc theo trạng thái yêu cầu"
                value={status}
                onChange={selectStatus}
                size="sm"
              >
                {ACCESS_FILTER_STATUSES.map((value) => (
                  <SegmentedControlItem
                    key={value}
                    value={value}
                    label={ACCESS_FILTER_LABELS[value]}
                  />
                ))}
              </SegmentedControl>

              <Button
                variant="secondary"
                size="sm"
                label={requests.isFetching ? "Đang tải…" : "Tải lại"}
                isDisabled={requests.isFetching}
                onClick={() => void requests.refetch()}
              />
            </HStack>
          </Stack>
        </LayoutHeader>
      }
      content={
        <LayoutContent padding={0} isScrollable>
          <Stack direction="vertical" height="100%">
            {/* The live region is ALWAYS mounted, empty most of the time: a
                region that appears together with its text is announced
                unreliably. Announced without stealing focus — the admin keeps
                working (web-feedback-states §4). */}
            <Stack
              direction="vertical"
              role="status"
              aria-live="polite"
              paddingInline={4}
              paddingBlock={outcome ? 3 : 0}
            >
              {outcome ? (
                <Banner
                  status="success"
                  isDismissable
                  onDismiss={() => setOutcome(null)}
                  title="Đã lưu quyết định"
                  description={outcome}
                />
              ) : null}
            </Stack>

            {decide.isError ? (
              <Stack direction="vertical" paddingInline={4} paddingBlock={3}>
                {/* No retry button here on purpose: the same click is one row
                    away, and a blind "thử lại" on a decision is how an account
                    gets blocked twice. */}
                <ApiErrorNotice error={decide.error} />
              </Stack>
            ) : null}

            <HStack gap={3} paddingInline={4} paddingBlock={3} align="center" wrap="wrap">
              <Heading level={2}>Danh sách yêu cầu</Heading>
              {/* Only once the list is real: "0 yêu cầu" while loading reads as
                  an answer, and an admin would act on it. */}
              {requests.data ? (
                <Text type="supporting" role="status" aria-live="polite">
                  {items.length} yêu cầu · {ACCESS_FILTER_LABELS[status].toLowerCase()}
                </Text>
              ) : null}
            </HStack>

            <StackItem size="fill">
              <AccessRequestsBody
                status={status}
                isFirstLoad={isFirstLoad}
                showSkeleton={showSkeleton}
                isError={requests.isError}
                error={requests.error}
                onRetry={() => void requests.refetch()}
                onShowAll={() => selectStatus("all")}
                items={items}
                busyId={busyId}
                onDecide={handleDecide}
              />
            </StackItem>
          </Stack>
        </LayoutContent>
      }
    />
  );
}

function AccessRequestsBody({
  status,
  isFirstLoad,
  showSkeleton,
  isError,
  error,
  onRetry,
  onShowAll,
  items,
  busyId,
  onDecide,
}: {
  status: AccessFilterStatus;
  isFirstLoad: boolean;
  showSkeleton: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
  onShowAll: () => void;
  items: readonly AccessRequest[];
  busyId: string | null;
  onDecide: (request: AccessRequest, decision: AccessDecision, role: AccessRole) => void;
}) {
  // --- Loading (delayed so a fast answer does not flash) -------------------
  if (isFirstLoad) return showSkeleton ? <AccessRequestTableSkeleton /> : null;

  // --- Error, with nothing to fall back on ---------------------------------
  if (isError && items.length === 0) {
    return (
      <Stack direction="vertical" padding={4}>
        <ApiErrorNotice error={error} onRetry={onRetry} />
      </Stack>
    );
  }

  // --- Empty: three different situations, three different sentences ---------
  if (items.length === 0) {
    if (status === "pending") {
      // Good news, not a problem: the queue is clear. No primary CTA — there is
      // nothing to do (core-feedback-states §Empty, kind "done").
      return (
        <Stack direction="vertical" padding={4}>
          <EmptyState
            headingLevel={3}
            title="Không có ai chờ duyệt"
            description="Mọi yêu cầu truy cập đều đã được xử lý. Khi có người lạ đăng nhập lần đầu, tên họ sẽ xuất hiện ở đây."
            actions={
              <Button variant="secondary" label="Xem tất cả yêu cầu" onClick={onShowAll} />
            }
          />
        </Stack>
      );
    }

    if (status === "all") {
      return (
        <Stack direction="vertical" padding={4}>
          <EmptyState
            headingLevel={3}
            title="Chưa có yêu cầu nào"
            description="Chưa ai từng đăng nhập vào đơn vị này ngoài những người đã được cấp quyền sẵn. Yêu cầu được tạo tự động ở lần đăng nhập đầu tiên — bạn không phải thêm tay."
          />
        </Stack>
      );
    }

    // Filtered out, not lost: the data may well exist under another filter.
    return (
      <Stack direction="vertical" padding={4}>
        <EmptyState
          headingLevel={3}
          title={`Không có yêu cầu nào ở trạng thái “${ACCESS_FILTER_LABELS[status]}”`}
          description="Dữ liệu vẫn còn nguyên — chỉ là không có ai ở trạng thái đang lọc. Xem tất cả để đối chiếu."
          actions={<Button variant="secondary" label="Xem tất cả yêu cầu" onClick={onShowAll} />}
        />
      </Stack>
    );
  }

  // --- Data, possibly STALE -------------------------------------------------
  // The dangerous case: a refetch failed while rows from an earlier answer are
  // still on screen. Hiding that would let an admin approve against a list the
  // server no longer agrees with. The rows stay (still the best information we
  // have) and the failure is said out loud, with a way to try again.
  return (
    <Stack direction="vertical" height="100%">
      {isError ? (
        <Stack direction="vertical" paddingInline={4} paddingBlock={3}>
          <Banner
            status="warning"
            title="Danh sách bên dưới có thể đã cũ — chưa làm mới được"
            description={`${presentApiError(toApiError(error)).description} Những gì đang hiện là kết quả của lần tải gần nhất; hãy thử lại trước khi duyệt ai.`}
            endContent={<Button variant="secondary" size="sm" label="Thử lại" onClick={onRetry} />}
          />
        </Stack>
      ) : null}

      <StackItem size="fill">
        <AccessRequestTable items={items} busyId={busyId} onDecide={onDecide} />
      </StackItem>
    </Stack>
  );
}
