import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { initDb } from "../db/schema";
import {
  importAmexData,
  parseAmexAmount,
  parseAmexDate,
  cleanReference,
  classifyAmexType,
} from "./amex";

const HEADER =
  "Date,Description,Card Member,Account #,Amount,Extended Details,Appears On Your Statement As,Address,Town/City,Postcode,Country,Reference,Category";

// Generic, non-personal fixture rows. One physical row per transaction except
// the last, whose quoted address spans two physical lines (as Amex exports do).
const FIXTURE = `${HEADER}
15/01/2026,SUPERMARKET            EXAMPLETON,A CARDHOLDER,-12345,12.50,GOODS,SUPERMARKET            EXAMPLETON,1 EXAMPLE ROAD,EXAMPLETON,ZZ1 1ZA,EXAMPLELAND,'AT260000000000000000001',General Purchases-Groceries
14/01/2026,COFFEE SHOP            EXAMPLETON,A CARDHOLDER,-12345,3.20,,COFFEE SHOP            EXAMPLETON,2 EXAMPLE ROAD,EXAMPLETON,ZZ1 1ZB,EXAMPLELAND,'AT260000000000000000002',Entertainment-Bars & Cafés
13/01/2026,TRAIN COMPANY          EXAMPLETON,A CARDHOLDER,-12345,25.00,,TRAIN COMPANY          EXAMPLETON,3 EXAMPLE ROAD,EXAMPLETON,ZZ1 1ZC,EXAMPLELAND,'AT260000000000000000003',Travel-Rail Services
12/01/2026,GADGET STORE           EXAMPLETON,A CARDHOLDER,-12345,-40.00,,GADGET STORE           EXAMPLETON,4 EXAMPLE ROAD,EXAMPLETON,ZZ1 1ZD,EXAMPLELAND,'AT260000000000000000004',General Purchases-Electronics Stores
10/01/2026,PAYMENT RECEIVED - THANK YOU,A CARDHOLDER,-12345,-100.00,,PAYMENT RECEIVED - THANK YOU,,,,,'10000000000000000000009',
09/01/2026,CLOUD SERVICE          SAMPLE CITY,A CARDHOLDER,-12345,3.82,Foreign Spend Amount: 5.00 EXAMPLE DOLLAR Commission Amount: 0.11 Currency Exchange Rate: 1.3477,CLOUD SERVICE          SAMPLE CITY,"100 EXAMPLE STREET
SUITE 200",SAMPLE CITY,00000,EXAMPLELAND,'AT260000000000000000006',General Purchases-Computer Supplies
`;

interface EventRow {
  source_id: string;
  source_account: string;
  type: string;
  timestamp: string;
  title: string;
  content: string;
  location_name: string | null;
  tags: string | null;
}

describe("amex parser", () => {
  describe("parseAmexAmount", () => {
    it("negates a charge (Amex positive) into Monzo convention (money out negative)", () => {
      expect(parseAmexAmount("56.90")).toBe(-56.9);
    });

    it("negates a credit (Amex negative) into positive", () => {
      expect(parseAmexAmount("-220.75")).toBe(220.75);
    });

    it("strips thousands separators", () => {
      expect(parseAmexAmount("1,398.39")).toBe(-1398.39);
    });

    it("throws on a non-numeric amount", () => {
      expect(() => parseAmexAmount("n/a")).toThrow();
    });
  });

  describe("parseAmexDate", () => {
    it("converts UK DD/MM/YYYY to a full ISO timestamp at UTC midnight", () => {
      expect(parseAmexDate("04/05/2026")).toBe("2026-05-04T00:00:00Z");
    });

    it("anchors to midnight so the day-view range query includes the event", () => {
      // The /timeline?date= query filters `timestamp >= 'DATE T00:00:00'`; a
      // bare 'YYYY-MM-DD' sorts before that lower bound and is hidden despite
      // showing in search. A full ISO timestamp falls inside the day's range.
      const ts = parseAmexDate("04/05/2026");
      expect(ts && ts >= "2026-05-04T00:00:00" && ts < "2026-05-04T24:00:00").toBe(true);
    });

    it("returns null for an unrecognized format", () => {
      expect(parseAmexDate("2026-05-04")).toBeNull();
    });
  });

  describe("cleanReference", () => {
    it("strips the Excel text-guard quotes", () => {
      expect(cleanReference("'AT260000000000000000001'")).toBe(
        "AT260000000000000000001"
      );
    });
  });

  describe("classifyAmexType", () => {
    it("flags bill payments", () => {
      expect(classifyAmexType("", 100, true)).toBe("transaction:payment");
    });

    it("flags non-payment credits as refunds", () => {
      expect(classifyAmexType("General Purchases-Electronics Stores", 40, false)).toBe(
        "transaction:refund"
      );
    });

    it("maps categories to Monzo-style buckets", () => {
      expect(classifyAmexType("General Purchases-Groceries", -10, false)).toBe(
        "transaction:groceries"
      );
      expect(classifyAmexType("Entertainment-Bars & Cafés", -10, false)).toBe(
        "transaction:food"
      );
      expect(classifyAmexType("Travel-Rail Services", -10, false)).toBe(
        "transaction:transport"
      );
      expect(classifyAmexType("General Purchases-Fuel", -10, false)).toBe(
        "transaction:transport"
      );
      expect(classifyAmexType("General Purchases-Clothing Stores", -10, false)).toBe(
        "transaction:shopping"
      );
    });

    it("falls back to generic transaction for unknown categories", () => {
      expect(classifyAmexType("Some New-Category", -10, false)).toBe("transaction");
    });
  });

  describe("importAmexData", () => {
    let db: Database;
    let fixtureDir: string;

    beforeEach(async () => {
      db = new Database(":memory:");
      initDb(db);
      fixtureDir = join(tmpdir(), `amex-fixture-${randomUUID()}`);
      await mkdir(fixtureDir, { recursive: true });
    });

    afterEach(async () => {
      db.close();
      await rm(fixtureDir, { recursive: true, force: true });
    });

    async function writeCsv(body: string): Promise<string> {
      const path = join(fixtureDir, `activity-${randomUUID()}.csv`);
      await writeFile(path, body);
      return path;
    }

    function rows(): EventRow[] {
      return db
        .prepare(
          "SELECT source_id, source_account, type, timestamp, title, content, location_name, tags FROM events WHERE source = 'amex' ORDER BY timestamp DESC"
        )
        .all() as EventRow[];
    }

    it("imports all transactions with the Reference as a quote-stripped source_id", async () => {
      const path = await writeCsv(FIXTURE);
      const added = await importAmexData(db, path, "personal");

      expect(added).toBe(6);
      const all = rows();
      expect(all).toHaveLength(6);
      expect(all.every((r) => r.source_account === "personal")).toBe(true);
      expect(all.map((r) => r.source_id)).toContain("AT260000000000000000001");
      // No leftover apostrophes from the Excel text guard.
      expect(all.every((r) => !r.source_id.includes("'"))).toBe(true);
    });

    it("normalizes the inverted sign: charges show -£, credits +£", async () => {
      const path = await writeCsv(FIXTURE);
      await importAmexData(db, path, "personal");

      const byRef = (ref: string) =>
        db
          .prepare("SELECT * FROM events WHERE source_id = ?")
          .get(ref) as EventRow;

      // Groceries charge (Amex 12.50 positive) → -£12.50 spend.
      const groceries = byRef("AT260000000000000000001");
      expect(groceries.type).toBe("transaction:groceries");
      expect(groceries.title).toBe("-£12.50 at SUPERMARKET EXAMPLETON");
      expect(groceries.timestamp).toBe("2026-01-15T00:00:00Z");
      expect(groceries.location_name).toBe("1 EXAMPLE ROAD, EXAMPLETON, ZZ1 1ZA");

      // Merchant refund (Amex -40.00) → +£40.00, typed as a refund.
      const refund = byRef("AT260000000000000000004");
      expect(refund.type).toBe("transaction:refund");
      expect(refund.title).toBe("+£40.00 refund from GADGET STORE EXAMPLETON");

      // Bill payment (Amex -100.00, "PAYMENT RECEIVED") → +£100.00, no location.
      const payment = byRef("10000000000000000000009");
      expect(payment.type).toBe("transaction:payment");
      expect(payment.title).toBe("+£100.00 - PAYMENT RECEIVED - THANK YOU");
      expect(payment.location_name).toBeNull();
    });

    it("handles a multi-line quoted address and keeps foreign-spend detail searchable", async () => {
      const path = await writeCsv(FIXTURE);
      await importAmexData(db, path, "personal");

      const cloud = db
        .prepare("SELECT * FROM events WHERE source_id = ?")
        .get("AT260000000000000000006") as EventRow;

      expect(cloud.type).toBe("transaction:shopping");
      // The embedded newline in the address is collapsed, not split into a new row.
      expect(cloud.location_name).toBe("100 EXAMPLE STREET SUITE 200, SAMPLE CITY, 00000");
      expect(cloud.content).toContain("EXAMPLE DOLLAR");
      expect(JSON.parse(cloud.tags ?? "[]")).toEqual([
        "General Purchases-Computer Supplies",
      ]);
    });

    it("is idempotent: re-importing the same export adds nothing", async () => {
      const path = await writeCsv(FIXTURE);
      expect(await importAmexData(db, path, "personal")).toBe(6);
      expect(await importAmexData(db, path, "personal")).toBe(0);
      expect(rows()).toHaveLength(6);
    });

    it("keeps the same transaction separate per account", async () => {
      const path = await writeCsv(FIXTURE);
      await importAmexData(db, path, "personal");
      await importAmexData(db, path, "business");
      expect(rows()).toHaveLength(12);
    });

    it("fails fast when the Reference column is absent (basic export)", async () => {
      const basic = "Date,Description,Amount\n15/01/2026,SUPERMARKET,12.50\n";
      const path = await writeCsv(basic);
      await expect(importAmexData(db, path, "personal")).rejects.toThrow(
        /Include all additional transaction details/
      );
    });
  });
});
