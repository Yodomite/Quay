import type { KycFieldSpec, KycStatus } from "@checkout/core";

// SEP-12: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0012.md
//
// Every field submitted here is a real person's PII (name, email, address, ...).
// This module never fabricates a value — the anchor's discovery response is the
// only source of truth for what's required, and callers decide what to send.

interface RawFieldSpec {
  type: string;
  description?: string;
  optional?: boolean;
  choices?: string[];
}

interface RawGetCustomerResponse {
  id?: string;
  status: string;
  fields?: Record<string, RawFieldSpec>;
  message?: string;
}

export interface Sep12CustomerResult {
  customerId: string | null;
  status: KycStatus;
  requiredFields: KycFieldSpec[];
  message: string | null;
}

function toFieldSpecs(fields: Record<string, RawFieldSpec> | undefined): KycFieldSpec[] {
  if (!fields) return [];
  return Object.entries(fields).map(([name, spec]) => ({
    name,
    type: spec.type,
    description: spec.description,
    optional: spec.optional ?? false,
    choices: spec.choices,
  }));
}

function toKycStatus(status: string): KycStatus {
  // ACCEPTED / REJECTED / NEEDS_INFO / PROCESSING are the SEP-12 statuses we
  // model; anything else (e.g. NEEDS_VERIFICATION) is treated as PROCESSING —
  // still not cleared to cash out, but not a hard rejection either.
  if (status === "ACCEPTED" || status === "REJECTED" || status === "NEEDS_INFO" || status === "PROCESSING") {
    return status;
  }
  return "PROCESSING";
}

/** Discovers required fields and current status for a customer, identified by
 *  the anchor-assigned `customerId` once one exists, else by `account`. */
export async function getSep12Customer(
  baseUrl: string,
  jwt: string,
  params: { account: string; customerId?: string | null },
): Promise<Sep12CustomerResult> {
  const url = new URL("/sep12/customer", baseUrl);
  if (params.customerId) {
    url.searchParams.set("id", params.customerId);
  } else {
    url.searchParams.set("account", params.account);
  }

  const res = await fetch(url, { headers: { authorization: `Bearer ${jwt}` } });
  if (res.status === 404) {
    // No customer record yet — every field is required, nothing on file.
    return { customerId: null, status: "unsubmitted" as KycStatus, requiredFields: [], message: null };
  }
  if (!res.ok) {
    throw new Error(`SEP-12 customer GET failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as RawGetCustomerResponse;
  return {
    customerId: body.id ?? params.customerId ?? null,
    status: toKycStatus(body.status),
    requiredFields: toFieldSpecs(body.fields),
    message: body.message ?? null,
  };
}

/** Submits exactly the fields given — no defaults, no fabricated identity. */
export async function putSep12Customer(
  baseUrl: string,
  jwt: string,
  params: { account: string; customerId?: string | null; fields: Record<string, string> },
): Promise<{ customerId: string }> {
  const res = await fetch(new URL("/sep12/customer", baseUrl), {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
    body: JSON.stringify({
      ...(params.customerId ? { id: params.customerId } : { account: params.account }),
      ...params.fields,
    }),
  });
  if (!res.ok) {
    throw new Error(`SEP-12 customer PUT failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { id: string };
  return { customerId: body.id };
}
