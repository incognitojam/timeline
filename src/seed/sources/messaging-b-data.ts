/**
 * Shared data for the "messaging-b" generators: a chat phrasebook for Skype,
 * SMS Backup & Restore, and Google Messages (scripted exchanges and small
 * talk between Alex and the persona, with placeholders filled from catalogues
 * of real public places, films, music, and games), plus an import helper.
 */
import type { SeedContext, SeedDay } from "../context";
import type { PersonKey } from "../persona";
import { PLACES, VENUES } from "../persona";
import type { Rng } from "../rng";

/** Google Messages takes over texting from SMS Backup & Restore for the last ~18 months. */
export const GOOGLE_MESSAGES_DAYS = 548;

/** "me" is Alex, "them" the conversation partner, "other" a second group member. */
type Speaker = "me" | "them" | "other";
type Line = readonly [Speaker, string];

export type Topic = "friend" | "hike" | "family" | "mum" | "sister" | "brunch" | "gaming" | "uni" | "music";

interface Exchange {
  topics: readonly Topic[];
  lines: readonly Line[];
}

const TRAILS = [
  "Mount Si",
  "Rattlesnake Ledge",
  "Poo Poo Point",
  "Lake Serene",
  "Heather Lake",
  "Twin Falls",
  "Mailbox Peak",
  "Lake 22",
  "Snow Lake",
  "Granite Mountain",
  "Wallace Falls",
  "Little Si",
  "Annette Lake",
  "Franklin Falls",
] as const;

const FILMS = [
  "Dune: Part Two",
  "Past Lives",
  "Oppenheimer",
  "The Holdovers",
  "Spider-Man: Across the Spider-Verse",
  "Poor Things",
  "Anatomy of a Fall",
  "Inside Out 2",
  "The Wild Robot",
  "Conclave",
  "Perfect Days",
  "Everything Everywhere All at Once",
] as const;

const ARTISTS = [
  "Fleet Foxes",
  "Death Cab for Cutie",
  "Japanese Breakfast",
  "Big Thief",
  "Khruangbin",
  "Mitski",
  "boygenius",
  "Vampire Weekend",
  "Bon Iver",
  "Phoebe Bridgers",
  "Caroline Polachek",
  "Alvvays",
] as const;

const MUSIC_VENUES = ["the Showbox", "Neumos", "the Crocodile", "the Moore Theatre", "Climate Pledge Arena"] as const;

const BOARD_GAMES = ["Wingspan", "Catan", "Codenames", "Ticket to Ride", "Cascadia", "Azul", "Spirit Island", "Terraforming Mars"] as const;

const VIDEO_GAMES = ["Baldur's Gate 3", "Stardew Valley", "Factorio", "Helldivers 2", "Balatro", "Minecraft", "Valheim", "Deep Rock Galactic"] as const;

const DISHES = ["pho", "ramen", "tacos", "dumplings", "pad see ew", "teriyaki", "khachapuri", "banh mi", "pizza", "curry"] as const;

const TIMES = ["6:30", "7", "7:30", "8", "8:15", "6", "5:45"] as const;

const DAYS = ["Saturday", "Sunday", "Friday", "Thursday", "tomorrow", "next weekend"] as const;

const EXCHANGES: readonly Exchange[] = [
  {
    topics: ["hike", "friend"],
    lines: [
      ["them", "{trail} this {day}? forecast looks dry for once"],
      ["me", "I'm in. what time are we leaving"],
      ["them", "pick you up at {time}, trailhead lot fills up fast"],
      ["me", "perfect, I'll bring coffee"],
      ["them", "and I'll bring sandwiches obviously"],
    ],
  },
  {
    topics: ["hike", "friend"],
    lines: [
      ["me", "my legs are still destroyed from {trail} 😂"],
      ["them", "same. that last mile was brutal"],
      ["me", "worth it for the view though"],
      ["them", "sending you the photos tonight"],
    ],
  },
  {
    topics: ["hike", "friend"],
    lines: [
      ["them", "did you see the WTA trip report for {trail}? snow above 3000ft"],
      ["me", "ugh. microspikes then?"],
      ["them", "yeah or we swap to {trail2}"],
      ["me", "{trail2} works, less driving too"],
      ["them", "deal"],
    ],
  },
  {
    topics: ["hike", "friend"],
    lines: [
      ["me", "anyone have a spare headlamp I can borrow? mine died"],
      ["them", "yep I've got two, will throw it in the car"],
      ["me", "legend, thank you"],
    ],
  },
  {
    topics: ["friend"],
    lines: [
      ["them", "{venue} after work?"],
      ["me", "can't tonight, stuck on a release. tomorrow?"],
      ["them", "tomorrow works"],
      ["me", "{time}?"],
      ["them", "see you there"],
    ],
  },
  {
    topics: ["friend"],
    lines: [
      ["me", "running about 10 min late, sorry!"],
      ["them", "no rush, I grabbed a table"],
      ["me", "order me whatever you're having"],
    ],
  },
  {
    topics: ["friend", "music"],
    lines: [
      ["them", "{artist} just announced a show at {musicvenue}"],
      ["me", "no way. when do tickets go on sale"],
      ["them", "friday at 10am"],
      ["me", "I'll set an alarm. getting two?"],
      ["them", "yes please, I'll venmo you"],
    ],
  },
  {
    topics: ["friend", "music"],
    lines: [
      ["me", "have you listened to the new {artist} album yet"],
      ["them", "on repeat all week"],
      ["me", "track 3 is unreal"],
    ],
  },
  {
    topics: ["friend"],
    lines: [
      ["them", "finally watched {film}"],
      ["me", "and??"],
      ["them", "ok you were right, it's great"],
      ["me", "told you 😌"],
    ],
  },
  {
    topics: ["friend"],
    lines: [
      ["me", "want to see {film} this weekend? playing at the Cinerama"],
      ["them", "yes! saturday evening?"],
      ["me", "booking the 7:15"],
      ["them", "👍"],
    ],
  },
  {
    topics: ["friend"],
    lines: [
      ["them", "craving {dish}. you around?"],
      ["me", "always. {venue} or somewhere new?"],
      ["them", "let's try that place by {place}"],
      ["me", "see you at {time}"],
    ],
  },
  {
    topics: ["friend"],
    lines: [
      ["them", "happy friday!! any plans"],
      ["me", "absolutely nothing and I love it"],
      ["them", "same. couch and pizza"],
    ],
  },
  {
    topics: ["friend"],
    lines: [
      ["me", "are you going to the farmers market at {place} tomorrow?"],
      ["them", "probably around 10"],
      ["me", "cool, text me when you're there"],
    ],
  },
  {
    topics: ["friend"],
    lines: [
      ["them", "did you get home ok?"],
      ["me", "yep, light rail was quick. thanks for tonight!"],
      ["them", "anytime 🙂"],
    ],
  },
  {
    topics: ["friend", "gaming"],
    lines: [
      ["them", "board games at mine {day}? thinking {boardgame}"],
      ["me", "yes. I'll bring snacks"],
      ["them", "bring the expansion if you still have it"],
      ["me", "will do"],
    ],
  },
  {
    topics: ["gaming", "uni"],
    lines: [
      ["them", "server's back up, I patched it last night"],
      ["me", "nice, was it the memory leak again"],
      ["them", "yep. bumped the heap and it's been fine since"],
      ["me", "hopping on later tonight"],
    ],
  },
  {
    topics: ["gaming", "uni"],
    lines: [
      ["me", "{videogame} tonight? I'm free after 8"],
      ["them", "yes. I'll ping the others"],
      ["other", "count me in"],
      ["them", "8:30 then, voice chat as usual"],
    ],
  },
  {
    topics: ["gaming"],
    lines: [
      ["them", "how far are you in {videogame}"],
      ["me", "way too far. lost my whole sunday to it"],
      ["them", "haha same"],
    ],
  },
  {
    topics: ["uni"],
    lines: [
      ["them", "found photos from the second year house, we looked so young"],
      ["me", "send them!! actually maybe don't"],
      ["them", "too late 😂"],
      ["me", "I can't believe we lived like that"],
    ],
  },
  {
    topics: ["uni"],
    lines: [
      ["me", "any word on the reunion?"],
      ["them", "looking like a weekend in spring"],
      ["other", "I can host if people want to come to mine"],
      ["me", "that would be amazing"],
    ],
  },
  {
    topics: ["uni"],
    lines: [
      ["them", "how's the new job treating you"],
      ["me", "good! team is great, a lot to learn"],
      ["them", "seattle suits you"],
      ["me", "the rain doesn't though"],
    ],
  },
  {
    topics: ["family", "mum"],
    lines: [
      ["them", "Hi love, are you free for a call on Sunday?"],
      ["me", "Yes! afternoon works"],
      ["them", "Lovely. Around 3?"],
      ["me", "perfect, talk then ❤️"],
    ],
  },
  {
    topics: ["family", "mum"],
    lines: [
      ["them", "Did you remember your sister's birthday card?"],
      ["me", "posted it yesterday"],
      ["them", "Good. Proud of you"],
    ],
  },
  {
    topics: ["family", "mum"],
    lines: [
      ["them", "How is the weather up there? It's been so warm here"],
      ["me", "grey and drizzly as usual"],
      ["them", "Make sure you're eating properly"],
      ["me", "I am mum, made curry last night"],
      ["them", "Send me the recipe!"],
    ],
  },
  {
    topics: ["family", "mum"],
    lines: [
      ["them", "Your dad says hi. He's finally fixed the fence"],
      ["me", "haha only took three summers"],
      ["them", "Don't tell him I said that"],
    ],
  },
  {
    topics: ["family", "mum"],
    lines: [
      ["me", "landed safely ✈️"],
      ["them", "Oh good. Text me when you're home"],
      ["me", "will do"],
    ],
  },
  {
    topics: ["family", "sister"],
    lines: [
      ["them", "can I crash at yours the weekend after next? there's a race in Seattle"],
      ["me", "of course, couch is yours"],
      ["them", "you're the best"],
      ["me", "I'll come cheer at the finish"],
    ],
  },
  {
    topics: ["family", "sister"],
    lines: [
      ["them", "mum's asking about thanksgiving again"],
      ["me", "I'll drive down wednesday night"],
      ["them", "ok I'll tell her. bring your board games"],
    ],
  },
  {
    topics: ["family", "sister"],
    lines: [
      ["me", "how did the long run go?"],
      ["them", "16 miles!! knees are complaining"],
      ["me", "that's amazing, you're going to crush the half"],
    ],
  },
  {
    topics: ["family", "sister"],
    lines: [
      ["them", "help. what do I get mum for her birthday"],
      ["me", "she keeps talking about that pottery class"],
      ["them", "omg yes, let's split it"],
      ["me", "deal, send me the link"],
    ],
  },
  {
    topics: ["family", "sister"],
    lines: [
      ["them", "portland is SO sunny today"],
      ["me", "rude"],
      ["them", "😎"],
    ],
  },
  {
    topics: ["brunch"],
    lines: [
      ["them", "brunch {day}? {venue} or {venue2}"],
      ["other", "{venue2} has the good hash browns"],
      ["me", "{venue2} it is. 11?"],
      ["them", "11 works"],
      ["other", "I'll put our name down"],
    ],
  },
  {
    topics: ["brunch"],
    lines: [
      ["me", "running 5 min late, order me a latte"],
      ["other", "already done"],
      ["them", "we got the big table by the window"],
    ],
  },
  {
    topics: ["brunch"],
    lines: [
      ["other", "that was the best brunch yet"],
      ["them", "the cinnamon roll alone"],
      ["me", "same time next week?"],
      ["other", "obviously"],
    ],
  },
  {
    topics: ["brunch"],
    lines: [
      ["them", "skipping this week, family stuff. have fun!"],
      ["me", "we'll miss you!"],
      ["other", "saving you a pastry"],
    ],
  },
  {
    topics: ["mum"],
    lines: [
      ["them", "Saw a lovely article about hiking in the Cascades and thought of you"],
      ["me", "aw send it over"],
      ["them", "Be careful up there though"],
      ["me", "always am, we go in a group"],
    ],
  },
  {
    topics: ["mum"],
    lines: [
      ["them", "Are you coming home for the holidays this year?"],
      ["me", "planning to! looking at flights now"],
      ["them", "Wonderful. I'll make up the spare room"],
    ],
  },
  {
    topics: ["mum"],
    lines: [
      ["them", "The garden is finally coming back after the frost"],
      ["me", "send me a photo of the roses"],
      ["them", "I will when the light is better"],
    ],
  },
  {
    topics: ["mum"],
    lines: [
      ["me", "how did the doctor's appointment go?"],
      ["them", "All fine, just a check up. Nothing to worry about"],
      ["me", "glad to hear it ❤️"],
    ],
  },
  {
    topics: ["mum"],
    lines: [
      ["them", "Your aunt is visiting next month, she'd love to see you"],
      ["me", "I'll try to come down for a weekend"],
      ["them", "That would make her day"],
    ],
  },
  {
    topics: ["mum"],
    lines: [
      ["them", "I finished that book you recommended"],
      ["me", "what did you think?"],
      ["them", "Couldn't put it down. Got any more?"],
      ["me", "I'll make you a list"],
    ],
  },
  {
    topics: ["sister"],
    lines: [
      ["them", "do you still have my blue rain jacket"],
      ["me", "...maybe"],
      ["them", "ALEX"],
      ["me", "I'll bring it next time I visit, promise"],
    ],
  },
  {
    topics: ["sister"],
    lines: [
      ["me", "just watched {film}, you need to see it"],
      ["them", "adding it to the list"],
      ["me", "the list is 200 films long"],
      ["them", "and growing 😌"],
    ],
  },
  {
    topics: ["sister"],
    lines: [
      ["them", "new apartment update: the radiator makes a noise like a whale"],
      ["me", "😂 call the landlord"],
      ["them", "I did. he said 'that's normal'"],
    ],
  },
  {
    topics: ["sister"],
    lines: [
      ["them", "made your {dish} recipe, it was a hit"],
      ["me", "told you. the secret is more garlic"],
      ["them", "the secret is always more garlic"],
    ],
  },
  {
    topics: ["sister"],
    lines: [
      ["me", "can you call mum this week? she's been asking"],
      ["them", "yeah I'll ring her tomorrow"],
      ["me", "thanks"],
    ],
  },
  {
    topics: ["friend"],
    lines: [
      ["them", "climbing at Fern Street tonight?"],
      ["me", "my forearms say no but I say yes"],
      ["them", "haha 7?"],
      ["me", "see you there"],
    ],
  },
  {
    topics: ["friend"],
    lines: [
      ["me", "how did the interview go?"],
      ["them", "really well I think! second round next week"],
      ["me", "amazing, fingers crossed"],
    ],
  },
  {
    topics: ["friend"],
    lines: [
      ["them", "can you water my plants while I'm away? back on {day}"],
      ["me", "of course, leave the key with your neighbour"],
      ["them", "you're a star"],
    ],
  },
  {
    topics: ["friend", "hike"],
    lines: [
      ["them", "the larches should be turning soon. Lake Ingalls?"],
      ["me", "that's a big day. permits?"],
      ["them", "no permit needed for day hikes, just an early start"],
      ["me", "ok I'm in if we leave at 5"],
    ],
  },
  {
    topics: ["friend"],
    lines: [
      ["me", "picked up a copy of that book at Elliott Bay"],
      ["them", "ooh tell me what you think"],
      ["me", "three chapters in and hooked"],
    ],
  },
  {
    topics: ["gaming", "friend"],
    lines: [
      ["them", "did you see the {videogame} update"],
      ["me", "yes! the new map looks great"],
      ["them", "squad up this weekend?"],
      ["me", "saturday night"],
    ],
  },
];

/** Openers per topic, for unscripted small talk; either side may send them. */
const OPENERS: Record<Topic, readonly string[]> = {
  friend: [
    "what are you up to this weekend?",
    "how's your week going",
    "just walked past {venue} and thought of you",
    "are you free {day}?",
    "you have to try the {dish} at {venue}",
    "it's actually sunny?? going to {place}",
    "random question: do you still have that camping stove",
    "drinks at Northbound Brewing {day}?",
    "did you end up going to {place}?",
    "tell me something good",
  ],
  hike: [
    "{trail} {day}?",
    "trail report says {trail} is clear",
    "what's the forecast looking like for the mountains",
    "need to get one more hike in before the snow",
    "parking at {trail} was a nightmare last time, let's go early",
    "new boots arrived, need to break them in on {trail2}",
  ],
  family: ["how's everyone doing?", "thinking of you today", "any news from home?"],
  mum: [
    "Hello love, how was your week?",
    "Just checking in. Are you keeping warm?",
    "Did you get the parcel I sent?",
    "Dad and I are going away for the weekend",
    "What would you like for your birthday?",
    "Have you spoken to your sister recently?",
    "Call me when you get a minute x",
  ],
  sister: [
    "SOS what do I make for dinner",
    "guess who I ran into in portland",
    "mum sent me a 4 minute voice memo about her neighbour's cat",
    "running club was brutal today",
    "are you coming down for mum's birthday?",
    "listening to {artist} and feeling nostalgic",
    "rate my new haircut 1-10 (photo incoming)",
  ],
  brunch: [
    "brunch {day}?",
    "where are we going this week",
    "{venue} has a new menu apparently",
    "who's in for brunch?",
  ],
  gaming: [
    "{videogame} later?",
    "who's on tonight",
    "just bought {videogame}, no regrets",
    "rematch at {boardgame}? I demand it",
  ],
  uni: [
    "remember the library all-nighters?",
    "just got a wedding invite from someone from halls 😳",
    "how's everyone doing these days",
    "found my old lecture notes, why did I keep these",
  ],
  music: [
    "{artist} at {musicvenue}, anyone?",
    "making a playlist for the road trip, send songs",
    "can't stop listening to {artist}",
  ],
};

/** Generic replies that fit after most openers. */
const REPLIES = [
  "haha yes",
  "omg yes",
  "ooh nice",
  "sounds good to me",
  "I'm in",
  "maybe! let me check",
  "can't this time, next week?",
  "not much, you?",
  "all good here",
  "busy but good",
  "yes please",
  "100%",
  "that's amazing",
  "no way",
  "ha I was just thinking that",
  "let me know!",
  "ugh same",
  "sure, what time?",
  "I'll text you later",
  "love that",
] as const;

const QUICK_LINES = [
  "omw",
  "here!",
  "lol",
  "haha yes",
  "sounds good",
  "thank you!!",
  "on the bus now",
  "just saw this, sorry",
  "can I call you in 5?",
  "👍",
  "love that",
  "good luck today!",
  "how was it?",
  "parking now",
  "heading out",
  "happy birthday!! 🎉",
] as const;

/** One set of placeholder values per session, so every line of an exchange agrees. */
function placeholderValues(rng: Rng): Record<string, string> {
  const trails = rng.sample(TRAILS, 2) as [string, string];
  const venues = rng.sample(VENUES, 2);
  const [venue, venue2] = [venues[0]?.name ?? "", venues[1]?.name ?? ""];
  return {
    trail: trails[0],
    trail2: trails[1],
    venue,
    venue2,
    place: rng.pick(PLACES).name,
    film: rng.pick(FILMS),
    artist: rng.pick(ARTISTS),
    musicvenue: rng.pick(MUSIC_VENUES),
    boardgame: rng.pick(BOARD_GAMES),
    videogame: rng.pick(VIDEO_GAMES),
    dish: rng.pick(DISHES),
    time: rng.pick(TIMES),
    day: rng.pick(DAYS),
  };
}

function fill(text: string, values: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`Unknown phrasebook placeholder ${match}`);
    return value;
  });
}

export interface ChatLine {
  at: Date;
  /** Who sent it: "alex" or a persona member. */
  from: PersonKey;
  text: string;
}

/** A plausible local start time for a chat: lunch or evening on weekdays, any waking hour at weekends. */
export function chatStart(rng: Rng, day: SeedDay): { hour: number; minute: number } {
  const hour = day.isWeekend
    ? rng.weighted([
        [9, 1],
        [10, 2],
        [11, 2],
        [13, 2],
        [15, 2],
        [17, 2],
        [19, 3],
        [21, 2],
        [22, 1],
      ])
    : rng.weighted([
        [7, 1],
        [8, 1],
        [12, 3],
        [13, 1],
        [17, 2],
        [18, 3],
        [19, 3],
        [20, 3],
        [21, 3],
        [22, 2],
      ]);
  return { hour, minute: rng.int(0, 59) };
}

/**
 * One scripted chat session on `day`: an exchange whose topics overlap
 * `topics` (or a single quick line), with gaps of seconds to minutes.
 * `them` is the conversation partner; `others` are further group members.
 */
export function chatSession(
  ctx: SeedContext,
  rng: Rng,
  day: SeedDay,
  topics: readonly Topic[],
  them: PersonKey,
  others: readonly PersonKey[] = [],
): ChatLine[] {
  const { hour, minute } = chatStart(rng, day);
  let at = ctx.localDate(day.date, hour, minute, rng.int(0, 59)).getTime();
  const out: ChatLine[] = [];

  if (rng.chance(0.15)) {
    out.push({ at: new Date(at), from: rng.chance(0.5) ? "alex" : them, text: rng.pick(QUICK_LINES) });
    return out;
  }

  const values = placeholderValues(rng);
  const gap = () => (rng.chance(0.12) ? rng.int(600, 2400) : rng.int(8, 240)) * 1000;

  if (rng.chance(0.35)) {
    // Unscripted small talk: an opener, a reply, sometimes a second round.
    const openers = topics.flatMap((topic) => OPENERS[topic]);
    let speaker: PersonKey = rng.chance(0.5) ? "alex" : them;
    const replier = () => (speaker === "alex" ? (others.length > 0 ? rng.pick([them, ...others]) : them) : "alex");
    for (let round = rng.int(1, 2); round > 0; round--) {
      out.push({ at: new Date(at), from: speaker, text: fill(rng.pick(openers), values) });
      at += gap();
      const reply = replier();
      out.push({ at: new Date(at), from: reply, text: rng.pick(REPLIES) });
      at += gap();
      speaker = reply;
    }
    return out;
  }

  const candidates = EXCHANGES.filter((exchange) => exchange.topics.some((topic) => topics.includes(topic)));
  const exchange = rng.pick(candidates);
  const other = others.length > 0 ? rng.pick(others) : them;
  for (const [speaker, text] of exchange.lines) {
    const from = speaker === "me" ? "alex" : speaker === "them" ? them : other;
    out.push({ at: new Date(at), from, text: fill(text, values) });
    at += gap();
  }
  return out;
}
