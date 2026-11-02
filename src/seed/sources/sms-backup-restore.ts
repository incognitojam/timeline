import { importCalls, importMms, importSms } from "../../parsers/sms-backup-restore";
import type { SeedContext, SeedDay, SeedSource } from "../context";
import type { Person, PersonKey } from "../persona";
import { PEOPLE, peopleOn, personByKey, SELF, TIME_ZONE } from "../persona";
import type { Rng } from "../rng";
import { type ChatLine, chatSession, chatStart, GOOGLE_MESSAGES_DAYS, type Topic } from "./messaging-b-data";

const NAME = "sms-backup-restore";

const TOPICS: Partial<Record<PersonKey, readonly Topic[]>> = {
  rowan: ["hike", "friend"],
  sam: ["friend", "gaming"],
  mei: ["sister"],
  linda: ["mum"],
  luis: ["friend", "music"],
};

/** Phone contacts Alex calls (a superset of the people they text here). */
const CALL_WEIGHTS: readonly (readonly [PersonKey, number])[] = [
  ["linda", 8],
  ["mei", 5],
  ["rowan", 4],
  ["sam", 2],
  ["priya", 2],
  ["omar", 1],
  ["luis", 1],
];

/** Automated texts from numbers that aren't contacts. */
const SERVICES = [
  { number: "+12025550190", lines: ["Driftwood Coffee: your order is ready for pickup", "Driftwood Coffee: you've earned a free drink! Show this text at the counter"] },
  { number: "+12025550191", lines: ["Capitol Hill Dental: reminder of your appointment on {date} at 9:30 AM. Reply C to confirm", "Capitol Hill Dental: thanks for visiting! Your next cleaning is due in 6 months"] },
  { number: "+12025550192", lines: ["Your verification code is {code}. Don't share it with anyone.", "{code} is your login code. It expires in 10 minutes."] },
  { number: "+12025550193", lines: ["Greenline Grocery: your delivery is on its way, arriving 6-7pm", "Greenline Grocery: your order has been delivered. Enjoy!"] },
  { number: "+12025550194", lines: ["Northwind Pharmacy: your prescription is ready for pickup", "Seattle City Light: a scheduled outage may affect your area on {date} 9am-1pm"] },
] as const;

const MMS_CAPTIONS = [
  "view from the top!",
  "look who I ran into",
  "new plant baby 🌱",
  "the sunset tonight",
  "found this at the market",
  "",
  "dinner",
  "trail was so muddy",
] as const;

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const readableFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  hour12: true,
});

/** SMS Backup & Restore's `readable_date`, e.g. "Mar 4, 2024 7:12:03 PM". */
function readableDate(at: Date): string {
  return readableFormatter.format(at).replace(" at ", " ").replace(/,(?=\s\d+:)/, "");
}

function attrs(values: Record<string, string | number>): string {
  return Object.entries(values)
    .map(([key, value]) => `${key}="${escapeXml(String(value))}"`)
    .join(" ");
}

function smsTag(line: ChatLine, counterparty: Person, rng: Rng): string {
  const sent = line.from === "alex";
  const ms = line.at.getTime();
  return `  <sms ${attrs({
    protocol: 0,
    address: counterparty.phone,
    date: ms,
    type: sent ? 2 : 1,
    subject: "null",
    body: line.text,
    toa: "null",
    sc_toa: "null",
    service_center: sent ? "null" : "+12025550199",
    read: 1,
    status: -1,
    locked: 0,
    date_sent: sent ? 0 : ms - rng.int(1, 9) * 1000,
    sub_id: 1,
    readable_date: readableDate(line.at),
    contact_name: counterparty.name,
  })} />`;
}

async function mmsBlock(
  ctx: SeedContext,
  rng: Rng,
  id: number,
  at: Date,
  counterparty: Person,
  sent: boolean,
  variant: number,
): Promise<string> {
  const ms = at.getTime();
  const image = await ctx.image({ width: 480, height: 360, hue: rng.int(0, 359), variant });
  const caption = rng.pick(MMS_CAPTIONS);
  const fileName = `IMG_${String(20000 + id)}.jpg`;
  const parts = [
    `      <part ${attrs({ seq: 0, ct: "image/jpeg", name: fileName, chset: "null", cd: "null", fn: "null", cid: `<${fileName}>`, cl: fileName, ctt_s: "null", ctt_t: "null" })} data="${image.toString("base64")}" />`,
  ];
  if (caption) {
    parts.push(
      `      <part ${attrs({ seq: 0, ct: "text/plain", name: "null", chset: 106, cd: "null", fn: "null", cid: "<text_0.txt>", cl: "text_0.txt", ctt_s: "null", ctt_t: "null", text: caption })} />`,
    );
  }
  const header = attrs({
    _id: id,
    date: ms,
    rr: "null",
    sub: "null",
    ct_t: "application/vnd.wap.multipart.related",
    read_status: "null",
    seen: 1,
    msg_box: sent ? 2 : 1,
    address: counterparty.phone,
    sub_cs: "null",
    resp_st: "null",
    retr_st: "null",
    d_tm: "null",
    text_only: 0,
    exp: "null",
    locked: 0,
    m_id: `mms${rng.hex(16)}`,
    st: "null",
    retr_txt_cs: "null",
    retr_txt: "null",
    creator: sent ? "com.google.android.apps.messaging" : "null",
    date_sent: Math.floor(ms / 1000),
    read: 1,
    m_size: image.length,
    rpt_a: "null",
    ct_cls: "null",
    pri: 129,
    sub_id: 1,
    tr_id: `T${rng.hex(12)}`,
    resp_txt: "null",
    ct_l: "null",
    m_cls: "personal",
    d_rpt: 129,
    v: 18,
    m_type: sent ? 128 : 132,
    readable_date: readableDate(at),
    contact_name: counterparty.name,
  });
  const from = sent ? SELF.phone : counterparty.phone;
  const to = sent ? counterparty.phone : SELF.phone;
  return [
    `  <mms ${header}>`,
    "    <parts>",
    ...parts,
    "    </parts>",
    "    <addrs>",
    `      <addr address="${from}" type="137" charset="106" />`,
    `      <addr address="${to}" type="151" charset="106" />`,
    "    </addrs>",
    "  </mms>",
  ].join("\n");
}

function serviceTag(ctx: SeedContext, rng: Rng, day: SeedDay): string {
  const service = rng.pick(SERVICES);
  const at = ctx.localDate(day.date, rng.int(8, 19), rng.int(0, 59), rng.int(0, 59));
  const body = rng
    .pick(service.lines)
    .replace("{code}", rng.digits(6))
    .replace("{date}", readableDate(new Date(at.getTime() + rng.int(2, 10) * 86_400_000)).split(" ").slice(0, 3).join(" ").replace(/,$/, ""));
  return `  <sms ${attrs({
    protocol: 0,
    address: service.number,
    date: at.getTime(),
    type: 1,
    subject: "null",
    body,
    toa: "null",
    sc_toa: "null",
    service_center: "+12025550199",
    read: 1,
    status: -1,
    locked: 0,
    date_sent: at.getTime() - 2000,
    sub_id: 1,
    readable_date: readableDate(at),
    contact_name: "(Unknown)",
  })} />`;
}

function callTag(ctx: SeedContext, rng: Rng, day: SeedDay): string {
  const key = rng.weighted(CALL_WEIGHTS);
  const person = personByKey(key);
  const type = rng.weighted([
    [1, 40],
    [2, 45],
    [3, 15],
  ] as const);
  // Long Sunday calls with mum; quick logistics calls otherwise.
  const seconds =
    type === 3 ? 0 : key === "linda" && day.weekday === 0 ? rng.int(900, 3600) : Math.round(Math.exp(rng.normal(4.6, 0.9)));
  const { hour, minute } = chatStart(rng, day);
  const at = ctx.localDate(day.date, hour, minute, rng.int(0, 59));
  return `  <call ${attrs({
    number: person.phone,
    duration: seconds,
    date: at.getTime(),
    type,
    presentation: 1,
    subscription_id: 1,
    post_dial_digits: "",
    subscription_component_name: "com.android.phone/com.android.services.telephony.TelephonyConnectionService",
    readable_date: readableDate(at),
    contact_name: person.name,
  })} />`;
}

export const smsBackupRestoreSeed: SeedSource = {
  name: NAME,
  produces: {
    phone: ["sms:sent", "sms:received", "mms:sent", "mms:received", "call:incoming", "call:outgoing", "call:missed"],
  },
  async seed(ctx: SeedContext) {
    const rng = ctx.rng(NAME);
    const textDays = ctx.days.slice(0, Math.max(0, ctx.days.length - GOOGLE_MESSAGES_DAYS));
    const contacts = peopleOn("sms");
    const smsTags: string[] = [];
    const mmsBlocks: string[] = [];

    for (const day of textDays) {
      for (const person of contacts) {
        const topics = TOPICS[person.key];
        if (!topics) throw new Error(`SMS contact ${person.key} has no topics`);
        if (rng.chance(0.04 * person.closeness)) {
          for (const line of chatSession(ctx, rng, day, topics, person.key)) smsTags.push(smsTag(line, person, rng));
        }
        if (rng.chance(0.0025 * person.closeness)) {
          const { hour, minute } = chatStart(rng, day);
          const at = ctx.localDate(day.date, hour, minute, rng.int(0, 59));
          mmsBlocks.push(await mmsBlock(ctx, rng, mmsBlocks.length + 1, at, person, rng.chance(0.5), mmsBlocks.length));
        }
      }
      if (rng.chance(0.2)) smsTags.push(serviceTag(ctx, rng, day));
    }

    const callTags: string[] = [];
    for (const day of ctx.days) {
      for (let n = rng.poisson(day.isWeekend ? 0.38 : 0.24); n > 0; n--) callTags.push(callTag(ctx, rng, day));
    }

    const lastDay = textDays.at(-1) ?? ctx.days[0];
    if (!lastDay) throw new Error("sms-backup-restore needs at least one day");
    const backupDate = ctx.localDate(lastDay.date, 23, 0).getTime();
    const header = "<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>";
    const smsXml = [
      header,
      `<smses count="${smsTags.length + mmsBlocks.length}" backup_set="${rng.uuid()}" backup_date="${backupDate}" type="full">`,
      ...smsTags,
      ...mmsBlocks,
      "</smses>",
      "",
    ].join("\n");
    const callsXml = [
      header,
      `<calls count="${callTags.length}" backup_set="${rng.uuid()}" backup_date="${ctx.localDate(ctx.anchorDate, 3, 0).getTime()}" type="full">`,
      ...callTags,
      "</calls>",
      "",
    ].join("\n");

    const smsPath = ctx.writeStaged(NAME, "sms.xml", smsXml);
    const callsPath = ctx.writeStaged(NAME, "calls.xml", callsXml);
    const options = { silent: true };
    await importSms(ctx.db, smsPath, SELF.phone, options);
    await importMms(ctx.db, smsPath, SELF.phone, options);
    await importCalls(ctx.db, callsPath, SELF.phone, options);

    // The owner's number is never upserted by this importer (only counterparties).
    const counterparties = new Set<PersonKey>([...contacts.map((p) => p.key), ...CALL_WEIGHTS.map(([key]) => key)]);
    for (const person of PEOPLE) {
      if (counterparties.has(person.key)) ctx.identify(person.key, `phone:${person.phone}`);
    }
  },
};
