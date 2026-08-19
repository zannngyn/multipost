import {
  isOperatorProvider,
  normaliseDisplayName,
  normaliseEmail,
  normaliseProviderAccountId,
  operatorSessionEmail,
  type AccessStatus,
  type OperatorProvider,
  type OperatorRole,
} from "@/shared/operator-access";

import { AppError } from "./errors";

/**
 * Access registry (E1.4) — "ai được vào công cụ này".
 *
 * One row per provider identity. A first sign-in by an unknown identity writes
 * a `pending` row and is refused; an admin then approves (with a role) or
 * blocks it. Pure domain: the words live in `shared/operator-access`, the
 * validation that turns untrusted provider data into a usable identity lives
 * here, and every I/O detail lives behind `ports/access-request-repo`.
 */

export interface AccessRequest {
  readonly id: string;
  readonly tenantId: string;
  readonly provider: OperatorProvider;
  readonly providerAccountId: string;
  /**
   * The address this identity's JWT session carries — the key `getOperatorSession`
   * looks the status up by. Synthetic for Facebook (see shared/operator-access).
   */
  readonly sessionEmail: string;
  /** The address the provider actually returned. Null is normal for Facebook. */
  readonly email: string | null;
  readonly displayName: string | null;
  readonly status: AccessStatus;
  /** Set only when approved; null while pending and for a blocked identity. */
  readonly role: OperatorRole | null;
  readonly requestedAt: Date;
  readonly decidedAt: Date | null;
  readonly decidedByEmail: string | null;
}

/** A provider identity that passed validation and can be filed in the registry. */
export interface OperatorIdentity {
  readonly provider: OperatorProvider;
  readonly providerAccountId: string;
  readonly sessionEmail: string;
  readonly email: string | null;
  readonly displayName: string | null;
}

export interface RawOperatorIdentity {
  readonly provider: unknown;
  readonly providerAccountId: unknown;
  readonly email?: unknown;
  readonly displayName?: unknown;
}

/**
 * Untrusted provider payload -> identity, or a typed refusal.
 *
 * Edge cases first, because every one of them has been seen in the wild:
 * Facebook returns no e-mail at all, returns an empty name, and hands out
 * app-scoped ids that differ per app. Nothing here is defaulted silently — a
 * missing id is an error, a missing e-mail/name is an explicit null.
 */
export function toOperatorIdentity(raw: RawOperatorIdentity): OperatorIdentity {
  if (!isOperatorProvider(raw?.provider)) {
    throw new AppError("INVALID_INPUT", {
      message: "Unsupported sign-in provider",
      userMessage: "Cách đăng nhập này không được hỗ trợ.",
      context: { provider: typeof raw?.provider === "string" ? raw.provider : null },
    });
  }

  const provider = raw.provider;
  const providerAccountId = normaliseProviderAccountId(raw?.providerAccountId);
  if (!providerAccountId) {
    throw new AppError("INVALID_INPUT", {
      message: "Provider account id is missing or malformed",
      userMessage: "Không đọc được định danh tài khoản từ nhà cung cấp đăng nhập.",
      context: { provider, field: "providerAccountId" },
    });
  }

  const email = normaliseEmail(raw?.email);
  const sessionEmail = operatorSessionEmail({ provider, providerAccountId, email });
  if (!sessionEmail) {
    // Only reachable for Google without a usable address: there is then no
    // identity key at all, and guessing one would file two people under one row.
    throw new AppError("INVALID_INPUT", {
      message: "Sign-in carried no usable identity address",
      userMessage: "Tài khoản này không cung cấp email nên chưa thể cấp quyền.",
      context: { provider, provider_account_id: providerAccountId, field: "email" },
    });
  }

  return {
    provider,
    providerAccountId,
    sessionEmail,
    email,
    displayName: normaliseDisplayName(raw?.displayName),
  };
}
