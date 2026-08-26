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
    expect(cfg.MINIO_USE_SSL).toBe(true);
  });

  it("rejects when the secret is missing", () => {
    expect(() => loadMinioConfig({ ...base, MINIO_SECRET_KEY: "" })).toThrow();
  });

  it("rejects a public endpoint that is not a URL", () => {
    expect(() => loadMinioConfig({ ...base, MINIO_PUBLIC_ENDPOINT: "minio:9000" })).toThrow();
  });
});
