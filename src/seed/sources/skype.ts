import type { SeedContext, SeedSource } from "../context";
import type { PersonKey } from "../persona";
import { peopleOn, personByKey, SELF } from "../persona";
import { type ChatLine, chatSession, chatStart, type Topic } from "./messaging-b-data";

const NAME = "skype";
const ACCOUNT = SELF.handle;

/** Skype ids as they appear in the export: newer accounts are `live:`, older ones bare usernames. */
const SKYPE_IDS: Partial<Record<PersonKey, string>> = {
  alex: `8:live:${SELF.handle}`,
  sam: "8:live:samokafor",
  linda: "8:live:linda.rivera.62",
  theo: "8:theo.brooks",
  omar: "8:live:omarhaddad",
};

const DM_TOPICS: Partial<Record<PersonKey, readonly Topic[]>> = {
  sam: ["uni", "friend", "gaming"],
  linda: ["mum"],
  theo: ["uni", "gaming"],
  omar: ["gaming", "friend"],
};

const GROUP = {
  id: "19:7f3c9a2e4b1d4e8fa06b5c2d9e1f3a47@thread.skype",
  name: "Uni crew",
  members: ["theo", "sam", "omar"] as const satisfies readonly PersonKey[],
};

/** Alex stopped using Skype after the first year of the range. */
const ACTIVE_DAYS = 365;

function skypeId(key: PersonKey): string {
  const id = SKYPE_IDS[key];
  if (!id) throw new Error(`No Skype id for ${key}`);
  return id;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&apos;").replace(/"/g, "&quot;");
}

interface SkypeMessage {
  id: string;
  displayName: string | null;
  originalarrivaltime: string;
  messagetype: string;
  version: number;
  content: string;
  conversationid: string;
  from: string;
  properties: Record<string, unknown> | null;
  amsreferences: string[] | null;
}

function textMessage(conversationId: string, line: ChatLine): SkypeMessage {
  const ms = line.at.getTime();
  return {
    id: String(ms),
    displayName: personByKey(line.from).name,
    originalarrivaltime: line.at.toISOString(),
    messagetype: "RichText",
    version: ms,
    content: escapeHtml(line.text),
    conversationid: conversationId,
    from: skypeId(line.from),
    properties: null,
    amsreferences: null,
  };
}

function callMessage(conversationId: string, from: PersonKey, end: Date, seconds: number, missed: boolean): SkypeMessage {
  const ms = end.getTime();
  const sender = personByKey(from);
  const part = missed
    ? `<part identity="${skypeId(from).slice(2)}"><name>${sender.name}</name></part>`
    : `<part identity="${skypeId(from).slice(2)}"><name>${sender.name}</name><duration>${seconds.toFixed(3)}</duration></part>`;
  return {
    id: String(ms),
    displayName: sender.name,
    originalarrivaltime: end.toISOString(),
    messagetype: "Event/Call",
    version: ms,
    content: `<partlist type="${missed ? "missed" : "ended"}" alt="">${part}</partlist>`,
    conversationid: conversationId,
    from: skypeId(from),
    properties: null,
    amsreferences: null,
  };
}

export const skypeSeed: SeedSource = {
  name: NAME,
  produces: { skype: ["message:dm", "message:group", "message:call"] },
  async seed(ctx: SeedContext) {
    const rng = ctx.rng(NAME);
    const days = ctx.days.slice(0, ACTIVE_DAYS);
    const contacts = peopleOn("skype");
    const dms = new Map<PersonKey, SkypeMessage[]>(contacts.map((p) => [p.key, []]));
    const group: SkypeMessage[] = [];

    for (const day of days) {
      // Usage tails off over the year as everyone drifts to other apps.
      const activity = 1 - day.index / ACTIVE_DAYS;
      for (const person of contacts) {
        const list = dms.get(person.key);
        const topics = DM_TOPICS[person.key];
        if (!list || !topics) throw new Error(`Skype contact ${person.key} has no topics`);
        const conversationId = skypeId(person.key);
        if (rng.chance(0.035 * person.closeness * activity)) {
          for (const line of chatSession(ctx, rng, day, topics, person.key)) list.push(textMessage(conversationId, line));
        }
        // Mum's Sunday video calls (and the odd catch-up with friends).
        const callChance = person.key === "linda" ? (day.weekday === 0 ? 0.6 : 0.02) : 0.01;
        if (rng.chance(callChance * activity)) {
          const { hour, minute } = chatStart(rng, day);
          const caller: PersonKey = rng.chance(0.5) ? "alex" : person.key;
          const missed = rng.chance(0.15);
          const seconds = missed ? 0 : rng.float(120, 3600);
          const end = new Date(ctx.localDate(day.date, hour, minute).getTime() + seconds * 1000);
          list.push(callMessage(conversationId, caller, end, seconds, missed));
        }
      }
      if (rng.chance((day.isWeekend ? 0.5 : 0.25) * activity)) {
        const them = rng.pick(GROUP.members);
        const others = GROUP.members.filter((key) => key !== them);
        for (const line of chatSession(ctx, rng, day, ["uni", "gaming"], them, others)) group.push(textMessage(GROUP.id, line));
      }
    }

    const conversations = [
      ...contacts.map((person) => ({
        id: skypeId(person.key),
        displayName: person.name,
        version: 1,
        properties: { conversationblocked: false, lastimreceivedtime: null, consumptionhorizon: null },
        threadProperties: null,
        MessageList: dms.get(person.key) ?? [],
      })),
      {
        id: GROUP.id,
        displayName: GROUP.name,
        version: 1,
        properties: { conversationblocked: false, lastimreceivedtime: null, consumptionhorizon: null },
        threadProperties: {
          membercount: GROUP.members.length + 1,
          members: JSON.stringify([skypeId("alex"), ...GROUP.members.map(skypeId)]),
          topic: GROUP.name,
        },
        MessageList: group,
      },
    ];

    const lastDay = days.at(-1);
    if (!lastDay) throw new Error("Skype seed needs at least one day");
    const exportData = {
      userId: skypeId("alex"),
      exportDate: ctx.localIso(lastDay.date, 12),
      conversations,
    };
    ctx.writeStaged(NAME, "export/messages.json", JSON.stringify(exportData));
    await ctx.runParserCli("skype.ts", [`${ctx.stage(NAME)}/export`, ACCOUNT]);

    for (const [key, id] of Object.entries(SKYPE_IDS) as [PersonKey, string][]) {
      const rest = id.slice(2);
      ctx.identify(key, rest.startsWith("live:") ? rest : `skype:${rest}`);
    }
  },
};
