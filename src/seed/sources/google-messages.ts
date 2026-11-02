import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  EVENT_SOURCE,
  type GmConversation,
  type GmMedia,
  type GmMessage,
  type GmParticipant,
  type GmRecord,
  importGoogleMessages,
} from "../../platforms/google-messages/parser";
import type { SeedContext, SeedDay, SeedSource } from "../context";
import type { Person, PersonKey } from "../persona";
import { GROUP_CHATS, peopleOn, personByKey, SELF } from "../persona";
import { type ChatLine, chatSession, chatStart, GOOGLE_MESSAGES_DAYS, type Topic } from "./messaging-b-data";

const NAME = "google-messages";

const TOPICS: Partial<Record<PersonKey, readonly Topic[]>> = {
  rowan: ["hike", "friend"],
  priya: ["friend", "music", "hike"],
  mei: ["sister"],
  linda: ["mum"],
  omar: ["friend", "gaming"],
};

/** Linda's phone doesn't do RCS, so her thread stays SMS/MMS. */
const SMS_ONLY: ReadonlySet<PersonKey> = new Set(["linda"]);

const SERVICES = [
  { number: "+12025550192", lines: ["Your verification code is {code}. Don't share it with anyone.", "{code} is your sign-in code"] },
  { number: "+12025550195", lines: ["Lakeview Noodle House: your table for 2 is ready!", "Lakeview Noodle House: thanks for joining the waitlist, you're #3"] },
  { number: "+12025550196", lines: ["Your package was delivered to the front desk.", "Your package is out for delivery today."] },
] as const;

const PHOTO_CAPTIONS = ["", "", "look!", "today's view", "this is the one", "found it", "🌲🌲🌲", "you had to be there"] as const;

interface Thread {
  conversation: GmConversation;
  messages: GmMessage[];
  /** Participant id per persona key. */
  ids: Map<PersonKey, string>;
}

function participant(id: string, person: Person, isMe: boolean): GmParticipant {
  return { participant_id: id, number: person.phone, name: isMe ? undefined : person.name, is_me: isMe, visible: true };
}

/** Sunday brunch lives up to its name. */
function groupChance(day: SeedDay): number {
  if (day.weekday === 0) return 0.75;
  return day.weekday === 6 ? 0.45 : 0.07;
}

/** The sidecar's dump order: each conversation, its messages, then its completion marker; contacts last. */
function toRecords(threads: readonly Thread[], contacts: readonly Person[]): GmRecord[] {
  const records: GmRecord[] = [];
  for (const t of threads) {
    t.messages.sort((a, b) => a.timestamp_ms - b.timestamp_ms);
    const last = t.messages.at(-1);
    records.push({ ...t.conversation, ...(last ? { last_message_ts_ms: last.timestamp_ms } : {}) });
    records.push(...t.messages);
    records.push({ kind: "conversation_done", id: t.conversation.id, messages: t.messages.length });
  }
  for (const person of contacts) {
    records.push({ kind: "contact", participant_id: `c${person.numericId}`, contact_id: person.numericId, name: person.name, number: person.phone });
  }
  return records;
}

export const googleMessagesSeed: SeedSource = {
  name: NAME,
  produces: {
    [EVENT_SOURCE]: ["sms:sent", "sms:received", "mms:sent", "mms:received", "rcs:sent", "rcs:received"],
  },
  async seed(ctx: SeedContext) {
    const rng = ctx.rng(NAME);
    const days = ctx.recentDays(GOOGLE_MESSAGES_DAYS);
    const mediaDir = ctx.stage(`${NAME}-media`);
    let nextConversation = 101;
    let nextMessage = 50_001;
    let nextParticipant = 2;
    let mediaCount = 0;
    const threads: Thread[] = [];

    const thread = (members: readonly Person[], options: { name?: string; rcs: boolean }): Thread => {
      const id = String(nextConversation++);
      const ids = new Map<PersonKey, string>([["alex", "1"]]);
      const participants = [participant("1", SELF, true)];
      for (const person of members) {
        const pid = String(nextParticipant++);
        ids.set(person.key, pid);
        participants.push(participant(pid, person, false));
      }
      const conversation: GmConversation = {
        kind: "conversation",
        id,
        ...(options.name ? { name: options.name } : {}),
        folder: "INBOX",
        is_group: members.length > 1,
        type: options.rcs ? "RCS" : "SMS",
        participants,
      };
      const created: Thread = { conversation, messages: [], ids };
      threads.push(created);
      return created;
    };

    const push = (t: Thread, at: Date, from: PersonKey, fields: Partial<GmMessage>): void => {
      const outgoing = from === "alex";
      t.messages.push({
        kind: "message",
        id: String(nextMessage++),
        conversation_id: t.conversation.id,
        timestamp_ms: at.getTime(),
        direction: outgoing ? "outgoing" : "incoming",
        message_type: t.conversation.type === "RCS" ? "rcs" : "sms",
        status: outgoing ? (t.conversation.type === "RCS" ? "OUTGOING_DISPLAYED" : "OUTGOING_COMPLETE") : "INCOMING_COMPLETE",
        ...(outgoing ? {} : { sender_participant_id: t.ids.get(from), sender_number: personByKey(from).phone }),
        ...fields,
      });
    };

    const pushLines = (t: Thread, lines: ChatLine[]): void => {
      for (const line of lines) push(t, line.at, line.from, { text: line.text });
    };

    const pushPhoto = async (t: Thread, day: SeedDay, from: PersonKey): Promise<void> => {
      const { hour, minute } = chatStart(rng, day);
      const at = ctx.localDate(day.date, hour, minute, rng.int(0, 59));
      const landscape = rng.chance(0.7);
      const [width, height] = landscape ? [640, 480] : [480, 640];
      const image = await ctx.image({ width, height, hue: rng.int(0, 359), variant: mediaCount });
      const mediaId = `MediaId_${rng.hex(24)}`;
      const fileName = `PXL_${day.date.replaceAll("-", "")}_${rng.digits(9)}.jpg`;
      const path = `${mediaId}.jpg`;
      writeFileSync(join(mediaDir, path), image);
      mediaCount++;
      const media: GmMedia = {
        media_id: mediaId,
        name: fileName,
        mime_type: "image/jpeg",
        format: "jpeg",
        size: image.length,
        width,
        height,
        status: "stored",
        path,
      };
      const caption = rng.pick(PHOTO_CAPTIONS);
      push(t, at, from, {
        ...(t.conversation.type === "RCS" ? {} : { message_type: "mms" }),
        ...(caption ? { text: caption } : {}),
        media: [media],
      });
    };

    const tombstone = (t: Thread, text: string): void => {
      const first = days[0];
      if (!first) throw new Error("google-messages needs at least one day");
      push(t, ctx.localDate(first.date, 0, 5), "alex", { direction: "system", text });
    };

    // One-to-one threads.
    const contacts = peopleOn("google-messages");
    const direct = new Map<PersonKey, Thread>();
    for (const person of contacts) {
      const rcs = !SMS_ONLY.has(person.key);
      const t = thread([person], { rcs });
      tombstone(t, rcs ? `Chatting with ${person.name} (RCS)` : `Texting with ${person.name} (SMS/MMS)`);
      direct.set(person.key, t);
    }

    // The group chat.
    const groupSpec = GROUP_CHATS["google-messages"]?.[0];
    if (!groupSpec) throw new Error("persona has no google-messages group chat");
    const groupMembers = groupSpec.members.map(personByKey);
    const group = thread(groupMembers, { name: groupSpec.name, rcs: true });
    tombstone(group, `${groupSpec.name} was created`);

    const services = SERVICES.map((service) => {
      const t: Thread = thread([], { rcs: false });
      t.conversation.participants.push({ participant_id: String(nextParticipant), number: service.number, is_me: false, visible: true });
      return { service, thread: t, pid: String(nextParticipant++) };
    });

    for (const day of days) {
      // A little busier in the most recent months.
      const recency = 0.85 + 0.3 * (1 - day.daysAgo / GOOGLE_MESSAGES_DAYS);
      for (const person of contacts) {
        const t = direct.get(person.key);
        const topics = TOPICS[person.key];
        if (!t || !topics) throw new Error(`Google Messages contact ${person.key} has no thread/topics`);
        if (rng.chance(0.04 * person.closeness * recency)) pushLines(t, chatSession(ctx, rng, day, topics, person.key));
        // Mum sends (and gets) photos as MMS rather than texting about them.
        const photoChance = SMS_ONLY.has(person.key) ? 0.02 : 0.0012 * person.closeness;
        if (rng.chance(photoChance)) await pushPhoto(t, day, rng.chance(0.5) ? "alex" : person.key);
      }

      if (rng.chance(groupChance(day))) {
        const them = rng.pick(groupSpec.members);
        const others = groupSpec.members.filter((key) => key !== them);
        pushLines(group, chatSession(ctx, rng, day, ["brunch"], them, others));
        if (day.weekday === 0 && rng.chance(0.08)) await pushPhoto(group, day, rng.pick(["alex", ...groupSpec.members]));
      }

      if (rng.chance(0.1)) {
        const { service, thread: t, pid } = rng.pick(services);
        const at = ctx.localDate(day.date, rng.int(8, 20), rng.int(0, 59), rng.int(0, 59));
        t.messages.push({
          kind: "message",
          id: String(nextMessage++),
          conversation_id: t.conversation.id,
          timestamp_ms: at.getTime(),
          direction: "incoming",
          message_type: "sms",
          status: "INCOMING_COMPLETE",
          sender_participant_id: pid,
          sender_number: service.number,
          text: rng.pick(service.lines).replace("{code}", rng.digits(6)),
        });
      }
    }

    const records = toRecords(threads, contacts);
    const lines = records.map((record) => JSON.stringify(record));
    ctx.writeStaged(NAME, "dump.jsonl", `${lines.join("\n")}\n`);
    await ctx.inTransaction(() =>
      importGoogleMessages(ctx.db, lines, {
        sourceAccount: SELF.phone,
        importBatch: `${EVENT_SOURCE}-${SELF.phone}-seed`,
        mediaDir,
      }),
    );

    ctx.identify("alex", `phone:${SELF.phone}`);
    for (const person of [...contacts, ...groupMembers]) ctx.identify(person.key, `phone:${person.phone}`);
  },
};
