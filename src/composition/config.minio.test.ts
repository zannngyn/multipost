import { describe, expect, it } from "vitest";
import { loadMinioConfig } from "@/composition/config";

const base = {
  MINIO_INTERNAL_ENDPOINT: "minio:9000",
  MINIO_PUBLIC_ENDPOINT: "https://media.vannt.asia",
  MINIO_ACCESS_KEY: "key",
  MINIO_SECRET_KEY: "secret",
};

describe("loadMinioConfig", () => {
  it("defaults bucket and useSSL", () => {
    const cfg = loadMinioConfig(base);
    expect(cfg.MINIO_BUCKET).toBe("mysp-media");
    expect(cfg.MINIO_USE_SSL).toBe(false);
  });

  it("rejects when the secret is missing", () => {
    expect(() => loadMinioConfig({ ...base, MINIO_SECRET_KEY: "" })).toThrow();
  });

  it("rejects a public endpoint that is not a URL", () => {
    expect(() => loadMinioConfig({ ...base, MINIO_PUBLIC_ENDPOINT: "minio:9000" })).toThrow();
  });

  // I5: a strict allowlist, not "!== 'false'" — that guess used to turn "",
  // "0", "no" and "off" into `true`, which re-opens the Critical this epic
  // already paid for once (MINIO_USE_SSL=true against the plain-HTTP
  // internal hop boots green, then every confirm dies with EPROTO).
  describe("MINIO_USE_SSL — strict allowlist", () => {
    it.each([
      ["true", true],
      ["TRUE", true],
      ["false", false],
      ["FALSE", false],
      [" true ", true],
    ])("accepts %j as %s", (raw, expected) => {
      expect(loadMinioConfig({ ...base, MINIO_USE_SSL: raw }).MINIO_USE_SSL).toBe(expected);
    });

    it("defaults to false when unset", () => {
      expect(loadMinioConfig(base).MINIO_USE_SSL).toBe(false);
    });

    it.each(["", "0", "no", "off", "yes"])("rejects %j instead of guessing", (raw) => {
      expect(() => loadMinioConfig({ ...base, MINIO_USE_SSL: raw })).toThrow();
    });
  });
});
