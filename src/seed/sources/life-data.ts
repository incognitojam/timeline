/**
 * Shared catalogue for the "life" generators (Spotify, Spotify friends): real,
 * well-known albums with approximate album-version track lengths. Ids and
 * artwork are synthetic.
 */
import { Rng } from "../rng";

export interface CatalogueTrack {
  artist: string;
  album: string;
  track: string;
  durationMs: number;
  /** YYYY-MM-DD the album came out; nobody plays it before then. */
  released: string;
  uri: string;
  albumUri: string;
  artistUri: string;
}

type AlbumSpec = readonly [artist: string, album: string, released: string, tracks: readonly (readonly [string, string])[]];

const ALBUMS: readonly AlbumSpec[] = [
  ["Fleetwood Mac", "Rumours", "1977-02-04", [
    ["Second Hand News", "2:43"], ["Dreams", "4:17"], ["Never Going Back Again", "2:14"], ["Don't Stop", "3:13"],
    ["Go Your Own Way", "3:38"], ["Songbird", "3:20"], ["The Chain", "4:30"], ["You Make Loving Fun", "3:31"],
    ["Gold Dust Woman", "4:51"],
  ]],
  ["Fleetwood Mac", "Tango in the Night", "1987-04-13", [["Everywhere", "3:48"], ["Little Lies", "3:38"], ["Seven Wonders", "3:38"]]],
  ["Tame Impala", "Currents", "2015-07-17", [
    ["Let It Happen", "7:47"], ["The Less I Know the Better", "3:36"], ["Eventually", "5:19"],
    ["'Cause I'm a Man", "4:01"], ["New Person, Same Old Mistakes", "6:03"], ["Yes I'm Changing", "4:30"],
  ]],
  ["Tame Impala", "The Slow Rush", "2020-02-14", [
    ["One More Year", "5:24"], ["Borderline", "3:57"], ["Lost in Yesterday", "4:10"], ["Breathe Deeper", "6:12"],
  ]],
  ["Tame Impala", "Lonerism", "2012-10-05", [["Feels Like We Only Go Backwards", "3:12"], ["Elephant", "3:31"]]],
  ["SZA", "SOS", "2022-12-09", [
    ["Kill Bill", "2:33"], ["Snooze", "3:21"], ["Good Days", "4:39"], ["Nobody Gets Me", "3:00"], ["Shirt", "3:01"],
    ["Low", "3:01"], ["I Hate U", "2:55"],
  ]],
  ["SZA", "Ctrl", "2017-06-09", [["Love Galore", "4:35"], ["The Weekend", "4:32"], ["Broken Clocks", "3:51"]]],
  ["Billie Eilish", "Hit Me Hard and Soft", "2024-05-17", [
    ["Birds of a Feather", "3:30"], ["Lunch", "2:59"], ["Chihiro", "5:03"], ["Wildflower", "4:21"],
    ["The Greatest", "4:53"], ["L'Amour de Ma Vie", "5:33"],
  ]],
  ["Sabrina Carpenter", "Short n' Sweet", "2024-08-23", [
    ["Espresso", "2:55"], ["Please Please Please", "3:06"], ["Taste", "2:37"], ["Bed Chem", "2:51"], ["Juno", "3:43"],
  ]],
  ["Chappell Roan", "The Rise and Fall of a Midwest Princess", "2023-09-22", [
    ["Pink Pony Club", "4:18"], ["Hot to Go!", "3:04"], ["Red Wine Supernova", "3:12"], ["Casual", "3:52"],
    ["Femininomenon", "3:39"],
  ]],
  ["Chappell Roan", "Good Luck, Babe!", "2024-04-05", [["Good Luck, Babe!", "3:38"]]],
  ["AURORA", "All My Demons Greeting Me as a Friend", "2016-03-11", [
    ["Runaway", "4:08"], ["Running with the Wolves", "3:13"], ["Conqueror", "3:26"],
  ]],
  ["Fleet Foxes", "Fleet Foxes", "2008-06-03", [["White Winter Hymnal", "2:27"], ["Ragged Wood", "5:07"]]],
  ["Fleet Foxes", "Helplessness Blues", "2011-05-03", [["Helplessness Blues", "5:04"], ["Montezuma", "3:37"]]],
  ["Death Cab for Cutie", "Transatlanticism", "2003-10-07", [
    ["Transatlanticism", "7:55"], ["The Sound of Settling", "2:12"], ["Title and Registration", "3:39"],
  ]],
  ["Death Cab for Cutie", "Plans", "2005-08-30", [["I Will Follow You into the Dark", "3:09"], ["Soul Meets Body", "3:51"]]],
  ["Bon Iver", "For Emma, Forever Ago", "2008-02-19", [["Skinny Love", "3:58"], ["Flume", "3:39"], ["Re: Stacks", "6:41"]]],
  ["Bon Iver", "Bon Iver, Bon Iver", "2011-06-17", [["Holocene", "5:36"]]],
  ["Phoebe Bridgers", "Punisher", "2020-06-18", [["Garden Song", "3:39"], ["Kyoto", "3:04"], ["I Know the End", "5:44"]]],
  ["boygenius", "the record", "2023-03-31", [["Not Strong Enough", "3:55"], ["$20", "3:39"], ["Cool About It", "2:46"]]],
  ["Khruangbin", "Con Todo El Mundo", "2018-01-26", [
    ["Maria También", "3:28"], ["Friday Morning", "3:42"], ["Evan Finds the Third Room", "4:08"],
  ]],
  ["Mac DeMarco", "Salad Days", "2014-04-01", [["Salad Days", "2:35"], ["Chamber of Reflection", "3:51"]]],
  ["Mac DeMarco", "2", "2012-10-16", [["Ode to Viceroy", "3:54"], ["Freaking Out the Neighborhood", "2:53"]]],
  ["Vampire Weekend", "Vampire Weekend", "2008-01-29", [["A-Punk", "2:17"], ["Oxford Comma", "3:16"]]],
  ["Vampire Weekend", "Father of the Bride", "2019-05-03", [["Harmony Hall", "5:07"], ["This Life", "4:28"]]],
  ["Arctic Monkeys", "AM", "2013-09-09", [
    ["Do I Wanna Know?", "4:32"], ["R U Mine?", "3:21"], ["Why'd You Only Call Me When You're High?", "2:41"],
  ]],
  ["Radiohead", "In Rainbows", "2007-10-10", [
    ["15 Step", "3:57"], ["Nude", "4:15"], ["Weird Fishes/Arpeggi", "5:18"], ["Reckoner", "4:50"],
  ]],
  ["Radiohead", "OK Computer", "1997-05-21", [["Paranoid Android", "6:23"], ["Karma Police", "4:21"], ["No Surprises", "3:48"]]],
  ["Frank Ocean", "Blonde", "2016-08-20", [["Nights", "5:07"], ["Pink + White", "3:04"], ["Ivy", "4:09"], ["Self Control", "4:09"]]],
  ["Frank Ocean", "channel ORANGE", "2012-07-10", [["Thinkin Bout You", "3:20"], ["Pyramids", "9:53"]]],
  ["Kendrick Lamar", "GNX", "2024-11-22", [["squabble up", "2:37"], ["luther", "2:57"], ["tv off", "3:40"]]],
  ["Kendrick Lamar", "DAMN.", "2017-04-14", [["DNA.", "3:05"], ["HUMBLE.", "2:57"], ["LOVE.", "3:33"]]],
  ["Japanese Breakfast", "Jubilee", "2021-06-04", [["Paprika", "3:30"], ["Be Sweet", "3:47"], ["Kokomo, IN", "3:51"]]],
  ["Mitski", "Be the Cowboy", "2018-08-17", [["Washing Machine Heart", "2:08"], ["Nobody", "3:13"]]],
  ["Mitski", "The Land Is Inhospitable and So Are We", "2023-09-15", [["My Love Mine All Mine", "2:17"]]],
  ["Beach House", "Bloom", "2012-05-15", [["Myth", "4:18"], ["Wild", "5:19"], ["Lazuli", "5:01"]]],
  ["Beach House", "Depression Cherry", "2015-08-28", [["Space Song", "5:20"]]],
  ["HAIM", "Days Are Gone", "2013-09-27", [["The Wire", "4:05"], ["Forever", "4:06"]]],
  ["Daft Punk", "Random Access Memories", "2013-05-17", [
    ["Instant Crush", "5:37"], ["Lose Yourself to Dance", "5:53"], ["Get Lucky", "6:09"],
  ]],
  ["Daft Punk", "Discovery", "2001-03-12", [["One More Time", "5:20"], ["Digital Love", "4:58"]]],
  ["LCD Soundsystem", "Sound of Silver", "2007-03-12", [
    ["North American Scum", "5:25"], ["Someone Great", "6:25"], ["All My Friends", "7:37"],
  ]],
  ["Caribou", "Suddenly", "2020-02-28", [["Home", "3:16"], ["Never Come Back", "5:59"]]],
  ["Caribou", "Our Love", "2014-10-06", [["Can't Do Without You", "3:56"]]],
  ["Clairo", "Charm", "2024-07-12", [["Juna", "3:35"], ["Sexy to Someone", "3:30"]]],
  ["Clairo", "Immunity", "2019-08-02", [["Bags", "4:20"]]],
  ["Lorde", "Melodrama", "2017-06-16", [["Green Light", "3:54"], ["Liability", "2:52"], ["Supercut", "4:37"]]],
  ["Taylor Swift", "folklore", "2020-07-24", [["cardigan", "3:59"], ["the 1", "3:30"], ["august", "4:21"]]],
  ["Taylor Swift", "1989 (Taylor's Version)", "2023-10-27", [["Style (Taylor's Version)", "3:51"]]],
  ["Hozier", "Unreal Unearth", "2023-08-18", [["Francesca", "4:33"]]],
  ["Hozier", "Hozier", "2014-09-19", [["Take Me to Church", "4:01"]]],
  ["Noah Kahan", "Stick Season", "2022-10-14", [["Northern Attitude", "4:10"], ["Stick Season", "3:02"]]],
  ["The Strokes", "Is This It", "2001-07-30", [["Someday", "3:07"], ["Last Nite", "3:13"], ["Hard to Explain", "3:47"]]],
  ["Big Thief", "Dragon New Mountain I Believe in You", "2022-02-11", [["Change", "3:59"], ["Simulation Swarm", "4:56"]]],
  ["Nirvana", "Nevermind", "1991-09-24", [["Smells Like Teen Spirit", "5:01"], ["Come as You Are", "3:38"], ["Lithium", "4:17"]]],
  ["Pearl Jam", "Ten", "1991-08-27", [["Even Flow", "4:53"], ["Alive", "5:41"], ["Black", "5:43"]]],
  ["Sufjan Stevens", "Carrie & Lowell", "2015-03-31", [["Should Have Known Better", "5:08"], ["Fourth of July", "4:38"]]],
  ["Fred again..", "Actual Life 3 (January 1 - September 9 2022)", "2022-10-28", [
    ["Delilah (pull me out of this)", "4:33"], ["Danielle (smile on my face)", "3:54"],
  ]],
  // Mostly the friends' taste rather than Alex's.
  ["Charli xcx", "BRAT", "2024-06-07", [["360", "2:13"], ["Von dutch", "2:44"], ["Apple", "2:31"]]],
  ["Dua Lipa", "Future Nostalgia", "2020-03-27", [["Don't Start Now", "3:03"], ["Levitating", "3:23"]]],
  ["Tyler, The Creator", "IGOR", "2019-05-17", [["EARFQUAKE", "3:10"]]],
  ["Tyler, The Creator", "CHROMAKOPIA", "2024-10-28", [["St. Chroma", "3:17"], ["Sticky", "4:13"]]],
  ["Foo Fighters", "The Colour and the Shape", "1997-05-20", [["Everlong", "4:10"], ["My Hero", "4:20"]]],
  ["Queens of the Stone Age", "Songs for the Deaf", "2002-08-27", [["No One Knows", "4:38"]]],
  ["Jamie xx", "In Colour", "2015-05-29", [["Gosh", "4:53"], ["Loud Places", "4:43"]]],
  ["Bicep", "Isles", "2021-01-22", [["Apricots", "5:30"], ["Atlas", "4:51"]]],
  ["Olivia Rodrigo", "GUTS", "2023-09-08", [["vampire", "3:39"], ["bad idea right?", "3:04"]]],
  ["Olivia Rodrigo", "SOUR", "2021-05-21", [["drivers license", "4:02"]]],
];

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Deterministic 22-character base62 id shaped like a Spotify id. */
export function spotifyId(key: string): string {
  const rng = new Rng(`spotify-id:${key}`);
  let out = "";
  for (let i = 0; i < 22; i++) out += BASE62[rng.int(0, 61)];
  return out;
}

function parseLength(length: string): number {
  const [m, s] = length.split(":").map(Number) as [number, number];
  return (m * 60 + s) * 1000;
}

export const CATALOGUE: readonly CatalogueTrack[] = ALBUMS.flatMap(([artist, album, released, tracks]) =>
  tracks.map(([track, length]) => ({
    artist,
    album,
    track,
    durationMs: parseLength(length),
    released,
    uri: `spotify:track:${spotifyId(`${artist}/${album}/${track}`)}`,
    albumUri: `spotify:album:${spotifyId(`${artist}/${album}`)}`,
    artistUri: `spotify:artist:${spotifyId(artist)}`,
  })),
);

export function tracksBy(artists: readonly string[]): CatalogueTrack[] {
  const wanted = new Set(artists);
  const found = CATALOGUE.filter((t) => wanted.has(t.artist));
  const missing = artists.filter((a) => !found.some((t) => t.artist === a));
  if (missing.length > 0) throw new Error(`Catalogue has no tracks for: ${missing.join(", ")}`);
  return found;
}

/**
 * Album artwork as an inline SVG gradient, so the music UI renders covers
 * without fetching anything. Stable per album.
 */
export function albumArt(albumKey: string): string {
  const rng = new Rng(`album-art:${albumKey}`);
  const hue = rng.int(0, 359);
  const second = (hue + rng.int(30, 150)) % 360;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="hsl(${hue},60%,55%)"/><stop offset="1" stop-color="hsl(${second},55%,25%)"/>` +
    `</linearGradient></defs><rect width="300" height="300" fill="url(#g)"/>` +
    `<circle cx="${rng.int(80, 220)}" cy="${rng.int(80, 220)}" r="${rng.int(30, 80)}" fill="hsla(${(hue + 180) % 360},70%,85%,0.6)"/>` +
    `</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
