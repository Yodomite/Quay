import type { PaymentLink, PaymentRequest } from "@checkout/core";

export type { PaymentLink, PaymentRequest };

export interface LinkWithRequest {
  link: PaymentLink;
  request: PaymentRequest;
}

// Browser calls go to NEXT_PUBLIC_API_URL; server-side calls fall back to API_URL.
const BROWSER_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

export function apiBase(): string {
  if (typeof window === "undefined") {
    return process.env.API_URL ?? BROWSER_BASE;
  }
  return BROWSER_BASE;
}

// ── Typed error envelope ────────────────────────────────────────────────────

/** Machine-readable error codes the API can return in its `error` field. */
export type ApiErrorCode =
  | "not_found"
  | "invalid_body"
  | "conflict"
  | "unreachable"   // synthetic — fetch itself threw (DNS / network down)
  | "server_error";  // 5xx or unexpected non-JSON response

/** Structured error thrown by http() so callers can branch on code. */
export class CheckoutError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly status: number,
    detail: string,
  ) {
    super(`${code} (${status}): ${detail}`);
    this.name = "CheckoutError";
  }
}

/** Map an error code to copy suitable for a seller-facing dashboard. */
export function describeError(err: CheckoutError): string {
  switch (err.code) {
    case "not_found":
      return "This link no longer exists. It may have been removed or the id is wrong.";
    case "invalid_body":
      return "The data sent to the server was invalid. Check your inputs and try again.";
    case "conflict":
      return "This action cannot be completed right now. The link may be in an unexpected state. Try refreshing.";
    case "unreachable":
      return "We can't reach the payment service right now. Check your connection and try again.";
    case "server_error":
      return "Something went wrong on the server. Please try again in a moment.";
    default:
      return "An unexpected error occurred. Please try again.";
  }
}

// ── HTTP client ─────────────────────────────────────────────────────────────

/**
 * Thin fetch wrapper.
 *
 * - 2xx → parse JSON and return `T`
 * - 4xx/5xx → extract `{ error: string }` envelope and throw `CheckoutError`
 * - Network failure → throw `CheckoutError` with code `"unreachable"`
 */
async function http<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${apiBase()}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
      cache: "no-store",
    });
  } catch {
    throw new CheckoutError("unreachable", 0, "Network request failed");
  }

  if (!res.ok) {
    let apiCode: string | undefined;
    try {
      const body = (await res.json()) as { error?: string };
      apiCode = body.error;
    } catch {
      // response wasn't JSON
    }
    const code: ApiErrorCode =
      res.status >= 500
        ? "server_error"
        : res.status === 409
          ? "conflict"
          : apiCode === "not_found"
            ? "not_found"
            : apiCode === "invalid_body"
              ? "invalid_body"
              : "server_error";
    const detail = apiCode ?? res.statusText;
    throw new CheckoutError(code, res.status, detail);
  }

  return res.json() as Promise<T>;
}

export interface CreateLinkInput {
  title: string;
  amount: string;
  assetCode: "USDC" | "XLM";
  expiresInMinutes?: number;
}

export const api = {
  createLink: (input: CreateLinkInput) =>
    http<LinkWithRequest>("/links", { method: "POST", body: JSON.stringify(input) }),

  listLinks: () => http<{ links: PaymentLink[] }>("/links"),

  getLink: (id: string) => http<LinkWithRequest>(`/links/${id}`),

  cashOut: (
    id: string,
    targetCurrency: string,
    payoutFields: Record<string, string> = {},
  ) =>
    http<{ job: { jobId: string; status: string; targetAmount: string; targetCurrency: string } }>(
      `/links/${id}/cash-out`,
      { method: "POST", body: JSON.stringify({ targetCurrency, payoutFields }) },
    ),
};
