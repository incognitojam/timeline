/**
 * Shared conversation engine and phrasebooks for the Discord, Facebook,
 * Instagram, and Google Chat seed generators.
 *
 * A script is a short exchange between roles (0 = Alex, 1.. = the other
 * participants of the conversation). The planner picks scripts per day,
 * fills their {slots}, and spaces the lines out like a real chat.
 */
import type { SeedContext, SeedDay } from "../context";
import type { PersonKey } from "../persona";
import { personByKey, PLACES, VENUES } from "../persona";
import type { Rng } from "../rng";

/** One line: [role, text]. Prefix text with "^" to mark it a reply to the previous line. */
export type ScriptLine = readonly [number, string];
export type Script = readonly ScriptLine[];

export interface PlannedMessage {
  at: Date;
  by: PersonKey;
  text: string;
  /** Line carried a {photo} marker. */
  photo: boolean;
  /** Line carried a {gif} marker. */
  gif: boolean;
  /** URL from a {link_*} slot, when the line shares one. */
  link: string | null;
  /** Explicit reply to the previous message. */
  reply: boolean;
  /** Sequence number of the session (one script run) this line belongs to. */
  session: number;
}

export interface ConversationPlan {
  /** Participants other than Alex. Role n (n ≥ 1) maps to members[n - 1]. */
  members: readonly PersonKey[];
  scripts: readonly Script[];
  /** Expected sessions per week at a day weight of 1. */
  sessionsPerWeek: number;
  /** Relative activity on a day (0 = silent). Defaults to 1. */
  dayWeight?: (day: SeedDay) => number;
  /** Local start hour (fractional) of a session on a day. */
  startHour: (day: SeedDay, rng: Rng) => number;
  /** Shuffle which member plays which role per session (groups). */
  shuffleRoles?: boolean;
  /** Probability of a short reaction line after each scripted line. */
  fillerChance?: number;
  /** Typical seconds between lines. */
  gapSeconds?: readonly [number, number];
}

const FILLERS: readonly string[] = [
  "haha",
  "lol",
  "😂",
  "nice",
  "omg",
  "true",
  "yeah",
  "same",
  "ha yes",
  "100%",
  "wait really?",
  "love that",
  "oof",
  "👍",
  "🙌",
  "hah",
  "good call",
  "fair",
  "ok ok",
  "classic",
];

/** Plan every message of one conversation across the seed range, oldest first. */
export function planConversation(ctx: SeedContext, rng: Rng, plan: ConversationPlan): PlannedMessage[] {
  const out: PlannedMessage[] = [];
  let busyUntil = 0;
  let session = 0;
  const [gapMin, gapMax] = plan.gapSeconds ?? [12, 240];
  for (const day of ctx.days) {
    const weight = plan.dayWeight ? plan.dayWeight(day) : 1;
    if (weight <= 0) continue;
    const sessions = rng.poisson((plan.sessionsPerWeek / 7) * weight);
    for (let s = 0; s < sessions; s++) {
      const hour = plan.startHour(day, rng);
      let at = ctx.localDate(day.date, 0, Math.round(hour * 60), rng.int(0, 59)).getTime();
      // Never overlap the previous session; push this one later instead.
      if (at < busyUntil) at = busyUntil + rng.int(20, 90) * 60_000;
      const roles = rolesFor(plan, rng);
      const script = rng.pick(plan.scripts);
      const slots = new Map<string, string>();
      session++;
      for (const [role, raw] of script) {
        const line = fillLine(raw, rng, roles, slots);
        out.push({ ...line, at: new Date(at), by: roleKey(roles, role), session });
        at += gap(rng, gapMin, gapMax);
        if (plan.fillerChance && rng.chance(plan.fillerChance)) {
          const others = roles.filter((key) => key !== roleKey(roles, role));
          out.push({
            at: new Date(at),
            by: rng.pick(others),
            text: rng.pick(FILLERS),
            photo: false,
            gif: false,
            link: null,
            reply: false,
            session,
          });
          at += gap(rng, gapMin, gapMax);
        }
      }
      busyUntil = at;
    }
  }
  return out;
}

function gap(rng: Rng, min: number, max: number): number {
  // Mostly quick back-and-forth, occasionally a long pause.
  const seconds = rng.chance(0.08) ? rng.int(max * 2, max * 10) : rng.int(min, max);
  return seconds * 1000 + rng.int(0, 999);
}

function rolesFor(plan: ConversationPlan, rng: Rng): PersonKey[] {
  const members = plan.shuffleRoles ? rng.shuffle(plan.members) : [...plan.members];
  return ["alex", ...members];
}

function roleKey(roles: readonly PersonKey[], role: number): PersonKey {
  if (role === 0) return "alex";
  // Scripts written for bigger groups wrap around smaller ones.
  const index = 1 + ((role - 1) % (roles.length - 1));
  const key = roles[index];
  if (!key) throw new Error(`Script role ${role} has no participant`);
  return key;
}

function fillLine(
  raw: string,
  rng: Rng,
  roles: readonly PersonKey[],
  slots: Map<string, string>,
): Pick<PlannedMessage, "text" | "photo" | "gif" | "link" | "reply"> {
  let text = raw;
  const reply = text.startsWith("^");
  if (reply) text = text.slice(1);
  const photo = text.includes("{photo}");
  const gif = text.includes("{gif}");
  text = text.replace("{photo}", "").replace("{gif}", "");
  let link: string | null = null;
  text = text.replace(/\{(\w+)\}/g, (_, name: string) => {
    if (/^\d$/.test(name)) return personByKey(roleKey(roles, Number(name))).first;
    let value = slots.get(name);
    if (value === undefined) {
      const options = SLOTS[name];
      if (!options) throw new Error(`Unknown script slot {${name}}`);
      value = rng.pick(options);
      slots.set(name, value);
    }
    if (name.startsWith("link")) link = value;
    return value;
  });
  return { text: text.trim(), photo, gif, link, reply };
}

/** Local hour helpers for common rhythms. */
export const HOURS = {
  evening: (day: SeedDay, rng: Rng) => (day.isWeekend ? rng.float(10, 22.5) : rng.float(17.5, 23)),
  anytime: (day: SeedDay, rng: Rng) => (day.isWeekend ? rng.float(9, 23) : rng.weighted([[rng.float(7.5, 9), 1], [rng.float(12, 13.5), 2], [rng.float(17.5, 23.5), 5]])),
  work: (_day: SeedDay, rng: Rng) => rng.weighted([[rng.float(9, 12), 5], [rng.float(13, 17.5), 5], [rng.float(17.5, 19), 1]]),
};

export function weekdaysOnly(day: SeedDay): number {
  return day.isWeekend ? 0 : 1;
}

/** Gently busier in recent months. */
export function recentLift(ctx: SeedContext): (day: SeedDay) => number {
  const total = ctx.days.length;
  return (day) => 0.8 + 0.4 * (day.index / total);
}

const SLOTS: Readonly<Record<string, readonly string[]>> = {
  trail: [
    "Rattlesnake Ledge",
    "Mount Si",
    "Mailbox Peak",
    "Lake Serene",
    "Poo Poo Point",
    "Twin Falls",
    "Heather Lake",
    "Snow Lake",
    "Lake 22",
    "Wallace Falls",
    "Granite Mountain",
    "Annette Lake",
    "Little Si",
    "Tolmie Peak",
    "the Skyline Trail at Paradise",
    "Cougar Mountain",
    "Blanca Lake",
    "Colchuck Lake",
    "Maple Pass",
    "Lake Ingalls",
  ],
  time: ["6:30", "7", "7:30", "8", "8:30"],
  wday: ["Saturday", "Sunday"],
  place: PLACES.filter((p) => !/Trailhead|Airport/.test(p.name)).map((p) => p.name),
  venue: VENUES.map((v) => v.name),
  game: [
    "Baldur's Gate 3",
    "Helldivers 2",
    "Valheim",
    "Stardew Valley",
    "Lethal Company",
    "Deep Rock Galactic",
    "Overcooked 2",
    "Balatro",
    "Rocket League",
    "Factorio",
    "It Takes Two",
    "Satisfactory",
  ],
  boardgame: ["Codenames", "Wingspan", "Catan", "Azul", "Ticket to Ride", "Cascadia", "Spirit Island", "The Crew"],
  artist: [
    "Phoebe Bridgers",
    "Fleet Foxes",
    "Death Cab for Cutie",
    "Japanese Breakfast",
    "Bon Iver",
    "Khruangbin",
    "Mitski",
    "The National",
    "Big Thief",
    "boygenius",
    "Vampire Weekend",
    "Caroline Polachek",
    "Fred again..",
    "Tame Impala",
  ],
  venue_music: ["the Showbox", "Neumos", "the Crocodile", "Climate Pledge Arena", "the Paramount", "the Moore", "Gorge Amphitheatre"],
  movie: [
    "Dune: Part Two",
    "Past Lives",
    "Oppenheimer",
    "Everything Everywhere All at Once",
    "The Holdovers",
    "Poor Things",
    "Perfect Days",
    "Spider-Man: Across the Spider-Verse",
    "Inside Out 2",
    "Conclave",
    "The Wild Robot",
  ],
  show: ["Severance", "The Bear", "Shōgun", "Slow Horses", "Andor", "The Last of Us", "Only Murders in the Building", "Arcane"],
  book: [
    "Tomorrow, and Tomorrow, and Tomorrow",
    "Project Hail Mary",
    "Piranesi",
    "The Overstory",
    "Klara and the Sun",
    "Demon Copperhead",
    "Sea of Tranquility",
    "The Ministry of Time",
  ],
  food: ["ramen", "tacos", "pho", "dumplings", "pizza", "Thai", "burgers", "banh mi", "sushi", "dim sum", "biryani"],
  dish: ["shakshuka", "a massive lasagna", "dal", "focaccia", "bibimbap", "chili", "lemon pasta", "mapo tofu", "tamales"],
  weather: ["rain", "fog", "low clouds", "wind", "drizzle", "smoke from the fires", "snow above 3000ft"],
  n: ["2", "3", "4", "5", "6"],
  pal: ["Casey", "Devon", "Ines", "Marcus", "Tara", "Kenji"],
  month: ["March", "May", "June", "August", "September"],
  miles: ["4", "5.5", "6", "7.2", "8", "9.5", "11"],
  gain: ["1100", "1500", "2000", "2400", "3100", "3800"],
  team: ["Sounders", "Kraken", "Mariners", "Seahawks", "Storm"],
  service: ["ingest-api", "batch-scheduler", "event-router", "schema-registry", "metrics-gateway", "backfill-worker"],
  pr: ["1412", "1438", "1459", "1477", "1503", "1526", "1544", "1561", "1590", "1612"],
  ticket: ["PLAT-2041", "PLAT-2087", "PLAT-2133", "PLAT-2178", "PLAT-2210", "PLAT-2256", "PLAT-2301"],
  dashboard: ["the latency dashboard", "the ingest lag panel", "the error budget board", "the Kafka consumer lag graph"],
  meeting: ["standup", "sprint planning", "the retro", "the design review", "1:1s", "the incident review"],
  lang: ["Go", "TypeScript", "Rust", "Python"],
  link_hike: [
    "https://www.wta.org/go-hiking/hikes/rattlesnake-ledge",
    "https://www.wta.org/go-hiking/hikes/mount-si",
    "https://www.wta.org/go-hiking/hikes/lake-serene",
    "https://www.wta.org/go-hiking/hikes/snow-lake-1",
    "https://www.nps.gov/mora/planyourvisit/conditions.htm",
    "https://www.fs.usda.gov/mbs",
  ],
  link_game: [
    "https://store.steampowered.com/app/1086940/Baldurs_Gate_3/",
    "https://store.steampowered.com/app/553850/HELLDIVERS_2/",
    "https://store.steampowered.com/app/892970/Valheim/",
    "https://store.steampowered.com/app/2379780/Balatro/",
    "https://www.minecraft.net/en-us/updates",
  ],
  link_music: [
    "https://open.spotify.com/album/6Xn9QnlNUpO2d1vXf0Zp0h",
    "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M",
    "https://www.youtube.com/watch?v=hTWKbfoikeg",
    "https://www.kexp.org/read/",
  ],
  link_news: [
    "https://en.wikipedia.org/wiki/Seattle_Center",
    "https://www.seattle.gov/parks",
    "https://www.theverge.com/tech",
    "https://news.ycombinator.com/",
    "https://www.kuow.org/",
  ],
  link_food: [
    "https://www.seriouseats.com/the-food-lab",
    "https://cooking.nytimes.com/recipes/1017947-shakshuka",
    "https://www.bonappetit.com/recipes",
  ],
  link_work: [
    "https://go.example.com/runbook-ingest",
    "https://go.example.com/oncall-rota",
    "https://docs.example.com/platform/rfc-schema-v2",
    "https://grafana.example.com/d/ingest-lag",
  ],
  link_reel: [
    "https://www.instagram.com/reel/Cx3kQe9LmPa/",
    "https://www.instagram.com/reel/C1rTt0aNv2k/",
    "https://www.instagram.com/reel/C5bYw8OrQ7e/",
    "https://www.instagram.com/reel/C8pLz2nSx4u/",
    "https://www.instagram.com/reel/DAk9mF3vR1o/",
    "https://www.instagram.com/reel/DCs2hW6tY8i/",
  ],
  link_post: [
    "https://www.instagram.com/p/CwQ1fJ3rL9d/",
    "https://www.instagram.com/p/C2nT7kVsP4a/",
    "https://www.instagram.com/p/C6hX0eMuW2b/",
    "https://www.instagram.com/p/DBe4rG8qN5c/",
  ],
};

// ─── Discord ────────────────────────────────────────────────────────────────

export const HIKE_GROUP_SCRIPTS: readonly Script[] = [
  [
    [1, "ok who's in for {trail} this {wday}?"],
    [2, "me!! what time"],
    [1, "leave Capitol Hill at {time}? parking fills up fast"],
    [0, "in. I can drive, fits 4"],
    [3, "I'm out this weekend sadly, have fun"],
    [1, "I'll bring sandwiches 🥪"],
  ],
  [
    [0, "forecast for {wday} says {weather} 😬"],
    [1, "mountain forecast or the regular one?"],
    [0, "NOAA point forecast, 60% after noon"],
    [2, "we could do something lower? {trail} is usually fine"],
    [1, "^yeah let's swap, save the big one for a clear day"],
  ],
  [
    [1, "{photo}made it to the top 🥾"],
    [2, "that view!!"],
    [0, "{photo}the lake was so still this morning"],
    [3, "ugh so jealous"],
    [1, "{miles} miles, {gain} ft gain, legs are toast"],
  ],
  [
    [2, "trip report on WTA says the road to {trail} is washed out {link_hike}"],
    [0, "oh no, that's the one we wanted"],
    [1, "plan B: {trail} instead?"],
    [2, "works for me"],
  ],
  [
    [0, "anyone have a spare headlamp? mine died on the last trip"],
    [3, "I have like 3, will bring one"],
    [0, "legend"],
  ],
  [
    [1, "carpool spot: {venue} at {time}, coffee first ☕"],
    [0, "perfect"],
    [2, "running 10 min late sorry!!"],
    [1, "no worries, we're grabbing pastries"],
  ],
  [
    [3, "do we need a Discover Pass or Northwest Forest Pass for {trail}?"],
    [1, "NW Forest Pass, I have one in the car"],
    [3, "^ok good, I always mix them up"],
  ],
  [
    [0, "{photo}"],
    [0, "found this on the way down, no idea what it is"],
    [2, "pretty sure that's a banana slug lol"],
    [1, "classic PNW"],
  ],
  [
    [2, "post-hike {food}? I'm starving"],
    [1, "North Bend has that place by the outlet mall"],
    [0, "I'm in, I've been thinking about {food} since mile 2"],
  ],
  [
    [1, "thinking about an overnight at {trail} next month, permits open Tuesday"],
    [0, "I'm so in. need to dust off the tent"],
    [3, "count me in if it's a weekend"],
    [2, "I'll set an alarm for the permit drop"],
    [1, "^bless"],
  ],
  [
    [0, "{photo}sunrise from the car park, worth the early start"],
    [3, "ok fine, I'll come next time"],
    [1, "you say that every time {3}"],
  ],
  [
    [2, "anyone tried the new microspikes from REI?"],
    [1, "I have the Kahtoolas, they're great on packed snow"],
    [0, "same, saved me on {trail} last winter"],
  ],
  [
    [1, "rest day this weekend? my knees are filing a complaint"],
    [0, "honestly yes. brunch instead?"],
    [2, "{venue}? 10am?"],
    [1, "perfect 🥞"],
  ],
  [
    [3, "{photo}"],
    [3, "trail magic! someone left cookies at the junction"],
    [1, "this is why I love this community"],
  ],
  [
    [0, "did anyone grab my water filter? can't find it anywhere"],
    [2, "oh it's in my pack, sorry!! I'll drop it off"],
    [0, "^phew, thought it fell out at {trail}"],
  ],
  [
    [1, "larch season!! {trail} is supposed to be peak gold this weekend"],
    [2, "the crowds will be insane though"],
    [0, "if we leave at 5 we beat them"],
    [3, "5am?? who are you"],
  ],
  [
    [2, "gear swap: anyone want my old trekking poles? upgrading"],
    [3, "me! mine are held together with tape"],
    [2, "^they're yours"],
  ],
  [
    [1, "{trail} trip report: {miles} miles, muddy but the waterfall was pumping"],
    [0, "{photo}the waterfall really was pumping"],
    [2, "adding it to the list for spring"],
  ],
  [
    [0, "should we try {trail} at night for the meteor shower?"],
    [1, "the Perseids peak next week, could be epic"],
    [3, "I'll bring the hot chocolate"],
    [2, "and blankets, it gets cold up there"],
  ],
  [
    [3, "is anyone else's car making a weird noise after that forest road"],
    [0, "mine was fine but that road was brutal"],
    [1, "next time we take the long way"],
  ],
  [
    [1, "who wants to do the Enchantments lottery with me this year?"],
    [0, "every year we say this. yes"],
    [2, "putting in my application tonight"],
    [3, "^we will get it one day"],
  ],
  [
    [0, "{photo}mountain goat sighting 🐐"],
    [1, "he was SO close"],
    [2, "the goats own that trail"],
  ],
  [
    [2, "first aid kit check before saturday: who has the blister stuff"],
    [1, "I restocked moleskin last week"],
    [0, "I'll bring extra electrolyte tabs"],
  ],
  [
    [1, "{weather} on {wday}. still going?"],
    [3, "I'm in if we're back by 3, have dinner plans"],
    [0, "^we'll start early, easy"],
    [2, "rain jackets it is"],
  ],
];

export const GAME_NIGHT_SCRIPTS: readonly Script[] = [
  [
    [1, "game night thursday? I'm thinking {game}"],
    [2, "in"],
    [3, "maybe, depends on work"],
    [0, "I'm in, discord at 8?"],
    [1, "8 works"],
  ],
  [
    [2, "{link_game}"],
    [2, "it's on sale, we should all grab it"],
    [0, "already bought it 🙃"],
    [4, "$20? fine. you've convinced me"],
  ],
  [
    [1, "server's back up, I updated to the latest version"],
    [0, "did my base survive?"],
    [1, "^mostly. the creeper incident is not my fault"],
    [3, "it was absolutely your fault"],
  ],
  [
    [0, "gg last night, that final round was ridiculous"],
    [2, "I still can't believe {1} clutched that"],
    [1, "skill 😎"],
    [4, "luck"],
  ],
  [
    [3, "board game night at mine saturday? I got {boardgame}"],
    [0, "yes! I'll bring snacks"],
    [1, "can we also play {boardgame}"],
    [3, "^sure, if we finish before midnight this time"],
  ],
  [
    [1, "who left the minecart track unfinished"],
    [0, "it's a work in progress"],
    [2, "it's been a work in progress since March"],
  ],
  [
    [4, "patch notes for {game} dropped, they nerfed everything I like"],
    [0, "of course they did"],
    [3, "time for a new build"],
  ],
  [
    [0, "can't make it tonight, sorry, deadline at work"],
    [1, "boo. next week?"],
    [0, "^next week for sure"],
  ],
  [
    [2, "{photo}behold, the castle"],
    [1, "this is insane"],
    [3, "how many hours is that"],
    [2, "we don't talk about the hours"],
  ],
  [
    [1, "anyone up for a quick round of {game}? just hopped on"],
    [0, "give me 10 min"],
    [4, "joining"],
  ],
  [
    [3, "co-op campaign night: we finally finish {game}?"],
    [0, "we're like 80% through right?"],
    [1, "70 if we're being honest"],
    [2, "let's do it, I'll bring the snacks this time"],
  ],
  [
    [1, "jackbox tonight? I'll stream it"],
    [0, "yes, I've been working on my Quiplash material"],
    [3, "oh no"],
  ],
  [
    [4, "new map seed on the server, spawn is next to a huge ravine"],
    [2, "dibs on the mountain"],
    [0, "I'm building a bridge across, don't touch it"],
  ],
  [
    [2, "{game} tournament bracket is up, loser buys pizza 🍕"],
    [0, "I'm going to lose so badly"],
    [1, "^that's the spirit"],
  ],
  [
    [3, "the {boardgame} expansion arrived!!"],
    [1, "saturday then?"],
    [0, "I'll bring the good snacks this time, not the sad pretzels"],
  ],
  [
    [0, "anyone want to try {game}? it's on Game Pass"],
    [4, "downloading"],
    [1, "my laptop is going to melt but sure"],
  ],
  [
    [1, "ok who joined at 2am and blew up the farm"],
    [3, "...it was an accident"],
    [2, "the chickens did not deserve this"],
  ],
];

export const FRIEND_DM_SCRIPTS: readonly Script[] = [
  [
    [1, "have you seen {show}? just finished it"],
    [0, "halfway through! no spoilers"],
    [1, "my lips are sealed. episode 6 though 😳"],
    [0, "^stop 😂"],
  ],
  [
    [0, "{movie} this weekend? it's at the Cinerama"],
    [1, "yes! saturday evening?"],
    [0, "booking for 7:15"],
    [1, "🙌"],
  ],
  [
    [1, "{food} tonight? I'm craving it"],
    [0, "always. {venue}?"],
    [1, "meet there at 7"],
  ],
  [
    [0, "how did the thing go today?"],
    [1, "actually really well! will tell you properly later"],
    [0, "^yay!! proud of you"],
  ],
  [
    [1, "reading {book} on your recommendation, I'm hooked"],
    [0, "told you! where are you up to?"],
    [1, "just past the halfway twist"],
    [0, "oh you're in for it"],
  ],
  [
    [0, "happy friday 🎉 any plans?"],
    [1, "absolutely nothing and I'm thrilled"],
    [0, "the dream"],
  ],
  [
    [1, "{link_news}"],
    [1, "thought you'd find this interesting"],
    [0, "oh wow, reading now"],
  ],
  [
    [0, "are you going to {artist} at {venue_music}?"],
    [1, "trying to get tickets, they sold out in like 4 minutes"],
    [0, "ugh the resale prices are wild"],
    [1, "fingers crossed for the second date"],
  ],
  [
    [1, "random but do you still have my copy of {boardgame}?"],
    [0, "oh no... yes. I'll bring it next time"],
    [1, "haha no rush"],
  ],
  [
    [0, "walk around {place} later? weather's actually nice"],
    [1, "yes, I need to get out of the house"],
    [0, "5:30 at the main entrance"],
  ],
  [
    [1, "{photo}look what I found at the thrift store"],
    [0, "incredible. how much"],
    [1, "$4 😎"],
  ],
  [
    [0, "do you want to come to {place} with me on {wday}? there's a thing on"],
    [1, "yes, what time?"],
    [0, "around noon, I'll grab coffee from {venue} first"],
  ],
  [
    [1, "{artist} new single is out"],
    [0, "listening right now"],
    [1, "thoughts?"],
    [0, "^instantly on my playlist"],
  ],
  [
    [0, "I think I need a new hobby, the garden sensors project is eating my weekends"],
    [1, "is that the balcony plant thing?"],
    [0, "yes, the basil now has better monitoring than our prod systems"],
  ],
  [
    [1, "ugh, rough week"],
    [0, "want to get {food} and complain about it?"],
    [1, "that's exactly what I need"],
  ],
  [
    [0, "have you watched {movie}? I need to talk about the ending"],
    [1, "not yet, this weekend!"],
    [0, "text me the second you finish"],
  ],
  [
    [1, "{link_news}"],
    [0, "wait is this real"],
    [1, "apparently!"],
  ],
  [
    [0, "thanks again for helping me move the couch"],
    [1, "anytime. my back may never recover"],
    [0, "^dinner's on me"],
  ],
  [
    [1, "pub quiz thursday at {venue}? we need a fourth"],
    [0, "I'm in, I'll cover geography"],
    [1, "and I've got music covered"],
  ],
  [
    [0, "did you end up booking the trip?"],
    [1, "yes!! Vancouver in {month}"],
    [0, "amazing, get the dim sum in Richmond"],
  ],
];

export const DM_SCRIPTS: Readonly<Partial<Record<PersonKey, readonly Script[]>>> = {
  rowan: [
    [
      [1, "climbing tuesday? Fern Street has new routes up"],
      [0, "yes please, my forearms miss it"],
      [1, "6pm?"],
      [0, "see you there"],
    ],
    [
      [1, "{photo}scouted {trail} this morning, conditions are perfect"],
      [0, "omg ok we're doing that one this weekend"],
    ],
    [
      [0, "what sandwiches are you bringing saturday, asking for my stomach"],
      [1, "turkey pesto and the spicy veggie one"],
      [0, "^the veggie one is elite"],
    ],
    [
      [1, "thinking about doing the Wonderland Trail next summer. thoughts?"],
      [0, "terrifying and amazing. I'm in if we train"],
      [1, "training plan incoming 📋"],
    ],
  ],
  priya: [
    [
      [1, "{link_music}"],
      [1, "this album has been on repeat all week"],
      [0, "oh I love {artist}, will listen tonight"],
    ],
    [
      [1, "{artist} announced a show at {venue_music}!!"],
      [0, "WE'RE GOING"],
      [1, "presale code is tomorrow at 10"],
      [0, "^alarm set ⏰"],
    ],
    [
      [0, "book club pick for next month? I vote {book}"],
      [1, "seconded, I've been meaning to read it"],
    ],
    [
      [1, "{photo}look at this tiny dog at the farmers market"],
      [0, "I would die for him"],
    ],
  ],
  sam: [
    [
      [1, "{team} game tonight, you watching?"],
      [0, "yep, at {venue} with a few people, come"],
      [1, "omw after work"],
    ],
    [
      [1, "that last-minute goal 😱😱"],
      [0, "I screamed in the bar"],
      [1, "^the whole stadium did"],
    ],
    [
      [0, "found the best {food} in the city, we're going"],
      [1, "bold claim. when"],
      [0, "thursday?"],
      [1, "deal"],
    ],
  ],
  jordan: [
    [
      [1, "off the clock question: are you playing {game} yet"],
      [0, "started last night, it's eating my life"],
      [1, "^same lol"],
    ],
    [
      [0, "did you survive the offsite?"],
      [1, "barely. so many sticky notes"],
      [0, "the sticky notes always win"],
    ],
  ],
  theo: [
    [
      [1, "server update: I added a nether hub, finally"],
      [0, "about time! I'll hop on tonight"],
    ],
    [
      [1, "remember the all-nighter before the compilers final"],
      [0, "never again. that coffee machine"],
      [1, "^RIP to that coffee machine"],
    ],
    [
      [0, "you coming to Seattle at all this year?"],
      [1, "maybe for the summer! couch still available?"],
      [0, "always"],
    ],
  ],
  omar: [
    [
      [1, "{photo}made {dish} tonight, pretty proud"],
      [0, "that looks incredible, recipe please"],
      [1, "{link_food}"],
    ],
    [
      [1, "brunch sunday? I'll host"],
      [0, "I'll bring the pastries from {venue}"],
    ],
    [
      [0, "hopping on {game} in 10 if you want to join"],
      [1, "yes, just finishing dinner"],
    ],
  ],
};


// ─── Facebook ───────────────────────────────────────────────────────────────

export const FAMILY_GROUP_SCRIPTS: readonly Script[] = [
  [
    [2, "Sunday call this week? Dad wants to show off the garden 🌻"],
    [1, "yes! 11am works for me"],
    [0, "11 works, I'll call from the laptop"],
  ],
  [
    [2, "{photo}The tomatoes are finally ripe!"],
    [1, "they're enormous"],
    [0, "save me some for when I visit"],
  ],
  [
    [1, "what are we doing for Mum's birthday?"],
    [0, "dinner somewhere nice? I can book"],
    [2, "You two don't need to fuss!"],
    [1, "^we're fussing 💐"],
  ],
  [
    [0, "{photo}from the hike this weekend"],
    [2, "Be careful up there! Did you bring enough water?"],
    [0, "always mum 😄"],
  ],
  [
    [2, "Thanksgiving plans? We'd love to have you both home"],
    [1, "I can drive up from Portland Wednesday night"],
    [0, "I'll take the train down Thursday morning"],
    [2, "Wonderful ❤️"],
  ],
  [
    [1, "{link_news}"],
    [1, "mum did you see this"],
    [2, "Yes! Your aunt sent it too"],
  ],
  [
    [2, "Reminder: flu shots! 💉"],
    [0, "got mine last week"],
    [1, "booked for friday"],
  ],
  [
    [1, "{photo}new apartment! finally unpacked"],
    [2, "It's lovely sweetheart. Is that a new couch?"],
    [0, "it looks great!! very you"],
  ],
  [
    [2, "Did everyone see Grandma's message? She learned to use video calls!"],
    [1, "omg yes, she held the phone upside down for 5 minutes"],
    [0, "progress though 😂"],
  ],
  [
    [1, "Christmas: are we doing secret santa again?"],
    [2, "Yes please, $40 limit"],
    [0, "I'll set up the draw"],
  ],
  [
    [0, "{photo}made Mum's lasagna recipe, it's not as good as hers"],
    [2, "It looks perfect! Did you add the nutmeg?"],
    [0, "^...I forgot the nutmeg"],
  ],
];

export const FACEBOOK_DM_SCRIPTS: Readonly<Partial<Record<PersonKey, readonly Script[]>>> = {
  mei: [
    [
      [1, "half marathon training update: ran 10 miles today 🏃‍♀️"],
      [0, "WHAT. that's amazing"],
      [1, "legs are jelly"],
    ],
    [
      [1, "can you send me that photo from the coast trip?"],
      [0, "{photo}"],
      [1, "^thank you! framing it"],
    ],
    [
      [0, "how's Portland treating you?"],
      [1, "rainy but I love it. found the best {food} place"],
      [0, "take me when I visit"],
    ],
  ],
  linda: [
    [
      [1, "Did you get the package I sent?"],
      [0, "yes!! thank you for the cookies 🍪"],
      [1, "Make sure you share with your friends"],
    ],
    [
      [1, "Your father wants to know if you've changed your car's oil"],
      [0, "...I will this weekend"],
      [1, "😄"],
    ],
    [
      [0, "call tonight?"],
      [1, "Yes! After 7 please, I have book club"],
    ],
  ],
  priya: [
    [
      [1, "{link_music}"],
      [1, "have you heard this yet"],
      [0, "obsessed already"],
    ],
    [[1, "{gif}"], [0, "this is exactly me on monday mornings"]],
  ],
  sam: [
    [
      [1, "{team} tickets for saturday, want one?"],
      [0, "yes! how much do I owe you"],
      [1, "beers are fine"],
    ],
  ],
  theo: [
    [
      [1, "found old uni photos"],
      [1, "{photo}"],
      [0, "oh no. the haircut"],
      [1, "^the haircut was a choice"],
    ],
  ],
  luis: [
    [
      [1, "{photo}golden hour at {place} last night"],
      [0, "this is gorgeous, new lens?"],
      [1, "yep, the 35mm. obsessed"],
    ],
    [
      [1, "bike ride around Lake Washington saturday?"],
      [0, "yes, if we stop for coffee halfway"],
      [1, "non-negotiable ☕"],
    ],
  ],
};

export const FACEBOOK_FRIEND_SCRIPTS: readonly Script[] = [
  ...FRIEND_DM_SCRIPTS,
  [[1, "{gif}"], [0, "😂😂"]],
  [[0, "{gif}"], [1, "accurate"]],
  [
    [1, "{link_news}"],
    [0, "ha, saw this earlier"],
  ],
];

export const POSTS: readonly string[] = [
  "Finally made it up {trail}. Worth every switchback.",
  "Three years in Seattle and the first sunny day in spring still feels like a holiday.",
  "Anyone have recommendations for a good bike shop on Capitol Hill?",
  "New job, new commute, same coffee order.",
  "Spent the morning at {place}. Highly recommend.",
  "Hot take: {food} is the best post-hike meal.",
  "Saw {artist} at {venue_music} last night. Still buzzing.",
  "Just finished {book}. Need to talk about it with someone immediately.",
  "Happy birthday to the best sister, Mei! 🎂",
  "Garden update: the balcony tomatoes survived another week.",
  "Grateful for good friends, long trails, and dry socks.",
  "Thinking of getting into film photography. Talk me out of it.",
];

export const COMMENTS: readonly string[] = [
  "Congrats!! 🎉",
  "This is amazing",
  "So proud of you!",
  "Miss you guys",
  "Where is this?? Adding it to the list",
  "Happy birthday! Hope it's a great one",
  "Looks delicious",
  "Ha, this is so you",
  "We need to catch up soon",
  "Beautiful shot",
  "Can't wait!",
  "Love this",
];

// ─── Instagram ──────────────────────────────────────────────────────────────

export const INSTAGRAM_SCRIPTS: readonly Script[] = [
  [
    [1, "{link_reel}"],
    [0, "😂😂 this is us"],
  ],
  [
    [0, "{link_reel}"],
    [1, "why is this so accurate"],
  ],
  [
    [1, "{link_post}"],
    [1, "we need to go here"],
    [0, "adding to the list"],
  ],
  [
    [1, "Reacted ❤️ to your story"],
    [1, "where was that?!"],
    [0, "{place}! go at sunset"],
  ],
  [
    [0, "love the new profile pic"],
    [1, "thank you!! finally a good one"],
  ],
  [
    [1, "{photo}"],
    [1, "remember this day"],
    [0, "best day ever"],
  ],
  [
    [0, "your story from {venue} made me so hungry"],
    [1, "it's so good, you have to go"],
  ],
  [
    [1, "{link_reel}"],
    [1, "ok but we have to try this recipe"],
    [0, "next dinner party, it's decided"],
  ],
  [
    [0, "{photo}"],
    [0, "look who I ran into"],
    [1, "omg!! say hi"],
  ],
  [
    [1, "are you going to {pal}'s thing on saturday?"],
    [0, "yes! you?"],
    [1, "yep, see you there 🙌"],
  ],
  [
    [1, "Replied to your story: is that {trail}??"],
    [0, "yes! went with {pal} on saturday"],
    [1, "so jealous"],
  ],
  [
    [0, "{link_reel}"],
    [0, "the dog at the end 😭"],
    [1, "I've watched it 10 times"],
  ],
  [
    [1, "{photo}"],
    [1, "{venue} has a new menu"],
    [0, "going this week"],
  ],
  [
    [0, "congrats on the new job!! saw your post"],
    [1, "thank you!! still can't believe it"],
  ],
  [
    [1, "{link_post}"],
    [0, "we HAVE to go"],
    [1, "next month?"],
    [0, "^yes, I'll check dates"],
  ],
];

// ─── Google Chat ────────────────────────────────────────────────────────────

export const WORK_GROUP_SCRIPTS: readonly Script[] = [
  [
    [1, "heads up: deploying {service} to prod in 10"],
    [0, "👍 I'll keep an eye on {dashboard}"],
    [2, "go for it"],
    [1, "done, canary looks healthy"],
  ],
  [
    [2, "can someone review PR #{pr}? it's the {service} retry fix"],
    [0, "on it after {meeting}"],
    [2, "thanks!"],
    [0, "left a couple of comments, mostly nits. approved"],
  ],
  [
    [0, "seeing elevated 5xx on {service}, anyone else?"],
    [1, "yeah, looks like the upstream timeout. checking"],
    [2, "I paged the data team just in case"],
    [1, "rolled back the config change, errors dropping"],
    [0, "confirmed, back to baseline. I'll write up {ticket}"],
  ],
  [
    [1, "reminder: {meeting} moved to 2pm today"],
    [0, "thanks"],
    [2, "👍"],
  ],
  [
    [2, "draft RFC for schema v2 is up: {link_work}"],
    [0, "nice, will read before thursday"],
    [1, "left some questions on the migration section"],
  ],
  [
    [0, "who's on call this week?"],
    [1, "me until Wednesday, then {2}"],
    [2, "yep, handoff at 10am Wednesday"],
  ],
  [
    [1, "lunch? thinking Lakeview Noodle House"],
    [0, "in"],
    [2, "can't, back to back meetings 😩"],
  ],
  [
    [2, "the flaky test in {service} is back"],
    [0, "the timezone one? I thought we fixed that"],
    [2, "different one, this time it's ordering"],
    [0, "I'll take {ticket}, I have context"],
  ],
  [
    [0, "backfill for last week finished overnight, 0 errors"],
    [1, "🎉 nice"],
    [2, "huge, thanks for babysitting it"],
  ],
  [
    [1, "anyone know why the build cache is cold today?"],
    [2, "CI runners were rotated this morning"],
    [1, "ah that explains it"],
  ],
  [
    [2, "quarterly planning doc is ready for comments"],
    [0, "will add the ingest items"],
    [1, "same for the scheduler work"],
  ],
  [
    [0, "PSA: bumping {lang} version in {service}, ping me if anything weird happens"],
    [1, "👍"],
  ],
  [
    [1, "{service} memory usage keeps creeping up after the last deploy"],
    [0, "looks like the cache isn't evicting, I'll profile it"],
    [2, "could be the new batch size, we doubled it"],
    [0, "^yep, that's it. reverting the batch size for now"],
  ],
  [
    [2, "standup notes: I'm on {ticket}, blocked on schema review"],
    [0, "I can review the schema after lunch"],
    [1, "I'm finishing the {service} dashboards"],
  ],
  [
    [0, "the {lang} upgrade broke the integration tests, looking"],
    [1, "is it the deprecated flag?"],
    [0, "yep, one line fix, PR #{pr}"],
    [2, "approved"],
  ],
  [
    [1, "friday demo: who's presenting the ingest work?"],
    [0, "I can, I have the before/after latency graphs"],
    [2, "🙌"],
  ],
  [
    [2, "on-call was quiet this week, only one page for {service}"],
    [0, "the alert threshold change helped"],
    [1, "let's keep it, nice work"],
  ],
  [
    [0, "anyone know who owns the {service} terraform?"],
    [1, "infra team, but {2} has context"],
    [2, "^I do, what's up?"],
    [0, "need to bump the instance size, I'll send a PR"],
  ],
  [
    [1, "reminder to fill in the peer feedback forms by friday"],
    [0, "doing mine now"],
    [2, "oof, thanks for the reminder"],
  ],
  [
    [2, "coffee run to Driftwood? taking orders"],
    [0, "oat flat white please 🙏"],
    [1, "drip coffee, black, thank you"],
  ],
  [
    [0, "postmortem for last week's {service} outage is in the doc: {link_work}"],
    [1, "great write-up, the timeline is super clear"],
    [2, "added two action items at the bottom"],
  ],
  [
    [1, "the backfill is at 60%, ETA tomorrow morning"],
    [0, "nice, ping me if it stalls"],
  ],
];

export const WORK_DM_SCRIPTS: Readonly<Partial<Record<PersonKey, readonly Script[]>>> = {
  jordan: [
    [
      [1, "got a sec to pair on {ticket}?"],
      [0, "yep, huddle in 5"],
    ],
    [
      [0, "thoughts on splitting {service} into two deployments?"],
      [1, "I like it, but let's measure first"],
      [0, "fair, I'll add some metrics"],
    ],
    [
      [1, "can you cover {meeting} for me tomorrow? dentist"],
      [0, "sure, I'll take notes"],
      [1, "you're the best"],
    ],
    [
      [1, "the on-call handoff doc is out of date, I'll fix it today"],
      [0, "thank you, the runbook links are broken too {link_work}"],
    ],
    [
      [0, "the {service} on-call alert fired twice last night, false positive both times"],
      [1, "ugh, I'll tune the threshold today"],
    ],
    [
      [1, "are you coming to {meeting}? need your take on the timeline"],
      [0, "yes, running 2 min late"],
    ],
    [
      [0, "nice job on the demo today"],
      [1, "thanks! the graphs did the heavy lifting"],
    ],
    [
      [1, "quick sanity check: is {ticket} still on your plate?"],
      [0, "yes, should have a PR up by tomorrow"],
      [1, "perfect, thanks"],
    ],
  ],
  nadia: [
    [
      [1, "your PR #{pr} looks good, one question about the retry backoff"],
      [0, "it's exponential with jitter, capped at 30s"],
      [1, "perfect, approving"],
    ],
    [
      [0, "do you have the latency numbers from last week's load test?"],
      [1, "yes, p99 was around 180ms. sending the dashboard"],
      [1, "{link_work}"],
    ],
    [
      [1, "are you going to the team offsite?"],
      [0, "yes! you?"],
      [1, "yep, carpool?"],
    ],
    [
      [0, "can I borrow you for 15 min to talk through the schema migration?"],
      [1, "sure, 3pm?"],
      [0, "works"],
    ],
    [
      [1, "I'm out friday, could you keep an eye on the {service} rollout?"],
      [0, "of course, enjoy the long weekend"],
    ],
    [
      [1, "the {service} RFC needs one more approver, would you take a look?"],
      [0, "reading it now"],
      [0, "approved with a small comment on the rollback plan"],
    ],
    [
      [0, "thanks for covering on-call yesterday"],
      [1, "no problem, it was quiet"],
    ],
  ],
};

export function workDmScripts(key: PersonKey): readonly Script[] {
  const scripts = WORK_DM_SCRIPTS[key];
  if (!scripts) throw new Error(`No work DM scripts for ${key}`);
  return scripts;
}

/**
 * JSON as Meta (Facebook/Instagram) exports write it: every string's UTF-8
 * bytes re-read as Latin-1 code points, then \u-escaped, which the parsers'
 * decode step reverses.
 */
export function metaExportJson(value: unknown): string {
  return JSON.stringify(mangle(value), null, 2).replace(
    /[\u0080-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function mangle(value: unknown): unknown {
  if (typeof value === "string") return String.fromCharCode(...Buffer.from(value, "utf8"));
  if (Array.isArray(value)) return value.map(mangle);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mangle(v)]));
  }
  return value;
}

/** Facebook's decaying weight: busiest at the start of the range, ~10% by the end. */
export function fadingOut(ctx: SeedContext): (day: SeedDay) => number {
  const total = ctx.days.length;
  return (day) => Math.exp(-2.3 * (day.index / total));
}
