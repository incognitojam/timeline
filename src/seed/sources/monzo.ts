import { upsertIdentities } from "../../db/queries";
import type { UpsertIdentityOptions } from "../../db/identities";
import { extractCounterpartyIdentity, type MonzoTransaction } from "../../parsers/monzo";
import type { SeedContext, SeedDay, SeedSource } from "../context";
import { type PersonKey, personByKey, PLACES, type Place, VENUES } from "../persona";
import type { Rng } from "../rng";

/**
 * Alex kept a Monzo (GBP) account from before moving to Seattle and uses it as
 * an everyday card: Monzo converts each USD purchase, so `amount` is pence and
 * `local_amount` is the original cents.
 *
 * The Monzo parser only exposes its OAuth sync; its title/type helpers are
 * private. This builds API-shaped transactions and replays the sync's insert
 * (mirrored helpers below) plus its exported counterparty-identity mapping.
 */

const ACCOUNT = { id: "acc_00009Seed1AlexRivera01", description: "user_00009SeedAlexRivera", type: "uk_retail" };

interface Merchant {
  name: string;
  category: string;
  emoji: string;
  /** USD price range in dollars. */
  price: readonly [number, number];
  place?: Place;
  online?: boolean;
  atm?: boolean;
}

function at(name: string): Place {
  const found = [...PLACES, ...VENUES].find((p) => p.name === name);
  if (!found) throw new Error(`Unknown seed place: ${name}`);
  return found;
}

function local(name: string, lat: number, lng: number, address: string): Place {
  return { name, lat, lng, category: "", address };
}

/** Keeps each merchant typed as a Merchant while preserving the keys. */
function merchants<K extends string>(m: Record<K, Merchant>): Record<K, Merchant> {
  return m;
}

const M = merchants({
  driftwood: { name: "Driftwood Coffee", category: "eating_out", emoji: "☕", price: [4.5, 7.5], place: at("Driftwood Coffee") },
  cedar: { name: "Cedar & Salt Bakery", category: "eating_out", emoji: "🥐", price: [5, 14], place: at("Cedar & Salt Bakery") },
  noodle: { name: "Lakeview Noodle House", category: "eating_out", emoji: "🍜", price: [13, 19], place: at("Lakeview Noodle House") },
  taqueria: { name: "Harbor Taqueria", category: "eating_out", emoji: "🌮", price: [11, 17], place: at("Harbor Taqueria") },
  piroshky: { name: "Piroshky Piroshky", category: "eating_out", emoji: "🥟", price: [7, 13], place: local("Piroshky Piroshky", 47.6098, -122.3424, "1908 Pike Pl, Seattle, WA") },
  ramen: { name: "Copperleaf Ramen", category: "eating_out", emoji: "🍜", price: [16, 24], place: at("Copperleaf Ramen") },
  brewery: { name: "Northbound Brewing", category: "eating_out", emoji: "🍺", price: [8, 32], place: at("Northbound Brewing") },
  grocery: { name: "Greenline Grocery", category: "groceries", emoji: "🛒", price: [6, 34], place: at("Greenline Grocery") },
  lime: { name: "Lime", category: "transport", emoji: "🛴", price: [2.5, 8], online: true },
  uber: { name: "Uber", category: "transport", emoji: "🚕", price: [11, 38], online: true },
  orca: { name: "Sound Transit", category: "transport", emoji: "🚆", price: [10, 40], place: local("Sound Transit", 47.6114, -122.3365, "Westlake Station, Seattle, WA") },
  ferry: { name: "Washington State Ferries", category: "transport", emoji: "⛴️", price: [9.85, 9.85], place: local("Washington State Ferries", 47.6025, -122.3384, "Colman Dock, Seattle, WA") },
  climbing: { name: "Fern Street Climbing Gym", category: "entertainment", emoji: "🧗", price: [24, 24], place: at("Fern Street Climbing Gym") },
  siff: { name: "SIFF Cinema Egyptian", category: "entertainment", emoji: "🎬", price: [14, 16], place: local("SIFF Cinema Egyptian", 47.6145, -122.3197, "805 E Pine St, Seattle, WA") },
  books: { name: "Elliott Bay Book Company", category: "shopping", emoji: "📚", price: [16, 42], place: at("Elliott Bay Book Company") },
  rei: { name: "REI", category: "shopping", emoji: "🏔️", price: [18, 140], place: local("REI", 47.6201, -122.3296, "222 Yale Ave N, Seattle, WA") },
  bartell: { name: "Bartell Drugs", category: "general", emoji: "💊", price: [4, 26], place: local("Bartell Drugs", 47.6228, -122.3208, "Broadway E, Seattle, WA") },
  atm: { name: "ATM", category: "cash", emoji: "🏧", price: [60, 100], place: local("ATM", 47.6146, -122.3205, "Broadway, Seattle, WA"), atm: true },
  spotify: { name: "Spotify", category: "bills", emoji: "🎧", price: [11.99, 11.99], online: true },
  netflix: { name: "Netflix", category: "bills", emoji: "📺", price: [15.49, 15.49], online: true },
  icloud: { name: "Apple", category: "bills", emoji: "☁️", price: [2.99, 2.99], online: true },
});

/** Friends who pay Alex back through Monzo; only `user_` ids are durable. */
const P2P: readonly { key: PersonKey; userId: string | null }[] = [
  { key: "rowan", userId: "user_00009RowanHaleSeed01" },
  { key: "mei", userId: "user_00009MeiRiveraSeed01" },
  { key: "linda", userId: "user_00009LindaRiveraSd01" },
  { key: "sam", userId: null },
  { key: "priya", userId: null },
];

const HOLIDAY_POT = { id: "pot_00009HolidaySeed0001", name: "Holiday" };

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function monzoId(rng: Rng, prefix: string): string {
  let out = `${prefix}_0000`;
  for (let i = 0; i < 18; i++) out += BASE62[rng.int(0, 61)];
  return out;
}

// Mirrors formatAmount/getTransactionTitle/getTransactionType in src/parsers/monzo.ts.
function formatAmount(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(Math.abs(amount) / 100);
}

function transactionTitle(tx: MonzoTransaction, potNames: Map<string, string>): string {
  const amount = formatAmount(tx.amount, tx.currency);
  const sign = tx.amount >= 0 ? "+" : "-";
  if (typeof tx.merchant === "object" && tx.merchant?.name) return `${sign}${amount} at ${tx.merchant.name}`;
  if (tx.counterparty?.name) return `${sign}${amount} ${tx.amount >= 0 ? "from" : "to"} ${tx.counterparty.name}`;
  let desc = tx.description;
  for (const [potId, potName] of potNames) desc = desc.replace(potId, potName);
  return `${sign}${amount} - ${desc}`;
}

function transactionType(tx: MonzoTransaction): string {
  if (tx.decline_reason) return "transaction:declined";
  if (tx.is_load) return "transaction:topup";
  if (tx.amount > 0) return "transaction:credit";
  const types: Record<string, string> = {
    transport: "transaction:transport",
    groceries: "transaction:groceries",
    eating_out: "transaction:food",
    entertainment: "transaction:entertainment",
    shopping: "transaction:shopping",
    bills: "transaction:bills",
    cash: "transaction:cash",
  };
  return types[tx.category?.toLowerCase()] ?? "transaction";
}

class Ledger {
  readonly txs: MonzoTransaction[] = [];
  private readonly merchantIds = new Map<string, { id: string; group: string }>();

  constructor(
    private readonly ctx: SeedContext,
    private readonly rng: Rng,
  ) {}

  /** GBP per USD, drifting slowly over the range. */
  private rate(day: SeedDay): number {
    return 0.79 + 0.03 * Math.sin(day.index / 140);
  }

  private when(day: SeedDay, hour: number, minute: number): string {
    return this.ctx.localIso(day.date, hour, minute, this.rng.int(0, 59));
  }

  private settled(created: string): string {
    return new Date(Date.parse(created) + this.rng.int(18, 60) * 3_600_000).toISOString();
  }

  spend(day: SeedDay, merchant: Merchant, hour: number, minute: number, notes = ""): void {
    const rng = this.rng;
    const usdCents = Math.round(rng.float(merchant.price[0], merchant.price[1]) * 100);
    let ids = this.merchantIds.get(merchant.name);
    if (!ids) {
      ids = { id: monzoId(rng, "merch"), group: monzoId(rng, "grp") };
      this.merchantIds.set(merchant.name, ids);
    }
    const created = this.when(day, hour, minute);
    const p = merchant.place;
    const parts = p?.address.split(", ") ?? [];
    const declined = rng.chance(0.004);
    this.txs.push({
      id: monzoId(rng, "tx"),
      created,
      description: merchant.name.toUpperCase().replace(/[^A-Z0-9 ]/g, "").padEnd(22, " ") + (p ? "SEATTLE      WA" : "ONLINE"),
      amount: -Math.round(usdCents * this.rate(day)),
      currency: "GBP",
      merchant: {
        id: ids.id,
        group_id: ids.group,
        name: merchant.name,
        logo: "",
        emoji: merchant.emoji,
        category: merchant.category,
        online: merchant.online ?? false,
        atm: merchant.atm ?? false,
        address: {
          short_formatted: p ? p.address : "",
          formatted: p ? `${p.address}, United States` : "",
          address: parts[0] ?? "",
          city: p ? "Seattle" : "",
          region: p ? "WA" : "",
          country: "USA",
          postcode: p ? "98102" : "",
          latitude: p?.lat ?? 0,
          longitude: p?.lng ?? 0,
        },
      },
      notes,
      metadata: {},
      category: merchant.category,
      is_load: false,
      settled: declined ? "" : this.settled(created),
      local_amount: -usdCents,
      local_currency: "USD",
      ...(declined ? { decline_reason: "INSUFFICIENT_FUNDS" } : {}),
    });
  }

  transfer(day: SeedDay, key: PersonKey, userId: string | null, pence: number, notes: string): void {
    const person = personByKey(key);
    const created = this.when(day, this.rng.int(9, 22), this.rng.int(0, 59));
    this.txs.push({
      id: monzoId(this.rng, "tx"),
      created,
      description: notes,
      amount: pence,
      currency: "GBP",
      merchant: null,
      notes,
      metadata: {},
      category: "general",
      is_load: false,
      settled: created,
      local_amount: pence,
      local_currency: "GBP",
      counterparty: userId
        ? { name: person.name, user_id: userId, account_id: monzoId(this.rng, "acc"), preferred_name: person.first }
        : { name: person.name, user_id: `anonuser_${this.rng.hex(22)}` },
    });
  }

  other(day: SeedDay, fields: Partial<MonzoTransaction> & Pick<MonzoTransaction, "description" | "amount" | "category">): void {
    const created = this.when(day, this.rng.int(7, 21), this.rng.int(0, 59));
    this.txs.push({
      id: monzoId(this.rng, "tx"),
      created,
      merchant: null,
      notes: "",
      metadata: {},
      is_load: false,
      settled: created,
      currency: "GBP",
      local_amount: fields.amount,
      local_currency: "GBP",
      ...fields,
    });
  }
}

const SPLIT_NOTES = ["gas for the hike 🚗", "trailhead parking", "brunch", "concert tix", "pizza night", "groceries for the cabin", "Kraken tickets"];
const FAMILY_NOTES = ["happy birthday love Mum x", "for the flights", "treat yourself", "christmas money 🎄"];

function weekdaySpending(ledger: Ledger, rng: Rng, day: SeedDay): void {
  if (rng.chance(0.62)) ledger.spend(day, rng.weighted([[M.driftwood, 4], [M.cedar, 1]]), 8, rng.int(5, 55));
  if (rng.chance(0.5)) ledger.spend(day, rng.weighted([[M.noodle, 3], [M.taqueria, 2], [M.piroshky, 1]]), 12, rng.int(0, 50));
  if (rng.chance(0.28)) ledger.spend(day, M.lime, rng.pick([8, 17, 18]), rng.int(0, 59));
  if ((day.weekday === 2 || day.weekday === 4) && rng.chance(0.35)) ledger.spend(day, M.climbing, 18, rng.int(0, 30));
  if (rng.chance(0.2)) ledger.spend(day, M.grocery, 18, rng.int(20, 59));
}

function weekendSpending(ledger: Ledger, rng: Rng, day: SeedDay): void {
  if (rng.chance(0.55)) ledger.spend(day, M.cedar, 10, rng.int(0, 59));
  if (rng.chance(0.3)) ledger.spend(day, rng.weighted([[M.ramen, 2], [M.brewery, 3], [M.taqueria, 1]]), rng.int(17, 20), rng.int(0, 59));
  if (rng.chance(0.25)) ledger.spend(day, M.uber, rng.pick([11, 19, 22, 23]), rng.int(0, 59));
  if (rng.chance(0.25)) ledger.spend(day, M.grocery, rng.int(11, 17), rng.int(0, 59));
  if (rng.chance(0.08)) ledger.spend(day, M.siff, 19, rng.int(0, 30));
  if (rng.chance(0.1)) ledger.spend(day, M.books, rng.int(12, 16), rng.int(0, 59));
  if (rng.chance(0.03)) ledger.spend(day, M.ferry, 9, rng.int(0, 40));
}

function anyDaySpending(ledger: Ledger, rng: Rng, day: SeedDay): void {
  const dom = Number(day.date.slice(8, 10));
  if (rng.chance(0.05)) ledger.spend(day, M.rei, rng.int(12, 18), rng.int(0, 59));
  if (rng.chance(0.06)) ledger.spend(day, M.bartell, rng.int(9, 20), rng.int(0, 59));
  if (rng.chance(0.08)) ledger.spend(day, M.orca, rng.int(7, 9), rng.int(0, 59));
  if (dom === 3) ledger.spend(day, M.spotify, 4, 12);
  if (dom === 11) ledger.spend(day, M.netflix, 3, 40);
  if (dom === 21) ledger.spend(day, M.icloud, 5, 5);
  if (rng.chance(0.03)) ledger.spend(day, M.atm, rng.int(10, 20), rng.int(0, 59));
}

function moneyMovements(ledger: Ledger, rng: Rng, day: SeedDay): void {
  const dom = Number(day.date.slice(8, 10));
  // Top up from Alex's US bank every other Friday.
  if (day.weekday === 5 && day.index % 14 < 7) {
    ledger.other(day, { description: "Top up", amount: rng.int(15, 35) * 1000, category: "general", is_load: true });
  }
  // Monthly savings into the holiday pot, and the odd refund.
  if (dom === 1) ledger.other(day, { description: HOLIDAY_POT.id, amount: -5000, category: "savings" });
  if (rng.chance(0.01)) {
    const merchant = rng.pick([M.rei, M.books, M.uber]);
    ledger.other(day, {
      description: `${merchant.name.toUpperCase()} REFUND`,
      amount: rng.int(800, 6000),
      category: merchant.category,
      notes: "refund",
    });
  }
  // Friends square up after weekends; family sends birthday money.
  if (day.weekday === 1 && rng.chance(0.25)) {
    const friend = rng.pick(P2P.filter((p) => p.key !== "linda"));
    ledger.transfer(day, friend.key, friend.userId, rng.int(8, 45) * 100, rng.pick(SPLIT_NOTES));
  }
  if (day.weekday === 0 && rng.chance(0.06)) {
    const friend = rng.pick(P2P.filter((p) => p.key !== "linda"));
    ledger.transfer(day, friend.key, friend.userId, -rng.int(10, 60) * 100, rng.pick(SPLIT_NOTES));
  }
  if (day.date.slice(5) === "06-14" || day.date.slice(5) === "12-20") {
    const mum = P2P.find((p) => p.key === "linda");
    if (mum) ledger.transfer(day, mum.key, mum.userId, rng.pick([5000, 7500, 10000]), rng.pick(FAMILY_NOTES));
  }
}

export const monzoSeed: SeedSource = {
  name: "monzo",
  produces: {
    monzo: [
      "transaction",
      "transaction:topup",
      "transaction:credit",
      "transaction:transport",
      "transaction:food",
      "transaction:groceries",
      "transaction:entertainment",
      "transaction:shopping",
      "transaction:bills",
      "transaction:cash",
    ],
  },
  async seed(ctx) {
    const rng = ctx.rng("monzo");
    const ledger = new Ledger(ctx, rng);

    for (const day of ctx.days) {
      if (day.isWeekend) weekendSpending(ledger, rng, day);
      else weekdaySpending(ledger, rng, day);
      anyDaySpending(ledger, rng, day);
      moneyMovements(ledger, rng, day);
    }

    const potNames = new Map([[HOLIDAY_POT.id, HOLIDAY_POT.name]]);
    const insert = ctx.db.prepare(`
      INSERT OR IGNORE INTO events (
        source, source_id, source_account, type, timestamp,
        title, content, latitude, longitude, location_name,
        people, tags, raw_data, import_batch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const importBatch = `monzo-sync-${ctx.anchorDate}`;
    const identities: UpsertIdentityOptions[] = [];

    // The API returns oldest first; the sync skips declined transactions.
    ledger.txs.sort((a, b) => a.created.localeCompare(b.created));
    ctx.db.transaction(() => {
      for (const tx of ledger.txs) {
        if (tx.decline_reason) continue;
        const title = transactionTitle(tx, potNames);
        let lat: number | null = null;
        let lng: number | null = null;
        let locName: string | null = null;
        if (typeof tx.merchant === "object" && tx.merchant?.address) {
          lat = tx.merchant.address.latitude || null;
          lng = tx.merchant.address.longitude || null;
          locName = tx.merchant.address.short_formatted || null;
        }
        const tags = [tx.category, ACCOUNT.type].filter(Boolean);
        const counterparty = extractCounterpartyIdentity(tx);
        if (counterparty) identities.push(counterparty.identity);
        insert.run(
          "monzo", tx.id, ACCOUNT.type, transactionType(tx), tx.created,
          title, title, lat, lng, locName,
          counterparty ? JSON.stringify([counterparty.identifier]) : null,
          JSON.stringify(tags), JSON.stringify({ ...tx, account_id: ACCOUNT.id }), importBatch,
        );
      }
    })();

    const unique = new Map(identities.map((identity) => [identity.platformId, identity]));
    upsertIdentities(ctx.db, [...unique.values()]);
    for (const { key, userId } of P2P) {
      if (userId && unique.has(userId)) ctx.identify(key, `monzo:${userId}`);
    }
  },
};
