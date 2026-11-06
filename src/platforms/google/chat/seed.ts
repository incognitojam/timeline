import { importChatData } from "./parser";
import type { SeedSource } from "../../../seed/context";
import type { Person } from "../../../seed/persona";
import { GROUP_CHATS, peopleOn, personByKey, SELF } from "../../../seed/persona";
import type { Rng } from "../../../seed/rng";
import {
  HOURS,
  type PlannedMessage,
  planConversation,
  WORK_GROUP_SCRIPTS,
  weekdaysOnly,
  workDmScripts,
} from "../../../seed/sources/messaging-a-data";

const NAME = "google-chat";
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Takeout's created_date, e.g. "Friday, 21 May 2021 at 14:41:21 UTC". */
function takeoutDate(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${DAYS[at.getUTCDay()]}, ${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()} at ` +
    `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())} UTC`
  );
}

function member(p: Person) {
  return { name: p.name, email: p.email, user_type: "Human" };
}

/** Takeout messages.json for one space; each session is one threaded topic. */
function messagesJson(rng: Rng, spaceId: string, plan: readonly PlannedMessage[]): string {
  const topics = new Map<number, string>();
  const messages = plan.map((planned) => {
    // A topic's first message shares the topic's id; replies get their own.
    let topic = topics.get(planned.session);
    let id: string;
    if (topic) {
      id = rng.hex(11);
    } else {
      topic = rng.hex(11);
      topics.set(planned.session, topic);
      id = topic;
    }
    return {
      creator: member(personByKey(planned.by)),
      created_date: takeoutDate(planned.at),
      text: planned.text,
      topic_id: topic,
      message_id: `${spaceId}/${topic}/${id}`,
    };
  });
  return JSON.stringify({ messages }, null, 2);
}

/**
 * Work chat from a Google Takeout "Google Chat" export: the platform squad
 * space and DMs with teammates, weekday working hours only.
 */
export const googleChatSeed: SeedSource = {
  name: NAME,
  produces: { "google-chat": ["message"] },
  async seed(ctx) {
    const rng = ctx.rng(NAME);
    const workHours = HOURS.work;

    for (const group of GROUP_CHATS["google-chat"] ?? []) {
      const spaceId = `AAAA${rng.hex(7)}`;
      const plan = planConversation(ctx, ctx.rng(`${NAME}:space:${group.id}`), {
        members: group.members,
        scripts: WORK_GROUP_SCRIPTS,
        sessionsPerWeek: group.perDay * 0.8,
        dayWeight: weekdaysOnly,
        startHour: workHours,
        shuffleRoles: true,
        fillerChance: 0.2,
        gapSeconds: [20, 420],
      });
      const dir = `Groups/Space ${spaceId}`;
      ctx.writeStaged(
        NAME,
        `${dir}/group_info.json`,
        JSON.stringify({ name: group.name, members: [SELF, ...group.members.map(personByKey)].map(member) }, null, 2),
      );
      ctx.writeStaged(NAME, `${dir}/messages.json`, messagesJson(rng, spaceId, plan));
    }

    for (const person of peopleOn("google-chat")) {
      const spaceId = `dm${rng.hex(9)}`;
      const plan = planConversation(ctx, ctx.rng(`${NAME}:dm:${person.key}`), {
        members: [person.key],
        scripts: workDmScripts(person.key),
        sessionsPerWeek: person.closeness * 0.22,
        dayWeight: weekdaysOnly,
        startHour: workHours,
        fillerChance: 0.15,
        gapSeconds: [20, 420],
      });
      const dir = `Users/${person.name}`;
      ctx.writeStaged(NAME, `${dir}/user_info.json`, JSON.stringify({ name: person.name, email: person.email, user_type: "Human" }, null, 2));
      ctx.writeStaged(NAME, `${dir}/messages.json`, messagesJson(rng, spaceId, plan));
      ctx.identify(person.key, `google-chat:${person.email}`);
    }

    await ctx.inTransaction(() => importChatData(ctx.db, ctx.stage(NAME), SELF.email));
    ctx.identify("alex", `google-chat:${SELF.email}`);
  },
};
