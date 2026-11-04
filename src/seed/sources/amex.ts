import { importAmexData } from "../../parsers/amex";
import type { SeedDay, SeedSource } from "../context";
import type { Rng } from "../rng";

/**
 * Alex's UK American Express card (kept from before the move), used for bigger
 * purchases in Seattle. The export is the "Include all additional transaction
 * details" CSV: posting dates as DD/MM/YYYY, GBP amounts (charges positive),
 * and the original USD amount in Extended Details.
 */

const ACCOUNT = "personal";
const HEADER = [
  "Date", "Description", "Card Member", "Account #", "Amount", "Extended Details", "Appears On Your Statement As",
  "Address", "Town/City", "Postcode", "Country", "Reference", "Category",
] as const;

interface Merchant {
  statement: string;
  category: string;
  usd: readonly [number, number];
  address: string;
  city?: string;
  postcode?: string;
}

const MERCHANTS = {
  traderJoes: { statement: "TRADER JOE'S #131", category: "General Purchases-Groceries", usd: [28, 95], address: "1700 E MADISON ST", postcode: "98122" },
  pcc: { statement: "PCC COMMUNITY MARKETS", category: "General Purchases-Groceries", usd: [22, 80], address: "1600 BROADWAY", postcode: "98122" },
  qfc: { statement: "QFC #5823", category: "General Purchases-Groceries", usd: [15, 60], address: "417 BROADWAY E", postcode: "98102" },
  copperleaf: { statement: "COPPERLEAF RAMEN", category: "Entertainment-Restaurants", usd: [32, 70], address: "CAPITOL HILL", postcode: "98122" },
  lakeview: { statement: "LAKEVIEW NOODLE HOUSE", category: "Entertainment-Restaurants", usd: [28, 64], address: "SOUTH LAKE UNION", postcode: "98109" },
  harbor: { statement: "HARBOR TAQUERIA", category: "Entertainment-Restaurants", usd: [24, 58], address: "DOWNTOWN", postcode: "98101" },
  piroshky: { statement: "PIROSHKY PIROSHKY", category: "Entertainment-Restaurants", usd: [8, 18], address: "1908 PIKE PL", postcode: "98101" },
  dinner: { statement: "TILIKUM PLACE CAFE", category: "Entertainment-Restaurants", usd: [55, 140], address: "407 CEDAR ST", postcode: "98121" },
  northbound: { statement: "NORTHBOUND BREWING", category: "Entertainment-Bars & Cafés", usd: [14, 62], address: "BALLARD", postcode: "98107" },
  driftwood: { statement: "DRIFTWOOD COFFEE", category: "Entertainment-Bars & Cafés", usd: [5, 16], address: "PIKE/PINE", postcode: "98122" },
  ticketmaster: { statement: "TICKETMASTER", category: "Entertainment-Theatrical Events", usd: [45, 180], address: "", city: "WEST HOLLYWOOD", postcode: "90069" },
  mopop: { statement: "MUSEUM OF POP CULTURE", category: "Entertainment-General Attractions", usd: [32, 64], address: "325 5TH AVE N", postcode: "98109" },
  amazon: { statement: "AMAZON.COM", category: "General Purchases-Online Purchases", usd: [9, 120], address: "410 TERRY AVE N", postcode: "98109" },
  rei: { statement: "REI #11 SEATTLE", category: "General Purchases-Sporting Goods Stores", usd: [25, 260], address: "222 YALE AVE N", postcode: "98109" },
  uniqlo: { statement: "UNIQLO UNIVERSITY VILLAGE", category: "General Purchases-Clothing Stores", usd: [30, 120], address: "4601 26TH AVE NE", postcode: "98105" },
  apple: { statement: "APPLE.COM/BILL", category: "General Purchases-Computer Supplies", usd: [0.99, 14.99], address: "ONE APPLE PARK WAY", city: "CUPERTINO", postcode: "95014" },
  bartell: { statement: "BARTELL DRUGS #12", category: "General Purchases-Pharmacies", usd: [6, 40], address: "600 BROADWAY E", postcode: "98102" },
  uber: { statement: "UBER *TRIP", category: "Travel-Taxis & Coach", usd: [12, 48], address: "1725 3RD ST", city: "SAN FRANCISCO", postcode: "94158" },
  alaska: { statement: "ALASKA AIRLINES", category: "Travel-Airline", usd: [120, 420], address: "19300 INTERNATIONAL BLVD", city: "SEATAC", postcode: "98188" },
  amtrak: { statement: "AMTRAK CASCADES", category: "Travel-Rail Services", usd: [38, 92], address: "303 S JACKSON ST", postcode: "98104" },
  hotel: { statement: "ACE HOTEL PORTLAND", category: "Travel-Lodging", usd: [180, 320], address: "1022 SW STARK ST", city: "PORTLAND", postcode: "97205" },
  parking: { statement: "SP+ PARKING", category: "General Purchases-Parking Charges", usd: [8, 32], address: "1ST AVE", postcode: "98104" },
  fuel: { statement: "SHELL OIL 57444", category: "General Purchases-Fuel", usd: [38, 64], address: "NORTH BEND WAY", city: "NORTH BEND", postcode: "98045" },
  dentist: { statement: "CAPITOL HILL DENTAL", category: "Business Services-Health Care Services", usd: [60, 240], address: "BROADWAY", postcode: "98102" },
  xfinity: { statement: "COMCAST XFINITY", category: "Business Services-Internet Services", usd: [65, 65], address: "1701 JFK BLVD", city: "PHILADELPHIA", postcode: "19103" },
  cityLight: { statement: "SEATTLE CITY LIGHT", category: "Business Services-Other Services", usd: [38, 96], address: "700 5TH AVE", postcode: "98104" },
} satisfies Record<string, Merchant>;

type MerchantKey = keyof typeof MERCHANTS;

/** Direct debits by day of month. */
const MONTHLY_BILLS: Readonly<Record<number, MerchantKey>> = { 6: "xfinity", 14: "apple", 18: "cityLight" };

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

interface Row {
  /** UTC-midnight posting date, for sorting. */
  date: string;
  cells: Record<(typeof HEADER)[number], string>;
}

function postingDate(date: string): string {
  const [y, m, d] = date.split("-");
  return `${d}/${m}/${y}`;
}

export const amexSeed: SeedSource = {
  name: "amex",
  produces: {
    amex: [
      "transaction",
      "transaction:payment",
      "transaction:refund",
      "transaction:groceries",
      "transaction:food",
      "transaction:transport",
      "transaction:entertainment",
      "transaction:shopping",
      "transaction:health",
    ],
  },
  async seed(ctx) {
    const rng = ctx.rng("amex");
    const rows: Row[] = [];
    let statementGbp = 0;

    const reference = (prefix: string, year: string) => `'${prefix}${year.slice(2)}${rng.digits(19)}'`;
    const usdToGbp = (day: SeedDay) => 1.27 + 0.04 * Math.sin(day.index / 120);

    const charge = (day: SeedDay, key: MerchantKey, refund = false) => {
      const m: Merchant = MERCHANTS[key];
      const usd = Math.round(rng.float(m.usd[0], m.usd[1]) * 100) / 100;
      const rate = Math.round(usdToGbp(day) * 10_000) / 10_000;
      const commission = Math.round((usd / rate) * 0.0299 * 100) / 100;
      const gbp = Math.round((usd / rate + commission) * 100) / 100;
      const city = m.city ?? "SEATTLE";
      const description = `${m.statement.padEnd(22, " ")} ${city}`;
      // Charges post a day or two after the purchase.
      const posted = ctx.days[Math.min(ctx.days.length - 1, day.index + rng.int(0, 2))] ?? day;
      const amount = refund ? -gbp : gbp;
      statementGbp += amount;
      rows.push({
        date: posted.date,
        cells: {
          Date: postingDate(posted.date),
          Description: description,
          "Card Member": "ALEX RIVERA",
          "Account #": "-21005",
          Amount: amount.toFixed(2),
          "Extended Details": `Foreign Spend Amount: ${usd.toFixed(2)} US DOLLAR Commission Amount: ${commission.toFixed(2)} Currency Exchange Rate: ${rate.toFixed(4)}`,
          "Appears On Your Statement As": description,
          Address: m.address,
          "Town/City": city,
          Postcode: m.postcode ?? "",
          Country: "UNITED STATES",
          Reference: reference("AT", posted.date),
          Category: m.category,
        },
      });
    };

    const pick = (items: readonly (readonly [MerchantKey, number])[]) => rng.weighted(items);

    const spendDay = (day: SeedDay) => {
      if (rng.chance(day.isWeekend ? 0.6 : 0.35)) charge(day, pick([["traderJoes", 4], ["pcc", 2], ["qfc", 2]]));
      if (rng.chance(day.isWeekend ? 0.55 : 0.3)) {
        charge(day, pick([["copperleaf", 3], ["lakeview", 2], ["harbor", 2], ["piroshky", 1], ["dinner", day.weekday === 6 ? 2 : 0.4]]));
      }
      if (rng.chance(day.isWeekend ? 0.35 : 0.12)) charge(day, pick([["northbound", 3], ["driftwood", 2]]));
      if (rng.chance(0.3)) charge(day, "amazon");
      if (rng.chance(0.1)) charge(day, "uber");
      if (rng.chance(0.04)) charge(day, pick([["rei", 3], ["uniqlo", 2], ["bartell", 2]]));
      if (rng.chance(0.03)) charge(day, pick([["ticketmaster", 2], ["mopop", 1]]));
      if (day.weekday === 6 && rng.chance(0.2)) charge(day, pick([["fuel", 3], ["parking", 2]]));
      if (rng.chance(0.006)) charge(day, "dentist");
      if (rng.chance(0.012)) {
        // A Portland trip to see Mei.
        charge(day, pick([["alaska", 2], ["amtrak", 3]]));
        if (rng.chance(0.5)) charge(day, "hotel");
      }
      const bill = MONTHLY_BILLS[Number(day.date.slice(8, 10))];
      if (bill) charge(day, bill);
      if (rng.chance(0.012)) charge(day, pick([["amazon", 4], ["rei", 1], ["uniqlo", 1]]), true);
    };

    const payStatement = (day: SeedDay) => {
      if (Number(day.date.slice(8, 10)) === 25 && statementGbp > 0) {
        const amount = Math.round(statementGbp * 100) / 100;
        statementGbp = 0;
        rows.push({
          date: day.date,
          cells: {
            Date: postingDate(day.date),
            Description: "PAYMENT RECEIVED - THANK YOU",
            "Card Member": "ALEX RIVERA",
            "Account #": "-21005",
            Amount: (-amount).toFixed(2),
            "Extended Details": "",
            "Appears On Your Statement As": "PAYMENT RECEIVED - THANK YOU",
            Address: "",
            "Town/City": "",
            Postcode: "",
            Country: "",
            Reference: reference("1000", day.date),
            Category: "",
          },
        });
      }
    };

    for (const day of ctx.days) {
      spendDay(day);
      payStatement(day);
    }

    // One "by year" export per calendar year, newest transaction first.
    const byYear = new Map<string, Row[]>();
    for (const row of rows) {
      const year = row.date.slice(0, 4);
      const list = byYear.get(year);
      if (list) list.push(row);
      else byYear.set(year, [row]);
    }
    for (const [year, yearRows] of byYear) {
      yearRows.sort((a, b) => b.date.localeCompare(a.date));
      const lines = [HEADER.join(","), ...yearRows.map((row) => HEADER.map((h) => csvCell(row.cells[h])).join(","))];
      const path = ctx.writeStaged("amex", `activity-${year}.csv`, `${lines.join("\n")}\n`);
      await importAmexData(ctx.db, path, ACCOUNT);
    }
  },
};
