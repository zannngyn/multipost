import { describe, expect, it } from "vitest";

import {
  TENANT_SECRETS_ENC_KEY,
  secretsNotConfiguredReason,
  secretsNotConfiguredView,
} from "../channel-secrets";

/**
 * The point of this module is that the warning shown BEFORE anyone types and
 * the error shown AFTER a write fails are the same words. That only holds while
 * the synthetic error keeps hitting `presentApiError`'s config branch — if it
 * ever slips into the generic one, the warning silently degrades to "Thao tác
 * không thành công" and nobody notices. These tests are that tripwire.
 */

describe("secretsNotConfiguredView", () => {
  it("lands in the system-config branch, not the generic one", () => {
    expect(secretsNotConfiguredView().kind).toBe("config");
  });

  it("never offers a retry — an operator cannot fix a missing env var", () => {
    expect(secretsNotConfiguredView().canRetry).toBe(false);
  });

  it("names the exact variable an admin has to set", () => {
    const view = secretsNotConfiguredView();
    expect(view.hint).toContain(TENANT_SECRETS_ENC_KEY);
  });

  it("tells the admin where to put it and to restart", () => {
    const view = secretsNotConfiguredView();
    expect(view.hint).toContain(".env");
    expect(view.hint).toContain("khởi động lại");
  });
});

describe("secretsNotConfiguredReason", () => {
  it("gives one non-empty line usable as a tooltip on a disabled control", () => {
    const reason = secretsNotConfiguredReason();
    expect(reason.length).toBeGreaterThan(0);
    expect(reason).toContain(TENANT_SECRETS_ENC_KEY);
  });
});
