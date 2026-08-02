import { afterEach, describe, expect, it, vi } from "vitest";
import { getSep12Customer, putSep12Customer } from "../src/sep12";

const BASE_URL = "https://testanchor.stellar.org";
const JWT = "jwt-token";
const ACCOUNT = "GDEST0000000000000000000000000000000000000000000000000000";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("putSep12Customer", () => {
  it("sends exactly the fields given — no fabricated identity, ever", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "cust_1" }));
    vi.stubGlobal("fetch", fetchMock);

    await putSep12Customer(BASE_URL, JWT, {
      account: ACCOUNT,
      fields: { first_name: "Ada", email_address: "ada@example.org" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ account: ACCOUNT, first_name: "Ada", email_address: "ada@example.org" });
    // No literal placeholder value ever appears in the outgoing request body.
    const raw = init.body as string;
    expect(raw).not.toContain("Demo");
    expect(raw).not.toContain("Seller");
    expect(raw).not.toContain("example.com");
  });

  it("submits an empty body untouched when given no fields (kick-off discovery call)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "cust_1" }));
    vi.stubGlobal("fetch", fetchMock);

    await putSep12Customer(BASE_URL, JWT, { account: ACCOUNT, fields: {} });

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ account: ACCOUNT });
  });

  it("addresses by customerId instead of account once one exists", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "cust_1" }));
    vi.stubGlobal("fetch", fetchMock);

    await putSep12Customer(BASE_URL, JWT, { account: ACCOUNT, customerId: "cust_1", fields: { first_name: "Ada" } });

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ id: "cust_1", first_name: "Ada" });
    expect(body.account).toBeUndefined();
  });

  it("throws with the anchor's response text on a non-OK PUT", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 400 })));
    await expect(putSep12Customer(BASE_URL, JWT, { account: ACCOUNT, fields: {} })).rejects.toThrow(/400/);
  });
});

describe("getSep12Customer", () => {
  it("reports unsubmitted (no fields known yet) on a 404", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not found", { status: 404 })));
    const result = await getSep12Customer(BASE_URL, JWT, { account: ACCOUNT });
    expect(result).toEqual({ customerId: null, status: "unsubmitted", requiredFields: [], message: null });
  });

  it("parses required fields, status, and message verbatim", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          id: "cust_1",
          status: "NEEDS_INFO",
          fields: {
            first_name: { type: "string", optional: false },
            middle_name: { type: "string", optional: true, description: "Optional middle name" },
          },
          message: "please provide your legal name",
        }),
      ),
    );

    const result = await getSep12Customer(BASE_URL, JWT, { account: ACCOUNT });
    expect(result.customerId).toBe("cust_1");
    expect(result.status).toBe("NEEDS_INFO");
    expect(result.message).toBe("please provide your legal name");
    expect(result.requiredFields).toEqual([
      { name: "first_name", type: "string", optional: false, description: undefined, choices: undefined },
      {
        name: "middle_name",
        type: "string",
        optional: true,
        description: "Optional middle name",
        choices: undefined,
      },
    ]);
  });

  it("queries by id when a customerId is known, else by account", async () => {
    // A fresh Response per call — a Response body can only be read once, and
    // both calls below get their body consumed by getSep12Customer's res.json().
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ status: "ACCEPTED" })));
    vi.stubGlobal("fetch", fetchMock);

    await getSep12Customer(BASE_URL, JWT, { account: ACCOUNT, customerId: "cust_1" });
    const [urlWithId] = fetchMock.mock.calls[0] as [URL];
    expect(urlWithId.searchParams.get("id")).toBe("cust_1");
    expect(urlWithId.searchParams.get("account")).toBeNull();

    await getSep12Customer(BASE_URL, JWT, { account: ACCOUNT });
    const [urlWithAccount] = fetchMock.mock.calls[1] as [URL];
    expect(urlWithAccount.searchParams.get("account")).toBe(ACCOUNT);
  });
});
