import { importSpotifyData } from "../../parsers/spotify";
import type { SeedContext, SeedDay, SeedSource } from "../context";
import type { Rng } from "../rng";
import { CATALOGUE, type CatalogueTrack, spotifyId } from "./life-data";

/** Spotify account name (the importer's source_account). */
const ACCOUNT = "alexrivera";

/** How much Alex likes each artist; anything unlisted is a friend's taste. */
const AFFINITY: Readonly<Record<string, number>> = {
  "Fleetwood Mac": 6,
  "Tame Impala": 6,
  SZA: 5,
  "Billie Eilish": 4,
  "Sabrina Carpenter": 3,
  "Chappell Roan": 3,
  AURORA: 2,
  "Fleet Foxes": 3,
  "Death Cab for Cutie": 3,
  "Bon Iver": 2,
  "Phoebe Bridgers": 2,
  boygenius: 2,
  Khruangbin: 3,
  "Mac DeMarco": 2,
  "Vampire Weekend": 2,
  "Arctic Monkeys": 2,
  Radiohead: 3,
  "Frank Ocean": 3,
  "Kendrick Lamar": 2,
  "Japanese Breakfast": 2,
  Mitski: 1.5,
  "Beach House": 2,
  HAIM: 1.5,
  "Daft Punk": 2,
  "LCD Soundsystem": 2,
  Caribou: 2,
  Clairo: 1.5,
  Lorde: 1.5,
  "Taylor Swift": 1,
  Hozier: 1,
  "Noah Kahan": 1,
  "The Strokes": 1.5,
  "Big Thief": 1.5,
  Nirvana: 1,
  "Pearl Jam": 1,
  "Sufjan Stevens": 1.5,
  "Fred again..": 2,
};

interface Show {
  name: string;
  /** Title templates; `{}` is replaced by a subject. */
  templates: readonly string[];
  subjects: readonly string[];
  minutes: readonly [number, number];
  weight: number;
}

/** Real shows; episode titles are invented and generic. */
const SHOWS: readonly Show[] = [
  {
    name: "Hard Fork",
    templates: ["{} + Listener Questions", "The Week in {}", "{}, Explained", "Is {} Overhyped?", "{} + Hard Questions"],
    subjects: ["AI Agents", "Robotaxis", "Smart Glasses", "Chatbot Companions", "App Store Fights", "Chip Export Rules", "Social Media Bans for Teens", "Vibe Coding", "Deepfake Detection", "The Search Shake-Up", "Humanoid Robots", "Prediction Markets"],
    minutes: [55, 75],
    weight: 3,
  },
  {
    name: "Decoder with Nilay Patel",
    templates: ["Why {} is harder than it looks", "The fight over {}", "What's next for {}", "Inside the business of {}"],
    subjects: ["open source AI", "the smartphone", "streaming bundles", "creator payouts", "browser choice", "right to repair", "EV charging", "podcast ads", "smart home standards", "cloud gaming"],
    minutes: [45, 65],
    weight: 1.5,
  },
  {
    name: "99% Invisible",
    templates: ["The Hidden Life of {}", "{}", "The Secret History of {}", "In Defense of {}"],
    subjects: ["Bike Lanes", "Concrete", "Sidewalk Curb Cuts", "Highway Signs", "Map Rooms", "Houseboats", "Public Benches", "Freeway Lids", "Manhole Covers", "Parking Minimums", "Ferry Terminals", "Street Trees"],
    minutes: [30, 45],
    weight: 1.5,
  },
  {
    name: "Radiolab",
    templates: ["{}", "The Science of {}", "{}, Revisited"],
    subjects: ["The Sound of Ice", "Counting Crows", "Memory Palaces", "Seeing in the Dark", "The Weight of Air", "Gut Feelings", "Tiny Clocks", "Octopus Minds", "Lost Colors", "Sleep Debt"],
    minutes: [35, 60],
    weight: 1.5,
  },
  {
    name: "Search Engine",
    templates: ["Why does {} feel like that?", "Who decides {}?", "What actually happens to {}?", "Is {} getting worse?"],
    subjects: ["the airport", "what a minute is", "your old phone", "the internet", "every subscription", "a returned package", "tipping", "the weather forecast", "hotel pricing"],
    minutes: [35, 55],
    weight: 1.5,
  },
  {
    name: "Syntax - Tasty Web Development Treats",
    templates: ["{} in 2025", "Hasty Treat: {}", "{} Deep Dive", "Everything You Need to Know About {}"],
    subjects: ["CSS Container Queries", "SQLite", "Local-First Apps", "Bun", "Signals", "Testing", "Web Components", "Self-Hosting", "View Transitions", "TypeScript Generics", "Edge Functions", "Vite Plugins", "Accessibility Audits"],
    minutes: [40, 70],
    weight: 3,
  },
];

const BOOKS: readonly { title: string; chapters: number }[] = [
  { title: "Project Hail Mary", chapters: 30 },
  { title: "The Overstory", chapters: 24 },
  { title: "Tomorrow, and Tomorrow, and Tomorrow", chapters: 28 },
];

interface StreamingEntry {
  ts: string;
  platform: string;
  ms_played: number;
  conn_country: string;
  ip_addr: string;
  master_metadata_track_name: string | null;
  master_metadata_album_artist_name: string | null;
  master_metadata_album_album_name: string | null;
  spotify_track_uri: string | null;
  episode_name: string | null;
  episode_show_name: string | null;
  spotify_episode_uri: string | null;
  audiobook_title: string | null;
  audiobook_uri: string | null;
  audiobook_chapter_uri: string | null;
  audiobook_chapter_title: string | null;
  reason_start: string;
  reason_end: string;
  shuffle: boolean;
  skipped: boolean;
  offline: boolean;
  offline_timestamp: number | null;
  incognito_mode: boolean;
}

type Platform = "ios" | "osx" | "web_player" | "Sonos One";

const IP_BY_PLATFORM: Record<Platform, string> = {
  ios: "198.51.100.23",
  osx: "203.0.113.41",
  web_player: "203.0.113.41",
  "Sonos One": "192.0.2.15",
};

function blank(ts: string, platform: Platform, ms: number): StreamingEntry {
  return {
    ts,
    platform,
    ms_played: ms,
    conn_country: "US",
    ip_addr: IP_BY_PLATFORM[platform],
    master_metadata_track_name: null,
    master_metadata_album_artist_name: null,
    master_metadata_album_album_name: null,
    spotify_track_uri: null,
    episode_name: null,
    episode_show_name: null,
    spotify_episode_uri: null,
    audiobook_title: null,
    audiobook_uri: null,
    audiobook_chapter_uri: null,
    audiobook_chapter_title: null,
    reason_start: "clickrow",
    reason_end: "trackdone",
    shuffle: false,
    skipped: false,
    offline: false,
    offline_timestamp: null,
    incognito_mode: false,
  };
}

/** Spotify's export timestamps have second precision. */
function exportTs(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

class Listener {
  readonly entries: StreamingEntry[] = [];
  private readonly showEpisode = new Map<string, number>();
  private book = 0;
  private chapter = 0;

  constructor(private readonly rng: Rng) {}

  /** Tracks Alex might play on a day, weighted by taste and novelty. */
  pool(date: string): [CatalogueTrack, number][] {
    const day = Date.parse(date);
    return CATALOGUE.flatMap((t): [CatalogueTrack, number][] => {
      const affinity = AFFINITY[t.artist];
      if (affinity === undefined || t.released > date) return [];
      const ageDays = (day - Date.parse(t.released)) / 86_400_000;
      // New releases get heavy rotation for a few months.
      const novelty = ageDays < 120 ? 3 : ageDays < 365 ? 1.5 : 1;
      return [[t, affinity * novelty]];
    });
  }

  music(date: string, startMs: number, count: number, platform: Platform): number {
    const rng = this.rng;
    const pool = this.pool(date);
    const mode = rng.weighted<"album" | "artist" | "shuffle">([["album", 3], ["artist", 2.5], ["shuffle", 4.5]]);
    let queue: CatalogueTrack[];
    if (mode === "album") {
      const seed = rng.weighted(pool);
      queue = CATALOGUE.filter((t) => t.albumUri === seed.albumUri);
    } else if (mode === "artist") {
      const seed = rng.weighted(pool);
      queue = rng.shuffle(pool.filter(([t]) => t.artist === seed.artist).map(([t]) => t));
    } else {
      queue = Array.from({ length: count }, () => rng.weighted(pool));
    }
    while (queue.length < count) queue = queue.concat(Array.from({ length: count - queue.length }, () => rng.weighted(pool)));

    const offline = platform === "ios" && rng.chance(0.08);
    let t = startMs;
    let reasonStart = rng.pick(["clickrow", "playbtn", "appload", "clickrow"]);
    for (const track of queue.slice(0, count)) {
      const skip = rng.chance(0.12);
      const blip = !skip && rng.chance(0.02);
      const ms = blip ? rng.int(600, 2900) : skip ? rng.int(4000, 70_000) : track.durationMs - rng.int(0, 1500);
      t += ms + rng.int(200, 2500);
      const entry = blank(exportTs(t), platform, ms);
      entry.master_metadata_track_name = track.track;
      entry.master_metadata_album_artist_name = track.artist;
      entry.master_metadata_album_album_name = track.album;
      entry.spotify_track_uri = track.uri;
      entry.reason_start = reasonStart;
      entry.reason_end = skip || blip ? "fwdbtn" : "trackdone";
      entry.shuffle = mode === "shuffle";
      entry.skipped = skip || blip;
      entry.offline = offline;
      entry.offline_timestamp = offline ? Math.floor((t - ms) / 1000) : null;
      this.entries.push(entry);
      reasonStart = entry.reason_end;
    }
    // A session sometimes ends mid-track.
    if (rng.chance(0.3)) {
      const track = rng.weighted(pool);
      const ms = rng.int(20_000, Math.max(25_000, track.durationMs - 20_000));
      t += ms;
      const entry = blank(exportTs(t), platform, ms);
      entry.master_metadata_track_name = track.track;
      entry.master_metadata_album_artist_name = track.artist;
      entry.master_metadata_album_album_name = track.album;
      entry.spotify_track_uri = track.uri;
      entry.reason_start = reasonStart;
      entry.reason_end = rng.pick(["endplay", "logout", "remote"]);
      entry.shuffle = mode === "shuffle";
      this.entries.push(entry);
    }
    return t;
  }

  podcast(startMs: number, platform: Platform): number {
    const rng = this.rng;
    const show = rng.weighted(SHOWS.map((s): [Show, number] => [s, s.weight]));
    const index = this.showEpisode.get(show.name) ?? 0;
    this.showEpisode.set(show.name, index + 1);
    const subject = show.subjects[index % show.subjects.length] as string;
    const template = show.templates[(index * 3 + Math.floor(index / show.subjects.length)) % show.templates.length] as string;
    const title = template.replace("{}", subject);
    const full = rng.int(show.minutes[0] * 60, show.minutes[1] * 60) * 1000;
    const ms = rng.chance(0.6) ? full : rng.int(8 * 60, Math.round(full / 1000) - 120) * 1000;
    const entry = blank(exportTs(startMs + ms), platform, ms);
    entry.episode_name = title;
    entry.episode_show_name = show.name;
    entry.spotify_episode_uri = `spotify:episode:${spotifyId(`${show.name}#${index}`)}`;
    entry.reason_start = "clickrow";
    entry.reason_end = ms === full ? "trackdone" : rng.pick(["endplay", "logout"]);
    this.entries.push(entry);
    return startMs + ms;
  }

  audiobook(startMs: number): void {
    const book = BOOKS[this.book];
    if (!book) return;
    const rng = this.rng;
    this.chapter++;
    const ms = rng.int(18 * 60, 38 * 60) * 1000;
    const entry = blank(exportTs(startMs + ms), "ios", ms);
    entry.audiobook_title = book.title;
    entry.audiobook_uri = `spotify:show:${spotifyId(`audiobook:${book.title}`)}`;
    entry.audiobook_chapter_uri = `spotify:episode:${spotifyId(`audiobook:${book.title}#${this.chapter}`)}`;
    entry.audiobook_chapter_title = `Chapter ${this.chapter}`;
    entry.reason_start = this.chapter === 1 ? "clickrow" : "playbtn";
    entry.reason_end = rng.pick(["endplay", "trackdone", "logout"]);
    this.entries.push(entry);
    if (this.chapter >= book.chapters) {
      this.book++;
      this.chapter = 0;
    }
  }
}

function playDay(ctx: SeedContext, rng: Rng, listener: Listener, day: SeedDay): void {
  if (rng.chance(0.02)) return; // A quiet day.
  const at = (hour: number, minute: number) => ctx.localDate(day.date, hour, minute).getTime();
  if (!day.isWeekend) {
    const commute = at(7, 30 + rng.int(0, 25));
    if (rng.chance(0.55)) listener.podcast(commute, "ios");
    else listener.music(day.date, commute, rng.int(5, 8), "ios");
    listener.music(day.date, at(9, 40 + rng.int(0, 40)), Math.max(2, rng.poisson(6)), rng.chance(0.85) ? "osx" : "web_player");
    listener.music(day.date, at(13, 30 + rng.int(0, 60)), Math.max(2, rng.poisson(5)), "osx");
    const evening = at(18, 30 + rng.int(0, 90));
    if (rng.chance(0.2)) listener.podcast(evening, "Sonos One");
    else if (rng.chance(0.6)) listener.music(day.date, evening, Math.max(2, rng.poisson(3)), rng.chance(0.5) ? "Sonos One" : "ios");
    if (rng.chance(0.25)) listener.audiobook(at(22, 10 + rng.int(0, 40)));
    return;
  }
  if (day.weekday === 6 && rng.chance(0.4)) {
    // Drive to and from a trailhead.
    listener.music(day.date, at(7, 45 + rng.int(0, 30)), rng.int(10, 14), "ios");
    listener.music(day.date, at(15, 20 + rng.int(0, 60)), rng.int(9, 13), "ios");
  } else {
    listener.music(day.date, at(9, 50 + rng.int(0, 100)), Math.max(3, rng.poisson(6)), "Sonos One");
    listener.music(day.date, at(14, 30 + rng.int(0, 90)), Math.max(2, rng.poisson(5)), rng.chance(0.5) ? "ios" : "osx");
  }
  if (rng.chance(0.3)) listener.podcast(at(17, rng.int(0, 50)), "ios");
  listener.music(day.date, at(19, 30 + rng.int(0, 60)), Math.max(2, rng.poisson(3)), "Sonos One");
  if (rng.chance(0.2)) listener.audiobook(at(22, 30 + rng.int(0, 40)));
}

export const spotifySeed: SeedSource = {
  name: "spotify",
  produces: { spotify: ["listen:track", "listen:podcast", "listen:audiobook"] },
  async seed(ctx) {
    const rng = ctx.rng("spotify");
    const listener = new Listener(rng);
    for (const day of ctx.days) playDay(ctx, rng, listener, day);

    // The export splits history into numbered files of roughly a year each.
    const byYear = new Map<string, StreamingEntry[]>();
    for (const entry of listener.entries) {
      const year = entry.ts.slice(0, 4);
      const list = byYear.get(year);
      if (list) list.push(entry);
      else byYear.set(year, [entry]);
    }
    let index = 0;
    for (const [year, entries] of byYear) {
      ctx.writeStaged(
        "spotify",
        `Spotify Extended Streaming History/Streaming_History_Audio_${year}_${index++}.json`,
        JSON.stringify(entries),
      );
    }
    await importSpotifyData(ctx.db, ctx.stage("spotify"), ACCOUNT);
  },
};
