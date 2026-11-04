import { join } from "node:path";
import { importInstagramData } from "../../parsers/instagram";
import type { SeedSource } from "../context";
import { peopleOn, personByKey, SELF } from "../persona";
import { HOURS, INSTAGRAM_SCRIPTS, metaExportJson, planConversation, recentLift } from "./messaging-a-data";

const NAME = "instagram";

/**
 * Instagram DMs from an "Download your information" export (JSON), run
 * through importInstagramData on its messages/ folder. Mostly reels, post
 * shares, story replies, and photos, busier in recent months.
 */
export const instagramSeed: SeedSource = {
  name: NAME,
  produces: {
    instagram: ["message:dm", "message:dm:attachment", "message:dm:share", "message:dm:share:reel"],
  },
  async seed(ctx) {
    const rng = ctx.rng(NAME);
    const messagesRoot = "your_instagram_activity/messages";
    const lift = recentLift(ctx);
    const people = peopleOn("instagram");

    for (const person of people) {
      const plan = planConversation(ctx, ctx.rng(`${NAME}:dm:${person.key}`), {
        members: [person.key],
        scripts: INSTAGRAM_SCRIPTS,
        sessionsPerWeek: person.closeness * 0.075,
        dayWeight: (day) => lift(day) * lift(day),
        startHour: HOURS.evening,
        fillerChance: 0.1,
        gapSeconds: [20, 900],
      });
      const folder = `${person.handle}_${rng.digits(16)}`;
      const threadPath = `inbox/${folder}`;
      const messages = plan.map((planned) => {
        const msg: Record<string, unknown> = {
          sender_name: personByKey(planned.by).name,
          timestamp_ms: planned.at.getTime(),
        };
        if (planned.photo) {
          msg.photos = [
            {
              uri: `${messagesRoot}/${threadPath}/photos/${rng.digits(17)}_${rng.digits(16)}_${rng.digits(18)}_n.jpg`,
              creation_timestamp: Math.floor(planned.at.getTime() / 1000),
            },
          ];
        }
        if (planned.link) {
          msg.share = { link: planned.link, original_content_owner: rng.pick(["natgeo", "kexp", "seattlegov", "wta_hikers", "bonappetitmag"]) };
        }
        if (planned.text && !(planned.link && planned.text === planned.link)) msg.content = planned.text;
        if (rng.chance(0.12)) {
          const actor = planned.by === "alex" ? person : SELF;
          msg.reactions = [{ reaction: rng.pick(["❤️", "😂", "😍", "🔥"]), actor: actor.name, timestamp: Math.floor(planned.at.getTime() / 1000) + rng.int(5, 600) }];
        }
        msg.is_geoblocked_for_viewer = false;
        msg.is_unsent_image_by_messenger_kid_parent = false;
        return msg;
      });
      messages.sort((a, b) => Number(b.timestamp_ms) - Number(a.timestamp_ms));
      ctx.writeStaged(
        NAME,
        `${messagesRoot}/${threadPath}/message_1.json`,
        metaExportJson({
          participants: [{ name: person.name }, { name: SELF.name }],
          messages,
          title: person.name,
          is_still_participant: true,
          thread_path: threadPath,
          magic_words: [],
        }),
      );
      ctx.identify(person.key, `instagram:name:${person.name}`);
    }

    await ctx.inTransaction(() => importInstagramData(ctx.db, join(ctx.stage(NAME), messagesRoot), SELF.handle));
    ctx.identify("alex", `instagram:name:${SELF.name}`);
  },
};
