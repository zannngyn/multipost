import { randomBytes } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { Logger } from "@/core/ports/infra";

import {
  SECRET_ENVELOPE_PREFIX,
  findPlaintextSecretFields,
  isSealedSecret,
  isSecretFieldName,
  makeSecretBox,
  openConfigSecrets,
  sealConfigSecrets,
  secretsEqual,
  type SecretBox,
} from "./secret-box";

/**
 * Edge cases first: a wrong key, a tampered envelope and a missing key are the
 * three ways this box can betray a Page token. The legacy passthrough is tested
 * as loudly as the crypto — it is the migration path, not an accident.
 */

const KEY = randomBytes(32).toString("base64");
const OTHER_KEY = randomBytes(32).toString("base64");
const TOKEN = "EAAG7ZBv1exampleP4geAccessToken0000";

function makeLogger(): Logger & { warns: Array<{ message: string; context?: unknown }> } {
  const warns: Array<{ message: string; context?: unknown }> = [];
  const logger = {
    warns,
    child: () => logger,
    debug: vi.fn(),
    info: vi.fn(),
    warn: (message: string, context?: unknown) => warns.push({ message, context }),
    error: vi.fn(),
  } as unknown as Logger & { warns: typeof warns };
  return logger;
}

/** `null` = TENANT_SECRETS_ENC_KEY is not set at all. */
function box(key: string | null = KEY): SecretBox & { logger: ReturnType<typeof makeLogger> } {
  const logger = makeLogger();
  const readKey = () => key ?? undefined;
  return Object.assign(makeSecretBox({ logger, readKey }), { logger });
}

describe("makeSecretBox — key handling", () => {
  it("does not read the key at construction (a process that never seals still boots)", () => {
    const readKey = vi.fn(() => undefined);
    expect(() => makeSecretBox({ logger: makeLogger(), readKey })).not.toThrow();
    expect(readKey).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", null],
    ["empty", "   "],
    ["too short", randomBytes(16).toString("base64")],
    ["too long", randomBytes(64).toString("base64")],
    ["not base64", "not-a-base64-key!!!!"],
  ])("fails with INVALID_INPUT when the key is %s — at use, not at boot", (_label, key) => {
    expect(() => box(key).sealSecret(TOKEN)).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("never puts the key or the plaintext into the error context", () => {
    const error = (() => {
      try {
        box("short").sealSecret(TOKEN);
        return null;
      } catch (caught) {
        return caught as { context: Record<string, unknown>; message: string };
      }
    })();

    const serialised = JSON.stringify(error);
    expect(serialised).not.toContain(TOKEN);
    expect(serialised).not.toContain("short");
    expect(error?.context).toMatchObject({ scope: "secrets" });
  });
});

describe("makeSecretBox — seal/open", () => {
  it("refuses to seal an empty value", () => {
    expect(() => box().sealSecret("")).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("refuses to seal an already sealed value (double encryption is a bug)", () => {
    const b = box();
    expect(() => b.sealSecret(b.sealSecret(TOKEN))).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("refuses to open an empty value", () => {
    expect(() => box().openSecret("")).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("round-trips a Page token and leaves no plaintext in the envelope", () => {
    const b = box();
    const sealed = b.sealSecret(TOKEN);

    expect(sealed.startsWith(SECRET_ENVELOPE_PREFIX)).toBe(true);
    expect(sealed).not.toContain(TOKEN);
    expect(sealed.split(":")).toHaveLength(5);
    expect(b.openSecret(sealed)).toBe(TOKEN);
    expect(secretsEqual(b.openSecret(sealed), TOKEN)).toBe(true);
  });

  it("produces a different envelope every time (fresh IV, no ciphertext equality oracle)", () => {
    const b = box();
    expect(b.sealSecret(TOKEN)).not.toBe(b.sealSecret(TOKEN));
  });

  it("fails to open a value sealed with another key", () => {
    const sealed = box(KEY).sealSecret(TOKEN);
    const error = (() => {
      try {
        box(OTHER_KEY).openSecret(sealed);
        return null;
      } catch (caught) {
        return caught as { code: string; context: Record<string, unknown> };
      }
    })();

    expect(error?.code).toBe("INVALID_INPUT");
    expect(error?.context).toMatchObject({ scope: "secrets", reason: "DECRYPT_FAILED" });
  });

  it("fails to open an envelope whose auth tag was tampered with", () => {
    const b = box();
    const [, , iv, tag, ciphertext] = b.sealSecret(TOKEN).split(":");
    const flipped = Buffer.from(tag, "base64");
    flipped[0] ^= 0xff;
    const tampered = `${SECRET_ENVELOPE_PREFIX}${iv}:${flipped.toString("base64")}:${ciphertext}`;

    expect(() => b.openSecret(tampered)).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("fails to open an envelope whose ciphertext was tampered with", () => {
    const b = box();
    const [, , iv, tag, ciphertext] = b.sealSecret(TOKEN).split(":");
    const flipped = Buffer.from(ciphertext, "base64");
    flipped[0] ^= 0xff;
    const tampered = `${SECRET_ENVELOPE_PREFIX}${iv}:${tag}:${flipped.toString("base64")}`;

    expect(() => b.openSecret(tampered)).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it.each([
    ["too few parts", `${SECRET_ENVELOPE_PREFIX}onlyone:two`],
    ["an iv of the wrong length", `${SECRET_ENVELOPE_PREFIX}AAAA:${"A".repeat(24)}:AAAA`],
  ])("rejects a malformed envelope (%s)", (_label, value) => {
    const error = (() => {
      try {
        box().openSecret(value);
        return null;
      } catch (caught) {
        return caught as { context: Record<string, unknown> };
      }
    })();
    expect(error?.context).toMatchObject({ reason: "MALFORMED_ENVELOPE" });
  });

  it("passes a legacy plaintext value through WITH a warning, so it stays visible", () => {
    const b = box();
    const value = b.openSecret(TOKEN, { tenantId: "t-1", provider: "meta", field: "pageAccessToken" });

    expect(value).toBe(TOKEN);
    expect(b.logger.warns).toHaveLength(1);
    expect(b.logger.warns[0]?.context).toMatchObject({
      scope: "secrets",
      reason: "PLAINTEXT_LEGACY",
      tenant_id: "t-1",
      provider: "meta",
      field: "pageAccessToken",
    });
    // The warning names the field; it never carries the token itself.
    expect(JSON.stringify(b.logger.warns)).not.toContain(TOKEN);
  });

  it("opens legacy plaintext even when no key is configured at all", () => {
    expect(box(null).openSecret(TOKEN)).toBe(TOKEN);
  });
});

describe("config helpers — the contract every repo follows", () => {
  it.each([
    ["pageAccessToken", true],
    ["accessToken", true],
    ["refreshToken", true],
    ["clientSecret", true],
    ["apiKey", true],
    ["api_key", true],
    ["password", true],
    ["pageId", false],
    ["driveFolderId", false],
    ["spreadsheetId", false],
    ["sheetName", false],
  ])("classifies %s as secret=%s by NAME", (name, expected) => {
    expect(isSecretFieldName(name)).toBe(expected);
  });

  it("seals only the secret-looking fields and leaves the rest readable", () => {
    const b = box();
    const config = {
      pageId: "123456",
      pageAccessToken: TOKEN,
      spacingMs: 60000,
      nested: { clientSecret: "shhh", label: "main" },
    };

    const sealed = sealConfigSecrets(config, b);

    expect(sealed.pageId).toBe("123456");
    expect(sealed.spacingMs).toBe(60000);
    expect(sealed.nested.label).toBe("main");
    expect(isSealedSecret(sealed.pageAccessToken)).toBe(true);
    expect(isSealedSecret(sealed.nested.clientSecret)).toBe(true);
    expect(JSON.stringify(sealed)).not.toContain(TOKEN);
    expect(openConfigSecrets(sealed, b)).toEqual(config);
  });

  it("is idempotent: re-sealing a config does not double-encrypt", () => {
    const b = box();
    const once = sealConfigSecrets({ pageAccessToken: TOKEN }, b);
    const twice = sealConfigSecrets(once, b);
    expect(twice.pageAccessToken).toBe(once.pageAccessToken);
    expect(b.openSecret(twice.pageAccessToken)).toBe(TOKEN);
  });

  it("lists plaintext secret fields by path, never by value", () => {
    const found = findPlaintextSecretFields({
      pageId: "1",
      pageAccessToken: TOKEN,
      nested: { apiKey: "abc", note: "fine" },
      sealed: { clientSecret: box().sealSecret("x") },
    });

    expect(found.sort()).toEqual(["nested.apiKey", "pageAccessToken"]);
    expect(found.join(",")).not.toContain(TOKEN);
  });

  it("reports nothing for a catalog config — it holds ids, not credentials", () => {
    expect(
      findPlaintextSecretFields({
        driveFolderId: "1bA48sjugz9BczcoR0-zOc-VNlIYikp4v",
        spreadsheetId: "1Qdhp9YS0mePn7G3focqAhqV3Mb1eymFqbX0EC1bFCVs",
        sheetName: "Mẫu 2026",
      }),
    ).toEqual([]);
  });
});
