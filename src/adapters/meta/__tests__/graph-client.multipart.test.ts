import { describe, expect, it } from "vitest";

import { AppError } from "@/core/domain/errors";
import type { LogBindings, LogContext, Logger } from "@/core/ports/infra";

import { makeGraphClient } from "../graph-client";

/**
 * The multipart transport — the fix for Graph 324.
 *
 * Measured, not theoretical: a `url=` photo makes Facebook fetch the file itself
 * and abandon it around 30s (4 of 10 photos accepted on a real post, three hangs
 * of 29.5s). Uploading the same 10 files as multipart `source` put 10/10 on the
 * Page. These tests hold the parts of that contract we control: the bytes go in
 * the body, the token goes in the body and never in the URL or a log, and an
 * upload gets a bigger budget than a form POST.
 */

const PAGE_TOKEN = "PAGE-TOKEN-SECRET";
const PIXEL = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9]);

interface LogLine {
  level: string;
  message: string;
  context?: LogContext;
}

function recordingLogger(lines: LogLine[]): Logger {
  const make = (): Logger => ({
    child: (_bindings: LogBindings) => make(),
    debug: (message, context) => lines.push({ level: "debug", message, context }),
    info: (message, context) => lines.push({ level: "info", message, context }),
    warn: (message, context) => lines.push({ level: "warn", message, context }),
    error: (message, context) => lines.push({ level: "error", message, context }),
  });
  return make();
}

function harness(
  answer: { status?: number; body?: unknown } = { body: { id: "p1" } },
  options: { uploadTimeoutMs?: number } = {},
) {
  const lines: LogLine[] = [];
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requests.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(answer.body ?? {}), {
      status: answer.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const client = makeGraphClient({
    logger: recordingLogger(lines),
    fetchImpl,
    ...(options.uploadTimeoutMs ? { uploadTimeoutMs: options.uploadTimeoutMs } : {}),
  });
  return { client, requests, lines };
}

function part(overrides: Partial<{ field: string; fileName: string; bytes: Uint8Array; mimeType: string | null }> = {}) {
  return {
    field: "source",
    fileName: "1.jpg",
    bytes: PIXEL,
    mimeType: "image/jpeg" as string | null,
    ...overrides,
  };
}

async function expectAppError(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(() => null).catch((e: unknown) => e);
  expect(AppError.is(error)).toBe(true);
  return error as AppError;
}

// --- Edge cases first -------------------------------------------------------

describe("postMultipart — refused before anything leaves the process", () => {
  it("refuses a missing path or token", async () => {
    const { client, requests } = harness();

    await expect(
      client.postMultipart({ path: "  ", params: {}, files: [part()], accessToken: PAGE_TOKEN }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      client.postMultipart({ path: "1/photos", params: {}, files: [part()], accessToken: "  " }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { has_token: false } });
    expect(requests).toHaveLength(0);
  });

  it("refuses a call with no file part, and a part with no bytes", async () => {
    const { client, requests } = harness();

    await expect(
      client.postMultipart({ path: "1/photos", params: {}, files: [], accessToken: PAGE_TOKEN }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { reason: "NO_FILE_PART" } });
    await expect(
      client.postMultipart({
        path: "1/photos",
        params: {},
        files: [part({ fileName: "empty.jpg", bytes: new Uint8Array(0) })],
        accessToken: PAGE_TOKEN,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      context: { reason: "EMPTY_FILE_PART", file_name: "empty.jpg", retryable: false },
    });
    // Graph answers an empty part with an opaque "invalid image file"; refusing
    // here keeps the reason readable and saves a pointless round trip.
    expect(requests).toHaveLength(0);
  });

  it("maps a transport failure the same way the form POST does", async () => {
    const lines: LogLine[] = [];
    const fetchImpl = (async () => {
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;
    const client = makeGraphClient({ logger: recordingLogger(lines), fetchImpl });

    const error = await expectAppError(
      client.postMultipart({
        path: "555000111/photos",
        params: {},
        files: [part()],
        accessToken: PAGE_TOKEN,
      }),
    );

    expect(error.code).toBe("META_ERROR");
    expect(error.context).toMatchObject({
      path: "555000111/photos",
      upload_bytes: PIXEL.length,
    });
    expect(JSON.stringify(lines)).not.toContain(PAGE_TOKEN);
  });

  it("aborts an upload that outlives its budget", async () => {
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("The operation timed out")));
      })) as unknown as typeof fetch;
    const client = makeGraphClient({
      logger: recordingLogger([]),
      fetchImpl,
      uploadTimeoutMs: 20,
    });

    const error = await expectAppError(
      client.postMultipart({
        path: "1/photos",
        params: {},
        files: [part()],
        accessToken: PAGE_TOKEN,
      }),
    );
    expect(error.code).toBe("META_ERROR");
    expect(error.context).toMatchObject({ timeout_ms: 20 });
  });

  it("translates a Graph error body exactly like the form POST", async () => {
    const { client, lines } = harness({
      status: 400,
      body: { error: { code: 324, message: "Missing or invalid image file" } },
    });

    const error = await expectAppError(
      client.postMultipart({
        path: "555000111/photos",
        params: {},
        files: [part()],
        accessToken: PAGE_TOKEN,
      }),
    );

    expect(error.code).toBe("META_ERROR");
    expect(error.context).toMatchObject({ graph_code: 324 });
    expect(JSON.stringify(lines)).not.toContain(PAGE_TOKEN);
  });
});

// --- What actually goes on the wire -----------------------------------------

describe("postMultipart — the request", () => {
  it("sends the bytes as a file part, the token in the body, nothing in the URL", async () => {
    const { client, requests } = harness();

    await client.postMultipart({
      path: "555000111/photos",
      params: { published: "false", temporary: "true" },
      files: [part({ fileName: "MR (25).jpg" })],
      accessToken: PAGE_TOKEN,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://graph.facebook.com/v23.0/555000111/photos");
    expect(requests[0].url).not.toContain(PAGE_TOKEN);
    // No hand-written content-type: fetch must pick the multipart boundary.
    expect(requests[0].init.headers).toBeUndefined();

    const form = requests[0].init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("published")).toBe("false");
    expect(form.get("temporary")).toBe("true");
    expect(form.get("access_token")).toBe(PAGE_TOKEN);

    const file = form.get("source") as File;
    expect(file).toBeInstanceOf(Blob);
    expect(file.name).toBe("MR (25).jpg");
    expect(file.type).toBe("image/jpeg");
    expect(file.size).toBe(PIXEL.length);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PIXEL);
  });

  it("uploads a VIEW into a larger buffer without leaking the rest of it", async () => {
    const { client, requests } = harness();
    // Node hands out views like this when it slices a read buffer; sending the
    // view's whole backing buffer would upload someone else's bytes.
    const backing = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

    await client.postMultipart({
      path: "1/photos",
      params: {},
      files: [part({ fileName: "slice.jpg", bytes: backing.subarray(2, 5), mimeType: null })],
      accessToken: PAGE_TOKEN,
    });

    const file = (requests[0].init.body as FormData).get("source") as File;
    expect(file.size).toBe(3);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([3, 4, 5]));
    // No MIME from the source (606 real files have no extension): the honest
    // default, never a guessed image type.
    expect(file.type).toBe("application/octet-stream");
  });

  it("cannot have its token overwritten by a params entry", async () => {
    const { client, requests } = harness();

    await client.postMultipart({
      path: "1/photos",
      params: { access_token: "NOT-THE-REAL-ONE" },
      files: [part()],
      accessToken: PAGE_TOKEN,
    });

    expect((requests[0].init.body as FormData).get("access_token")).toBe(PAGE_TOKEN);
  });

  it("leaves the form-urlencoded POST untouched (other calls still use it)", async () => {
    const { client, requests } = harness({ body: { id: "1_2" } });

    await client.post({
      path: "555000111/feed",
      params: { message: "x" },
      accessToken: PAGE_TOKEN,
    });

    const init = requests[0].init as RequestInit & { headers: Record<string, string> };
    expect(init.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(init.body).toBeInstanceOf(URLSearchParams);
  });
});
