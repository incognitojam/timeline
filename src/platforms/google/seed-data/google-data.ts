/**
 * Shared helpers and catalogs for the Google-family seed generators (Search,
 * YouTube, Chrome) — the same searches and videos show up in several exports,
 * as they would for a real Takeout.
 */
import type { SeedContext, SeedDay } from "../../../seed/context";
import { SELF } from "../../../seed/persona";
import type { Rng } from "../../../seed/rng";

/** Account label passed to the Google importers. */
export const GOOGLE_ACCOUNT = SELF.email;

/** Stable 32-bit hash for ids that must not depend on draw order. */
export function stableHash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Gentle ramp so recent months are a little denser than three years ago. */
export function recencyFactor(ctx: SeedContext, day: SeedDay): number {
  return 0.75 + (0.5 * day.index) / Math.max(1, ctx.days.length - 1);
}

const WEEKDAY_HOURS = [0.4, 0.15, 0, 0, 0, 0, 0.2, 0.9, 1.4, 1.3, 1.2, 1.2, 1.8, 1.3, 1.1, 1.1, 1, 1, 1.3, 1.9, 2.2, 2.2, 1.7, 1];
const WEEKEND_HOURS = [0.8, 0.4, 0.1, 0, 0, 0, 0, 0.3, 0.8, 1.3, 1.6, 1.6, 1.5, 1.4, 1.3, 1.3, 1.3, 1.4, 1.5, 1.8, 2, 2, 1.7, 1.2];

/** Fractional local hour for casual phone/laptop activity on a day. */
export function activityHour(rng: Rng, day: SeedDay, weights?: readonly number[]): number {
  const table = weights ?? (day.isWeekend ? WEEKEND_HOURS : WEEKDAY_HOURS);
  const hour = rng.weighted(table.map((weight, h) => [h, weight] as const));
  return hour + rng.next();
}

/** UTC Date for a fractional local hour on a day (handles DST via the context). */
export function atLocalHour(ctx: SeedContext, date: string, hour: number): Date {
  const totalSeconds = Math.floor(hour * 3600);
  return ctx.localDate(date, 0, 0, totalSeconds);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "22 Mar 2024, 19:10:16 UTC" — a My Activity timestamp the parsers accept. */
export function myActivityTimestamp(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}, ` +
    `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())} UTC`
  );
}

/** Wrap My Activity content cells in the Takeout HTML page chrome. */
export function myActivityPage(cells: readonly string[]): string {
  return (
    `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>My Activity</title></head>` +
    `<body><div class="mdl-grid">\n${cells.join("\n")}\n</div></body></html>\n`
  );
}

/**
 * One My Activity outer cell: `<action>&nbsp;<detail>` then the timestamp, as
 * Takeout writes it (a literal U+00A0 after the action verb).
 */
export function myActivityCell(product: string, action: string, detail: string, at: Date): string {
  const nbsp = "\u00A0";
  return (
    `<div class="outer-cell mdl-cell mdl-cell--12-col mdl-shadow--2dp"><div class="mdl-grid">` +
    `<div class="header-cell mdl-cell mdl-cell--12-col"><p class="mdl-typography--title">${product}<br></p></div>` +
    `<div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">${action}${nbsp}${detail}<br>${myActivityTimestamp(at)}</div>` +
    `<div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1 mdl-typography--text-right"></div>` +
    `<div class="content-cell mdl-cell mdl-cell--12-col mdl-typography--caption"><b>Products:</b><br>${nbsp}${product}<br></div>` +
    `</div></div>`
  );
}

// ---------------------------------------------------------------------------
// Search catalog
// ---------------------------------------------------------------------------

export interface SearchResult {
  title: string;
  url: string;
}

export interface SearchPick {
  query: string;
  category: SearchCategory;
  result: SearchResult | null;
}

type SearchCategory = "dev" | "local" | "food" | "outdoors" | "media" | "howto" | "shopping" | "weather" | "travel" | "health";

const DEV_QUERIES = [
  "typescript satisfies vs as",
  "typescript discriminated union exhaustive switch",
  "typescript infer return type of async function",
  "tsconfig moduleResolution bundler",
  "bun test mock module",
  "bun sqlite prepared statement transaction",
  "bun build --compile target",
  "solidjs createResource suspense",
  "solidjs show vs switch",
  "tanstack query invalidate queries after mutation",
  "tailwind v4 theme directive",
  "vite proxy websocket",
  "rust borrow checker cannot borrow as mutable more than once",
  "rust error E0502",
  "rust lifetime elision rules",
  "rust clap derive subcommand",
  "rust serde rename_all camelCase",
  "rust anyhow vs thiserror",
  "cargo workspace shared dependencies",
  "rust iterator group by",
  "rust chrono parse date",
  "go context cancel goroutine",
  "go errgroup example",
  "go generics constraint ordered",
  "golang table driven tests",
  "go mod tidy private repo",
  "golang pgx batch insert",
  "go json omitempty time.Time",
  "python asyncio gather timeout",
  "python dataclass default factory",
  "raspberry pi i2c soil moisture sensor",
  "micropython deep sleep esp32",
  "python poetry vs uv",
  "sqlite fts5 tokenizer unicode61",
  "sqlite json_extract index",
  "sqlite wal mode concurrent readers",
  "sqlite upsert on conflict do update",
  "postgres explain analyze buffers",
  "postgres partial index",
  "git rebase onto",
  "git rerere",
  "git worktree add existing branch",
  "git bisect run",
  "github actions cache bun",
  "github actions matrix include",
  "docker compose healthcheck depends_on",
  "kubernetes pod crashloopbackoff",
  "terraform for_each map",
  "bash parameter expansion default value",
  "zsh history substring search",
  "jq select by key",
  "neovim lsp format on save",
  "tmux copy mode vi",
  "homebrew services restart",
  "macos launchctl bootstrap gui",
  "regex lookbehind javascript",
  "css container queries",
  "css grid auto-fill minmax",
  "web vitals INP",
  "http 429 retry-after header",
  "oauth pkce flow",
  "jwt refresh token rotation",
  "kafka consumer lag",
  "parquet vs avro",
  "duckdb read parquet s3",
  "protobuf oneof",
  "grpc deadline exceeded",
  "opentelemetry trace context propagation",
  "prometheus histogram quantile",
  "grafana variable regex",
  "leetcode interval scheduling",
  "big o of heapify",
  "utf-8 byte order mark",
  "unix timestamp to date",
  "cron expression every weekday 9am",
  "semver caret vs tilde",
] as const;

const DEV_DOCS: readonly [RegExp, string, string][] = [
  [/rust|cargo|serde|clap|anyhow/, "https://doc.rust-lang.org/book/", "The Rust Programming Language"],
  [/\bgo\b|golang|errgroup|pgx/, "https://pkg.go.dev/", "Go Packages"],
  [/typescript|tsconfig/, "https://www.typescriptlang.org/docs/handbook/", "TypeScript: Handbook"],
  [/python|asyncio|dataclass|micropython/, "https://docs.python.org/3/library/", "Python 3 Documentation"],
  [/sqlite/, "https://www.sqlite.org/docs.html", "SQLite Documentation"],
  [/postgres/, "https://www.postgresql.org/docs/current/", "PostgreSQL Documentation"],
  [/\bgit\b|github/, "https://git-scm.com/docs", "Git - Reference"],
  [/\bbun\b/, "https://bun.sh/docs", "Bun Docs"],
  [/css|regex|web vitals|http/, "https://developer.mozilla.org/en-US/docs/Web/", "MDN Web Docs"],
  [/solidjs/, "https://docs.solidjs.com/", "SolidJS Docs"],
];

const LOCAL_QUERIES = [
  "pike place market hours",
  "seattle central library hours",
  "link light rail schedule capitol hill",
  "seattle to bainbridge ferry schedule",
  "kerry park sunset time",
  "climate pledge arena events",
  "kraken schedule",
  "mariners tickets",
  "sounders match tonight",
  "museum of pop culture tickets",
  "discovery park lighthouse trail",
  "ballard locks salmon viewing season",
  "gas works park parking",
  "green lake loop distance",
  "seattle street parking rules sunday",
  "capitol hill farmers market",
  "seattle public library book sale",
  "elliott bay book company events",
  "fremont sunday market",
  "seattle art museum free first thursday",
  "volunteer park conservatory hours",
  "seattle cherry blossoms uw quad",
  "bumbershoot lineup",
  "seafair dates",
  "seattle aquarium membership",
  "chihuly garden and glass tickets",
  "king county metro trip planner",
  "orca card reload",
  "seattle city light outage map",
  "recycling pickup schedule seattle",
] as const;

const DISHES = [
  "shakshuka", "pad see ew", "chicken tikka masala", "miso ramen", "carbonara", "birria tacos",
  "mapo tofu", "banana bread", "focaccia", "pho", "bibimbap", "green curry", "mushroom risotto",
  "dal makhani", "salmon teriyaki", "chili con carne", "sourdough starter", "dutch baby",
  "okonomiyaki", "lentil soup", "pesto pasta", "fish tacos", "kimchi fried rice", "tamales",
] as const;

const FOOD_QUERIES = [
  "best ramen capitol hill",
  "brunch near volunteer park",
  "tacos south lake union",
  "seattle happy hour oysters",
  "cast iron pan seasoning",
  "how long to rest steak",
  "substitute for buttermilk",
  "what is gochujang",
  "is cilantro stem edible",
  "pour over coffee ratio",
  "aeropress inverted recipe",
] as const;

const TRAILS = [
  "mount si", "rattlesnake ledge", "poo poo point", "lake serene", "mailbox peak", "twin falls",
  "heather lake", "lake 22", "snow lake", "colchuck lake", "rattlesnake mountain", "tiger mountain",
] as const;

const OUTDOOR_TEMPLATES = [
  (t: string) => `${t} trail conditions`,
  (t: string) => `${t} trip report`,
  (t: string) => `${t} elevation gain`,
  (t: string) => `${t} parking pass`,
  (t: string) => `${t} hike how long`,
] as const;

const OUTDOOR_QUERIES = [
  "northwest forest pass vs discover pass",
  "wta trail finder",
  "snoqualmie pass weather",
  "i-90 pass conditions",
  "best rain jacket for hiking",
  "how to waterproof hiking boots",
  "ten essentials hiking list",
  "bear canister rules enchantments",
  "enchantments permit lottery",
  "larch season washington",
  "microspikes vs crampons",
  "mount rainier wildflower peak bloom",
  "olympic national park camping reservations",
] as const;

const MEDIA_QUERIES = [
  "dune part two showtimes seattle",
  "oppenheimer imax 70mm",
  "the bear season 3 release date",
  "severance season 2 episode count",
  "shogun fx cast",
  "past lives movie",
  "everything everywhere all at once director",
  "the last of us season 2",
  "succession finale explained",
  "andor season 2",
  "fleabag where to watch",
  "phoebe bridgers tour",
  "boygenius the record",
  "khruangbin seattle",
  "fleet foxes shore",
  "bon iver new album",
  "taylor swift eras tour movie",
  "tears of the kingdom tips",
  "baldur's gate 3 best class",
  "hades 2 early access",
  "stardew valley 1.6 update",
  "balatro joker tier list",
  "minecraft 1.21 trial chambers",
  "minecraft villager trading hall design",
  "wingspan board game expansion",
  "catan seafarers rules",
  "tomorrow and tomorrow and tomorrow book",
  "project hail mary movie",
  "brandon sanderson reading order",
  "pachinko apple tv",
] as const;

const HOWTO_QUERIES = [
  "how to descale a kettle",
  "how to fix a squeaky door hinge",
  "how to remove stripped screw",
  "how to clean a french press",
  "how to repot a monstera",
  "fiddle leaf fig brown spots",
  "how to unclog a drain without chemicals",
  "how to fold a fitted sheet",
  "how to true a bike wheel",
  "replace bike chain how often",
  "tubeless tire sealant how long",
  "how to wash a down jacket",
  "how to change an ac filter",
  "what time is it in london",
  "convert 180 celsius to fahrenheit",
  "how many ounces in a cup",
  "daylight saving time 2025",
  "is the post office open today",
  "how to renew passport",
  "washington state drivers license renewal",
  "what does ttyl mean",
  "why is the sky blue",
  "how do noise cancelling headphones work",
  "speed of light in km per second",
] as const;

const SHOPPING_QUERIES = [
  "rei garage sale",
  "patagonia nano puff sale",
  "best mechanical keyboard 2024",
  "kindle paperwhite vs oasis",
  "sony wh-1000xm5 vs bose qc ultra",
  "pixel 9 vs pixel 8",
  "standing desk frame",
  "ergonomic chair under 500",
  "usb-c hub 4k 60hz",
  "merino base layer",
  "trail running shoes wide toe box",
  "osprey talon 22",
  "plant grow light balcony",
  "espresso grinder under 300",
  "nintendo switch oled price",
] as const;

const WEATHER_QUERIES = [
  "seattle weather",
  "seattle weather tomorrow",
  "seattle weather this weekend",
  "seattle rain forecast",
  "north bend weather",
  "air quality seattle",
  "sunrise time seattle",
  "portland weather",
] as const;

const TRAVEL_QUERIES = [
  "seattle to portland drive time",
  "amtrak cascades schedule",
  "powell's city of books hours",
  "portland food carts",
  "washington park rose garden",
  "sea airport security wait times",
  "alaska airlines baggage fee",
  "ferry building marketplace hours",
  "golden gate park things to do",
  "bart from sfo to downtown",
  "vancouver bc border wait time",
  "victoria clipper schedule",
] as const;

const HEALTH_QUERIES = [
  "couch to 10k plan",
  "half marathon training plan beginner",
  "runner's knee stretches",
  "foam rolling it band",
  "how much protein per day",
  "vitamin d deficiency symptoms",
  "resting heart rate normal",
  "hrv what is good",
  "climbing finger pulley injury",
  "bouldering grades v scale",
  "yoga for lower back pain",
  "how many steps a day",
] as const;

function stackOverflowResult(query: string): SearchResult {
  const id = 40_000_000 + (stableHash(query) % 38_000_000);
  const title = query.charAt(0).toUpperCase() + query.slice(1);
  return { title: `${title} - Stack Overflow`, url: `https://stackoverflow.com/questions/${id}/${slugify(query)}` };
}

function devResult(rng: Rng, query: string): SearchResult {
  const docs = DEV_DOCS.find(([pattern]) => pattern.test(query));
  if (docs && rng.chance(0.45)) return { title: docs[2], url: docs[1] };
  if (rng.chance(0.15)) {
    return {
      title: `${query} · Issue #${1000 + (stableHash(query) % 9000)} · GitHub`,
      url: `https://github.com/search?q=${encodeURIComponent(query)}&type=issues`,
    };
  }
  return stackOverflowResult(query);
}

function wikiResult(subject: string): SearchResult {
  const title = subject
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("_");
  return { title: `${title.replace(/_/g, " ")} - Wikipedia`, url: `https://en.wikipedia.org/wiki/${title}` };
}

function titleCase(text: string): string {
  return text.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** Pick a plausible Google search for this moment in Alex's life. */
export function pickSearch(rng: Rng, day: SeedDay, hour: number): SearchPick {
  const month = Number(day.date.slice(5, 7));
  const workHours = !day.isWeekend && hour >= 9 && hour < 18;
  const summer = month >= 6 && month <= 9;
  const category = rng.weighted<SearchCategory>([
    ["dev", workHours ? 9 : 2.5],
    ["local", 1.6],
    ["food", hour >= 16 && hour < 20 ? 3 : 1.4],
    ["outdoors", (day.isWeekend || day.weekday === 5 ? 2.2 : 0.9) * (summer ? 1.6 : 0.7)],
    ["media", workHours ? 0.6 : 2.2],
    ["howto", 1.6],
    ["shopping", month === 11 || month === 12 ? 2.2 : 0.9],
    ["weather", hour < 10 ? 2.2 : 0.8],
    ["travel", 0.5],
    ["health", 0.8],
  ]);
  return buildSearch(rng, category, month);
}

function buildSearch(rng: Rng, category: SearchCategory, month: number): SearchPick {
  return { category, ...SEARCH_BUILDERS[category](rng, month) };
}

const SEARCH_BUILDERS: Record<SearchCategory, (rng: Rng, month: number) => Omit<SearchPick, "category">> = {
  dev: (rng) => {
    const query = rng.pick(DEV_QUERIES);
    return { query, result: rng.chance(0.55) ? devResult(rng, query) : null };
  },
  local: (rng) => {
    const query = rng.pick(LOCAL_QUERIES);
    const result = rng.chance(0.3)
      ? { title: `${titleCase(query)} | Visit Seattle`, url: `https://visitseattle.org/?s=${encodeURIComponent(query)}` }
      : null;
    return { query, result };
  },
  food: (rng) => {
    if (rng.chance(0.6)) {
      const dish = rng.pick(DISHES);
      const query = rng.pick([`${dish} recipe`, `easy ${dish}`, `${dish} recipe serious eats`, `vegetarian ${dish}`]);
      const result = rng.chance(0.55)
        ? rng.chance(0.5)
          ? {
              title: `${titleCase(dish)} Recipe - NYT Cooking`,
              url: `https://cooking.nytimes.com/recipes/${1_000_000 + (stableHash(dish) % 30_000)}-${slugify(dish)}`,
            }
          : { title: `The Best ${titleCase(dish)} | Serious Eats`, url: `https://www.seriouseats.com/${slugify(dish)}-recipe` }
        : null;
      return { query, result };
    }
    const query = rng.pick(FOOD_QUERIES);
    return { query, result: null };
  },
  outdoors: (rng) => {
    if (rng.chance(0.6)) {
      const trail = rng.pick(TRAILS);
      const query = rng.pick(OUTDOOR_TEMPLATES)(trail);
      const result = rng.chance(0.6)
        ? { title: `${titleCase(trail)} — Washington Trails Association`, url: `https://www.wta.org/go-hiking/hikes/${slugify(trail)}` }
        : null;
      return { query, result };
    }
    return { query: rng.pick(OUTDOOR_QUERIES), result: null };
  },
  media: (rng) => {
    const query = rng.pick(MEDIA_QUERIES);
    return { query, result: rng.chance(0.35) ? wikiResult(query.split(" ").slice(0, 3).join(" ")) : null };
  },
  howto: (rng) => {
    const query = rng.pick(HOWTO_QUERIES);
    const result = rng.chance(0.3)
      ? { title: `${titleCase(query)} - wikiHow`, url: `https://www.wikihow.com/${titleCase(query).replace(/ /g, "-")}` }
      : null;
    return { query, result };
  },
  shopping: (rng, month) => {
    const seasonal =
      month === 11 ? ["gift ideas for sister", "black friday camera deals", "board games for families"] : [];
    const query = rng.pick([...SHOPPING_QUERIES, ...seasonal]);
    const result = rng.chance(0.3)
      ? { title: `${titleCase(query)} | REI Co-op`, url: `https://www.rei.com/search?q=${encodeURIComponent(query)}` }
      : null;
    return { query, result };
  },
  weather: (rng) => {
    return { query: rng.pick(WEATHER_QUERIES), result: null };
  },
  travel: (rng) => {
    const query = rng.pick(TRAVEL_QUERIES);
    return { query, result: rng.chance(0.3) ? wikiResult(query.split(" ").slice(0, 2).join(" ")) : null };
  },
  health: (rng) => {
    const query = rng.pick(HEALTH_QUERIES);
    return { query, result: rng.chance(0.25) ? wikiResult(query.split(" ").slice(0, 2).join(" ")) : null };
  },
};

// ---------------------------------------------------------------------------
// YouTube catalog
// ---------------------------------------------------------------------------

export interface YouTubeChannel {
  name: string;
  /** Synthetic channel id (UC + 22 chars), not the real channel's id. */
  id: string;
  weight: number;
  titles: readonly string[];
}

export interface YouTubeVideo {
  id: string;
  title: string;
  channel: YouTubeChannel;
}

const TECH_100 = ["Rust", "Go", "Bun", "SQLite", "WebAssembly", "Kubernetes", "Zig", "Deno", "SolidJS", "Tailwind", "Redis", "gRPC", "Nix", "HTMX", "Elixir", "DuckDB"];

const CHANNEL_DEFS: readonly { name: string; weight: number; titles: readonly string[] }[] = [
  { name: "Fireship", weight: 6, titles: [...TECH_100.map((t) => `${t} in 100 Seconds`), "I tried 10 code editors", "The Code Report", "God-tier developer roadmap"] },
  { name: "3Blue1Brown", weight: 3, titles: ["But what is a neural network?", "Essence of linear algebra, chapter 1", "The determinant", "Why is pi here? And why is it squared?", "Visualizing the Riemann zeta function", "How (and why) to raise e to the power of a matrix"] },
  { name: "Veritasium", weight: 4, titles: ["The Surprising Secret of Synchronization", "Why No One Has Measured The Speed Of Light", "The Bizarre Behavior of Rotating Bodies", "Math's Fundamental Flaw", "The Most Misunderstood Concept in Physics", "Why the Future of Cars is Electric"] },
  { name: "Tom Scott", weight: 3, titles: ["The Unexpected Logic Behind Rolling Multiple Dice", "Why Electrons Don't Fall Into The Nucleus", "This Bridge Moves Sideways", "The Town Where Everyone Lives in One Building", "Why Snow Is Quiet"] },
  { name: "Kurzgesagt – In a Nutshell", weight: 3, titles: ["The Egg", "What If You Detonated a Nuclear Bomb in the Marianas Trench?", "The Largest Star in the Universe", "Why Alien Life Would be our Doom", "How To Make Friends As An Adult"] },
  { name: "Technology Connections", weight: 3, titles: ["The dishwasher is (probably) better than you think", "Heat pumps: the future of home heating", "The 'Popcorn' button is a lie", "LED bulbs are better now", "Toasters are more complicated than you'd think"] },
  { name: "Babish Culinary Universe", weight: 3, titles: ["Binging with Babish: Ratatouille", "Basics with Babish: Pasta Carbonara", "Basics with Babish: Pizza", "Binging with Babish: Krabby Patty", "Basics with Babish: Sourdough"] },
  { name: "Joshua Weissman", weight: 2, titles: ["Making Fast Food Burgers At Home", "The Perfect Homemade Ramen", "But Cheaper: Chipotle Burrito", "Homemade Croissants (Easier Than You Think)", "Perfect Fried Chicken"] },
  { name: "Marques Brownlee", weight: 3, titles: ["Pixel 9 Pro Review!", "The Best Smartphones of the Year", "Dope Tech: Robot Vacuums", "Apple Vision Pro Impressions", "The Truth About Electric Cars"] },
  { name: "Hiking Washington", weight: 2, titles: ["Mount Si in Winter", "Rattlesnake Ledge at Sunrise", "Enchantments Thru-Hike in One Day", "Lake 22 Snowshoe", "Top 10 Day Hikes Near Seattle"] },
  { name: "REI", weight: 2, titles: ["How to Choose Hiking Boots", "Layering Basics", "How to Pack a Backpack", "Ten Essentials Explained", "Trail Running for Beginners"] },
  { name: "GCN", weight: 2, titles: ["How To Replace A Bike Chain", "Commuting By Bike In The Rain", "Is Indoor Training Worth It?", "5 Easy Bike Maintenance Jobs", "How To Climb Hills Faster"] },
  { name: "Kitboga", weight: 1.5, titles: ["Scammer Gets Confused By Grandma", "The Gift Card Scammer", "He Didn't Expect This"] },
  { name: "NPR Music", weight: 3, titles: ["Phoebe Bridgers: Tiny Desk Concert", "boygenius: Tiny Desk Concert", "Khruangbin: Tiny Desk Concert", "Fleet Foxes: Tiny Desk Concert", "Mac Miller: Tiny Desk Concert", "Anderson .Paak & The Free Nationals: Tiny Desk Concert"] },
  { name: "KEXP", weight: 3, titles: ["Fleet Foxes - Full Performance (Live on KEXP)", "Khruangbin - Full Performance (Live on KEXP)", "Car Seat Headrest - Full Performance (Live on KEXP)", "Japanese Breakfast - Full Performance (Live on KEXP)", "Death Cab for Cutie - Full Performance (Live on KEXP)"] },
  { name: "Lofi Girl", weight: 2.5, titles: ["lofi hip hop radio - beats to relax/study to", "synthwave radio - beats to chill/game to", "sleepy lofi - beats to sleep/chill to"] },
  { name: "Primitive Technology", weight: 1.5, titles: ["Primitive Technology: Tiled Roof Hut", "Primitive Technology: Water Wheel", "Primitive Technology: Iron Prills"] },
  { name: "Mumbo Jumbo", weight: 2, titles: ["Hermitcraft 10: Episode 1", "The Easiest Villager Trading Hall", "Minecraft Redstone Tricks You Didn't Know", "Building A Mega Base"] },
  { name: "Wendover Productions", weight: 2.5, titles: ["Why Flying is so Expensive", "The Logistics of the Olympics", "How Container Ships Work", "The Economics of Airline Food"] },
  { name: "Hank Green", weight: 1.5, titles: ["Why Do We Have Fingernails?", "The Weirdest Thing About Octopuses", "I Read the Whole Thing So You Don't Have To"] },
  { name: "Theo - t3.gg", weight: 2.5, titles: ["Why I'm Moving Off Vercel", "React Server Components Explained", "TypeScript Is Getting A Lot Faster", "I Was Wrong About SQLite"] },
  { name: "ThePrimeTime", weight: 2.5, titles: ["Rust Is Not For Everyone", "Vim As Your Editor", "The Hardest Part Of Programming", "Go Is Boring (And That's Good)"] },
  { name: "Seattle Kraken", weight: 1.5, titles: ["Highlights: Kraken vs. Canucks", "Kraken Goal of the Month", "Inside the Kraken Locker Room"] },
  { name: "Sounders FC", weight: 1, titles: ["Highlights: Sounders vs. Timbers", "Every Goal from the Season", "Matchday at Lumen Field"] },
  { name: "Steve Mould", weight: 2, titles: ["The Spinning Chain Mystery", "Why This Pendulum Never Stops", "A Better Way To Picture Atoms"] },
  { name: "Adam Neely", weight: 1.5, titles: ["Why Every Song Sounds the Same", "The Music Theory of Lo-Fi", "What Makes a Bassline Groove"] },
];

const VIEW_POSTS = [
  "New video drops Friday — any guesses what we built?",
  "Behind the scenes from this week's shoot",
  "Which recipe should we do next? Vote below",
  "Tour dates just announced!",
  "Thanks for 1M subscribers",
  "Quick poll: tabs or spaces?",
  "Our studio cat says hi",
  "Live stream tomorrow at 10am PT",
];

const YT_ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function ytId(seed: string, length: number): string {
  let h = stableHash(seed);
  let out = "";
  for (let i = 0; i < length; i++) {
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
    h = (h + i * 0x9e3779b9) >>> 0;
    out += YT_ID_CHARS[h % 64];
  }
  return out;
}

export const YOUTUBE_CHANNELS: readonly YouTubeChannel[] = CHANNEL_DEFS.map((def) => ({
  ...def,
  id: `UC${ytId(`channel:${def.name}`, 22)}`,
}));

export const YOUTUBE_VIDEOS: readonly YouTubeVideo[] = YOUTUBE_CHANNELS.flatMap((channel) =>
  channel.titles.map((title) => ({ id: ytId(`video:${channel.name}:${title}`, 11), title, channel })),
);

export function videosOf(channel: YouTubeChannel): YouTubeVideo[] {
  return YOUTUBE_VIDEOS.filter((v) => v.channel === channel);
}

export function pickVideo(rng: Rng): YouTubeVideo {
  const channel = rng.weighted(YOUTUBE_CHANNELS.map((c) => [c, c.weight] as const));
  return rng.pick(videosOf(channel));
}

export function pickCommunityPost(rng: Rng): { text: string; channel: YouTubeChannel; postId: string } {
  const channel = rng.weighted(YOUTUBE_CHANNELS.map((c) => [c, c.weight] as const));
  const text = rng.pick(VIEW_POSTS);
  return { text, channel, postId: `Ugk${ytId(`post:${channel.name}:${text}:${rng.int(0, 99)}`, 20)}` };
}

export const YOUTUBE_SEARCHES = [
  "lofi hip hop",
  "mount si hike",
  "how to replace bike chain",
  "tiny desk concert",
  "kexp live",
  "babish carbonara",
  "rust tutorial",
  "sqlite performance",
  "solidjs tutorial",
  "minecraft trading hall",
  "kraken highlights",
  "enchantments hike",
  "sourdough shaping",
  "fleet foxes live",
  "3blue1brown neural network",
  "how to wash down jacket",
  "pixel 9 review",
  "veritasium",
  "best hikes near seattle",
  "climbing technique footwork",
] as const;
