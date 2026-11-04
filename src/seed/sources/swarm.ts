import { insertSwarmEvent, type SwarmCheckin } from "../../parsers/swarm-api";
import type { SeedDay, SeedSource } from "../context";
import { type Person, type PersonKey, PLACES, type Place, personByKey, SELF, VENUES } from "../persona";
import type { Rng } from "../rng";

/** Foursquare user ids are numeric strings. */
function swarmUserId(person: Person): string {
  return String(80_000_000 + Number(person.numericId));
}

function place(name: string): Place {
  const found = [...PLACES, ...VENUES].find((p) => p.name === name);
  if (!found) throw new Error(`Unknown seed place: ${name}`);
  return found;
}

const SHOUTS: Readonly<Record<string, readonly string[]>> = {
  "Coffee Shop": ["first coffee of the day", "oat flat white kind of morning", "laptop + cortado", "standup prep"],
  Bakery: ["cardamom bun was worth it", "brunch crew assembling", "they had the rye loaf today"],
  "Noodle House": ["lunch break", "hand-pulled noodles, no regrets", "team lunch"],
  "Taco Place": ["taco tuesday technically", "al pastor, always"],
  Brewery: ["post-hike pints", "trivia night", "trying the hazy IPA"],
  "Climbing Gym": ["finally sent the V4", "bouldering session", "forearms are toast"],
  "Ramen Restaurant": ["rainy day ramen", "tonkotsu weather"],
  Trailhead: ["summit or bust", "early start, clear skies", "muddy but worth it", "views for days"],
  Park: ["lunchtime wander", "sunset walk", "picnic with the crew", "kite flying"],
  Market: ["lunchtime wander ☀️", "flowers for the flat", "watching the fish throwers"],
  Bookstore: ["just browsing (lies)", "picked up the new Becky Chambers"],
  Stadium: ["Sounders match!", "go Seahawks"],
  Arena: ["Kraken game", "concert night"],
  Museum: ["visiting with Mum", "rainy-day museum"],
  Landmark: ["showing Mei around", "tourist mode", "boats going through the locks"],
  Library: ["quiet afternoon of reading", "best architecture in the city"],
  Viewpoint: ["golden hour", "the classic skyline shot"],
  Airport: ["off to Portland", "flying home", "gate C, coffee in hand"],
};

interface Plan {
  place: Place;
  hour: number;
  minute: number;
  with?: readonly PersonKey[];
}

function weekdayPlans(rng: Rng, day: SeedDay): Plan[] {
  const plans: Plan[] = [];
  if (rng.chance(0.22)) {
    plans.push({ place: place(rng.weighted([["Driftwood Coffee", 3], ["Cedar & Salt Bakery", 1]])), hour: 8, minute: rng.int(10, 50) });
  }
  if (rng.chance(0.14)) {
    const lunch = rng.weighted([["Lakeview Noodle House", 3], ["Harbor Taqueria", 2], ["Pike Place Market", 1]]);
    plans.push({ place: place(lunch), hour: 12, minute: rng.int(0, 45), with: rng.chance(0.3) ? ["jordan"] : undefined });
  }
  if ((day.weekday === 2 || day.weekday === 4) && rng.chance(0.4)) {
    plans.push({ place: place("Fern Street Climbing Gym"), hour: 18, minute: rng.int(0, 50), with: rng.chance(0.5) ? ["priya"] : undefined });
  } else if (rng.chance(0.08)) {
    plans.push({ place: place(rng.pick(["Copperleaf Ramen", "Northbound Brewing"])), hour: 19, minute: rng.int(0, 50) });
  }
  if (rng.chance(0.1)) plans.push({ place: place("Greenline Grocery"), hour: 18, minute: rng.int(30, 59) });
  return plans;
}

function weekendPlans(rng: Rng, day: SeedDay): Plan[] {
  const plans: Plan[] = [];
  if (day.weekday === 6 && rng.chance(0.35)) {
    const trail = rng.pick(["Mount Si Trailhead", "Rattlesnake Ledge Trailhead"]);
    const crew = rng.sample<PersonKey>(["rowan", "priya", "sam"], rng.int(1, 3));
    plans.push({ place: place(trail), hour: 8, minute: rng.int(0, 40), with: crew });
    if (rng.chance(0.6)) plans.push({ place: place("Northbound Brewing"), hour: 16, minute: rng.int(0, 50), with: crew });
    return plans;
  }
  if (day.weekday === 0 && rng.chance(0.2)) {
    plans.push({ place: place("Cedar & Salt Bakery"), hour: 10, minute: rng.int(0, 40), with: rng.sample<PersonKey>(["mei", "rowan", "omar"], 2) });
  }
  if (rng.chance(0.5)) {
    const outing = rng.weighted([
      ["Volunteer Park", 3], ["Gas Works Park", 2], ["Discovery Park", 2], ["Green Lake Park", 2], ["Pike Place Market", 2],
      ["Elliott Bay Book Company", 2], ["Seattle Central Library", 1], ["Ballard Locks", 1], ["Kerry Park", 1],
      ["Museum of Pop Culture", 0.5], ["Space Needle", 0.3],
    ]);
    plans.push({ place: place(outing), hour: rng.int(11, 15), minute: rng.int(0, 59), with: rng.chance(0.25) ? [rng.pick<PersonKey>(["rowan", "luis", "hannah", "mei"])] : undefined });
  }
  if (rng.chance(0.12)) {
    plans.push({ place: place(rng.pick(["Lumen Field", "Climate Pledge Arena"])), hour: 19, minute: rng.int(0, 30), with: [rng.pick<PersonKey>(["sam", "theo", "omar"])] });
  } else if (rng.chance(0.25)) {
    plans.push({ place: place(rng.pick(["Copperleaf Ramen", "Northbound Brewing", "Harbor Taqueria"])), hour: rng.int(18, 20), minute: rng.int(0, 59) });
  }
  if (rng.chance(0.08)) plans.push({ place: place("Greenline Grocery"), hour: 17, minute: rng.int(0, 59) });
  return plans;
}

export const swarmSeed: SeedSource = {
  name: "swarm",
  produces: { swarm: ["location:visit"] },
  async seed(ctx) {
    const rng = ctx.rng("swarm");
    const venueIds = new Map<string, string>();
    const checkins: SwarmCheckin[] = [];

    for (const day of ctx.days) {
      const plans = day.isWeekend ? weekendPlans(rng, day) : weekdayPlans(rng, day);
      // A trip to see Mei in Portland every few months.
      if (day.weekday === 5 && rng.chance(0.03)) plans.push({ place: place("Seattle-Tacoma International Airport"), hour: 17, minute: rng.int(0, 50) });
      for (const plan of plans.sort((a, b) => a.hour - b.hour || a.minute - b.minute)) {
        const at = ctx.localDate(day.date, plan.hour, plan.minute, rng.int(0, 59));
        const offset = ctx.localOffset(at);
        const offsetMinutes = (offset.startsWith("-") ? -1 : 1) * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
        let venueId = venueIds.get(plan.place.name);
        if (!venueId) {
          venueId = rng.hex(24);
          venueIds.set(plan.place.name, venueId);
        }
        const addressParts = plan.place.address.split(", ");
        const shouts = SHOUTS[plan.place.category] ?? [];
        const shout = shouts.length > 0 && rng.chance(0.3) ? rng.pick(shouts) : "";
        checkins.push({
          id: rng.hex(24),
          createdAt: Math.floor(at.getTime() / 1000),
          timeZoneOffset: offsetMinutes,
          ...(shout ? { shout } : {}),
          venue: {
            id: venueId,
            name: plan.place.name,
            location: {
              lat: plan.place.lat,
              lng: plan.place.lng,
              address: addressParts[0],
              city: addressParts.length > 2 ? addressParts[addressParts.length - 2] : "Seattle",
              country: "United States",
              formattedAddress: [...addressParts, "United States"],
            },
            categories: [{ name: plan.place.category }],
          },
          ...(plan.with
            ? {
                with: plan.with.map((key) => {
                  const person = personByKey(key);
                  return { id: swarmUserId(person), firstName: person.first, lastName: person.last };
                }),
              }
            : {}),
        });
      }
    }

    const importBatch = `swarm-sync-${ctx.anchorDate}`;
    ctx.db.transaction(() => {
      for (const checkin of checkins) {
        if (!insertSwarmEvent(ctx.db, checkin, swarmUserId(SELF), importBatch)) {
          throw new Error(`Swarm seed check-in ${checkin.id} was not inserted`);
        }
      }
    })();
  },
};
