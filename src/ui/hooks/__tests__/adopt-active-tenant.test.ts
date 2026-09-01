import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { adoptActiveTenantCache } from "@/ui/hooks/adopt-active-tenant";
import type { MeResponse } from "@/ui/schemas/me.schema";
import { ApiError } from "@/ui/services/api-error";
import { fetchMe, meKeys } from "@/ui/services/me.api";

/**
 * The cache half of "I am now in a different company".
 *
 * WHY THIS FILE EXISTS: the first version of this rule shipped a bug that no
 * type, lint or unit test could see. `removeQueries()` DETACHES the observers
 * mounted on the query it removes; the `fetchQuery` that followed built a new
 * query object nobody was subscribed to. A brand-new account was provisioned a
 * company (`ensure-default` → 201) and the tree went on rendering "member of
 * nothing" — so `/onboarding` was never reached and the welcome screen was
 * missed for good, that account only having one first run.
 *
 * The assertions below are therefore about OBSERVERS, not about cache entries:
 * "the data changed" was already true in the broken version. What was not true
 * is that anything already on screen got told.
 *
 * No DOM: vitest runs `environment: "node"` here, and `QueryObserver` is what
 * `useQuery` mounts underneath, so this reproduces the real mechanism rather
 * than a mock of it.
 */

vi.mock("@/ui/services/me.api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/ui/services/me.api")>();
  return { ...actual, fetchMe: vi.fn() };
});

const fetchMeMock = vi.mocked(fetchMe);

function session(tenantIds: readonly string[]): MeResponse {
  return {
    account: { id: "acc-1", displayName: "Chị Vân", platformRole: null },
    tenants: tenantIds.map((id) => ({
      id,
      name: `Công ty ${id}`,
      slug: null,
      plan: "free",
      role: "owner" as const,
    })),
    activeTenantId: tenantIds[0] ?? null,
    isBootstrapAdmin: false,
    supportSession: null,
  };
}

/** A client with no retries — a failing test must fail now, not in 30 seconds. */
function newClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** What `useMe()` mounts: one subscribed observer on the identity query. */
function mountIdentityObserver(queryClient: QueryClient) {
  const observer = new QueryObserver<MeResponse, ApiError>(queryClient, {
    queryKey: meKeys.me(),
    queryFn: ({ signal }) => fetchMe(signal),
    staleTime: 60_000,
  });
  const unsubscribe = observer.subscribe(() => {});
  return { observer, unsubscribe };
}

beforeEach(() => {
  fetchMeMock.mockReset();
});

describe("adoptActiveTenantCache", () => {
  it("hands the new session to an identity observer that is already mounted", async () => {
    // The exact shape of the bug: signed in, member of nothing, then given a
    // company. Nothing re-renders in between — `setOptions` is never called.
    fetchMeMock.mockResolvedValueOnce(session([])).mockResolvedValueOnce(session(["t-new"]));

    const queryClient = newClient();
    const { observer, unsubscribe } = mountIdentityObserver(queryClient);
    await vi.waitFor(() => expect(observer.getCurrentResult().data).toStrictEqual(session([])));

    await adoptActiveTenantCache(queryClient);

    await vi.waitFor(() =>
      expect(observer.getCurrentResult().data).toStrictEqual(session(["t-new"])),
    );
    expect(observer.getCurrentResult().data?.tenants).toHaveLength(1);
    unsubscribe();
  });

  it("clears the identity data while the new session is on its way", async () => {
    // Not `invalidateQueries`: that keeps the previous company on screen during
    // the refetch, which is the leak, not a nicety.
    fetchMeMock.mockResolvedValueOnce(session(["t-old"]));
    const queryClient = newClient();
    const { observer, unsubscribe } = mountIdentityObserver(queryClient);
    await vi.waitFor(() => expect(observer.getCurrentResult().data).toBeDefined());

    let dataDuringSwitch: MeResponse | undefined = session(["t-old"]);
    fetchMeMock.mockImplementationOnce(async () => {
      dataDuringSwitch = observer.getCurrentResult().data;
      return session(["t-new"]);
    });

    await adoptActiveTenantCache(queryClient);

    expect(dataDuringSwitch).toBeUndefined();
    unsubscribe();
  });

  it("drops the rows of the company being left", async () => {
    fetchMeMock.mockResolvedValue(session(["t-new"]));
    const queryClient = newClient();
    queryClient.setQueryData(["products", "t-old"], [{ id: "p1" }]);
    queryClient.setQueryData(["channels", "t-old"], [{ id: "c1" }]);

    await adoptActiveTenantCache(queryClient);

    expect(queryClient.getQueryData(["products", "t-old"])).toBeUndefined();
    expect(queryClient.getQueryData(["channels", "t-old"])).toBeUndefined();
  });

  it("does not refetch a company-scoped query under the key of the company being left", async () => {
    // Guards against "just use resetQueries() for everything": a reset refetches
    // ACTIVE queries, whose keys still carry the previous `tenantKey`, while the
    // cookie already points at the new company — company B's rows would be
    // stored under company A's key and served on the way back.
    fetchMeMock.mockResolvedValue(session(["t-new"]));
    const queryClient = newClient();
    const productsFn = vi.fn().mockResolvedValue([{ id: "p1" }]);
    const products = new QueryObserver(queryClient, {
      queryKey: ["products", "t-old"],
      queryFn: productsFn,
      staleTime: 60_000,
    });
    // Subscribed for the whole test: an UNsubscribed observer is inactive, and
    // "inactive queries are not refetched" would prove nothing.
    products.subscribe(() => {});
    await vi.waitFor(() => expect(productsFn).toHaveBeenCalledTimes(1));

    await adoptActiveTenantCache(queryClient);

    expect(productsFn).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(["products", "t-old"])).toBeUndefined();
  });

  it("still leaves a fresh session in the cache when no screen is observing it", async () => {
    // `/join/<token>` renders outside the app shell, so the reset has nobody to
    // refetch for; the screen it navigates into must not start from empty.
    fetchMeMock.mockResolvedValue(session(["t-new"]));
    const queryClient = newClient();

    await adoptActiveTenantCache(queryClient);

    expect(queryClient.getQueryData(meKeys.me())).toStrictEqual(session(["t-new"]));
    expect(fetchMeMock).toHaveBeenCalledTimes(1);
  });

  it("fetches the session exactly once when a screen IS observing it", async () => {
    fetchMeMock.mockResolvedValueOnce(session([])).mockResolvedValueOnce(session(["t-new"]));
    const queryClient = newClient();
    const { unsubscribe } = mountIdentityObserver(queryClient);
    await vi.waitFor(() => expect(fetchMeMock).toHaveBeenCalledTimes(1));

    await adoptActiveTenantCache(queryClient);

    expect(fetchMeMock).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("rejects instead of pretending the switch worked when the session cannot be re-read", async () => {
    // The caller is a mutation's `onSuccess`; a swallowed failure here would
    // leave the operator in an app that answers 409 to everything with no idea
    // why (CLAUDE.md rule 5).
    const failure = new ApiError({
      code: "INTERNAL",
      status: 500,
      message: "identity read failed",
      userMessage: "Không đọc được phiên làm việc.",
    });
    fetchMeMock.mockRejectedValue(failure);
    const queryClient = newClient();

    await expect(adoptActiveTenantCache(queryClient)).rejects.toBe(failure);
  });
});
