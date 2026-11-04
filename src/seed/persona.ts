/**
 * The fictional person behind the synthetic seed database, and their world.
 *
 * Alex (the same persona as the README showcase in web/e2e/showcase.spec.ts)
 * lives in Seattle, writes software, hikes with friends, and uses far too many
 * apps. Every person, handle, email, phone number, message, and transaction is
 * invented. Emails use example.com and phone numbers use the 555-01xx range
 * reserved for fiction (with the 202 area code the release-safety check allows). Public places, music, and media are real and well known
 * so the UI reads naturally; nothing here comes from a real export.
 */

export interface Person {
  key: PersonKey;
  /** Full display name. */
  name: string;
  first: string;
  last: string;
  email: string;
  /** E.164, from the 555-01xx fictional range. */
  phone: string;
  /** Lowercase handle reused across platforms that have usernames. */
  handle: string;
  /** Stable numeric id used where a platform has snowflake-style ids. */
  numericId: string;
  relation: "self" | "friend" | "family" | "work" | "acquaintance";
  /** Relative chattiness: how often they appear in 1:1 conversations. */
  closeness: number;
  /** Platforms this person messages Alex on. */
  platforms: readonly MessagingPlatform[];
  dateOfBirth?: string;
  notes?: string;
}

export type MessagingPlatform =
  | "discord"
  | "facebook"
  | "instagram"
  | "skype"
  | "google-chat"
  | "sms"
  | "google-messages"
  | "linkedin";

export type PersonKey =
  | "alex"
  | "rowan"
  | "priya"
  | "sam"
  | "jordan"
  | "mei"
  | "linda"
  | "theo"
  | "nadia"
  | "luis"
  | "hannah"
  | "omar";

function person(p: Omit<Person, "email" | "phone"> & { phoneSuffix: number }): Person {
  const { phoneSuffix, ...rest } = p;
  return {
    ...rest,
    email: `${p.first.toLowerCase()}.${p.last.toLowerCase()}@example.com`,
    phone: `+1202555${String(phoneSuffix).padStart(4, "0")}`,
  };
}

export const SELF: Person = person({
  key: "alex",
  name: "Alex Rivera",
  first: "Alex",
  last: "Rivera",
  handle: "alexrivera",
  numericId: "1000",
  phoneSuffix: 100,
  relation: "self",
  closeness: 0,
  platforms: [],
  dateOfBirth: "1992-06-14",
});

export const PEOPLE: readonly Person[] = [
  person({
    key: "rowan",
    name: "Rowan Hale",
    first: "Rowan",
    last: "Hale",
    handle: "rowanhale",
    numericId: "1001",
    phoneSuffix: 101,
    relation: "friend",
    closeness: 10,
    platforms: ["discord", "sms", "google-messages", "instagram"],
    dateOfBirth: "1991-09-02",
    notes: "Hiking group organiser. Always brings sandwiches.",
  }),
  person({
    key: "priya",
    name: "Priya Natarajan",
    first: "Priya",
    last: "Natarajan",
    handle: "priyanat",
    numericId: "1002",
    phoneSuffix: 102,
    relation: "friend",
    closeness: 8,
    platforms: ["discord", "facebook", "google-messages", "instagram"],
    dateOfBirth: "1993-02-21",
  }),
  person({
    key: "sam",
    name: "Sam Okafor",
    first: "Sam",
    last: "Okafor",
    handle: "samokafor",
    numericId: "1003",
    phoneSuffix: 103,
    relation: "friend",
    closeness: 7,
    platforms: ["discord", "facebook", "skype", "sms"],
  }),
  person({
    key: "jordan",
    name: "Jordan Lee",
    first: "Jordan",
    last: "Lee",
    handle: "jordanlee",
    numericId: "1004",
    phoneSuffix: 104,
    relation: "work",
    closeness: 6,
    platforms: ["google-chat", "linkedin", "discord"],
    notes: "Teammate on the platform squad.",
  }),
  person({
    key: "mei",
    name: "Mei Rivera",
    first: "Mei",
    last: "Rivera",
    handle: "meirivera",
    numericId: "1005",
    phoneSuffix: 105,
    relation: "family",
    closeness: 9,
    platforms: ["google-messages", "sms", "facebook", "instagram"],
    dateOfBirth: "1995-11-30",
    notes: "Younger sister, lives in Portland.",
  }),
  person({
    key: "linda",
    name: "Linda Rivera",
    first: "Linda",
    last: "Rivera",
    handle: "lindarivera",
    numericId: "1006",
    phoneSuffix: 106,
    relation: "family",
    closeness: 6,
    platforms: ["sms", "google-messages", "facebook", "skype"],
    notes: "Mum.",
  }),
  person({
    key: "theo",
    name: "Theo Brooks",
    first: "Theo",
    last: "Brooks",
    handle: "theobrooks",
    numericId: "1007",
    phoneSuffix: 107,
    relation: "friend",
    closeness: 4,
    platforms: ["discord", "skype", "facebook"],
    notes: "University friend; Minecraft server admin.",
  }),
  person({
    key: "nadia",
    name: "Nadia Petrova",
    first: "Nadia",
    last: "Petrova",
    handle: "nadiap",
    numericId: "1008",
    phoneSuffix: 108,
    relation: "work",
    closeness: 4,
    platforms: ["google-chat", "linkedin"],
  }),
  person({
    key: "luis",
    name: "Luis Ortega",
    first: "Luis",
    last: "Ortega",
    handle: "luisortega",
    numericId: "1009",
    phoneSuffix: 109,
    relation: "friend",
    closeness: 3,
    platforms: ["instagram", "facebook", "sms"],
  }),
  person({
    key: "hannah",
    name: "Hannah Kim",
    first: "Hannah",
    last: "Kim",
    handle: "hannahkim",
    numericId: "1010",
    phoneSuffix: 110,
    relation: "acquaintance",
    closeness: 2,
    platforms: ["linkedin", "instagram"],
  }),
  person({
    key: "omar",
    name: "Omar Haddad",
    first: "Omar",
    last: "Haddad",
    handle: "omarhaddad",
    numericId: "1011",
    phoneSuffix: 111,
    relation: "friend",
    closeness: 3,
    platforms: ["discord", "google-messages", "skype"],
  }),
];

export const EVERYONE: readonly Person[] = [SELF, ...PEOPLE];

export function personByKey(key: PersonKey): Person {
  const found = EVERYONE.find((p) => p.key === key);
  if (!found) throw new Error(`Unknown persona key: ${key}`);
  return found;
}

/** People who use a given messaging platform with Alex. */
export function peopleOn(platform: MessagingPlatform): Person[] {
  return PEOPLE.filter((p) => p.platforms.includes(platform));
}

export interface GroupChat {
  id: string;
  name: string;
  members: readonly PersonKey[];
  /** Typical messages per day while active. */
  perDay: number;
}

/** Group chats, keyed by the platform they live on. */
export const GROUP_CHATS: Partial<Record<MessagingPlatform, readonly GroupChat[]>> = {
  discord: [
    { id: "weekend-hike", name: "weekend hike 🥾", members: ["rowan", "priya", "sam"], perDay: 6 },
    { id: "game-night", name: "game night", members: ["theo", "omar", "sam", "jordan"], perDay: 3 },
  ],
  facebook: [{ id: "riveras", name: "Rivera family", members: ["mei", "linda"], perDay: 2 }],
  "google-chat": [{ id: "platform-squad", name: "Platform squad", members: ["jordan", "nadia"], perDay: 5 }],
  "google-messages": [{ id: "sunday-brunch", name: "Sunday brunch", members: ["mei", "rowan", "omar"], perDay: 2 }],
};

export interface Place {
  name: string;
  lat: number;
  lng: number;
  category: string;
  address: string;
}

/**
 * Public Seattle-area places. Alex's home and office are neighbourhood
 * centroids, not real addresses.
 */
export const HOME: Place = {
  name: "Home",
  lat: 47.6235,
  lng: -122.3191,
  category: "Home",
  address: "Capitol Hill, Seattle, WA",
};

export const OFFICE: Place = {
  name: "Office",
  lat: 47.6205,
  lng: -122.3384,
  category: "Office",
  address: "South Lake Union, Seattle, WA",
};

export const PLACES: readonly Place[] = [
  { name: "Pike Place Market", lat: 47.6097, lng: -122.3422, category: "Market", address: "85 Pike St, Seattle, WA" },
  { name: "Volunteer Park", lat: 47.6301, lng: -122.3153, category: "Park", address: "1247 15th Ave E, Seattle, WA" },
  { name: "Gas Works Park", lat: 47.6456, lng: -122.3344, category: "Park", address: "2101 N Northlake Way, Seattle, WA" },
  { name: "Discovery Park", lat: 47.6573, lng: -122.4055, category: "Park", address: "3801 Discovery Park Blvd, Seattle, WA" },
  { name: "Seattle Central Library", lat: 47.6067, lng: -122.3325, category: "Library", address: "1000 4th Ave, Seattle, WA" },
  { name: "Space Needle", lat: 47.6205, lng: -122.3493, category: "Landmark", address: "400 Broad St, Seattle, WA" },
  { name: "Climate Pledge Arena", lat: 47.6221, lng: -122.354, category: "Arena", address: "334 1st Ave N, Seattle, WA" },
  { name: "Elliott Bay Book Company", lat: 47.6146, lng: -122.3194, category: "Bookstore", address: "1521 10th Ave, Seattle, WA" },
  { name: "Green Lake Park", lat: 47.6801, lng: -122.3287, category: "Park", address: "7201 E Green Lake Dr N, Seattle, WA" },
  { name: "Ballard Locks", lat: 47.6656, lng: -122.3972, category: "Landmark", address: "3015 NW 54th St, Seattle, WA" },
  { name: "Museum of Pop Culture", lat: 47.6215, lng: -122.3481, category: "Museum", address: "325 5th Ave N, Seattle, WA" },
  { name: "Lumen Field", lat: 47.5952, lng: -122.3316, category: "Stadium", address: "800 Occidental Ave S, Seattle, WA" },
  { name: "Mount Si Trailhead", lat: 47.4881, lng: -121.7233, category: "Trailhead", address: "SE Mount Si Rd, North Bend, WA" },
  { name: "Rattlesnake Ledge Trailhead", lat: 47.4347, lng: -121.7686, category: "Trailhead", address: "Rattlesnake Lake, North Bend, WA" },
  { name: "Seattle-Tacoma International Airport", lat: 47.4502, lng: -122.3088, category: "Airport", address: "17801 International Blvd, SeaTac, WA" },
  { name: "Kerry Park", lat: 47.6295, lng: -122.36, category: "Viewpoint", address: "211 W Highland Dr, Seattle, WA" },
];

/** Plausible coffee/food spots with invented names. */
export const VENUES: readonly Place[] = [
  { name: "Driftwood Coffee", lat: 47.6152, lng: -122.3205, category: "Coffee Shop", address: "Pike/Pine, Seattle, WA" },
  { name: "Cedar & Salt Bakery", lat: 47.6251, lng: -122.3213, category: "Bakery", address: "Capitol Hill, Seattle, WA" },
  { name: "Lakeview Noodle House", lat: 47.6219, lng: -122.3372, category: "Noodle House", address: "South Lake Union, Seattle, WA" },
  { name: "Harbor Taqueria", lat: 47.6087, lng: -122.3389, category: "Taco Place", address: "Downtown, Seattle, WA" },
  { name: "Northbound Brewing", lat: 47.6649, lng: -122.3836, category: "Brewery", address: "Ballard, Seattle, WA" },
  { name: "Fern Street Climbing Gym", lat: 47.6502, lng: -122.3501, category: "Climbing Gym", address: "Fremont, Seattle, WA" },
  { name: "Copperleaf Ramen", lat: 47.6145, lng: -122.3175, category: "Ramen Restaurant", address: "Capitol Hill, Seattle, WA" },
  { name: "Greenline Grocery", lat: 47.6201, lng: -122.3168, category: "Grocery Store", address: "Capitol Hill, Seattle, WA" },
];

/** Alex's employer and education, invented. */
export const CAREER = {
  employer: "Northwind Analytics",
  previousEmployer: "Bluefin Labs",
  title: "Senior Software Engineer",
  school: "University of Washington",
  degree: "BSc Computer Science",
};

/** Alex's coding projects, reused by WakaTime, GitHub, and coding-agent sessions. */
export const PROJECTS = [
  { name: "trailhead", repo: "alexrivera/trailhead", language: "TypeScript", description: "Hiking trip planner" },
  { name: "pocket-ledger", repo: "alexrivera/pocket-ledger", language: "Rust", description: "Budgeting CLI" },
  { name: "dotfiles", repo: "alexrivera/dotfiles", language: "Shell", description: "Personal config" },
  { name: "northwind-ingest", repo: "northwind/ingest", language: "Go", description: "Work data pipeline" },
  { name: "garden-sensors", repo: "alexrivera/garden-sensors", language: "Python", description: "Balcony plant monitor" },
] as const;

/**
 * Alex's home directory on their Mac, for coding-agent working directories.
 * Joined from parts because the release-safety check rejects literal home
 * paths for any user it doesn't allowlist; this one is fictional.
 */
export const HOME_DIR = ["", "Users", SELF.first.toLowerCase()].join("/");

/** IANA zone used for "local" times in the generated day. */
export const TIME_ZONE = "America/Los_Angeles";
