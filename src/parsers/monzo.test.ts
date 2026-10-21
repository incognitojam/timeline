import { describe, expect, test } from "bun:test";
import { extractCounterpartyIdentity, type MonzoTransaction } from "./monzo";

function makeTx(counterparty: MonzoTransaction["counterparty"]): MonzoTransaction {
  return {
    id: "tx_0000",
    created: "2026-01-01T00:00:00Z",
    description: "test",
    amount: -500,
    currency: "GBP",
    merchant: null,
    notes: "",
    metadata: {},
    category: "general",
    is_load: false,
    settled: "2026-01-01T00:00:00Z",
    local_amount: -500,
    local_currency: "GBP",
    counterparty,
  };
}

describe("extractCounterpartyIdentity", () => {
  test("mints an identity for a stable user_ counterparty", () => {
    const result = extractCounterpartyIdentity(
      makeTx({ user_id: "user_00009abc", name: "Alice", preferred_name: "Ali" })
    );

    expect(result).not.toBeNull();
    expect(result?.identifier).toBe("monzo:user_00009abc");
    expect(result?.identity.platformId).toBe("user_00009abc");
    expect(result?.identity.displayName).toBe("Ali");
  });

  test("does not mint an identity for an ephemeral anonuser_ counterparty", () => {
    const result = extractCounterpartyIdentity(
      makeTx({ user_id: "anonuser_4d3ce2b3c7b8a637750bde", name: "Bob" })
    );

    expect(result).toBeNull();
  });

  test("returns null when there is no counterparty user_id (e.g. merchant)", () => {
    expect(extractCounterpartyIdentity(makeTx({ name: "Some Shop" }))).toBeNull();
    expect(extractCounterpartyIdentity(makeTx(undefined))).toBeNull();
  });
});
