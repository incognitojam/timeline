import type { SeedDay, SeedSource } from "../context";
import { PROJECTS, SELF } from "../persona";
import type { Rng } from "../rng";
import { activityHour, atLocalHour, GOOGLE_ACCOUNT, pickSearch, pickVideo, recencyFactor, slugify } from "./google-data";

interface ChromeEntry {
  favicon_url: string;
  page_transition: string;
  page_transition_qualifier?: string;
  title: string;
  url: string;
  time_usec: number;
  client_id: string;
}

interface Page {
  title: string;
  url: string;
  transition?: string;
}

const HN_STORIES = [
  "Show HN: I built a tiny SQLite-backed personal search engine",
  "The case for boring technology",
  "Why we moved off microservices",
  "A visual guide to SSH tunnels",
  "Ask HN: What's your favourite self-hosted app?",
  "How Discord stores trillions of messages",
  "The unreasonable effectiveness of plain text",
  "Rust in production: two years later",
  "Postgres is enough",
  "What every programmer should know about memory",
  "Show HN: A CLI that turns your bank CSVs into a budget",
  "Local-first software: you own your data",
];

const REDDIT_THREADS: readonly [string, string][] = [
  ["Seattle", "Best rainy day activities in the city?"],
  ["Seattle", "Light rail to the airport is the best thing ever"],
  ["Seattle", "Anyone else see the orcas off Alki today?"],
  ["PNWhiking", "Mount Si conditions this weekend?"],
  ["PNWhiking", "Larches are peaking near Snoqualmie Pass"],
  ["PNWhiking", "First time doing Rattlesnake Ledge, tips?"],
  ["rust", "What's everyone working on this week?"],
  ["typescript", "Is satisfies the most underrated operator?"],
  ["selfhosted", "Show off your homelab dashboards"],
  ["bouldering", "Finally sent my first V5!"],
  ["Cooking", "My first focaccia, what went wrong?"],
  ["boardgames", "Wingspan with 5 players is chaos"],
  ["Minecraft", "Our survival world after two years"],
];

const NEWS: readonly [string, string, string][] = [
  ["The Seattle Times", "seattletimes.com", "Light rail extension opens to riders this weekend"],
  ["The Seattle Times", "seattletimes.com", "Atmospheric river brings heavy rain to Puget Sound"],
  ["The Seattle Times", "seattletimes.com", "Kraken clinch playoff spot with overtime win"],
  ["The Stranger", "thestranger.com", "The best things to do in Seattle this weekend"],
  ["KUOW", "kuow.org", "Why Seattle's summers keep getting smokier"],
  ["The Verge", "theverge.com", "The best Android phones to buy right now"],
  ["Ars Technica", "arstechnica.com", "How the latest SSD controllers squeeze out more speed"],
];

const SHOP: readonly [string, string][] = [
  ["Patagonia Nano Puff Jacket - Men's | REI Co-op", "https://www.rei.com/product/nano-puff-jacket"],
  ["Osprey Talon 22 Pack | REI Co-op", "https://www.rei.com/product/talon-22-pack"],
  ["Smartwool Merino 250 Base Layer | REI Co-op", "https://www.rei.com/product/merino-250-base-layer"],
  ["Black Diamond Spot 400 Headlamp | REI Co-op", "https://www.rei.com/product/spot-400-headlamp"],
  ["Keychron Q1 Pro Mechanical Keyboard", "https://www.keychron.com/products/keychron-q1-pro"],
  ["Amazon.com: Shopping Cart", "https://www.amazon.com/gp/cart/view.html"],
  ["Your Orders - Amazon.com", "https://www.amazon.com/gp/your-account/order-history"],
];

const WORK_DOCS = [
  "Ingest pipeline v2 design",
  "Q3 platform planning",
  "On-call handbook",
  "Incident review: delayed batch exports",
  "Schema registry migration plan",
  "Team offsite notes",
];

type BrowseKind = "search" | "github" | "work" | "hn" | "reddit" | "news" | "youtube" | "mail" | "shop" | "wta" | "media";

function favicon(url: string): string {
  const host = new URL(url).host;
  return `https://www.google.com/s2/favicons?domain=${host}`;
}

function githubPage(rng: Rng): Page {
  const project = rng.pick(PROJECTS);
  const base = `https://github.com/${project.repo}`;
  const n = rng.int(12, 240);
  return rng.weighted<Page>([
    [{ title: `${project.repo}: ${project.description}`, url: base }, 3],
    [{ title: `Pull requests · ${project.repo}`, url: `${base}/pulls` }, 3],
    [
      {
        title: `${rng.pick(["Fix flaky sync test", "Add retry with backoff", "Bump dependencies", "Refactor config loading", "Speed up import batching", "Handle empty export files"])} by ${SELF.handle} · Pull Request #${n} · ${project.repo}`,
        url: `${base}/pull/${n}`,
      },
      4,
    ],
    [{ title: `Issues · ${project.repo}`, url: `${base}/issues` }, 1.5],
    [{ title: `Actions · ${project.repo}`, url: `${base}/actions` }, 1.5],
    [{ title: `${project.name}/README.md at main · ${project.repo}`, url: `${base}/blob/main/README.md` }, 1],
  ]);
}

function browsePage(rng: Rng, day: SeedDay, hour: number): Page[] {
  const workHours = !day.isWeekend && hour >= 9 && hour < 18;
  const kind = rng.weighted<BrowseKind>([
    ["search", 6],
    ["github", workHours ? 5 : 1.2],
    ["work", workHours ? 3 : 0.2],
    ["hn", 1.6],
    ["reddit", 1.6],
    ["news", 1.2],
    ["youtube", workHours ? 0.4 : 2],
    ["mail", 1.2],
    ["shop", 0.7],
    ["wta", day.isWeekend || day.weekday === 4 || day.weekday === 5 ? 1.4 : 0.4],
    ["media", workHours ? 0.1 : 0.8],
  ]);
  return BROWSE[kind](rng, day, hour);
}

const BROWSE: Record<BrowseKind, (rng: Rng, day: SeedDay, hour: number) => Page[]> = {
  search: (rng, day, hour) => {
    const pick = pickSearch(rng, day, hour);
    const pages: Page[] = [
      {
        title: `${pick.query} - Google Search`,
        url: `https://www.google.com/search?q=${encodeURIComponent(pick.query)}`,
        transition: "GENERATED",
      },
    ];
    if (pick.result) pages.push(pick.result);
    return pages;
  },
  github: (rng) => {
    return [githubPage(rng), ...(rng.chance(0.5) ? [githubPage(rng)] : [])];
  },
  work: (rng) => {
    const doc = rng.pick(WORK_DOCS);
    return [
      rng.chance(0.5)
        ? { title: `${doc} - Google Docs`, url: `https://docs.google.com/document/d/${slugify(doc)}/edit` }
        : { title: `Platform squad - Google Chat`, url: "https://mail.google.com/chat/u/0/" },
    ];
  },
  hn: (rng) => {
    const story = rng.pick(HN_STORIES);
    return [
      { title: "Hacker News", url: "https://news.ycombinator.com/", transition: "TYPED" },
      { title: story, url: `https://news.ycombinator.com/item?id=${38_000_000 + rng.int(0, 4_000_000)}` },
    ];
  },
  reddit: (rng) => {
    const [sub, thread] = rng.pick(REDDIT_THREADS);
    return [{ title: `${thread} : r/${sub}`, url: `https://www.reddit.com/r/${sub}/comments/${rng.hex(6)}/${slugify(thread)}/` }];
  },
  news: (rng) => {
    const [site, host, headline] = rng.pick(NEWS);
    return [{ title: `${headline} | ${site}`, url: `https://www.${host}/${slugify(headline)}/` }];
  },
  youtube: (rng) => {
    const video = pickVideo(rng);
    return [{ title: `${video.title} - YouTube`, url: `https://www.youtube.com/watch?v=${video.id}` }];
  },
  mail: (rng) => {
    const unread = rng.int(0, 14);
    return [
      {
        title: unread > 0 ? `Inbox (${unread}) - ${SELF.email} - Gmail` : `Inbox - ${SELF.email} - Gmail`,
        url: "https://mail.google.com/mail/u/0/#inbox",
        transition: "AUTO_BOOKMARK",
      },
      ...(rng.chance(0.3) ? [{ title: "Google Calendar - Week view", url: "https://calendar.google.com/calendar/u/0/r/week" }] : []),
    ];
  },
  shop: (rng) => {
    const [title, url] = rng.pick(SHOP);
    return [{ title, url }];
  },
  wta: (rng) => {
    const trail = rng.pick(["Mount Si", "Rattlesnake Ledge", "Lake Serene", "Mailbox Peak", "Twin Falls", "Snow Lake", "Lake 22"]);
    return [
      { title: `${trail} — Washington Trails Association`, url: `https://www.wta.org/go-hiking/hikes/${slugify(trail)}` },
      ...(rng.chance(0.5)
        ? [{ title: `Trip Reports — ${trail} — Washington Trails Association`, url: `https://www.wta.org/go-hiking/hikes/${slugify(trail)}/@@related_tripreport_listing` }]
        : []),
    ];
  },
  media: (rng) => {
    const [title, url] = rng.pick<readonly [string, string]>([
      ["Netflix", "https://www.netflix.com/browse"],
      ["Spotify – Web Player", "https://open.spotify.com/"],
      ["Letterboxd • Social film discovery.", "https://letterboxd.com/"],
      ["Goodreads | Want to Read", "https://www.goodreads.com/review/list"],
    ]);
    return [{ title, url, transition: "TYPED" }];
  },
};

/** Takeout "Chrome/History.json", run through the CLI importer. */
export const googleChromeSeed: SeedSource = {
  name: "google-chrome",
  produces: { chrome: ["browse"] },
  async seed(ctx) {
    const rng = ctx.rng("google-chrome");
    const laptop = rng.hex(32);
    const work = rng.hex(32);
    const entries: ChromeEntry[] = [];

    for (const day of ctx.days) {
      const sessions = rng.poisson(1.75 * recencyFactor(ctx, day));
      for (let s = 0; s < sessions; s++) {
        const hour = activityHour(rng, day);
        let t = atLocalHour(ctx, day.date, hour).getTime();
        const client = !day.isWeekend && hour >= 9 && hour < 18 ? work : laptop;
        const pageCount = rng.int(1, 3);
        for (let p = 0; p < pageCount; p++) {
          for (const page of browsePage(rng, day, hour)) {
            // Sign-in hops show up as untitled redirects, which the importer skips.
            if (rng.chance(0.03)) {
              entries.push({
                favicon_url: "",
                page_transition: "LINK",
                page_transition_qualifier: "CLIENT_REDIRECT",
                title: "",
                url: "https://accounts.google.com/ServiceLogin",
                time_usec: t * 1000 - 400_000,
                client_id: client,
              });
            }
            entries.push({
              favicon_url: favicon(page.url),
              page_transition: page.transition ?? "LINK",
              ...(rng.chance(0.15) ? { page_transition_qualifier: "CHAIN_START_AND_END" } : {}),
              title: page.title,
              url: page.url,
              time_usec: t * 1000 + rng.int(0, 999),
              client_id: client,
            });
            t += rng.int(8, 240) * 1000;
          }
        }
      }
    }

    entries.sort((a, b) => b.time_usec - a.time_usec);
    ctx.writeStaged("google-chrome", "Chrome/History.json", JSON.stringify({ "Browser History": entries }));
    await ctx.runParserCli("parsers/google-chrome.ts", [ctx.stage("google-chrome"), GOOGLE_ACCOUNT]);
  },
};
