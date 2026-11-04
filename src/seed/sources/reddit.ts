import { importRedditData } from "../../parsers/reddit";
import type { SeedContext, SeedSource } from "../context";
import { SELF } from "../persona";
import type { Rng } from "../rng";

const NAME = "reddit";
const USERNAME = SELF.handle;

interface Subreddit {
  name: string;
  /** Relative share of Alex's activity. */
  weight: number;
  posts: readonly { title: string; body: string }[];
  comments: readonly string[];
  /** Titles of other people's threads Alex comments on or votes in. */
  threads: readonly string[];
}

const TRAILS = ["Mount Si", "Rattlesnake Ledge", "Lake Serene", "Snow Lake", "Mailbox Peak", "Lake 22", "Heather Lake", "Granite Mountain"] as const;

const SUBREDDITS: readonly Subreddit[] = [
  {
    name: "Seattle",
    weight: 5,
    posts: [
      { title: "Light rail at 7am on a Saturday is a delight", body: "Empty train, sunrise over the lake, a guy with a cello. Ten out of ten." },
      { title: "Where to watch the Blue Angels without the crowds?", body: "Kerry Park is always packed. Any quieter spots with a decent view of the lake?" },
      { title: "PSA: Volunteer Park conservatory is free on first Thursdays", body: "" },
      { title: "Best place to buy a used bike on Capitol Hill?", body: "Looking for a commuter, nothing fancy. Budget around $400." },
    ],
    comments: [
      "Gas Works Park at sunset is still undefeated.",
      "The 8 bus is a lifestyle, not a commute.",
      "Elliott Bay Book Company is the answer to most weekend questions.",
      "Discovery Park loop trail is great when the mountains are out.",
      "Bring a rain jacket. Not an umbrella. Never an umbrella.",
      "Pike Place on a weekday morning before 9 is actually lovely.",
      "Ballard Locks fish ladder is worth it in late summer when the salmon are running.",
      "The Central Library has free meeting rooms you can book, very underrated.",
      "Green Lake on a sunny Saturday is chaos. Go early or go to Magnuson.",
      "Can confirm, the mountain was out this morning and everyone on the bus was staring.",
    ],
    threads: [
      "What's the best teriyaki in the city?",
      "The mountain is out!",
      "Rainiest stretch I can remember",
      "Underrated neighbourhoods for a Sunday walk",
      "Moving to Seattle next month, what should I know?",
      "Light rail Lynnwood extension first impressions",
    ],
  },
  {
    name: "PNWhiking",
    weight: 5,
    posts: [
      { title: "{trail} trip report: snow above 3500ft, microspikes recommended", body: "Trail was clear to the second switchback then packed snow the rest of the way. Spikes made it easy. Parking lot full by 8:30." },
      { title: "Larches are turning on the way to Lake Ingalls", body: "Went up on Saturday, about 60% golden. Next weekend should be peak." },
      { title: "{trail} on a weekday is a different trail entirely", body: "Took a day off and had the summit to myself for 20 minutes." },
      { title: "Good beginner hikes within an hour of Seattle?", body: "Friend is visiting and wants mountains but nothing too punishing." },
    ],
    comments: [
      "Check the WTA trip reports before you go, conditions change fast this time of year.",
      "Little Si is a great warm up if you're new to the area.",
      "Start before 7 and you'll get parking. After 9 it's a gamble.",
      "Ten essentials, every time. Learned that one the hard way.",
      "The view from the top of {trail} on a clear day is unreal.",
      "Snow Lake is gorgeous but very popular, try it on a weekday.",
      "Microspikes are worth every penny from November to May.",
      "Twin Falls is lovely in the rain, honestly better than on a sunny day.",
      "Northwest Forest Pass, don't forget it. They do check.",
      "Rattlesnake Ledge is crowded but the lake at the bottom is a great swim spot in August.",
    ],
    threads: [
      "Trip report: {trail}",
      "Gear check before my first winter hike",
      "Are the roads to the trailheads open yet?",
      "Best fall colours near North Bend",
      "Sunrise from the top of {trail}",
    ],
  },
  {
    name: "rust",
    weight: 2,
    posts: [
      { title: "Show r/rust: pocket-ledger, a tiny budgeting CLI", body: "A weekend project to learn clap and serde. Feedback on the error handling very welcome!" },
    ],
    comments: [
      "thiserror for libraries, anyhow for binaries has served me well.",
      "Once the borrow checker clicks it really does change how you write code in other languages.",
      "cargo clippy -- -W clippy::pedantic is a humbling experience.",
      "You probably want an iterator chain here rather than collecting into a Vec first.",
      "serde's rename_all attribute will save you a lot of boilerplate.",
    ],
    threads: ["What's everyone working on this week?", "Error handling patterns in 2025", "Is async Rust worth it for CLI tools?"],
  },
  {
    name: "golang",
    weight: 2,
    posts: [{ title: "Structured logging with slog in a data pipeline: lessons learned", body: "We moved our ingest service from a third-party logger to log/slog. Notes on performance and handler design inside." }],
    comments: [
      "errgroup is the answer to about half of the concurrency questions on this sub.",
      "Table-driven tests plus t.Run makes failures so much easier to read.",
      "Context cancellation everywhere. Your future self will thank you.",
      "pprof will tell you the truth, your intuition won't.",
    ],
    threads: ["Generics a few years on: how are you using them?", "Favourite small standard library packages", "Who's hiring (monthly thread)"],
  },
  {
    name: "typescript",
    weight: 2,
    posts: [],
    comments: [
      "satisfies is my favourite addition in years.",
      "Discriminated unions solve this cleanly without any casts.",
      "Turn on noUncheckedIndexedAccess, it catches real bugs.",
      "Zod at the boundary, plain types everywhere else.",
    ],
    threads: ["What tsconfig flags do you always turn on?", "Bun vs Node for a new project in 2025", "Type-safe SQL options"],
  },
  {
    name: "boardgames",
    weight: 2,
    posts: [{ title: "Cascadia is the perfect weeknight game", body: "Thirty minutes, gorgeous components, and our group of four argues about it for days." }],
    comments: [
      "Wingspan with the Oceania expansion is a big improvement.",
      "Spirit Island is fantastic but bring snacks, it's a long one.",
      "Codenames is still the best opener for a mixed group.",
      "Sleeve your cards if your friends eat while playing. Ask me how I know.",
    ],
    threads: ["What did you play this week?", "Best two-player games?", "Gateway games for non-gamers"],
  },
  {
    name: "houseplants",
    weight: 1,
    posts: [{ title: "My balcony monstera after one Seattle summer", body: "Rescued it from the clearance shelf last spring. Moisture sensor and a grow light did the rest." }],
    comments: [
      "Overwatering kills more plants than anything else. Let it dry out.",
      "Pothos will survive almost anything, great starter plant.",
      "A cheap soil moisture sensor changed the game for me.",
    ],
    threads: ["Help! Yellow leaves on my fiddle leaf fig", "Show off your propagation station", "Low light plants for a north-facing window"],
  },
  {
    name: "selfhosted",
    weight: 1,
    posts: [],
    comments: [
      "Back up your backups. Then test restoring them.",
      "Tailscale made remote access to my home server painless.",
      "SQLite is more than enough for most personal projects.",
    ],
    threads: ["What's in your homelab?", "Personal data archive setups?", "Most useful self-hosted app you run"],
  },
  {
    name: "Ultralight",
    weight: 1,
    posts: [],
    comments: [
      "Cut the toothbrush handle all you want, it's the pack that matters.",
      "A good quilt saved me more weight than any other upgrade.",
      "Trekking poles double as tent poles, two birds.",
    ],
    threads: ["Shakedown: first overnight in the Cascades", "Rain gear for the PNW", "Lightest reliable stove?"],
  },
];

/** Strangers Alex trades DMs with. */
const PENPALS = [
  {
    user: "summit_sasquatch",
    subject: "selling microspikes",
    lines: [
      ["them", "Hey, are the microspikes from your post still available?"],
      ["me", "Yep! Size M, used one season. $25?"],
      ["them", "Deal. Could I pick them up near Capitol Hill this weekend?"],
      ["me", "Saturday morning works. Outside Cedar & Salt Bakery at 10?"],
      ["them", "See you there, thanks!"],
    ],
  },
  {
    user: "cascade_kestrel",
    subject: "Lake Ingalls carpool",
    lines: [
      ["them", "Saw your larch post. Any chance you have room in the car next Saturday?"],
      ["me", "We're full this time, sorry! Try the carpool thread pinned on the sub."],
      ["them", "Will do, thanks for replying!"],
    ],
  },
  {
    user: "ferry_fog",
    subject: "pocket-ledger question",
    lines: [
      ["them", "Hi! Does pocket-ledger support CSV import from banks?"],
      ["me", "Not yet, but it's on the list. Happy to take a PR if you're keen!"],
      ["them", "Might take you up on that. Nice project."],
    ],
  },
  {
    user: "meeple_marmot",
    subject: "Board game swap",
    lines: [
      ["them", "Interested in trading your copy of Azul for Cascadia?"],
      ["me", "I'm keeping Cascadia, sorry! Good luck with the swap."],
    ],
  },
] as const;

/** Openers that make repeated comment bodies read differently. */
const COMMENT_OPENERS = [
  "Seconding this.",
  "Great question!",
  "Ha, been there.",
  "Agree with the top comment.",
  "Thanks for posting this.",
  "Late reply, but:",
  "Came here to say this.",
  "Honestly?",
] as const;

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

function base36(rng: Rng, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[rng.int(0, ALPHABET.length - 1)];
  return out;
}

function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 50);
}

function fillTrail(text: string, rng: Rng): string {
  return text.replaceAll("{trail}", rng.pick(TRAILS));
}

function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function csv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return [header.join(","), ...rows.map((row) => row.map(csvField).join(","))].join("\n");
}

/** "2017-04-11 21:24:12 UTC", as in the Reddit export. */
function redditDate(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

/** Reddit browsing time: evenings and lunch breaks, plus lazy weekend mornings. */
function browseHour(rng: Rng, isWeekend: boolean): number {
  return isWeekend ? rng.pick([9, 10, 11, 14, 16, 20, 21, 22]) : rng.pick([7, 12, 12, 13, 19, 20, 21, 22, 23]);
}

export const redditSeed: SeedSource = {
  name: NAME,
  produces: { reddit: ["post", "comment", "message", "vote:up", "vote:down", "save"] },
  async seed(ctx: SeedContext) {
    const rng = ctx.rng(NAME);
    const ip = () => `203.0.113.${rng.int(2, 250)}`;
    const pickSub = () => rng.weighted(SUBREDDITS.map((sub) => [sub, sub.weight] as const));
    const threadUrl = (sub: Subreddit, id: string, title: string) => `https://www.reddit.com/r/${sub.name}/comments/${id}/${slug(title)}/`;

    // Posts: a few dozen over three years.
    const postRows: string[][] = [];
    const posts = SUBREDDITS.flatMap((sub) => sub.posts.map((post) => ({ sub, post })));
    // Every post once, plus a run of trip reports (the only ones Alex repeats).
    const tripReports = posts.filter(({ post }) => post.title.includes("{trail}"));
    const extra = Array.from({ length: 20 }, () => rng.pick(tripReports));
    for (const { sub, post } of [...posts, ...extra]) {
      const day = rng.pick(ctx.days);
      const at = ctx.localDate(day.date, browseHour(rng, day.isWeekend), rng.int(0, 59), rng.int(0, 59));
      const id = base36(rng, 7);
      const title = fillTrail(post.title, rng);
      postRows.push([
        id,
        threadUrl(sub, id, title),
        redditDate(at.toISOString()),
        String(Math.floor(at.getTime() / 1000)),
        ip(),
        sub.name,
        "{}",
        title,
        post.body ? "" : `https://www.reddit.com/r/${sub.name}/comments/${id}/`,
        post.body,
      ]);
    }

    // Comments: most days have none, some have a burst.
    const commentRows: string[][] = [];
    for (const day of ctx.days) {
      for (let n = rng.poisson(day.isWeekend ? 0.45 : 0.3); n > 0; n--) {
        const sub = pickSub();
        const at = ctx.localDate(day.date, browseHour(rng, day.isWeekend), rng.int(0, 59), rng.int(0, 59));
        const postId = base36(rng, 7);
        const commentId = base36(rng, 7);
        const thread = fillTrail(rng.pick(sub.threads), rng);
        let body = fillTrail(rng.pick(sub.comments), rng);
        if (rng.chance(0.3)) body = `${rng.pick(COMMENT_OPENERS)} ${body}`;
        if (rng.chance(0.25)) body += `\n\n${fillTrail(rng.pick(sub.comments), rng)}`;
        const parent = rng.chance(0.6) ? `t3_${postId}` : `t1_${base36(rng, 7)}`;
        commentRows.push([
          commentId,
          `https://www.reddit.com/r/${sub.name}/comments/${postId}/comment/${commentId}/`,
          redditDate(at.toISOString()),
          String(Math.floor(at.getTime() / 1000)),
          ip(),
          sub.name,
          "{}",
          threadUrl(sub, postId, thread),
          parent,
          body,
          "",
        ]);
      }
    }

    // Messages with a handful of strangers.
    const messageRows: string[][] = [];
    for (const penpal of PENPALS) {
      const day = rng.pick(ctx.days);
      let at = ctx.localDate(day.date, browseHour(rng, day.isWeekend), rng.int(0, 59)).getTime();
      const threadId = rng.chance(0.5) ? `t4_${base36(rng, 6)}` : "";
      penpal.lines.forEach(([speaker, body], index) => {
        const id = base36(rng, 6);
        const [from, to] = speaker === "me" ? [USERNAME, penpal.user] : [penpal.user, USERNAME];
        messageRows.push([
          id,
          `https://www.reddit.com/message/messages/${id}`,
          threadId,
          redditDate(new Date(at).toISOString()),
          ip(),
          from,
          to,
          index === 0 ? penpal.subject : `re: ${penpal.subject}`,
          body,
        ]);
        at += rng.int(10, 600) * 60_000;
      });
    }
    // Moderator notices arrive from the subreddit itself.
    for (const sub of ["PNWhiking", "Seattle"]) {
      const day = rng.pick(ctx.days);
      const id = base36(rng, 6);
      messageRows.push([
        id,
        `https://www.reddit.com/message/messages/${id}`,
        "",
        redditDate(ctx.localIso(day.date, rng.int(8, 22), rng.int(0, 59))),
        "",
        `/r/${sub}`,
        USERNAME,
        `Your post in r/${sub} was approved`,
        `Thanks for posting! Your submission to r/${sub} was held by the spam filter and has now been approved by the moderators.`,
      ]);
    }

    // Votes and saves carry no timestamps in the export.
    const voteRows = (count: number, kind: "post" | "comment") => {
      const rows: string[][] = [];
      for (let i = 0; i < count; i++) {
        const sub = pickSub();
        const id = base36(rng, 7);
        const thread = fillTrail(rng.pick(sub.threads), rng);
        const permalink =
          kind === "post" ? threadUrl(sub, id, thread) : `https://www.reddit.com/r/${sub.name}/comments/${base36(rng, 7)}/comment/${id}/`;
        rows.push([id, permalink, rng.chance(0.88) ? "up" : "down"]);
      }
      return rows;
    };
    const savedRows: string[][] = [];
    for (let i = 0; i < 30; i++) {
      const sub = pickSub();
      const id = base36(rng, 7);
      savedRows.push([id, threadUrl(sub, id, fillTrail(rng.pick(sub.threads), rng))]);
    }

    ctx.writeStaged(NAME, "export/posts.csv", csv(["id", "permalink", "date", "created_utc", "ip", "subreddit", "gildings", "title", "url", "body"], postRows));
    ctx.writeStaged(
      NAME,
      "export/comments.csv",
      csv(["id", "permalink", "date", "created_utc", "ip", "subreddit", "gildings", "link", "parent", "body", "media"], commentRows),
    );
    ctx.writeStaged(NAME, "export/messages_archive.csv", csv(["id", "permalink", "thread_id", "date", "ip", "from", "to", "subject", "body"], messageRows));
    ctx.writeStaged(NAME, "export/post_votes.csv", csv(["id", "permalink", "direction"], voteRows(220, "post")));
    ctx.writeStaged(NAME, "export/comment_votes.csv", csv(["id", "permalink", "direction"], voteRows(130, "comment")));
    ctx.writeStaged(NAME, "export/saved_posts.csv", csv(["id", "permalink"], savedRows));
    await ctx.inTransaction(() => importRedditData(ctx.db, `${ctx.stage(NAME)}/export`, USERNAME));

    ctx.identify("alex", `reddit:${USERNAME}`);
  },
};
