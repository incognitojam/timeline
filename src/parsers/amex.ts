/**
 * American Express Parser
 *
 * Imports transactions from Amex's transaction CSV export — specifically the
 * "Include all additional transaction details" variant, which carries the
 * per-transaction Reference (a stable id, identical to the OFX FITID) plus the
 * spending category and merchant address that the OFX/QFX export drops.
 *
 * Export from americanexpress.com → Statements & Activity → Download your
 * transactions → CSV, with "Include all additional transaction details"
 * ticked. The by-year and billing-period exports share this format; because
 * the Reference is a stable unique id, re-importing an overlapping export is
 * idempotent (INSERT OR IGNORE on (source, source_id, source_account)).
 *
 * CLI Usage:
 *   bun run src/parsers/amex.ts <activity.csv> [account-name]
 */

import { Database } from "bun:sqlite";
import { basename } from "node:path";
import { parseCSV } from "../lib/csv";
import { runParser } from "../lib/parser-cli";
import { onImportComplete } from "../db/import-hooks";

/** Collapse runs of whitespace (including embedded newlines) to single spaces. */
function tidy(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Convert Amex's UK "DD/MM/YYYY" date to a full ISO timestamp anchored at UTC
 * midnight ("YYYY-MM-DDT00:00:00Z"). The export carries no time-of-day (it's a
 * posting date), so we anchor to midnight — matching the other date-only
 * sources (fitbit, google-calendar all-day events).
 *
 * A bare "YYYY-MM-DD" must NOT be used: the day view filters with
 * `timestamp >= 'YYYY-MM-DDT00:00:00'`, and a date-only string sorts *before*
 * that lower bound (a prefix is lexicographically less than the longer string),
 * so the event is excluded from /timeline?date=... despite appearing in search.
 *
 * Returns null for an unrecognized format.
 */
export function parseAmexDate(raw: string): string | null {
  const match = raw.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  const [, dd, mm, yyyy] = match;
  return `${yyyy}-${mm}-${dd}T00:00:00Z`;
}

/**
 * Parse an Amex CSV amount into signed pounds using the *Monzo* convention
 * (money out negative, money in positive) for cross-source consistency.
 * Amex's CSV inverts this — a charge is positive and a credit (refund or bill
 * payment) is negative — so we negate. Throws on an unparseable value.
 */
export function parseAmexAmount(raw: string): number {
  const cleaned = raw.replace(/[^0-9.-]/g, "");
  const value = Number.parseFloat(cleaned);
  if (Number.isNaN(value)) {
    throw new Error(`Unparseable Amex amount: ${JSON.stringify(raw)}`);
  }
  return -value;
}

/** Strip Amex's Excel text-guard quotes (e.g. `'AT123'`) from a Reference. */
export function cleanReference(raw: string): string {
  return raw.replace(/^'+|'+$/g, "").trim();
}

/**
 * A card bill payment (paying off the balance) rather than a purchase or a
 * merchant refund. Amex gives these a Reference starting "1000" and the
 * description "PAYMENT RECEIVED".
 */
function isCardPayment(reference: string, description: string): boolean {
  return reference.startsWith("1000") || /payment received/i.test(description);
}

/**
 * Map an Amex "Top-Level-Sub Level" category to a Timeline transaction type,
 * mirroring the Monzo parser's category buckets. `signedPounds` is in Monzo
 * convention (money in positive).
 */
export function classifyAmexType(
  category: string,
  signedPounds: number,
  isPayment: boolean
): string {
  if (isPayment) return "transaction:payment";
  if (signedPounds > 0) return "transaction:refund"; // a credit that isn't a bill payment

  const idx = category.indexOf("-");
  const top = (idx >= 0 ? category.slice(0, idx) : category).trim();
  const sub = (idx >= 0 ? category.slice(idx + 1) : "").trim();

  switch (top) {
    case "Travel":
      return "transaction:transport";
    case "Entertainment":
      if (sub === "Restaurants" || sub === "Bars & Cafés") return "transaction:food";
      return "transaction:entertainment";
    case "General Purchases":
      if (sub === "Groceries") return "transaction:groceries";
      if (sub === "Fuel" || sub === "Parking Charges") return "transaction:transport";
      return "transaction:shopping";
    case "Business Services":
      if (sub === "Health Care Services") return "transaction:health";
      return "transaction";
    default:
      return "transaction";
  }
}

/** Format a signed pound amount as e.g. "-£56.90" / "+£220.75". */
function formatGBP(signedPounds: number): string {
  const formatted = new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
  }).format(Math.abs(signedPounds));
  return `${signedPounds >= 0 ? "+" : "-"}${formatted}`;
}

function buildTitle(merchant: string, signedPounds: number, isPayment: boolean): string {
  const amount = formatGBP(signedPounds);
  if (isPayment) return `${amount} - ${merchant}`;
  if (signedPounds > 0) return `${amount} refund from ${merchant}`;
  return `${amount} at ${merchant}`;
}

function buildLocationName(row: Record<string, string>): string | null {
  const parts = [
    tidy(row["Address"] ?? ""),
    tidy(row["Town/City"] ?? ""),
    tidy(row["Postcode"] ?? ""),
  ].filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join(", ") : null;
}

/** Searchable content: merchant, extended details (incl. FX), category, location. */
function buildContent(
  merchant: string,
  row: Record<string, string>,
  locationName: string | null
): string {
  return [merchant, tidy(row["Extended Details"] ?? ""), tidy(row["Category"] ?? ""), locationName ?? ""]
    .filter((part) => part.length > 0)
    .join(" — ");
}

/**
 * Import an Amex transactions CSV into the events table.
 * Returns the number of newly-inserted events (duplicates are ignored).
 */
export async function importAmexData(
  db: Database,
  filePath: string,
  account: string
): Promise<number> {
  if (!account) {
    throw new Error("amex parser requires an account name");
  }

  const text = await Bun.file(filePath).text();
  const rows = parseCSV(text);

  if (rows.length === 0) {
    console.log("No rows found in Amex CSV");
    return 0;
  }

  // Fail fast if this isn't the "Include all details" export — without the
  // Reference column there is no stable id to de-duplicate on.
  const first = rows[0];
  if (!("Reference" in first) || !("Date" in first) || !("Amount" in first)) {
    throw new Error(
      "Amex CSV is missing required columns (Date, Amount, Reference). " +
        "Re-export with 'Include all additional transaction details' enabled."
    );
  }

  const importBatch = `amex-${account}-${Date.now()}`;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO events (
      source, source_id, source_account, type, timestamp,
      title, content, latitude, longitude, location_name,
      people, tags, raw_data, import_batch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let added = 0;
  let skippedDuplicate = 0;
  let skippedInvalid = 0;

  const insertAll = db.transaction((items: Record<string, string>[]) => {
    for (const row of items) {
      const reference = cleanReference(row["Reference"] ?? "");
      const timestamp = parseAmexDate(row["Date"] ?? "");
      if (!reference || !timestamp) {
        skippedInvalid++;
        continue;
      }

      let signedPounds: number;
      try {
        signedPounds = parseAmexAmount(row["Amount"] ?? "");
      } catch {
        skippedInvalid++;
        continue;
      }

      const description = tidy(row["Description"] ?? "");
      const merchant = description || "Unknown";
      const payment = isCardPayment(reference, description);
      const type = classifyAmexType(row["Category"] ?? "", signedPounds, payment);
      const locationName = buildLocationName(row);
      const title = buildTitle(merchant, signedPounds, payment);
      const content = buildContent(merchant, row, locationName);
      const category = tidy(row["Category"] ?? "");

      const result = insert.run(
        "amex",
        reference,
        account,
        type,
        timestamp,
        title,
        content,
        null,
        null,
        locationName,
        null,
        JSON.stringify(category ? [category] : []),
        JSON.stringify(row),
        importBatch
      );

      if (result.changes > 0) added++;
      else skippedDuplicate++;
    }
  });

  insertAll(rows);
  onImportComplete(db);

  console.log(
    `Amex (${account}) ${basename(filePath)}: +${added} events ` +
      `(${skippedDuplicate} duplicate, ${skippedInvalid} invalid)`
  );

  return added;
}

// CLI
if (import.meta.main) {
  runParser(importAmexData, {
    name: "amex",
    defaultAccount: "personal",
    examples: [
      "bun run src/parsers/amex.ts ./activity.csv",
      "bun run src/parsers/amex.ts ./activity.csv personal",
    ],
  });
}
