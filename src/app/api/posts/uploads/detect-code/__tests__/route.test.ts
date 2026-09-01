import { describe, expect, it, vi } from "vitest";

const detectUploadCode = vi.fn();
const requireTenantContext = vi.fn();

vi.mock("@/composition/container", async (importOriginal) => {
  // The real module is kept for MAX_UPLOADS_PER_POST, which this route reads
  // at import time to build the zod schema; only the container is swapped.
  const actual = await importOriginal<typeof import("@/composition/container")>();
  return {
    ...actual,
    getContainer: () => ({
      logger: { child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
      usecases: { detectUploadCode },
    }),
  };
});
vi.mock("@/app/api/_lib/require-tenant-context", () => ({ requireTenantContext }));

// Hoisted out of every `it()`: the route imports `@/composition/container`
// through `importOriginal`, so the first import pulls in the real container
// (drizzle, redis, bullmq, googleapis, ffprobe). Doing that once at module
// scope keeps the cost in the "collect" phase; doing it inside a test eats
// the 5s default test timeout on a loaded machine.
const { POST } = await import("../route");

const TENANT = "11111111-1111-4111-8111-111111111111";

function post(body: unknown): Request {
  return new Request("http://localhost/api/posts/uploads/detect-code", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/posts/uploads/detect-code", () => {
  it("authorises as editor at tier M before reading the body", async () => {
    requireTenantContext.mockResolvedValue({ ctx: { tenantId: TENANT }, session: { email: "a@b.c" } });
    detectUploadCode.mockResolvedValue({ verdict: { status: "no_code" }, files: [], warnings: [] });

    await POST(post({ files: [{ fileName: "x.png" }] }));

    expect(requireTenantContext).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tier: "M", minRole: "editor" }),
    );
  });

  it("passes the tenant from the session, never from the body", async () => {
    requireTenantContext.mockResolvedValue({ ctx: { tenantId: TENANT }, session: { email: "a@b.c" } });
    detectUploadCode.mockResolvedValue({
      verdict: { status: "matched", productCode: "BG0SQ6083" }, files: [], warnings: [],
    });

    const response = await POST(post({ tenantId: "22222222-2222-4222-8222-222222222222", files: [{ fileName: "BG0SQ6083-AI (1).png" }] }));

    expect(response.status).toBe(200);
    expect(detectUploadCode).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT }),
    );
  });

  it("rejects an empty file list with 400", async () => {
    requireTenantContext.mockResolvedValue({ ctx: { tenantId: TENANT }, session: { email: "a@b.c" } });

    const response = await POST(post({ files: [] }));

    expect(response.status).toBe(400);
  });

  it("rejects more than MAX_UPLOADS_PER_POST files with 400", async () => {
    requireTenantContext.mockResolvedValue({ ctx: { tenantId: TENANT }, session: { email: "a@b.c" } });

    const files = Array.from({ length: 11 }, (_, index) => ({ fileName: `file-${index}.png` }));
    const response = await POST(post({ files }));

    expect(response.status).toBe(400);
    expect(detectUploadCode).not.toHaveBeenCalled();
  });
});
