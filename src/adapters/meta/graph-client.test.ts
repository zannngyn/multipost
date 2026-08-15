import { describe, expect, it } from "vitest";

import { AppError } from "@/core/domain/errors";
import type { LogBindings, LogContext, Logger } from "@/core/ports/infra";

import { ALLOWED_UPLOAD_HOSTS, makeGraphClient } from "./graph-client";

/**
 * The transport's two safety rules, which no test held before:
 *   1. `postAbsolute` sends a Page token ONLY to a host we named ourselves —
 *      the URL comes from Graph's own answer, so whoever shapes that answer
 *      would otherwise choose where the token goes;
 *   2. a non-JSON answer never puts credentials in the log through
 *      `body_preview` (GET carries them in the URL, uploads in a header).
 */

const PAGE_TOKEN = "PAGE-TOKEN-SECRET";
const UPLOAD_URL = "https://rupload.facebook.com/video-upload/v23.0/vid-1";

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

function harness(answer: { status?: number; body?: unknown; text?: string } = { body: {} }) {
  const lines: LogLine[] = [];
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
    calls.push(String(input));
    return new Response(answer.text ?? JSON.stringify(answer.body ?? {}), {
      status: answer.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const client = makeGraphClient({ logger: recordingLogger(lines), fetchImpl });
  return { client, calls, lines };
}

async function expectAppError(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(() => null).catch((e: unknown) => e);
  expect(AppError.is(error)).toBe(true);
  return error as AppError;
}

// --- Edge cases first -------------------------------------------------------

describe("postAbsolute — where the Page token is allowed to go", () => {
  it("refuses a host outside the allowlist and sends NOTHING", async () => {
    const { client, calls, lines } = harness();

    const error = await expectAppError(
      client.postAbsolute({
        url: "https://evil.example.com/video-upload/vid-1",
        headers: { Authorization: `OAuth ${PAGE_TOKEN}` },
        context: { step: "reels.upload" },
      }),
    );

    expect(error.code).toBe("UPLOAD_HOST_NOT_ALLOWED");
    expect(error.context).toMatchObject({
      host: "evil.example.com",
      reason: "UPLOAD_HOST_NOT_ALLOWED",
      retryable: false,
    });
    // The request must never have left.
    expect(calls).toEqual([]);
    // The refusal is visible, and names the host without leaking the token.
    const refusal = lines.find((line) => line.level === "error");
    expect(refusal?.context).toMatchObject({ host: "evil.example.com" });
    expect(JSON.stringify(lines)).not.toContain(PAGE_TOKEN);
  });

  it("is not fooled by a userinfo prefix that only LOOKS like the upload host", async () => {
    const { client, calls } = harness();

    const error = await expectAppError(
      client.postAbsolute({
        // Real host here is evil.example — a substring check would pass this.
        url: "https://rupload.facebook.com@evil.example/video-upload/vid-1",
        headers: { Authorization: `OAuth ${PAGE_TOKEN}` },
      }),
    );

    expect(error.code).toBe("UPLOAD_HOST_NOT_ALLOWED");
    expect(error.context).toMatchObject({ host: "evil.example" });
    expect(calls).toEqual([]);
  });

  it("still refuses a non-https or empty URL before anything else", async () => {
    const { client, calls } = harness();
    await expect(
      client.postAbsolute({ url: "http://rupload.facebook.com/x", headers: {} }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(client.postAbsolute({ url: "", headers: {} })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(calls).toEqual([]);
  });

  it("never logs the echoed body of an upload — the token is in a header", async () => {
    const { client, lines } = harness({
      status: 502,
      text: `<html>Bad gateway. Request headers: Authorization: OAuth ${PAGE_TOKEN}</html>`,
    });

    const error = await expectAppError(
      client.postAbsolute({
        url: UPLOAD_URL,
        headers: { Authorization: `OAuth ${PAGE_TOKEN}` },
      }),
    );

    expect(error.context).not.toHaveProperty("body_preview");
    expect(error.context).toMatchObject({ body_preview_omitted: expect.any(String) });
    expect(JSON.stringify(error.context)).not.toContain(PAGE_TOKEN);
    expect(JSON.stringify(lines)).not.toContain(PAGE_TOKEN);
  });
});

// --- Happy path -------------------------------------------------------------

describe("postAbsolute — the allowed host", () => {
  it("posts to rupload.facebook.com with the headers it was given", async () => {
    expect(ALLOWED_UPLOAD_HOSTS).toEqual(["rupload.facebook.com"]);
    const { client, calls } = harness({ body: { success: true } });

    const result = await client.postAbsolute({
      url: UPLOAD_URL,
      headers: { Authorization: `OAuth ${PAGE_TOKEN}`, file_url: "https://mysp.example.com/v.mp4" },
      context: { step: "reels.upload" },
    });

    expect(result).toEqual({ success: true });
    expect(calls).toEqual([UPLOAD_URL]);
  });

  it("treats an EMPTY body from the upload host as success (it answers nothing)", async () => {
    const { client } = harness({ text: "" });
    expect(await client.postAbsolute({ url: UPLOAD_URL, headers: {} })).toEqual({});
  });
});

describe("get — credentials live in the URL, so no body preview ever", () => {
  it("omits the preview and keeps the query string out of the error", async () => {
    const { client } = harness({ status: 500, text: "<html>oops ?access_token=SECRET-IN-URL</html>" });

    const error = await expectAppError(
      client.get({ path: "me/accounts", accessToken: "SECRET-IN-URL" }),
    );

    expect(error.context).not.toHaveProperty("body_preview");
    expect(JSON.stringify(error.context)).not.toContain("SECRET-IN-URL");
  });

  it("keeps the preview for a POST, where the credential is in the form body", async () => {
    const { client } = harness({ status: 500, text: "<html>upstream said no</html>" });

    const error = await expectAppError(
      client.post({ path: "123/photos", params: {}, accessToken: PAGE_TOKEN }),
    );

    expect(error.context).toMatchObject({ body_preview: "<html>upstream said no</html>" });
  });
});
