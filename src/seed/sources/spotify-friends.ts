import { upsertIdentity } from "../../db/identities";
import type { SeedSource } from "../context";
import { type PersonKey, personByKey } from "../persona";
import { albumArt, type CatalogueTrack, spotifyId, tracksBy } from "./life-data";

/**
 * Friend activity comes from Spotify's unofficial buddylist endpoint, polled by
 * the scheduler. The parser exports no insert helper (its sync needs a live
 * sp_dc cookie), so this builds the same buddylist payloads and writes them with
 * the parser's exact INSERT and identity upsert.
 */

interface FriendTaste {
  key: PersonKey;
  artists: readonly string[];
  playlists: readonly string[];
  /** Listening sessions per day. */
  sessions: number;
}

const FRIENDS: readonly FriendTaste[] = [
  {
    key: "rowan",
    artists: ["Fleet Foxes", "Bon Iver", "Big Thief", "Sufjan Stevens", "Noah Kahan", "Hozier", "Phoebe Bridgers"],
    playlists: ["Trail Mix", "Cabin Mornings"],
    sessions: 1.6,
  },
  {
    key: "priya",
    artists: ["Chappell Roan", "Charli xcx", "Dua Lipa", "Sabrina Carpenter", "Lorde", "HAIM"],
    playlists: ["Pop Rising", "getting ready"],
    sessions: 1.8,
  },
  {
    key: "sam",
    artists: ["Kendrick Lamar", "Tyler, The Creator", "Frank Ocean", "SZA"],
    playlists: ["RapCaviar", "Sunday Cuts"],
    sessions: 1.5,
  },
  {
    key: "mei",
    artists: ["Taylor Swift", "Olivia Rodrigo", "boygenius", "Phoebe Bridgers", "Clairo", "Mitski"],
    playlists: ["long run 10k", "sad girl autumn"],
    sessions: 1.4,
  },
  {
    key: "theo",
    artists: ["Foo Fighters", "Queens of the Stone Age", "Arctic Monkeys", "The Strokes", "Nirvana", "Pearl Jam"],
    playlists: ["Server Restart Bangers"],
    sessions: 1.0,
  },
  {
    key: "omar",
    artists: ["Fred again..", "Bicep", "Jamie xx", "Caribou", "Daft Punk", "LCD Soundsystem"],
    playlists: ["Deep Focus", "Night Rider"],
    sessions: 1.2,
  },
];

/** The scheduler polls the buddylist every 15 minutes. */
const POLL_MS = 15 * 60_000;
const HISTORY_DAYS = 150;

interface FriendActivity {
  timestamp: number;
  user: { uri: string; name: string };
  track: {
    uri: string;
    name: string;
    imageUrl: string;
    album: { uri: string; name: string };
    artist: { uri: string; name: string };
    context?: { uri: string; name: string; index: number };
  };
}

// Mirrors buildContent/buildTags in src/parsers/spotify-friends.ts.
function buildContent(track: FriendActivity["track"]): string {
  return [track.name, `by ${track.artist.name}`, `from ${track.album.name}`].join(" ");
}

function buildTags(track: FriendActivity["track"]): string[] {
  const tags = new Set<string>([`album:${track.album.name}`, `artist:${track.artist.name}`]);
  const context = track.context;
  if (context) {
    if (context.uri.startsWith("spotify:playlist:")) tags.add(`playlist:${context.name}`);
    else if (context.uri.startsWith("spotify:album:")) tags.add(`album:${context.name}`);
    else if (context.uri.startsWith("spotify:artist:")) tags.add(`artist:${context.name}`);
    else tags.add(`context:${context.name}`);
  }
  return [...tags];
}

export const spotifyFriendsSeed: SeedSource = {
  name: "spotify-friends",
  produces: { "spotify-friends": ["listen:track:friend"] },
  async seed(ctx) {
    const rng = ctx.rng("spotify-friends");
    const activities: FriendActivity[] = [];

    for (const friend of FRIENDS) {
      const person = personByKey(friend.key);
      const user = { uri: `spotify:user:${person.handle}`, name: person.name };
      const pool = tracksBy(friend.artists);
      for (const day of ctx.recentDays(HISTORY_DAYS)) {
        const sessions = rng.poisson(friend.sessions * (day.isWeekend ? 1.3 : 1));
        for (let s = 0; s < sessions; s++) {
          const startHour = day.isWeekend ? rng.int(9, 22) : rng.weighted([[8, 2], [12, 1], [17, 2], [20, 3], [22, 1]] as const);
          let at = ctx.localDate(day.date, startHour, rng.int(0, 59), rng.int(0, 59)).getTime();
          const polls = Math.max(1, rng.poisson(2.2));
          const playlist = rng.chance(0.45) ? rng.pick(friend.playlists) : null;
          const albumSeed: CatalogueTrack = rng.pick(pool);
          const albumTracks = pool.filter((t) => t.albumUri === albumSeed.albumUri);
          for (let p = 0; p < polls; p++) {
            const track = playlist || albumTracks.length < 2 ? rng.pick(pool) : (albumTracks[p % albumTracks.length] ?? albumSeed);
            if (track.released > day.date) continue;
            const context = playlist
              ? { uri: `spotify:playlist:${spotifyId(`playlist:${friend.key}:${playlist}`)}`, name: playlist, index: rng.int(0, 60) }
              : rng.chance(0.7)
                ? { uri: track.albumUri, name: track.album, index: p }
                : { uri: track.artistUri, name: track.artist, index: 0 };
            activities.push({
              timestamp: at,
              user,
              track: {
                uri: track.uri,
                name: track.track,
                imageUrl: albumArt(`${track.artist}/${track.album}`),
                album: { uri: track.albumUri, name: track.album },
                artist: { uri: track.artistUri, name: track.artist },
                context,
              },
            });
            at += POLL_MS + rng.int(-90_000, 90_000);
          }
        }
      }
      ctx.identify(friend.key, `spotify:${person.handle}`);
    }

    const insert = ctx.db.prepare(`
      INSERT OR IGNORE INTO events (
        source, source_id, source_account, type, timestamp,
        title, content, people, tags, raw_data, import_batch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const importBatch = `spotify-friends-seed-${ctx.anchorDate}`;
    ctx.db.transaction(() => {
      for (const activity of activities) {
        const { user, track, timestamp } = activity;
        const friendAccount = user.uri.replace("spotify:user:", "");
        insert.run(
          "spotify-friends",
          `spotify:friend:${user.uri}:${track.uri}@${timestamp}`,
          friendAccount,
          "listen:track:friend",
          new Date(timestamp).toISOString(),
          track.name,
          buildContent(track),
          JSON.stringify([`spotify:${friendAccount}`]),
          JSON.stringify(buildTags(track)),
          JSON.stringify(activity),
          importBatch,
        );
      }
    })();

    for (const friend of FRIENDS) {
      const person = personByKey(friend.key);
      upsertIdentity(ctx.db, { platform: "spotify", platformId: person.handle, displayName: person.name });
    }
  },
};
