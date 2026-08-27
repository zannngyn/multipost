import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  COMPOSE_DRAFT_MAX_BYTES,
  COMPOSE_DRAFT_SCHEMA_VERSION,
  type ComposeDraftPayload,
} from "@/ui/schemas/post-draft.schema";

import {
  COMPOSE_DRAFT_BUFFER_TTL_MS,
  composeDraftBuffer,
  composeDraftBufferKey,
} from "../compose-draft-buffer";

/**
 * Edge cases first (CLAUDE.md technical rule 1): every way browser storage can
 * fail an operator — no storage at all, a zero quota, a corrupt entry, an entry
 * from another build, one that is a day old — then the round trip.
 *
 * The tests run in the `node` environment (vitest.config.ts), so there is no
 * `window` unless one is installed here. That is on purpose: it proves the SSR
 * guard, and it means the fake storage can be made to throw exactly the way
 * Safari private mode does.
 */

const TENANT = "00000000-0000-0000-0000-000000000001";
const OTHER_TENANT = "00000000-0000-0000-0000-000000000002";
/** Two operators on the SAME machine, as on a shared workstation. */
const OWNER_A = "a1b2c3d4e5f60718";
const OWNER_B = "ffffeeeeddddcccc";
const A = { tenantId: TENANT, ownerKey: OWNER_A } as const;
const B_SAME_MACHINE = { tenantId: TENANT, ownerKey: OWNER_B } as const;
const B_OTHER_TENANT = { tenantId: OTHER_TENANT, ownerKey: OWNER_A } as const;
const T0 = Date.parse("2026-08-17T03:00:00.000Z");

class FakeStorage implements Storage {
  private readonly entries = new Map<string, string>();
  /** Set to make `setItem` throw, the way a full or blocked store does. */
  setItemError: unknown = null;
  getItemError: unknown = null;
  removeItemError: unknown = null;

  get length(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  getItem(key: string): string | null {
    if (this.getItemError) throw this.getItemError;
    return this.entries.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    if (this.removeItemError) throw this.removeItemError;
    this.entries.delete(key);
  }

  setItem(key: string, value: string): void {
    if (this.setItemError) throw this.setItemError;
    this.entries.set(key, value);
  }

  /** Test-only: write a raw string without going through the buffer. */
  seed(key: string, value: string): void {
    this.entries.set(key, value);
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }
}

let storage: FakeStorage;

function installWindow(value: unknown): void {
  Object.defineProperty(globalThis, "window", {
    value,
    configurable: true,
    writable: true,
  });
}

function removeWindow(): void {
  Reflect.deleteProperty(globalThis, "window");
}

function payload(overrides: Partial<ComposeDraftPayload> = {}): ComposeDraftPayload {
  return {
    step: "caption",
    composeKey: "MGKVX6310|trắng|image|-",
    productCode: "MGKVX6310",
    color: "TRẮNG",
    mediaKind: "image",
    videoTarget: "facebook_video",
    source: "drive",
    captions: { facebook: "Áo dài trắng — mã MGKVX6310" },
    captionOverrides: {},
    albumOrder: ["drive-file-1", "drive-file-2"],
    selectedChannelIds: ["fanpage-a"],
    shareCaption: true,
    schedule: { mode: "now", value: "" },
    savedAt: "2026-08-17T03:00:00.000Z",
    ...overrides,
  };
}

function seedEntry(
  address: { tenantId: string; ownerKey: string },
  entry: { schemaVersion?: unknown; storedAt?: string; payload?: unknown },
): void {
  storage.seed(
    composeDraftBufferKey(address.tenantId, address.ownerKey),
    JSON.stringify({
      schemaVersion: entry.schemaVersion ?? COMPOSE_DRAFT_SCHEMA_VERSION,
      storedAt: entry.storedAt ?? new Date(T0).toISOString(),
      payload: entry.payload ?? payload(),
    }),
  );
}

beforeEach(() => {
  storage = new FakeStorage();
  installWindow({ localStorage: storage });
  // Failures are logged on purpose; the test output should not carry them.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  removeWindow();
});

describe("compose-draft-buffer — no storage available", () => {
  it("reads null and reports 'unavailable' when there is no window (SSR)", () => {
    removeWindow();
    expect(composeDraftBuffer.read(A, T0)).toBeNull();
    expect(composeDraftBuffer.write(A, payload())).toEqual({
      ok: false,
      reason: "unavailable",
      userMessage: expect.any(String),
    });
    expect(composeDraftBuffer.clear(A)).toMatchObject({ ok: false, reason: "unavailable" });
  });

  it("survives a browser that throws on touching localStorage at all", () => {
    installWindow({
      get localStorage(): Storage {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
    expect(composeDraftBuffer.read(A, T0)).toBeNull();
    expect(composeDraftBuffer.write(A, payload())).toMatchObject({ reason: "unavailable" });
    expect(console.warn).toHaveBeenCalled();
  });

  it("refuses to touch storage without a tenant id", () => {
    expect(composeDraftBuffer.read({ tenantId: "   ", ownerKey: OWNER_A })).toBeNull();
    expect(composeDraftBuffer.write({ tenantId: "", ownerKey: OWNER_A }, payload())).toMatchObject({ reason: "invalid-tenant" });
    expect(composeDraftBuffer.clear({ tenantId: "", ownerKey: OWNER_A })).toMatchObject({ reason: "invalid-tenant" });
    expect(storage.length).toBe(0);
  });
});

/**
 * The shared-workstation case. Two operators, one browser profile: the draft of
 * whoever signed in first must be unreachable to whoever signs in next, exactly
 * as the DB scopes its row by (tenant, owner, kind) — business rule 7.
 */
describe("compose-draft-buffer — one bucket per operator", () => {
  it("puts the owner in the key, next to the tenant", () => {
    expect(composeDraftBufferKey(TENANT, OWNER_A)).toBe(
      `mysp.compose.draft.v1:${TENANT}:${OWNER_A}`,
    );
    expect(composeDraftBufferKey(TENANT, OWNER_A)).not.toBe(
      composeDraftBufferKey(TENANT, OWNER_B),
    );
  });

  it("falls back to the anonymous bucket, which is a scope of its own", () => {
    expect(composeDraftBufferKey(TENANT, "")).toBe(`mysp.compose.draft.v1:${TENANT}:anon`);
    expect(composeDraftBufferKey(TENANT, "   ")).toBe(composeDraftBufferKey(TENANT, ""));
  });

  it("never hands operator A's draft to operator B on the same machine", () => {
    composeDraftBuffer.write(A, payload({ productCode: "MGK-A" }), T0);

    expect(composeDraftBuffer.read(B_SAME_MACHINE, T0)).toBeNull();
    expect(composeDraftBuffer.read({ tenantId: TENANT, ownerKey: "" }, T0)).toBeNull();
    // A's own draft is untouched by B looking for one.
    expect(composeDraftBuffer.read(A, T0)?.productCode).toBe("MGK-A");
  });

  it("keeps B's own draft separate when both operators use the machine", () => {
    composeDraftBuffer.write(A, payload({ productCode: "MGK-A" }), T0);
    composeDraftBuffer.write(B_SAME_MACHINE, payload({ productCode: "MGK-B" }), T0);

    expect(composeDraftBuffer.read(A, T0)?.productCode).toBe("MGK-A");
    expect(composeDraftBuffer.read(B_SAME_MACHINE, T0)?.productCode).toBe("MGK-B");

    composeDraftBuffer.clear(A);
    expect(composeDraftBuffer.read(A, T0)).toBeNull();
    expect(composeDraftBuffer.read(B_SAME_MACHINE, T0)?.productCode).toBe("MGK-B");
  });
});

describe("compose-draft-buffer — pending discard marker", () => {
  it("reports nothing when no cleanup ever failed", () => {
    expect(composeDraftBuffer.takePendingDiscard(A)).toBe(false);
  });

  it("is consumed exactly once, and only by its own owner", () => {
    expect(composeDraftBuffer.markPendingDiscard(A)).toEqual({ ok: true });

    expect(composeDraftBuffer.takePendingDiscard(B_SAME_MACHINE)).toBe(false);
    expect(composeDraftBuffer.takePendingDiscard(A)).toBe(true);
    // Consumed: a second mount must not delete a draft the operator has since
    // started building again.
    expect(composeDraftBuffer.takePendingDiscard(A)).toBe(false);
  });

  it("does not throw when storage refuses the marker", () => {
    storage.setItemError = new DOMException("full", "QuotaExceededError");
    expect(composeDraftBuffer.markPendingDiscard(A)).toMatchObject({ ok: false, reason: "quota" });
  });
});

describe("compose-draft-buffer — reading a broken entry", () => {
  it("returns null when nothing was ever written", () => {
    expect(composeDraftBuffer.read(A, T0)).toBeNull();
  });

  it("drops an entry that is not JSON instead of throwing", () => {
    storage.seed(composeDraftBufferKey(TENANT, OWNER_A), "{not json");
    expect(composeDraftBuffer.read(A, T0)).toBeNull();
    expect(storage.has(composeDraftBufferKey(TENANT, OWNER_A))).toBe(false);
    expect(console.warn).toHaveBeenCalled();
  });

  it("drops an entry written by another schema version", () => {
    seedEntry(A, { schemaVersion: 0 });
    expect(composeDraftBuffer.read(A, T0)).toBeNull();
    expect(storage.has(composeDraftBufferKey(TENANT, OWNER_A))).toBe(false);
  });

  it("ignores an entry parked under an older key, and leaves it alone", () => {
    storage.seed(`mysp.compose.draft.v0:${TENANT}`, JSON.stringify({ payload: payload() }));
    expect(composeDraftBuffer.read(A, T0)).toBeNull();
    expect(storage.has(`mysp.compose.draft.v0:${TENANT}`)).toBe(true);
  });

  it("drops an entry whose payload carries a forbidden field", () => {
    seedEntry(A, { payload: { ...payload(), stock: 0 } });
    expect(composeDraftBuffer.read(A, T0)).toBeNull();
    expect(storage.has(composeDraftBufferKey(TENANT, OWNER_A))).toBe(false);
  });

  it("drops an entry whose payload no longer matches the wizard", () => {
    seedEntry(A, { payload: { ...payload(), step: "duyet-anh" } });
    expect(composeDraftBuffer.read(A, T0)).toBeNull();
    expect(storage.has(composeDraftBufferKey(TENANT, OWNER_A))).toBe(false);
  });

  it("returns null when getItem itself throws", () => {
    seedEntry(A, {});
    storage.getItemError = new DOMException("blocked", "SecurityError");
    expect(composeDraftBuffer.read(A, T0)).toBeNull();
    expect(console.warn).toHaveBeenCalled();
  });
});

describe("compose-draft-buffer — TTL", () => {
  it("still returns a draft on the last millisecond of the window", () => {
    seedEntry(A, { storedAt: new Date(T0).toISOString() });
    expect(composeDraftBuffer.read(A, T0 + COMPOSE_DRAFT_BUFFER_TTL_MS)).not.toBeNull();
  });

  it("drops a draft older than 24h instead of offering yesterday's work back", () => {
    seedEntry(A, { storedAt: new Date(T0).toISOString() });
    expect(composeDraftBuffer.read(A, T0 + COMPOSE_DRAFT_BUFFER_TTL_MS + 1)).toBeNull();
    expect(storage.has(composeDraftBufferKey(TENANT, OWNER_A))).toBe(false);
  });

  it("drops an entry stamped in the future — a clock we cannot trust", () => {
    seedEntry(A, { storedAt: new Date(T0 + 60_000).toISOString() });
    expect(composeDraftBuffer.read(A, T0)).toBeNull();
    expect(storage.has(composeDraftBufferKey(TENANT, OWNER_A))).toBe(false);
  });

  it("drops an entry whose storedAt is not a date", () => {
    seedEntry(A, { storedAt: "hôm qua" });
    expect(composeDraftBuffer.read(A, T0)).toBeNull();
  });
});

describe("compose-draft-buffer — writing", () => {
  it("reports 'quota' and KEEPS the previous draft when the store is full", () => {
    expect(composeDraftBuffer.write(A, payload(), T0)).toEqual({ ok: true });

    storage.setItemError = new DOMException("exceeded the quota", "QuotaExceededError");
    const result = composeDraftBuffer.write(A, payload({ productCode: "MGK-NEW" }), T0);

    expect(result).toMatchObject({ ok: false, reason: "quota" });
    expect(console.warn).toHaveBeenCalled();
    // Losing the older draft as well would turn a failed save into lost work.
    expect(composeDraftBuffer.read(A, T0)?.productCode).toBe("MGKVX6310");
  });

  it("separates a quota error from any other storage failure", () => {
    storage.setItemError = new TypeError("storage is gone");
    expect(composeDraftBuffer.write(A, payload())).toMatchObject({
      ok: false,
      reason: "storage-error",
    });
  });

  it("refuses a payload carrying a forbidden field, and writes nothing", () => {
    const dirty = { ...payload(), stock: 0 } as unknown as ComposeDraftPayload;
    expect(composeDraftBuffer.write(A, dirty)).toMatchObject({
      ok: false,
      reason: "rejected",
    });
    expect(storage.length).toBe(0);
  });

  it("refuses a payload bigger than the server would accept", () => {
    const huge = payload({ captions: { facebook: "x".repeat(COMPOSE_DRAFT_MAX_BYTES) } });
    expect(composeDraftBuffer.write(A, huge)).toMatchObject({
      ok: false,
      reason: "too-large",
    });
    expect(storage.length).toBe(0);
  });
});

describe("compose-draft-buffer — happy path", () => {
  it("round-trips exactly what was written", () => {
    const draft = payload({
      step: "xem-lai",
      captionOverrides: { "fanpage-a": "Bản riêng cho fanpage A" },
      schedule: { mode: "scheduled", value: "2026-08-20T09:30" },
      shareCaption: false,
    });
    expect(composeDraftBuffer.write(A, draft, T0)).toEqual({ ok: true });
    expect(composeDraftBuffer.read(A, T0)).toEqual(draft);
  });

  it("uses its own clock, and a draft written now is readable now", () => {
    expect(composeDraftBuffer.write(A, payload())).toEqual({ ok: true });
    expect(composeDraftBuffer.read(A)).not.toBeNull();
  });

  it("keeps tenants apart", () => {
    composeDraftBuffer.write(A, payload({ productCode: "MGK-A" }), T0);
    composeDraftBuffer.write(B_OTHER_TENANT, payload({ productCode: "MGK-B" }), T0);

    expect(composeDraftBuffer.read(A, T0)?.productCode).toBe("MGK-A");
    expect(composeDraftBuffer.read(B_OTHER_TENANT, T0)?.productCode).toBe("MGK-B");

    expect(composeDraftBuffer.clear(A)).toEqual({ ok: true });
    expect(composeDraftBuffer.read(A, T0)).toBeNull();
    expect(composeDraftBuffer.read(B_OTHER_TENANT, T0)?.productCode).toBe("MGK-B");
  });

  it("reports a clear that could not happen instead of pretending it did", () => {
    composeDraftBuffer.write(A, payload(), T0);
    storage.removeItemError = new DOMException("blocked", "SecurityError");
    expect(composeDraftBuffer.clear(A)).toMatchObject({
      ok: false,
      reason: "storage-error",
    });
  });
});
