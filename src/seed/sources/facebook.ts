import { join } from "node:path";
import sharp from "sharp";
import { extractFacebookMedia } from "../../media/facebook-extractor";
import { importFacebookData } from "../../parsers/facebook";
import type { SeedContext, SeedSource } from "../context";
import type { Person } from "../persona";
import { GROUP_CHATS, PLACES, peopleOn, personByKey, SELF } from "../persona";
import type { Rng } from "../rng";
import {
  COMMENTS,
  FACEBOOK_DM_SCRIPTS,
  FACEBOOK_FRIEND_SCRIPTS,
  FAMILY_GROUP_SCRIPTS,
  fadingOut,
  HOURS,
  metaExportJson,
  type PlannedMessage,
  planConversation,
  POSTS,
  type Script,
} from "./messaging-a-data";

const NAME = "facebook";
const ACCOUNT = SELF.handle;
const PHOTO_BUDGET = 22;
const GIF_BUDGET = 8;

/** Facebook friends outside the persona, for likes, comments, and new friendships. */
const ACQUAINTANCES = [
  "Casey Moreno",
  "Devon Park",
  "Ines Laurent",
  "Marcus Bell",
  "Tara Quinn",
  "Felix Andersen",
  "Ruth Delgado",
  "Kenji Watanabe",
  "Bea Lindqvist",
  "Oscar Mensah",
] as const;

const GROUPS = [
  "Seattle Hiking & Backpacking",
  "Capitol Hill Neighbors",
  "PNW Trail Conditions",
  "Seattle Board Gamers",
  "UW Computer Science Alumni",
  "Balcony Gardening PNW",
  "Seattle Film Photography",
  "Buy Nothing Capitol Hill",
] as const;

const PUBLIC_EVENTS = [
  "Fremont Solstice Parade",
  "Capitol Hill Block Party",
  "Seattle Lantern Festival",
  "Bumbershoot",
  "Northwest Folklife Festival",
  "Seafair Weekend",
  "Ballard SeafoodFest",
  "Bite of Seattle",
] as const;

const PRIVATE_EVENTS = [
  "Mei's birthday dinner",
  "Priya's housewarming",
  "Sam's 30th 🎉",
  "Friendsgiving 2023",
  "Board game marathon",
  "Summer BBQ at Gas Works",
  "Theo's farewell drinks",
] as const;

const REACTION_TYPES: readonly (readonly [string, number])[] = [
  ["LIKE", 60],
  ["LOVE", 20],
  ["HAHA", 9],
  ["WOW", 4],
  ["CARE", 4],
  ["SORRY", 3],
];

interface Thread {
  slug: string;
  title: string;
  threadType: "Regular" | "RegularGroup";
  members: Person[];
  plan: PlannedMessage[];
}

/**
 * A Facebook "Download Your Information" export (JSON, 2024 layout) run
 * through importFacebookData, then its message photos/GIFs pulled from the
 * export ZIP by the real media extractor. Activity fades over the range as
 * Alex drifts off Facebook.
 */
export const facebookSeed: SeedSource = {
  name: NAME,
  produces: {
    facebook: [
      "message",
      "message:photo",
      "message:share",
      "message:gif",
      "message:call",
      "post",
      "comment",
      "reaction:like",
      "reaction:love",
      "group:join",
      "event:response",
      "event:invitation",
      "friend:added",
    ],
  },
  async seed(ctx) {
    const rng = ctx.rng(NAME);
    const stage = ctx.stage(NAME);
    const fade = fadingOut(ctx);

    const threads: Thread[] = [];
    for (const person of peopleOn("facebook")) {
      const own = FACEBOOK_DM_SCRIPTS[person.key] ?? [];
      const scripts: Script[] = [...own, ...own, ...FACEBOOK_FRIEND_SCRIPTS];
      threads.push({
        slug: `${person.first}${person.last}`.toLowerCase(),
        title: person.name,
        threadType: "Regular",
        members: [person],
        plan: planConversation(ctx, ctx.rng(`${NAME}:dm:${person.key}`), {
          members: [person.key],
          scripts,
          sessionsPerWeek: person.closeness * 0.21,
          dayWeight: fade,
          startHour: HOURS.anytime,
          fillerChance: 0.15,
        }),
      });
    }
    for (const group of GROUP_CHATS.facebook ?? []) {
      threads.push({
        slug: group.name.toLowerCase().replace(/[^a-z]+/g, ""),
        title: group.name,
        threadType: "RegularGroup",
        members: group.members.map(personByKey),
        plan: planConversation(ctx, ctx.rng(`${NAME}:group:${group.id}`), {
          members: group.members,
          scripts: FAMILY_GROUP_SCRIPTS,
          sessionsPerWeek: group.perDay * 1.5,
          dayWeight: (day) => fade(day) * (day.weekday === 0 ? 2 : 1),
          startHour: HOURS.evening,
          fillerChance: 0.2,
        }),
      });
    }

    const photoLines = new Set(rng.sample(threads.flatMap((t) => t.plan.filter((m) => m.photo)), PHOTO_BUDGET));
    const gifLines = new Set(rng.sample(threads.flatMap((t) => t.plan.filter((m) => m.gif)), GIF_BUDGET));
    const mediaFiles: string[] = [];

    for (const thread of threads) {
      const folder = `${thread.slug}_${rng.digits(16)}`;
      const threadPath = `inbox/${folder}`;
      const base = `your_facebook_activity/messages/${threadPath}`;
      const messages: Record<string, unknown>[] = [];
      for (const planned of thread.plan) {
        messages.push(
          ...(await exportMessage(ctx, rng, thread, base, planned, {
            photo: photoLines.has(planned),
            gif: gifLines.has(planned),
            files: mediaFiles,
          })),
        );
      }
      // Exports list newest first; the parser requires non-increasing timestamps.
      messages.sort((a, b) => Number(b.timestamp_ms) - Number(a.timestamp_ms));
      ctx.writeStaged(
        NAME,
        `${base}/message_1.json`,
        metaExportJson({
          participants: [...thread.members, SELF].map((p) => ({ name: p.name })),
          messages,
          title: thread.title,
          is_still_participant: true,
          thread_path: threadPath,
          thread_type: thread.threadType,
          magic_words: [],
        }),
      );
    }

    writeActivity(ctx, rng);

    const zip = Bun.spawnSync(["zip", "-q", "-0", "facebook-alexrivera.zip", ...mediaFiles], { cwd: stage });
    if (zip.exitCode !== 0) throw new Error(`zip failed: ${zip.stderr.toString()}`);

    // Not one transaction: importFacebookData manages its own BEGIN/COMMIT.
    await importFacebookData(ctx.db, stage, ACCOUNT);
    const media = await extractFacebookMedia(ctx.db, join(stage, "facebook-alexrivera.zip"));
    if (media.failed > 0) throw new Error(`facebook: ${media.failed} attachments failed to extract`);

    ctx.identify("alex", `facebook:name:${SELF.name}`);
    for (const person of peopleOn("facebook")) ctx.identify(person.key, `facebook:name:${person.name}`);
  },
};

/**
 * A planned line as export message JSON (none for a bare media line left
 * without media), writing any photo/GIF it carries into the staged export.
 * Occasionally followed by a call record.
 */
async function exportMessage(
  ctx: SeedContext,
  rng: Rng,
  thread: Thread,
  base: string,
  planned: PlannedMessage,
  media: { photo: boolean; gif: boolean; files: string[] },
): Promise<Record<string, unknown>[]> {
  if (planned.text === "" && !media.photo && !media.gif) return [];
  const ms = planned.at.getTime();
  const msg: Record<string, unknown> = {
    sender_name: personByKey(planned.by).name,
    timestamp_ms: ms,
  };
  if (planned.text) msg.content = planned.text;
  if (media.photo) {
    const uri = `${base}/photos/${rng.digits(9)}_${rng.digits(15)}_${rng.digits(18)}_n.jpg`;
    const portrait = rng.chance(0.3);
    const image = await ctx.image({
      width: portrait ? 480 : 720,
      height: portrait ? 640 : 540,
      hue: (media.files.length * 61) % 360,
      variant: media.files.length + 100,
    });
    ctx.writeStaged(NAME, uri, image);
    media.files.push(uri);
    msg.photos = [{ uri, creation_timestamp: Math.floor(ms / 1000) }];
  }
  if (media.gif) {
    const uri = `${base}/gifs/${rng.digits(9)}_${rng.digits(15)}_n.gif`;
    const still = await ctx.image({
      width: 320,
      height: 240,
      hue: (media.files.length * 61) % 360,
      variant: media.files.length + 200,
      format: "png",
    });
    ctx.writeStaged(NAME, uri, await sharp(still).gif().toBuffer());
    media.files.push(uri);
    msg.gifs = [{ uri }];
  }
  if (planned.link) msg.share = { link: planned.link };
  if (rng.chance(0.1)) {
    const others = [SELF, ...thread.members].filter((p) => p.key !== planned.by);
    msg.reactions = rng
      .sample(others, rng.int(1, others.length))
      .map((p) => ({ reaction: rng.pick(["❤", "😆", "👍", "😮", "😢"]), actor: p.name }));
  }
  msg.is_geoblocked_for_viewer = false;
  if (thread.threadType !== "Regular" || !rng.chance(0.012)) return [msg];
  return [
    msg,
    {
      sender_name: rng.pick([SELF, ...thread.members]).name,
      timestamp_ms: ms + rng.int(5, 30) * 60_000,
      content: "The call ended.",
      call_duration: rng.int(60, 3600),
      is_geoblocked_for_viewer: false,
    },
  ];
}

/** Posts, comments, reactions, groups, events, and friends. */
function writeActivity(ctx: SeedContext, rng: Rng): void {
  const fade = fadingOut(ctx);
  const friends = [...peopleOn("facebook").map((p) => p.name), ...ACQUAINTANCES];
  const seconds = (day: string, hour: number) => Math.floor(ctx.localDate(day, 0, Math.round(hour * 60)).getTime() / 1000);
  /** Days chosen with the fading weight, `count` on average. */
  const fadingDays = (count: number) => {
    const scale = count / ctx.days.reduce((sum, day) => sum + fade(day), 0);
    return ctx.days.filter((day) => rng.chance(fade(day) * scale));
  };
  const fill = (text: string) =>
    text.replace(/\{(\w+)\}/g, (_, slot: string) => {
      const options: Readonly<Record<string, readonly string[]>> = {
        trail: ["Mount Si", "Rattlesnake Ledge", "Lake Serene", "Mailbox Peak", "Snow Lake"],
        place: PLACES.map((p) => p.name),
        food: ["ramen", "tacos", "pho", "a good burger"],
        artist: ["Fleet Foxes", "Death Cab for Cutie", "Japanese Breakfast", "Bon Iver"],
        venue_music: ["the Showbox", "Neumos", "the Paramount"],
        book: ["Project Hail Mary", "Piranesi", "Klara and the Sun"],
      };
      const values = options[slot];
      if (!values) throw new Error(`Unknown post slot {${slot}}`);
      return rng.pick(values);
    });

  const posts = fadingDays(70).map((day) => {
    const place = rng.chance(0.25) ? rng.pick(PLACES) : null;
    return {
      timestamp: seconds(day.date, rng.float(9, 22)),
      data: [{ post: fill(rng.pick(POSTS)) }],
      title: place ? `${SELF.name} was at ${place.name}.` : `${SELF.name} updated their status.`,
      ...(place ? { attachments: [{ data: [{ place: { name: place.name, coordinate: { latitude: place.lat, longitude: place.lng }, address: place.address } }] }] } : {}),
    };
  });
  ctx.writeStaged(NAME, "your_facebook_activity/posts/your_posts__check_ins__photos_and_videos_1.json", metaExportJson(posts));

  const comments = fadingDays(150).map((day) => {
    const ts = seconds(day.date, rng.float(8, 23.5));
    return {
      timestamp: ts,
      data: [{ comment: { timestamp: ts, comment: rng.pick(COMMENTS), author: SELF.name } }],
      title: `${SELF.name} commented on ${rng.pick(friends)}'s ${rng.pick(["post", "photo", "post", "video"])}.`,
    };
  });
  ctx.writeStaged(NAME, "your_facebook_activity/comments_and_reactions/comments.json", metaExportJson({ comments_v2: comments }));

  const reactions = fadingDays(320).map((day) => {
    const reaction = rng.weighted(REACTION_TYPES);
    const verb = reaction === "LIKE" ? "liked" : "reacted to";
    return {
      timestamp: seconds(day.date, rng.float(7, 23.9)),
      data: [{ reaction: { reaction, actor: SELF.name } }],
      title: `${SELF.name} ${verb} ${rng.pick(friends)}'s ${rng.pick(["post", "photo", "comment", "video"])}.`,
    };
  });
  ctx.writeStaged(NAME, "your_facebook_activity/comments_and_reactions/likes_and_reactions_1.json", metaExportJson(reactions));

  const joinedDays = rng.sample(ctx.days.slice(0, Math.floor(ctx.days.length * 0.6)), GROUPS.length);
  const groupsJoined = GROUPS.map((name, i) => {
    const day = joinedDays[i];
    if (!day) throw new Error("facebook: not enough days for group joins");
    return { timestamp: seconds(day.date, rng.float(9, 23)), data: [{ name }], title: `${SELF.name} became a member of ${name}.` };
  });
  ctx.writeStaged(
    NAME,
    "your_facebook_activity/groups/your_group_membership_activity.json",
    metaExportJson({ groups_joined_v2: groupsJoined }),
  );

  const eventEntry = (day: (typeof ctx.days)[number]) => {
    const name = rng.chance(0.55) ? rng.pick(PUBLIC_EVENTS) : rng.pick(PRIVATE_EVENTS);
    const start = seconds(day.date, rng.float(11, 20));
    return { name, start_timestamp: start + rng.int(3, 30) * 86_400, end_timestamp: start + rng.int(3, 30) * 86_400 + 4 * 3600, timestamp: start };
  };
  ctx.writeStaged(
    NAME,
    "your_facebook_activity/events/your_event_responses.json",
    metaExportJson({ event_responses_v2: { events_joined: fadingDays(22).map(eventEntry), events_declined: [], events_interested: [] } }),
  );
  ctx.writeStaged(
    NAME,
    "your_facebook_activity/events/event_invitations.json",
    metaExportJson({ events_invited_v2: fadingDays(16).map(eventEntry) }),
  );

  // Persona friendships predate the range; acquaintances are newer.
  const earlier = ctx.localDate(ctx.startDate, 12).getTime() / 1000;
  const friendDays = rng.sample(fadingDays(40), ACQUAINTANCES.length);
  const friendsList = [
    ...peopleOn("facebook").map((p) => ({ name: p.name, timestamp: Math.floor(earlier - rng.int(200, 4000) * 86_400) })),
    ...ACQUAINTANCES.map((name, i) => {
      const day = friendDays[i];
      if (!day) throw new Error("facebook: not enough days for new friendships");
      return { name, timestamp: seconds(day.date, rng.float(9, 23)) };
    }),
  ].sort((a, b) => b.timestamp - a.timestamp);
  ctx.writeStaged(NAME, "connections/friends/your_friends.json", metaExportJson({ friends_v2: friendsList }));
}
