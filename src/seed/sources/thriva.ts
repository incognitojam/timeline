import { getBiomarkerInfo } from "../../parsers/thriva-biomarkers";
import { getProfileInfo } from "../../parsers/thriva-profiles";
import type { SeedContext, SeedSource } from "../context";
import type { Rng } from "../rng";

/**
 * Thriva home blood tests. The parser's sync logs in with a password from
 * ~/.config and fetches its JSON:API, so this builds the same biomarker_result
 * and shop_order resources (biomarkers drawn from the parser's own profile and
 * biomarker maps) and replays the sync's inserts, titles, and tags.
 */

/** The sync derives the account from the login email's local part. */
const ACCOUNT = "alex.rivera";

type Level = "optimal" | "normal" | "abnormal" | "highly_abnormal";

interface Marker {
  unit: string;
  /** Normal range; null for an open bound. */
  low: number | null;
  high: number | null;
  /** Values at or beyond this are "optimal" (direction follows the range). */
  optimal?: { above?: number; below?: number };
  decimals: number;
  /** Alex's typical value, before the per-test story adjusts it. */
  typical: number;
  spread: number;
  /** Reported as "<x" / ">x" when beyond the assay limit. */
  floor?: { operator: "<" | ">"; at: number };
}

const MARKERS: Readonly<Record<string, Marker>> = {
  VIDC: { unit: "nmol/L", low: 50, high: 200, optimal: { above: 75 }, decimals: 0, typical: 70, spread: 8 },
  AB12: { unit: "pmol/L", low: 37.5, high: 188, optimal: { above: 70 }, decimals: 0, typical: 88, spread: 12 },
  FOLA: { unit: "ug/L", low: 3.9, high: 26.8, decimals: 1, typical: 9.4, spread: 1.6 },
  FERR: { unit: "ug/L", low: 30, high: 400, decimals: 0, typical: 112, spread: 20 },
  TSH: { unit: "mIU/L", low: 0.27, high: 4.2, decimals: 2, typical: 1.9, spread: 0.35 },
  FT4: { unit: "pmol/L", low: 12, high: 22, decimals: 1, typical: 16.2, spread: 1.2 },
  CHO: { unit: "mmol/L", low: null, high: 5, decimals: 1, typical: 4.8, spread: 0.25 },
  HDL: { unit: "mmol/L", low: 1, high: null, optimal: { above: 1.4 }, decimals: 2, typical: 1.45, spread: 0.08 },
  LDL: { unit: "mmol/L", low: null, high: 3, optimal: { below: 2.6 }, decimals: 1, typical: 2.9, spread: 0.2 },
  TRI: { unit: "mmol/L", low: null, high: 1.7, optimal: { below: 1.2 }, decimals: 2, typical: 0.95, spread: 0.15 },
  NHDF: { unit: "mmol/L", low: null, high: 4, decimals: 1, typical: 3.35, spread: 0.2 },
  CHDD: { unit: "ratio", low: null, high: 4, optimal: { below: 3.5 }, decimals: 1, typical: 3.3, spread: 0.2 },
  THR: { unit: "ratio", low: null, high: 1.6, decimals: 2, typical: 0.66, spread: 0.1 },
  HCR: { unit: "%", low: 20, high: null, decimals: 0, typical: 30, spread: 2 },
  BILI: { unit: "umol/L", low: null, high: 21, decimals: 0, typical: 11, spread: 3 },
  ALP: { unit: "U/L", low: 30, high: 130, decimals: 0, typical: 72, spread: 8 },
  GGT: { unit: "U/L", low: null, high: 60, decimals: 0, typical: 21, spread: 4 },
  PROT: { unit: "g/L", low: 60, high: 80, decimals: 0, typical: 71, spread: 2 },
  ALB: { unit: "g/L", low: 35, high: 50, decimals: 0, typical: 45, spread: 1.5 },
  GLOB: { unit: "g/L", low: 19, high: 35, decimals: 0, typical: 26, spread: 2 },
  ALT: { unit: "U/L", low: null, high: 50, decimals: 0, typical: 24, spread: 5 },
  GHBI: { unit: "mmol/mol", low: 20, high: 41, decimals: 0, typical: 34, spread: 1.5 },
  CRP: { unit: "mg/L", low: null, high: 5, decimals: 1, typical: 0.9, spread: 0.4, floor: { operator: "<", at: 0.6 } },
  CREA: { unit: "umol/L", low: 59, high: 104, decimals: 0, typical: 82, spread: 5 },
  GFR: { unit: "mL/min/1.73m2", low: 90, high: null, decimals: 0, typical: 96, spread: 4, floor: { operator: ">", at: 90 } },
};

interface Test {
  /** Days before the anchor that the order completed (kit dispatched). */
  orderedDaysAgo: number;
  profiles: readonly string[];
  totalCents: number;
  creditCents?: number;
  discountCents?: number;
  /** Shifts from the typical value for this test, by biomarker. */
  shift?: Readonly<Record<string, number>>;
}

/** A dark first winter in Seattle, then vitamin D supplements and less takeaway. */
const TESTS: readonly Test[] = [
  { orderedDaysAgo: 1018, profiles: ["VITD", "LIPP", "LFT", "GHB", "FERR", "CRP"], totalCents: 7900, discountCents: 1000, shift: { VIDC: -26, LDL: 0.4, CHO: 0.4, NHDF: 0.4 } },
  { orderedDaysAgo: 766, profiles: ["VITD", "BVIT", "LIPP"], totalCents: 5900, shift: { VIDC: 14, LDL: 0.1 } },
  { orderedDaysAgo: 563, profiles: ["VITD", "LIPP", "TF", "CREA", "FERR"], totalCents: 6900, creditCents: 1500, shift: { VIDC: 10, LDL: -0.2 } },
  { orderedDaysAgo: 234, profiles: ["VITD", "LIPP", "LFT", "GHB", "CRP", "BVIT"], totalCents: 8900, shift: { VIDC: 18, LDL: -0.35, CHO: -0.3, HDL: 0.08 } },
];

function levelFor(marker: Marker, value: number): Level {
  const outside = (marker.low !== null && value < marker.low) || (marker.high !== null && value > marker.high);
  if (outside) {
    const span = (marker.high ?? (marker.low ?? 0) * 2) - (marker.low ?? 0);
    const far = (marker.low !== null && value < marker.low - span * 0.3) || (marker.high !== null && value > marker.high + span * 0.3);
    return far ? "highly_abnormal" : "abnormal";
  }
  const o = marker.optimal;
  if (o && ((o.above !== undefined && value >= o.above) || (o.below !== undefined && value <= o.below))) return "optimal";
  return "normal";
}

function referenceRanges(marker: Marker) {
  const ranges: { name: string; level: string; lower_bound: number | null; upper_bound: number | null; description: string }[] = [];
  if (marker.low !== null) ranges.push({ name: "Low", level: "abnormal", lower_bound: null, upper_bound: marker.low, description: "Below the normal range" });
  ranges.push({ name: "Normal", level: "normal", lower_bound: marker.low, upper_bound: marker.high, description: "Within the normal range" });
  if (marker.high !== null) ranges.push({ name: "High", level: "abnormal", lower_bound: marker.high, upper_bound: null, description: "Above the normal range" });
  return ranges;
}

// Mirrors getLevelIndicator in src/parsers/thriva.ts.
const LEVEL_INDICATOR: Record<Level, string> = { optimal: "++", normal: "", abnormal: "!", highly_abnormal: "!!" };

/** Local date of a test's order; every test falls inside the seeded range. */
function orderedDate(ctx: SeedContext, test: Test): string {
  const day = ctx.days[ctx.days.length - 1 - test.orderedDaysAgo];
  if (!day) throw new Error(`Thriva seed test ${test.orderedDaysAgo} days ago is outside the seeded range`);
  return day.date;
}

function results(ctx: SeedContext, rng: Rng, test: Test) {
  // The kit arrives and is posted back a few days after the order.
  const collected = ctx.localDate(orderedDate(ctx, test), 7 + 24 * rng.int(3, 6), rng.int(10, 50));
  const processed = new Date(collected.getTime() + rng.int(30, 54) * 3_600_000);
  const codes = [...new Set(test.profiles.flatMap((p) => getProfileInfo(p).biomarkers))];
  return codes.map((code) => {
    const marker = MARKERS[code];
    if (!marker) throw new Error(`No seed reference values for Thriva biomarker ${code}`);
    const raw = rng.normal(marker.typical + (test.shift?.[code] ?? 0), marker.spread);
    const value = Number(Math.max(0, raw).toFixed(marker.decimals));
    const floored = marker.floor && (marker.floor.operator === "<" ? value < marker.floor.at : value > marker.floor.at);
    const reported = floored && marker.floor ? marker.floor.at : value;
    return {
      id: rng.uuid(),
      type: "biomarker_result" as const,
      attributes: {
        type: "numeric" as const,
        value: reported,
        unit: marker.unit,
        operator: floored && marker.floor ? marker.floor.operator : null,
        level: levelFor(marker, value),
        notes: "",
        reference_ranges: referenceRanges(marker),
        sample_collected_at: collected.toISOString(),
        sample_processed_at: processed.toISOString(),
        timestamp: processed.toISOString(),
        status: "successful" as const,
        source: "thriva",
        failure_reason: null,
      },
      relationships: { biomarker: { data: { type: "biomarker" as const, id: code } } },
    };
  });
}

export const thrivaSeed: SeedSource = {
  name: "thriva",
  produces: { thriva: ["thriva:biomarker", "thriva:order"] },
  async seed(ctx) {
    const rng = ctx.rng("thriva");
    const db = ctx.db;
    const importBatch = `thriva-seed-${ctx.anchorDate}`;
    const insert = db.prepare(`
      INSERT OR IGNORE INTO events (
        source, source_id, source_account, type, timestamp,
        title, content, tags, raw_data, import_batch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    db.transaction(() => {
      for (const test of TESTS) {
        for (const result of results(ctx, rng, test)) {
          const biomarkerId = result.relationships.biomarker.data.id;
          const biomarker = getBiomarkerInfo(biomarkerId);
          const attrs = result.attributes;
          const indicator = LEVEL_INDICATOR[attrs.level];
          const valueStr = attrs.operator != null ? `${attrs.operator}${attrs.value}` : String(attrs.value);
          const sourceLabel = attrs.source !== "thriva" ? ` (${attrs.source})` : "";
          const title = `${biomarker.name}: ${valueStr} ${attrs.unit}${indicator ? ` ${indicator}` : ""}${sourceLabel}`.trim();
          const content = `${biomarker.name} (${biomarkerId}): ${valueStr} ${attrs.unit} - ${attrs.level}`;
          const tags = [biomarkerId, biomarker.category, attrs.level, attrs.source];
          insert.run("thriva", result.id, ACCOUNT, "thriva:biomarker", attrs.sample_collected_at, title, content, JSON.stringify(tags), JSON.stringify(result), importBatch);
        }

        const created = ctx.localDate(orderedDate(ctx, test), 8, rng.int(0, 59), rng.int(0, 59));
        const completed = new Date(created.getTime() + rng.int(2, 20) * 60_000);
        const credit = test.creditCents ?? 0;
        const discount = test.discountCents ?? 0;
        const order = {
          id: String(rng.int(1_200_000, 1_999_999)),
          type: "shop_order" as const,
          attributes: {
            order_state: "complete",
            completed_at: completed.toISOString(),
            created_at: created.toISOString(),
            total_cents: test.totalCents - credit - discount,
            sub_total_cents: test.totalCents,
            credit_applied_cents: credit,
            discount_amount_cents: discount,
          },
          relationships: {
            test_cycles: { data: [{ type: "test_cycle", id: String(rng.int(300_000, 999_999)) }] },
            line_items: { data: test.profiles.map((profile) => ({ type: "line_item", id: `${profile}-${rng.int(10_000, 99_999)}` })) },
          },
        };
        const attrs = order.attributes;
        const total = (attrs.total_cents / 100).toFixed(2);
        const contentParts = [`Order ${order.id}: £${total}`];
        if (attrs.credit_applied_cents > 0) contentParts.push(`(£${(attrs.credit_applied_cents / 100).toFixed(2)} credit applied)`);
        if (attrs.discount_amount_cents > 0) contentParts.push(`(£${(attrs.discount_amount_cents / 100).toFixed(2)} discount)`);
        insert.run(
          "thriva", order.id, ACCOUNT, "thriva:order", attrs.completed_at || attrs.created_at,
          `Blood Test Order - £${total}`, contentParts.join(" "), JSON.stringify([attrs.order_state]), JSON.stringify(order), importBatch,
        );
      }
    })();
  },
};
