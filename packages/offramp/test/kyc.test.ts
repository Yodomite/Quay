import { describe, expect, it } from "vitest";
import type { KycFieldSpec } from "@checkout/core";
import { missingRequiredFields } from "../src/kyc";

const NAME: KycFieldSpec = { name: "first_name", type: "string", optional: false };
const EMAIL: KycFieldSpec = { name: "email_address", type: "string", optional: false };
const MIDDLE: KycFieldSpec = { name: "middle_name", type: "string", optional: true };

describe("missingRequiredFields", () => {
  it("names exactly the missing required fields", () => {
    expect(missingRequiredFields([NAME, EMAIL], {})).toEqual(["first_name", "email_address"]);
    expect(missingRequiredFields([NAME, EMAIL], { first_name: "Ada" })).toEqual(["email_address"]);
  });

  it("returns nothing once every required field has a non-blank value", () => {
    expect(
      missingRequiredFields([NAME, EMAIL], { first_name: "Ada", email_address: "ada@example.org" }),
    ).toEqual([]);
  });

  it("treats a whitespace-only value as missing, not fabricated", () => {
    expect(missingRequiredFields([NAME], { first_name: "   " })).toEqual(["first_name"]);
  });

  it("never requires an optional field", () => {
    expect(missingRequiredFields([NAME, MIDDLE], { first_name: "Ada" })).toEqual([]);
  });

  it("returns nothing when there are no required fields (nothing known yet)", () => {
    expect(missingRequiredFields([], { anything: "x" })).toEqual([]);
  });
});
