/**
 * Where Alex was, minute by minute, for the whole seed range. Google Location
 * History (older years), Google Timeline (recent years), Google Fit, and
 * Google Calendar all read from this one plan so commutes, hikes, and trips
 * line up across sources.
 */
import type { SeedContext, SeedDay } from "../context";
import { HOME, OFFICE, PLACES, type PersonKey, type Place, VENUES } from "../persona";
import type { Rng } from "../rng";
import { stableHash } from "./google-data";

export interface PlanPlace extends Place {
  placeId: string;
  semantic: "HOME" | "WORK" | "UNKNOWN";
}

export type MoveMode = "WALKING" | "RUNNING" | "CYCLING" | "IN_BUS" | "IN_PASSENGER_VEHICLE" | "IN_TRAIN" | "FLYING";

export interface PlanVisit {
  kind: "visit";
  place: PlanPlace;
  start: Date;
  end: Date;
}

export interface PlanMove {
  kind: "move";
  from: PlanPlace;
  to: PlanPlace;
  start: Date;
  end: Date;
  mode: MoveMode;
  distanceM: number;
}

export type PlanSegment = PlanVisit | PlanMove;

export interface PlanTrip {
  destination: "Portland" | "San Francisco";
  startDate: string;
  endDate: string;
}

export interface PlanHike {
  date: string;
  trailhead: PlanPlace;
  start: Date;
  end: Date;
  companions: PersonKey[];
}

export interface LocationPlan {
  segments: PlanSegment[];
  trips: PlanTrip[];
  hikes: PlanHike[];
}

const PLACE_ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

/** Synthetic Google place id ("ChIJ…"), stable per place name. */
function placeIdFor(name: string): string {
  let h = stableHash(`place:${name}`);
  let out = "ChIJ";
  for (let i = 0; i < 23; i++) {
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
    h = (h + 0x9e3779b9 + i) >>> 0;
    out += PLACE_ID_CHARS[h % 64];
  }
  return out;
}

function planPlace(place: Place, semantic: PlanPlace["semantic"] = "UNKNOWN"): PlanPlace {
  return { ...place, placeId: placeIdFor(place.name), semantic };
}

function byName(list: readonly Place[], name: string): PlanPlace {
  const found = list.find((p) => p.name === name);
  if (!found) throw new Error(`Unknown seed place: ${name}`);
  return planPlace(found);
}

const P = {
  home: planPlace(HOME, "HOME"),
  office: planPlace(OFFICE, "WORK"),
  airport: byName(PLACES, "Seattle-Tacoma International Airport"),
  mountSi: byName(PLACES, "Mount Si Trailhead"),
  rattlesnake: byName(PLACES, "Rattlesnake Ledge Trailhead"),
  noodles: byName(VENUES, "Lakeview Noodle House"),
  taqueria: byName(VENUES, "Harbor Taqueria"),
  coffee: byName(VENUES, "Driftwood Coffee"),
  bakery: byName(VENUES, "Cedar & Salt Bakery"),
  grocery: byName(VENUES, "Greenline Grocery"),
  brewery: byName(VENUES, "Northbound Brewing"),
  gym: byName(VENUES, "Fern Street Climbing Gym"),
  ramen: byName(VENUES, "Copperleaf Ramen"),
  books: byName(PLACES, "Elliott Bay Book Company"),
  arena: byName(PLACES, "Climate Pledge Arena"),
};

/** Public places outside Seattle for trips. */
const TRIP_PLACES = {
  portlandStay: planPlace({ name: "Pearl District", lat: 45.529, lng: -122.6822, category: "Neighborhood", address: "Pearl District, Portland, OR" }),
  portland: [
    planPlace({ name: "Powell's City of Books", lat: 45.5231, lng: -122.6814, category: "Bookstore", address: "1005 W Burnside St, Portland, OR" }),
    planPlace({ name: "Washington Park", lat: 45.5152, lng: -122.7166, category: "Park", address: "4033 SW Canyon Rd, Portland, OR" }),
    planPlace({ name: "Portland Saturday Market", lat: 45.5226, lng: -122.6703, category: "Market", address: "2 SW Naito Pkwy, Portland, OR" }),
  ],
  sfo: planPlace({ name: "San Francisco International Airport", lat: 37.6213, lng: -122.379, category: "Airport", address: "San Francisco, CA 94128" }),
  sfStay: planPlace({ name: "Union Square", lat: 37.788, lng: -122.4075, category: "Plaza", address: "333 Post St, San Francisco, CA" }),
  sf: [
    planPlace({ name: "Ferry Building Marketplace", lat: 37.7955, lng: -122.3937, category: "Market", address: "1 Ferry Building, San Francisco, CA" }),
    planPlace({ name: "Golden Gate Park", lat: 37.7694, lng: -122.4862, category: "Park", address: "San Francisco, CA" }),
    planPlace({ name: "Exploratorium", lat: 37.8015, lng: -122.3975, category: "Museum", address: "Pier 15, San Francisco, CA" }),
  ],
};

/** Weekend destinations with relative weights and typical stay (minutes). */
const WEEKEND: readonly (readonly [PlanPlace, number, number])[] = [
  [byName(PLACES, "Pike Place Market"), 3, 80],
  [byName(PLACES, "Volunteer Park"), 3, 60],
  [byName(PLACES, "Gas Works Park"), 2, 70],
  [byName(PLACES, "Discovery Park"), 2, 120],
  [byName(PLACES, "Green Lake Park"), 3, 75],
  [byName(PLACES, "Ballard Locks"), 1.2, 50],
  [byName(PLACES, "Kerry Park"), 1, 30],
  [byName(PLACES, "Museum of Pop Culture"), 0.6, 140],
  [byName(PLACES, "Seattle Central Library"), 1, 90],
  [byName(PLACES, "Space Needle"), 0.2, 90],
  [byName(PLACES, "Lumen Field"), 0.4, 180],
  [P.books, 2, 50],
  [P.bakery, 3, 45],
  [P.coffee, 3, 40],
  [P.brewery, 2, 110],
  [P.gym, 2, 100],
  [P.ramen, 1.5, 60],
];

const EVENING: readonly (readonly [PlanPlace, number, number])[] = [
  [P.gym, 3, 110],
  [P.ramen, 2, 60],
  [P.brewery, 2, 120],
  [P.books, 1, 45],
  [P.grocery, 3, 25],
  [P.arena, 0.4, 180],
];

function haversineM(a: Place, b: Place): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

function chooseMode(rng: Rng, straightM: number, month: number): MoveMode {
  const wet = month <= 3 || month >= 10;
  if (straightM < 1100) return "WALKING";
  if (straightM < 6000) {
    return rng.weighted<MoveMode>([
      ["WALKING", straightM < 2600 ? (wet ? 3 : 3.5) : 0.3],
      ["CYCLING", wet ? 1.5 : 3.5],
      ["IN_BUS", wet ? 4.5 : 2],
    ]);
  }
  if (straightM < 25_000) return rng.chance(0.3) ? "IN_BUS" : "IN_PASSENGER_VEHICLE";
  return "IN_PASSENGER_VEHICLE";
}

function travelSeconds(rng: Rng, mode: MoveMode, routeM: number): number {
  const speed: Record<MoveMode, number> = {
    WALKING: 1.35,
    RUNNING: 2.8,
    CYCLING: 4.6,
    IN_BUS: 4.2,
    IN_PASSENGER_VEHICLE: routeM > 20_000 ? 17 : 8,
    IN_TRAIN: 9.5,
    FLYING: 210,
  };
  const overhead = mode === "IN_BUS" ? 240 : mode === "FLYING" ? 1500 : mode === "IN_PASSENGER_VEHICLE" ? 180 : 0;
  return Math.round((routeM / speed[mode] + overhead) * rng.float(0.92, 1.15));
}

class PlanBuilder {
  readonly segments: PlanSegment[] = [];
  private place: PlanPlace = P.home;
  private since: Date;

  constructor(
    private readonly ctx: SeedContext,
    private readonly rng: Rng,
    start: Date,
  ) {
    this.since = start;
  }

  get current(): PlanPlace {
    return this.place;
  }

  get currentSince(): Date {
    return this.since;
  }

  /** Local wall-clock minutes since midnight → Date, never before the current stay began. */
  at(date: string, minutes: number): Date {
    const t = this.ctx.localDate(date, 0, 0, Math.round(minutes * 60));
    const earliest = this.since.getTime() + 8 * 60_000;
    return t.getTime() < earliest ? new Date(earliest) : t;
  }

  private closeVisit(end: Date): void {
    this.segments.push({ kind: "visit", place: this.place, start: this.since, end });
  }

  go(to: PlanPlace, depart: Date, forced?: MoveMode): Date {
    const straight = haversineM(this.place, to);
    const month = Number(new Date(depart.getTime() - 8 * 3_600_000).toISOString().slice(5, 7));
    const mode = forced ?? (straight > 300_000 ? "FLYING" : chooseMode(this.rng, straight, month));
    const routeM = Math.round(straight * (mode === "FLYING" ? 1.05 : this.rng.float(1.2, 1.4)));
    const arrive = new Date(depart.getTime() + travelSeconds(this.rng, mode, routeM) * 1000);
    this.closeVisit(depart);
    this.segments.push({ kind: "move", from: this.place, to, start: depart, end: arrive, mode, distanceM: routeM });
    this.place = to;
    this.since = arrive;
    return arrive;
  }

  /** Out-and-back exercise loop (a run from home). */
  loop(depart: Date, mode: MoveMode, distanceM: number): Date {
    const arrive = new Date(depart.getTime() + travelSeconds(this.rng, mode, distanceM) * 1000);
    this.closeVisit(depart);
    this.segments.push({ kind: "move", from: this.place, to: this.place, start: depart, end: arrive, mode, distanceM });
    this.since = arrive;
    return arrive;
  }

  /** Go somewhere, stay about `stayMin` minutes, and return the departure time from there. */
  outing(to: PlanPlace, depart: Date, stayMin: number): Date {
    const arrive = this.go(to, depart);
    return new Date(arrive.getTime() + Math.round(Math.max(12, stayMin * this.rng.float(0.7, 1.4)) * 60) * 1000);
  }

  finish(end: Date): void {
    const minEnd = this.since.getTime() + 30 * 60_000;
    this.closeVisit(end.getTime() > minEnd ? end : new Date(minEnd));
  }
}

const plans = new WeakMap<SeedContext, LocationPlan>();

/** The shared plan for this context (built once, deterministically). */
export function locationPlan(ctx: SeedContext): LocationPlan {
  const cached = plans.get(ctx);
  if (cached) return cached;
  const plan = buildPlan(ctx);
  plans.set(ctx, plan);
  return plan;
}

function buildPlan(ctx: SeedContext): LocationPlan {
  const rng = ctx.rng("google-location:plan");
  const first = ctx.days[0];
  const last = ctx.days.at(-1);
  if (!first || !last) throw new Error("Seed range has no days");
  const b = new PlanBuilder(ctx, rng, ctx.localDate(first.date, 0));
  const trips: PlanTrip[] = [];
  const hikes: PlanHike[] = [];
  let tripDaysLeft = 0;
  let trip: { stay: PlanPlace; sights: readonly PlanPlace[]; flew: boolean } | null = null;

  const jitter = (mean: number, sd: number) => rng.normal(mean, sd);

  for (const day of ctx.days) {
    const month = Number(day.date.slice(5, 7));

    if (trip && tripDaysLeft > 0) {
      tripDaysLeft--;
      if (tripDaysLeft === 0) {
        // Travel home.
        let t = b.at(day.date, jitter(13 * 60, 60));
        if (trip.flew) {
          t = b.go(TRIP_PLACES.sfo, t, "IN_PASSENGER_VEHICLE");
          t = b.go(P.airport, new Date(t.getTime() + 80 * 60_000), "FLYING");
          b.go(P.home, new Date(t.getTime() + 20 * 60_000), "IN_TRAIN");
        } else {
          b.go(P.home, t, "IN_PASSENGER_VEHICLE");
        }
        trip = null;
      } else {
        const sight = rng.pick(trip.sights);
        const back = b.outing(sight, b.at(day.date, jitter(11 * 60, 50)), rng.int(70, 180));
        b.go(trip.stay, back);
      }
      continue;
    }

    // Start a trip on some Fridays.
    if (day.weekday === 5 && day.daysAgo > 10) {
      const roll = rng.next();
      const destination = roll < 0.055 ? "Portland" : roll < 0.075 ? "San Francisco" : null;
      if (destination) {
        const length = rng.int(2, 3);
        const endIndex = Math.min(day.index + length, ctx.days.length - 1);
        const endDay = ctx.days[endIndex];
        if (!endDay) throw new Error("trip end outside range");
        trips.push({ destination, startDate: day.date, endDate: endDay.date });
        let t = b.at(day.date, jitter(10 * 60, 40));
        if (destination === "Portland") {
          b.go(TRIP_PLACES.portlandStay, t, "IN_PASSENGER_VEHICLE");
          trip = { stay: TRIP_PLACES.portlandStay, sights: TRIP_PLACES.portland, flew: false };
        } else {
          t = b.go(P.airport, t, "IN_TRAIN");
          t = b.go(TRIP_PLACES.sfo, new Date(t.getTime() + 95 * 60_000), "FLYING");
          b.go(TRIP_PLACES.sfStay, new Date(t.getTime() + 15 * 60_000), "IN_PASSENGER_VEHICLE");
          trip = { stay: TRIP_PLACES.sfStay, sights: TRIP_PLACES.sf, flew: true };
        }
        tripDaysLeft = endIndex - day.index;
        continue;
      }
    }

    if (day.isWeekend) weekendDay(b, rng, day, month, hikes);
    else weekday(b, rng, day);
  }

  b.finish(ctx.localDate(last.date, 22));
  return { segments: b.segments, trips, hikes };
}

function weekday(b: PlanBuilder, rng: Rng, day: SeedDay): void {
  const wfh = rng.chance(day.weekday === 1 || day.weekday === 5 ? 0.35 : 0.12);
  let eveningFree = true;
  if (wfh) {
    if (rng.chance(0.35)) {
      const back = b.outing(P.coffee, b.at(day.date, rng.normal(10 * 60, 45)), 35);
      b.go(P.home, back);
    }
  } else {
    b.go(P.office, b.at(day.date, rng.normal(8 * 60 + 20, 20)));
    if (rng.chance(0.22)) {
      const lunch = rng.chance(0.75) ? P.noodles : P.taqueria;
      const back = b.outing(lunch, b.at(day.date, rng.normal(12 * 60 + 10, 15)), 45);
      b.go(P.office, back);
    }
    const leave = b.at(day.date, rng.normal(17 * 60 + 45, 30));
    if (rng.chance(0.28)) {
      const [venue, , stay] = rng.weighted(EVENING.map((e) => [e, e[1]] as const));
      const back = b.outing(venue, leave, stay);
      b.go(P.home, back);
      eveningFree = false;
    } else {
      b.go(P.home, leave);
    }
  }
  if (eveningFree && rng.chance(0.2)) {
    b.loop(b.at(day.date, rng.normal(19 * 60 + 15, 30)), "RUNNING", rng.int(4500, 9000));
  }
  if (eveningFree && rng.chance(0.12)) {
    const back = b.outing(P.grocery, b.at(day.date, rng.normal(20 * 60, 30)), 25);
    b.go(P.home, back);
  }
}

function weekendDay(b: PlanBuilder, rng: Rng, day: SeedDay, month: number, hikes: PlanHike[]): void {
  const summer = month >= 6 && month <= 9;
  const shoulder = month === 5 || month === 10;
  if (rng.chance(summer ? 0.32 : shoulder ? 0.2 : 0.08)) {
    const trailhead = rng.chance(0.55) ? P.mountSi : P.rattlesnake;
    const arrive = b.go(trailhead, b.at(day.date, rng.normal(7 * 60 + 30, 25)), "IN_PASSENGER_VEHICLE");
    const leave = new Date(arrive.getTime() + rng.int(190, 330) * 60_000);
    const companions = rng.sample<PersonKey>(["rowan", "priya", "sam"], rng.int(1, 3));
    hikes.push({ date: day.date, trailhead, start: arrive, end: leave, companions });
    b.go(P.home, leave, "IN_PASSENGER_VEHICLE");
    if (rng.chance(0.3)) {
      const back = b.outing(P.brewery, b.at(day.date, rng.normal(18 * 60, 30)), 100);
      b.go(P.home, back);
    }
    return;
  }

  if (rng.chance(0.25)) {
    b.loop(b.at(day.date, rng.normal(8 * 60 + 45, 40)), "RUNNING", rng.int(5000, 12_000));
  }
  if (day.weekday === 0 && rng.chance(0.35)) {
    const back = b.outing(P.bakery, b.at(day.date, rng.normal(10 * 60 + 30, 30)), 60);
    b.go(P.home, back);
  }
  const outings = rng.weighted([
    [0, 1],
    [1, 4],
    [2, 3],
    [3, 1],
  ] as const);
  let depart = b.at(day.date, rng.normal(12 * 60, 60));
  for (let i = 0; i < outings; i++) {
    const [place, , stay] = rng.weighted(WEEKEND.map((w) => [w, w[1]] as const));
    if (place.name === b.current.name) continue;
    depart = b.outing(place, depart, stay);
    // Sometimes chain straight to the next stop instead of heading home.
    if (i === outings - 1 || rng.chance(0.55)) {
      const home = b.go(P.home, depart);
      depart = new Date(home.getTime() + rng.int(40, 180) * 60_000);
    }
  }
  if (day.weekday === 0 && rng.chance(0.6)) {
    const back = b.outing(P.grocery, b.at(day.date, rng.normal(17 * 60 + 30, 40)), 25);
    b.go(P.home, back);
  }
}

/** Every place the plan can visit, for seeding the places lookup table. */
export function planPlaces(plan: LocationPlan): PlanPlace[] {
  const seen = new Map<string, PlanPlace>();
  for (const s of plan.segments) {
    if (s.kind === "visit") seen.set(s.place.placeId, s.place);
  }
  return [...seen.values()];
}

/** Index into ctx.days where Google Timeline (on-device) takes over from Location History. */
export function timelineSplitIndex(ctx: SeedContext): number {
  return Math.floor(ctx.days.length / 2);
}

/** "47.6235000°, -122.3191000°" as written by on-device Timeline exports. */
export function latLngString(lat: number, lng: number): string {
  return `${lat.toFixed(7)}°, ${lng.toFixed(7)}°`;
}

/** Local wall-clock ISO string with offset, e.g. 2025-03-01T08:15:00.000-08:00. */
export function localIsoWithOffset(ctx: SeedContext, at: Date): string {
  const offset = ctx.localOffset(at);
  const sign = offset.startsWith("-") ? -1 : 1;
  const [hh, mm] = offset.slice(1).split(":").map(Number) as [number, number];
  const wall = new Date(at.getTime() + sign * (hh * 60 + mm) * 60_000);
  return `${wall.toISOString().slice(0, 23)}${offset}`;
}
