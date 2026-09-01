import { describe, expect, it } from "vitest";

import { MAX_UPLOADS_PER_POST } from "@/composition/container";
import { AppError } from "@/core/domain/errors";

import { readUploadForm } from "../read-upload-form";
import { testTenantId } from "@/core/domain/tenant-context.testing";

const ROUTE = "POST /api/posts/uploads";
const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");

function multipart(build: (form: FormData) => void): Request {
  const form = new FormData();
  build(form);
  return new Request("https://mysp.example.com/api/posts/uploads", { method: "POST", body: form });
}

function photo(name: string, bytes = 8): File {
  return new File([new Uint8Array(bytes)], name, { type: "image/jpeg" });
}

function valid(patch: (form: FormData) => void = () => {}): Request {
  return multipart((form) => {
    form.set("productCode", "MG1");
    form.append("files", photo("a.jpg"));
    patch(form);
  });
}

describe("readUploadForm — transport rejections", () => {
  it("refuses a body that is not multipart", async () => {
    const request = new Request("https://mysp.example.com/api/posts/uploads", {
      method: "POST",
      body: JSON.stringify({ tenantId: TENANT }),
      headers: { "content-type": "application/json" },
    });
    await expect(readUploadForm(request, ROUTE, TENANT)).rejects.toBeInstanceOf(AppError);
  });

  it("refuses a body with no file parts", async () => {
    const request = multipart((form) => {
        form.set("productCode", "MG1");
    });
    await expect(readUploadForm(request, ROUTE, TENANT)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("refuses missing fields with the field's own message", async () => {
    // `productCode` is now the ONLY required field: M1.3b removed `tenantId`
    // from the form, so a forged one can no longer address another tenant.
    const request = multipart((form) => {
      form.append("files", photo("a.jpg"));
    });
    await expect(readUploadForm(request, ROUTE, TENANT)).rejects.toMatchObject({
      userMessage: expect.stringContaining("Thiếu"),
    });
  });

  it("refuses more parts than one post may carry", async () => {
    const request = valid((form) => {
      for (let index = 0; index < MAX_UPLOADS_PER_POST; index += 1) {
        form.append("files", photo(`extra-${index}.jpg`));
      }
    });
    await expect(readUploadForm(request, ROUTE, TENANT)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("readUploadForm — the order field", () => {
  it("reads a JSON index list", async () => {
    const request = multipart((form) => {
        form.set("productCode", "MG1");
      form.append("files", photo("a.jpg"));
      form.append("files", photo("b.jpg"));
      form.set("order", "[1,0]");
    });

    const result = await readUploadForm(request, ROUTE, TENANT);
    expect(result.order).toEqual([1, 0]);
    expect(result.parts.map((part) => part.name)).toEqual(["a.jpg", "b.jpg"]);
  });

  it("treats an absent order as 'keep the order sent'", async () => {
    const result = await readUploadForm(valid(), ROUTE, TENANT);
    expect(result.order).toBeUndefined();
  });

  it("refuses a garbled order instead of silently ignoring it", async () => {
    // Business rule 5: falling back to "as sent" would publish a different
    // album than the one the operator arranged, with no sign anything went
    // wrong.
    for (const order of ["not json", "{}", '"[0]"']) {
      const request = valid((form) => form.set("order", order));
      await expect(readUploadForm(request, ROUTE, TENANT)).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
    }
  });

  it("refuses an order whose length does not match the file count", async () => {
    const request = valid((form) => form.set("order", "[0,1]"));
    await expect(readUploadForm(request, ROUTE, TENANT)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("refuses a negative index at the schema boundary", async () => {
    const request = valid((form) => form.set("order", "[-1]"));
    await expect(readUploadForm(request, ROUTE, TENANT)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("readUploadForm — happy path", () => {
  it("returns trimmed fields, the parts and their declared sizes", async () => {
    const request = multipart((form) => {
      form.set("productCode", "  mg1  ");
      form.append("files", photo("a.jpg", 12));
      form.append("files", photo("b.jpg", 34));
    });

    const result = await readUploadForm(request, ROUTE, TENANT);

    // Upper-casing belongs to the usecase; the transport only trims.
    expect(result.productCode).toBe("mg1");
    expect(result.declaredSizes).toEqual([12, 34]);
  });

  it("IGNORES a tenantId field an old client still sends (docs/11 §3.2)", async () => {
    // The transition rule: the server does not error on it, it simply never
    // reads it — the tenant of the write is the authorised one, always.
    const request = valid((form) => form.set("tenantId", "11111111-1111-1111-1111-111111111111"));
    const result = await readUploadForm(request, ROUTE, TENANT);
    expect(result).not.toHaveProperty("tenantId");
    expect(result.productCode).toBe("MG1");
  });

  it("ignores a non-file part named files", async () => {
    const request = valid((form) => form.append("files", "not-a-file"));
    const result = await readUploadForm(request, ROUTE, TENANT);
    expect(result.parts).toHaveLength(1);
  });
});
