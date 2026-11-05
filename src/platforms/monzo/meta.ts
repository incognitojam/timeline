import type { PlatformMeta } from "../types";

export const monzoMeta = {
  id: "monzo",
  color: "#FF5F5F",
  sources: [
    {
      id: "monzo",
      label: "Monzo",
      eventTypes: [
        "transaction",
        "transaction:bills",
        "transaction:cash",
        "transaction:credit",
        "transaction:declined",
        "transaction:entertainment",
        "transaction:food",
        "transaction:groceries",
        "transaction:shopping",
        "transaction:topup",
        "transaction:transport",
      ],
    },
  ],
  identityPlatforms: ["monzo"],
} as const satisfies PlatformMeta;
