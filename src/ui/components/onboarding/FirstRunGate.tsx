"use client";

import { Heading, Stack, Text } from "@astryxdesign/core";
import { useRouter } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { useOnboardingEntry } from "@/ui/hooks/useOnboardingProfile";
import { useEnsureDefaultTenant } from "@/ui/hooks/useTenantOnboarding";

/**
 * The door into the app for an account that has not been through onboarding.
 *
 * Two things happen here and nowhere else:
 *   1. AN ACCOUNT THAT BELONGS NOWHERE GETS A COMPANY. Provisioning is lazy
 *      (`POST /api/tenants/ensure-default`), so the "tạo công ty" screen never
 *      appears. It runs BEFORE the survey — the survey describes a company, and
 *      the three verbs behind it are tenant-scoped.
 *   2. AN UNFINISHED SURVEY IS RESUMED. `completed_at` is the only thing that
 *      decides it (spec §8): every question may legitimately be skipped, so
 *      "all four answered" is not the test, and neither is "sellerKind is set".
 *
 * The rule itself lives in `decideOnboardingEntry` (pure, tested); this file
 * only carries it out. Anyone whose answer is "app" — editors, support
 * sessions, bootstrap admins, tenants that already finished — falls straight
 * through and never notices this component exists.
 *
 * LATCHED, not derived, both times. Provisioning ends in `useAdoptActiveTenant`
 * and the redirect ends on another route, so a decision that flips as a result
 * of its own success must not fire twice: the account gains a membership the
 * instant `ensure-default` returns, and a second `router.replace` would land on
 * top of the navigation already in flight.
 *
 * `replace`, not `push`: the empty overview behind is not worth a history
 * entry, and Back out of onboarding must not land on an app where every API
 * answers 409.
 *
 * In effects rather than during render: navigating and posting are side
 * effects, and React refuses a router call made while rendering. One frame of
 * the bare overview is the cost, and it is cheap — with no active company
 * `useActiveTenant().isResolved` is false, so that frame is an empty shell.
 */
export function FirstRunGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { decision } = useOnboardingEntry();
  const ensureDefault = useEnsureDefaultTenant();
  const { mutate: provision } = ensureDefault;

  /**
   * The latches. Refs and not state on purpose: they are never read while
   * rendering — nothing on screen changes because of them — so holding them in
   * state would only buy a second render, and setting state inside an effect is
   * the cascading-render pattern `react-hooks/set-state-in-effect` rejects.
   */
  const hasProvisioned = useRef(false);
  const hasRedirected = useRef(false);

  useEffect(() => {
    if (decision !== "provision" || hasProvisioned.current) return;
    hasProvisioned.current = true;
    // Errors are NOT swallowed: the mutation keeps them, and the branch below
    // renders them instead of an app this account cannot use.
    provision();
  }, [decision, provision]);

  useEffect(() => {
    if (decision !== "onboard" || hasRedirected.current) return;
    hasRedirected.current = true;
    router.replace("/onboarding");
  }, [decision, router]);

  /**
   * Provisioning failed. This is the ONE state where falling through would be
   * dishonest: the account still belongs to no company, so every screen below
   * would answer 409 and the operator would be left clicking a dead app with no
   * idea why. `ApiErrorNotice` decides whether a retry can succeed.
   */
  if (ensureDefault.isError) {
    return (
      <Stack direction="vertical" gap={3} padding={4}>
        <Heading level={1}>Chưa mở được không gian làm việc</Heading>
        <Text type="supporting">
          Tài khoản của bạn chưa thuộc công ty nào, và hệ thống chưa tạo được công ty đầu tiên. Chưa
          dùng được màn hình nào cho tới khi việc này xong.
        </Text>
        <ApiErrorNotice error={ensureDefault.error} onRetry={() => provision()} />
      </Stack>
    );
  }

  return <>{children}</>;
}
