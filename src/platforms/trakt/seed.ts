import { insertTraktEvent, type TraktHistoryItem } from "./parser-api";
import type { SeedContext, SeedDay, SeedSource } from "../../seed/context";
import type { Rng } from "../../seed/rng";

/** Trakt username (the sync's source_account). */
const ACCOUNT = "alexrivera";

interface Film {
  title: string;
  year: number;
  imdb?: string;
  /** Earliest date Alex could watch it (cinema release). */
  from?: string;
  /** Watched at the cinema (a Trakt check-in) rather than at home. */
  cinema?: boolean;
}

const FILMS: readonly Film[] = [
  { title: "Spirited Away", year: 2001, imdb: "tt0245429" },
  { title: "Princess Mononoke", year: 1997, imdb: "tt0119698" },
  { title: "My Neighbor Totoro", year: 1988, imdb: "tt0096283" },
  { title: "Howl's Moving Castle", year: 2004, imdb: "tt0347149" },
  { title: "The Boy and the Heron", year: 2023, imdb: "tt6587046", from: "2023-12-08", cinema: true },
  { title: "Dune", year: 2021, imdb: "tt1160419" },
  { title: "Dune: Part Two", year: 2024, imdb: "tt15239678", from: "2024-03-01", cinema: true },
  { title: "Oppenheimer", year: 2023, imdb: "tt15398776" },
  { title: "Barbie", year: 2023, imdb: "tt1517268" },
  { title: "Past Lives", year: 2023, imdb: "tt13238346" },
  { title: "Poor Things", year: 2023, imdb: "tt14230458", from: "2023-12-08", cinema: true },
  { title: "Anatomy of a Fall", year: 2023, imdb: "tt17009710" },
  { title: "The Holdovers", year: 2023, imdb: "tt14849194", from: "2023-11-10" },
  { title: "Challengers", year: 2024, imdb: "tt16426418", from: "2024-04-26", cinema: true },
  { title: "Furiosa: A Mad Max Saga", year: 2024, imdb: "tt12037194", from: "2024-05-24", cinema: true },
  { title: "Inside Out 2", year: 2024, imdb: "tt22022452", from: "2024-06-14", cinema: true },
  { title: "The Wild Robot", year: 2024, imdb: "tt29623480", from: "2024-09-27" },
  { title: "Conclave", year: 2024, imdb: "tt20215234", from: "2024-10-25" },
  { title: "Wicked", year: 2024, imdb: "tt1262426", from: "2024-11-22", cinema: true },
  { title: "Everything Everywhere All at Once", year: 2022, imdb: "tt6710474" },
  { title: "The Grand Budapest Hotel", year: 2014, imdb: "tt2278388" },
  { title: "Arrival", year: 2016, imdb: "tt2543164" },
  { title: "Blade Runner 2049", year: 2017, imdb: "tt1856101" },
  { title: "Interstellar", year: 2014, imdb: "tt0816692" },
  { title: "Parasite", year: 2019, imdb: "tt6751668" },
  { title: "Mad Max: Fury Road", year: 2015, imdb: "tt1392190" },
  { title: "Knives Out", year: 2019, imdb: "tt8946378" },
  { title: "Top Gun: Maverick", year: 2022, imdb: "tt1745960" },
  { title: "Spider-Man: Across the Spider-Verse", year: 2023, imdb: "tt9362722" },
  { title: "The Martian", year: 2015, imdb: "tt3659388" },
  { title: "Lost in Translation", year: 2003, imdb: "tt0335266" },
  { title: "Her", year: 2013, imdb: "tt1798709" },
  { title: "Ex Machina", year: 2014, imdb: "tt0470752" },
  { title: "Whiplash", year: 2014, imdb: "tt2582802" },
  { title: "La La Land", year: 2016, imdb: "tt3783958" },
  { title: "Get Out", year: 2017, imdb: "tt5052448" },
  { title: "Nope", year: 2022, imdb: "tt10954984" },
  { title: "The Social Network", year: 2010, imdb: "tt1285016" },
  { title: "Inception", year: 2010, imdb: "tt1375666" },
  { title: "The Matrix", year: 1999, imdb: "tt0133093" },
  { title: "Paddington 2", year: 2017, imdb: "tt4468740" },
  { title: "Hot Fuzz", year: 2007, imdb: "tt0425112" },
  { title: "Amélie", year: 2001, imdb: "tt0211915" },
  { title: "The Lord of the Rings: The Fellowship of the Ring", year: 2001, imdb: "tt0120737" },
  { title: "The Lord of the Rings: The Two Towers", year: 2002, imdb: "tt0167261" },
  { title: "The Lord of the Rings: The Return of the King", year: 2003, imdb: "tt0167260" },
  { title: "Back to the Future", year: 1985, imdb: "tt0088763" },
  { title: "Jurassic Park", year: 1993, imdb: "tt0107290" },
  { title: "Alien", year: 1979, imdb: "tt0078748" },
  { title: "Before Sunrise", year: 1995, imdb: "tt0112471" },
  { title: "Moonlight", year: 2016, imdb: "tt4975722" },
  { title: "Little Women", year: 2019, imdb: "tt3281548" },
  { title: "Free Solo", year: 2018, imdb: "tt7775622" },
  { title: "The Secret Life of Walter Mitty", year: 2013, imdb: "tt0359950" },
  { title: "Wild", year: 2014, imdb: "tt2305051" },
  { title: "Into the Wild", year: 2007, imdb: "tt0758758" },
  { title: "Sleepless in Seattle", year: 1993, imdb: "tt0108160" },
  { title: "10 Things I Hate About You", year: 1999, imdb: "tt0147800" },
];

interface Season {
  show: string;
  year: number;
  imdb?: string;
  season: number;
  episodes: readonly string[];
  /** Earliest date Alex starts it. */
  from: string;
  /** Watched as it aired, one episode a week. */
  weekly?: boolean;
  /** Rewatched later as comfort TV. */
  rewatch?: boolean;
}

const SEASONS: readonly Season[] = [
  {
    show: "Severance", year: 2022, imdb: "tt11280740", season: 1, from: "2024-01-06", rewatch: true, episodes: [
      "Good News About Hell", "Half Loop", "In Perpetuity", "The You You Are", "The Grim Barbarity of Optics and Design",
      "Hide and Seek", "Defiant Jazz", "What's for Dinner?", "The We We Are",
    ],
  },
  {
    show: "Severance", year: 2022, imdb: "tt11280740", season: 2, from: "2025-01-17", weekly: true, episodes: [
      "Hello, Ms. Cobel", "Goodbye, Mrs. Selvig", "Who Is Alive?", "Woe's Hollow", "Trojan's Horse", "Attila",
      "Chikhai Bardo", "Sweet Vitriol", "The After Hours", "Cold Harbor",
    ],
  },
  {
    show: "The Bear", year: 2022, imdb: "tt14452776", season: 1, from: "2023-11-04", episodes: [
      "System", "Hands", "Brigade", "Dogs", "Sheridan", "Ceres", "Review", "Braciole",
    ],
  },
  {
    show: "The Bear", year: 2022, imdb: "tt14452776", season: 2, from: "2023-12-02", episodes: [
      "Beef", "Pasta", "Sundae", "Honeydew", "Pop", "Fishes", "Forks", "Bolognese", "Omelette", "The Bear",
    ],
  },
  {
    show: "Shōgun", year: 2024, imdb: "tt2788316", season: 1, from: "2024-02-27", weekly: true, episodes: [
      "Anjin", "Servants of Two Masters", "Tomorrow Is Tomorrow", "The Eightfold Fence", "Broken to the Fist",
      "Ladies of the Willow World", "A Stick of Time", "The Abyss of Life", "Crimson Sky", "A Dream of a Dream",
    ],
  },
  {
    show: "Fallout", year: 2024, imdb: "tt12637874", season: 1, from: "2024-04-11", episodes: [
      "The End", "The Target", "The Head", "The Ghouls", "The Past", "The Trap", "The Radio", "The Beginning",
    ],
  },
  {
    show: "The Last of Us", year: 2023, imdb: "tt3581920", season: 1, from: "2024-08-03", episodes: [
      "When You're Lost in the Darkness", "Infected", "Long, Long Time", "Please Hold to My Hand", "Endure and Survive",
      "Kin", "Left Behind", "When We Are in Need", "Look for the Light",
    ],
  },
  {
    show: "Andor", year: 2022, imdb: "tt9253284", season: 1, from: "2025-03-29", episodes: [
      "Kassa", "That Would Be Me", "Reckoning", "Aldhani", "The Axe Forgets", "The Eye", "Announcement", "Narkina 5",
      "Nobody's Listening!", "One Way Out", "Daughter of Ferrix", "Rix Road",
    ],
  },
  {
    show: "Arcane", year: 2021, imdb: "tt11126994", season: 1, from: "2024-10-12", episodes: [
      "Welcome to the Playground", "Some Mysteries Are Better Left Unsolved", "The Base Violence Necessary for Change",
      "Happy Progress Day!", "Everybody Wants to Be My Enemy", "When These Walls Come Tumbling Down", "The Boy Savior",
      "Oil and Water", "The Monster You Created",
    ],
  },
  {
    show: "Slow Horses", year: 2022, imdb: "tt5875444", season: 1, from: "2025-06-07", episodes: [
      "Failure's Contagious", "Work Drinks", "Bad Tradecraft", "Visiting Hours", "Mars", "Follies",
    ],
  },
  {
    show: "Succession", year: 2018, imdb: "tt7660850", season: 4, from: "2025-08-09", episodes: [
      "The Munsters", "Rehearsal", "Connor's Wedding", "Honeymoon States", "Kill List", "Living+", "Tailgate Party",
      "America Decides", "Church and State", "With Open Eyes",
    ],
  },
  {
    show: "The White Lotus", year: 2021, imdb: "tt13406094", season: 1, from: "2025-10-04", episodes: [
      "Arrivals", "New Day", "Mysterious Monkeys", "Recentering", "The Lotus-Eaters", "Departures",
    ],
  },
  {
    show: "Ted Lasso", year: 2020, imdb: "tt10986410", season: 1, from: "2026-01-03", episodes: [
      "Pilot", "Biscuits", "Trent Crimm: The Independent", "For the Children", "Tan Lines", "Two Aces",
      "Make Rebecca Great Again", "The Diamond Dogs", "All Apologies", "The Hope That Kills You",
    ],
  },
  {
    show: "Stranger Things", year: 2016, imdb: "tt4574334", season: 4, from: "2026-03-07", episodes: [
      "Chapter One: The Hellfire Club", "Chapter Two: Vecna's Curse", "Chapter Three: The Monster and the Superhero",
      "Chapter Four: Dear Billy", "Chapter Five: The Nina Project", "Chapter Six: The Dive",
      "Chapter Seven: The Massacre at Hawkins Lab", "Chapter Eight: Papa", "Chapter Nine: The Piggyback",
    ],
  },
  {
    show: "Breaking Bad", year: 2008, imdb: "tt0903747", season: 1, from: "2026-05-02", episodes: [
      "Pilot", "Cat's in the Bag...", "...And the Bag's in the River", "Cancer Man", "Gray Matter",
      "Crazy Handful of Nothin'", "A No-Rough-Stuff-Type Deal",
    ],
  },
  {
    show: "Avatar: The Last Airbender", year: 2005, imdb: "tt0417299", season: 1, from: "2024-11-30", rewatch: true, episodes: [
      "The Boy in the Iceberg", "The Avatar Returns", "The Southern Air Temple", "The Warriors of Kyoshi",
      "The King of Omashu", "Imprisoned", "The Spirit World (Winter Solstice, Part 1)",
      "Avatar Roku (Winter Solstice, Part 2)", "The Waterbending Scroll", "Jet", "The Great Divide", "The Storm",
      "The Blue Spirit", "The Fortuneteller", "Bato of the Water Tribe", "The Deserter", "The Northern Air Temple",
      "The Waterbending Master", "The Siege of the North, Part 1", "The Siege of the North, Part 2",
    ],
  },
  {
    show: "The Office", year: 2005, imdb: "tt0386676", season: 2, from: "2023-10-28", rewatch: true, episodes: [
      "The Dundies", "Sexual Harassment", "Office Olympics", "The Fire", "Halloween", "The Fight", "The Client",
      "Performance Review", "E-Mail Surveillance", "Christmas Party", "Booze Cruise", "The Injury", "The Secret",
      "The Carpet", "Boys and Girls", "Valentine's Day", "Dwight's Speech", "Take Your Daughter to Work Day",
      "Michael's Birthday", "Drug Testing", "Conflict Resolution", "Casino Night",
    ],
  },
  {
    show: "The Office", year: 2005, imdb: "tt0386676", season: 3, from: "2024-06-01", rewatch: true, episodes: [
      "Gay Witch Hunt", "The Convention", "The Coup", "Grief Counseling", "Initiation", "Diwali", "Branch Closing",
      "The Merger", "The Convict", "A Benihana Christmas", "Back from Vacation", "Traveling Salesmen", "The Return",
      "Ben Franklin", "Phyllis' Wedding", "Business School", "Cocktails", "The Negotiation", "Safety Training",
      "Product Recall", "Women's Appreciation", "Beach Games", "The Job",
    ],
  },
  {
    show: "The Great British Bake Off", year: 2010, imdb: "tt1877368", season: 14, from: "2023-10-24", weekly: true, episodes: [
      "Cake Week", "Biscuit Week", "Bread Week", "Back to School Week", "Pastry Week", "Botanical Week",
      "Chocolate Week", "Patisserie Week", "Semi-Final", "The Final",
    ],
  },
  {
    show: "The Great British Bake Off", year: 2010, imdb: "tt1877368", season: 15, from: "2024-09-27", weekly: true, episodes: [
      "Cake Week", "Biscuit Week", "Bread Week", "Caramel Week", "Autumn Week", "Pastry Week", "Dessert Week",
      "Patisserie Week", "Semi-Final", "The Final",
    ],
  },
  {
    show: "The Great British Bake Off", year: 2010, imdb: "tt1877368", season: 16, from: "2025-09-26", weekly: true, episodes: [
      "Cake Week", "Biscuit Week", "Bread Week", "Chocolate Week", "Pastry Week", "Spice Week", "Dessert Week",
      "Patisserie Week", "Semi-Final", "The Final",
    ],
  },
  {
    show: "Only Murders in the Building", year: 2021, imdb: "tt11691774", season: 1, from: "2025-11-15", episodes: [
      "True Crime", "Who Is Tim Kono?", "How Well Do You Know Your Neighbors?", "The Sting", "Twist",
      "To Protect and Serve", "The Boy from 6B", "Fan Fiction", "Double Time", "Open and Shut",
    ],
  },
];

/** Fake but stable numeric ids, as the Trakt API returns. */
function idFor(rng: Rng, seen: Map<string, number>, key: string): number {
  const existing = seen.get(key);
  if (existing !== undefined) return existing;
  const id = rng.int(100_000, 9_999_999);
  seen.set(key, id);
  return id;
}

function slug(title: string, year?: number): string {
  const base = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return year === undefined ? base : `${base}-${year}`;
}

function dayAfter(ctx: SeedContext, date: string, rng: Rng, minGap: number, maxGap: number): SeedDay | undefined {
  const start = ctx.days.findIndex((d) => d.date >= date);
  if (start < 0) return undefined;
  return ctx.days[start + rng.int(minGap, maxGap)];
}

export const traktSeed: SeedSource = {
  name: "trakt",
  produces: { trakt: ["trakt:movie", "trakt:episode"] },
  async seed(ctx) {
    const rng = ctx.rng("trakt");
    const ids = new Map<string, number>();
    const items: TraktHistoryItem[] = [];
    let historyId = 4_100_000_000;
    // Evening slots already taken, so two shows never overlap.
    const busy = new Set<string>();

    const evening = (day: SeedDay, runtimeMin: number): string => {
      let hour = day.isWeekend ? rng.int(15, 21) : rng.int(19, 21);
      while (busy.has(`${day.date}T${hour}`)) hour++;
      busy.add(`${day.date}T${hour}`);
      const end = ctx.localDate(day.date, hour, rng.int(0, 50) + runtimeMin, rng.int(0, 59));
      return end.toISOString();
    };

    const watchEpisodes = (season: Season, startDate: string, pass: number) => {
      const showKey = `show:${season.show}`;
      const show = {
        title: season.show,
        year: season.year,
        ids: {
          trakt: idFor(rng, ids, showKey),
          slug: slug(season.show),
          ...(season.imdb ? { imdb: season.imdb } : {}),
          tmdb: idFor(rng, ids, `tmdb:${showKey}`),
        },
      };
      let day = dayAfter(ctx, startDate, rng, 0, 2);
      let ep = 0;
      while (day && ep < season.episodes.length) {
        const tonight = season.weekly ? 1 : day.isWeekend ? rng.int(2, 4) : rng.int(1, 2);
        let previousEnd = 0;
        for (let n = 0; n < tonight && ep < season.episodes.length; n++, ep++) {
          const title = season.episodes[ep] as string;
          const runtime = season.show === "The Office" ? 22 : season.show.startsWith("Avatar") ? 23 : rng.int(42, 62);
          // The first episode claims an evening slot; the rest follow back to back.
          const base = n === 0 ? Date.parse(evening(day, runtime)) : previousEnd + (runtime + rng.int(1, 6)) * 60_000;
          previousEnd = base;
          items.push({
            id: historyId++,
            watched_at: new Date(base).toISOString(),
            action: rng.chance(0.85) ? "scrobble" : "watch",
            type: "episode",
            show,
            episode: {
              season: season.season,
              number: ep + 1,
              title,
              ids: {
                trakt: idFor(rng, ids, `ep:${season.show}:${season.season}:${ep}`),
                tmdb: idFor(rng, ids, `tmdb-ep:${season.show}:${season.season}:${ep}`),
              },
            },
          });
        }
        day = season.weekly ? dayAfter(ctx, day.date, rng, 7, 7) : dayAfter(ctx, day.date, rng, 1, pass > 0 ? 6 : 3);
      }
    };

    for (const season of SEASONS) {
      watchEpisodes(season, season.from, 0);
      if (season.rewatch) {
        // Comfort rewatches roughly a year apart.
        const passes = season.show === "The Office" ? 3 : season.show === "Severance" ? 1 : 2;
        for (let pass = 1; pass <= passes; pass++) {
          const start = ctx.days.find((d) => d.date >= season.from);
          const later = start ? ctx.days[start.index + pass * rng.int(300, 380)] : undefined;
          if (later) watchEpisodes(season, later.date, pass);
        }
      }
    }

    const filmItem = (film: Film, day: SeedDay, action: TraktHistoryItem["action"]): TraktHistoryItem => {
      const key = `movie:${film.title}`;
      return {
        id: historyId++,
        watched_at: evening(day, rng.int(95, 165)),
        action,
        type: "movie",
        movie: {
          title: film.title,
          year: film.year,
          ids: {
            trakt: idFor(rng, ids, key),
            slug: slug(film.title, film.year),
            ...(film.imdb ? { imdb: film.imdb } : {}),
            tmdb: idFor(rng, ids, `tmdb:${key}`),
          },
        },
      };
    };

    // Films: about two a week, more at weekends; a few favourites twice.
    const queue = rng.shuffle(FILMS.filter((f) => !f.from));
    const dated = FILMS.filter((f) => f.from);
    for (const film of dated) {
      const day = dayAfter(ctx, film.from ?? "", rng, 0, film.cinema ? 9 : 40);
      if (day) items.push(filmItem(film, day, film.cinema ? "checkin" : "scrobble"));
    }
    for (const day of ctx.days) {
      if (!rng.chance(day.isWeekend ? 0.32 : 0.09)) continue;
      const film = queue.length > 0 ? (queue.shift() as Film) : rng.pick(FILMS.filter((f) => !f.cinema));
      items.push(filmItem(film, day, rng.chance(0.9) ? "scrobble" : "watch"));
    }

    // The API pages newest first; insert in that order like a sync does.
    items.sort((a, b) => b.watched_at.localeCompare(a.watched_at));
    const importBatch = `trakt-sync-${ctx.anchorDate}`;
    ctx.db.transaction(() => {
      for (const item of items) {
        if (!insertTraktEvent(ctx.db, item, ACCOUNT, importBatch)) {
          throw new Error(`Trakt seed item ${item.id} was not inserted`);
        }
      }
    })();
  },
};
