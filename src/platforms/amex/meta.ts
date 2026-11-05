import type { PlatformMeta } from "../types";

export const amexMeta = {
  id: "amex",
  color: "#006FCF",
  sources: [
    {
      id: "amex",
      label: "American Express",
      eventTypes: [
        "transaction",
        "transaction:entertainment",
        "transaction:food",
        "transaction:groceries",
        "transaction:health",
        "transaction:payment",
        "transaction:refund",
        "transaction:shopping",
        "transaction:transport",
      ],
    },
  ],
} as const satisfies PlatformMeta;
