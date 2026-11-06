import type { SeedContext, SeedDay, SeedSource } from "../../../seed/context";
import { EVERYONE, type Person, PEOPLE, type PersonKey, personByKey, SELF, VENUES } from "../../../seed/persona";
import type { Rng } from "../../../seed/rng";
import { GOOGLE_ACCOUNT } from "../seed-data/google-data";
import { type LocationPlan, locationPlan } from "../seed-data/location-plan";

interface Attendee {
  name: string;
  email: string;
}

interface CalEvent {
  uid: string;
  summary: string;
  start: Date | string; // Date = timed, string (YYYY-MM-DD) = all-day
  end: Date | string;
  description?: string;
  location?: string;
  organizer?: Attendee;
  attendees?: Attendee[];
  created: Date;
  rrule?: string;
}

/** Coworkers who are not in the persona; they appear only as invitees. */
const COWORKERS: readonly Attendee[] = [
  { name: "Maya Chen", email: "maya.chen@example.com" },
  { name: "Dev Raman", email: "dev.raman@example.com" },
  { name: "Grace Liu", email: "grace.liu@example.com" },
  { name: "Tom Becker", email: "tom.becker@example.com" },
];

const asAttendee = (p: Person): Attendee => ({ name: p.name, email: p.email });

const CLIMBING_GYM = (() => {
  const gym = VENUES.find((v) => v.category === "Climbing Gym");
  if (!gym) throw new Error("persona VENUES has no climbing gym");
  return gym;
})();

const WORK_MEETINGS: readonly { summary: string; minutes: number; description?: string; people: number }[] = [
  { summary: "Sprint planning", minutes: 60, people: 5, description: "Review the board and commit to sprint goals." },
  { summary: "Sprint retro", minutes: 45, people: 5, description: "What went well, what didn't, action items." },
  { summary: "Design review: ingest v2", minutes: 60, people: 4, description: "Doc: Ingest pipeline v2 design. Please leave comments before the meeting." },
  { summary: "Schema registry sync", minutes: 30, people: 3 },
  { summary: "Incident review", minutes: 45, people: 4, description: "Blameless review of last week's delayed batch exports." },
  { summary: "On-call handoff", minutes: 15, people: 2 },
  { summary: "Platform squad demo", minutes: 30, people: 6 },
  { summary: "Interview: backend engineer", minutes: 60, people: 2, description: "Systems design loop. Scorecard in the hiring tool." },
  { summary: "Coffee chat", minutes: 30, people: 1 },
  { summary: "Quarterly planning", minutes: 90, people: 6 },
  { summary: "Pairing: backfill job", minutes: 60, people: 1 },
  { summary: "Architecture forum", minutes: 60, people: 6 },
];

const ERRANDS: readonly { summary: string; location?: string; minutes: number }[] = [
  { summary: "Dentist", location: "Capitol Hill Dental, Seattle, WA", minutes: 60 },
  { summary: "Haircut", location: "Broadway, Seattle, WA", minutes: 45 },
  { summary: "Doctor: annual physical", location: "First Hill, Seattle, WA", minutes: 45 },
  { summary: "Bike service drop-off", location: "Fremont, Seattle, WA", minutes: 30 },
  { summary: "Car registration renewal", minutes: 30 },
  { summary: "Pick up package from locker", minutes: 15 },
];

/**
 * Takeout "Calendar/*.ics": work meetings, social plans, appointments, the
 * hikes and trips from the shared location plan, and a Birthdays calendar.
 */
export const googleCalendarSeed: SeedSource = {
  name: "google-calendar",
  produces: { "google-calendar": ["event", "event:all-day"] },
  async seed(ctx) {
    const kit = makeKit(ctx);
    const plan = locationPlan(ctx);
    addRecurring(kit);
    for (const day of ctx.days) {
      if (!day.isWeekend) addWorkMeetings(kit, day);
      addPersonal(kit, day);
    }
    addFromPlan(kit, plan);
    const birthdays = birthdayEvents(ctx);

    ctx.writeStaged("google-calendar", `${SELF.email}.ics`, toIcs(ctx, kit.events, SELF.name));
    ctx.writeStaged("google-calendar", "Birthdays.ics", toIcs(ctx, birthdays, "Birthdays"));
    await ctx.runParserCli("platforms/google/calendar/parser.ts", [ctx.stage("google-calendar"), GOOGLE_ACCOUNT]);

    // The importer identifies attendees (not organizers) by email, and
    // birthdays by name.
    const byEmail = new Map<string, PersonKey>(EVERYONE.map((p) => [p.email, p.key]));
    const invited = new Set(kit.events.flatMap((e) => (e.attendees ?? []).map((a) => a.email)));
    for (const email of invited) {
      const key = byEmail.get(email);
      if (key) ctx.identify(key, `google-calendar:${email}`);
    }
    for (const person of PEOPLE) {
      if (person.dateOfBirth) ctx.identify(person.key, `google-calendar:name:${person.name}`);
    }
  },
};

interface Kit {
  ctx: SeedContext;
  rng: Rng;
  events: CalEvent[];
  me: Attendee;
  uid(): string;
  createdBefore(at: Date): Date;
  timed(date: string, hour: number, minute: number, minutes: number): { start: Date; end: Date };
  allDay(summary: string, date: string, endDate?: string, description?: string): void;
}

function makeKit(ctx: SeedContext): Kit {
  const rng = ctx.rng("google-calendar");
  const events: CalEvent[] = [];
  const kit: Kit = {
    ctx,
    rng,
    events,
    me: asAttendee(SELF),
    uid: () => `${rng.hex(26)}@google.com`,
    createdBefore: (at) => new Date(at.getTime() - rng.int(1, 21) * 86_400_000 - rng.int(0, 86_399) * 1000),
    timed: (date, hour, minute, minutes) => {
      const start = ctx.localDate(date, hour, minute);
      return { start, end: new Date(start.getTime() + minutes * 60_000) };
    },
    allDay: (summary, date, endDate, description) => {
      events.push({
        uid: kit.uid(),
        summary,
        start: date,
        end: nextDate(endDate ?? date),
        description,
        created: kit.createdBefore(new Date(`${date}T12:00:00Z`)),
      });
    },
  };
  return kit;
}

/** Recurring series as exported: one master VEVENT with an RRULE each. */
function addRecurring(kit: Kit): void {
  const first = kit.ctx.days[0];
  if (!first) throw new Error("Seed range has no days");
  const jordan = asAttendee(personByKey("jordan"));
  const nadia = asAttendee(personByKey("nadia"));
  const recurring: [string, number, number, number, string, Attendee[]][] = [
    ["Platform squad standup", 9, 30, 15, "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", [jordan, nadia, ...COWORKERS.slice(0, 2)]],
    ["1:1 Alex / Jordan", 14, 0, 30, "FREQ=WEEKLY;BYDAY=TU", [jordan]],
    ["Focus time", 13, 0, 120, "FREQ=WEEKLY;BYDAY=WE,TH", []],
  ];
  for (const [summary, h, m, minutes, rrule, people] of recurring) {
    const span = kit.timed(first.date, h, m, minutes);
    kit.events.push({
      uid: kit.uid(),
      summary,
      ...span,
      rrule,
      organizer: people.length > 0 ? jordan : kit.me,
      attendees: people.length > 0 ? [kit.me, ...people] : undefined,
      created: kit.createdBefore(span.start),
    });
  }
}

function addWorkMeetings(kit: Kit, day: SeedDay): void {
  const { rng } = kit;
  const colleagues = [asAttendee(personByKey("jordan")), asAttendee(personByKey("nadia")), ...COWORKERS];
  const meetings = rng.poisson(1.0);
  for (let i = 0; i < meetings; i++) {
    const meeting = rng.pick(WORK_MEETINGS);
    const others = rng.sample(colleagues, meeting.people);
    const organizer = rng.chance(0.4) ? kit.me : rng.pick(others);
    const span = kit.timed(day.date, rng.int(10, 16), rng.pick([0, 0, 30]), meeting.minutes);
    const firstName = others[0]?.name.split(" ")[0] ?? "team";
    kit.events.push({
      uid: kit.uid(),
      summary: meeting.summary === "Coffee chat" ? `Coffee chat: Alex / ${firstName}` : meeting.summary,
      ...span,
      description: meeting.description,
      location: rng.chance(0.6) ? "Northwind Analytics - SLU-4-Rainier (8)" : "https://meet.google.com/abc-defg-hij",
      organizer,
      attendees: [kit.me, ...others],
      created: kit.createdBefore(span.start),
    });
  }
}

function addPersonal(kit: Kit, day: SeedDay): void {
  const { rng } = kit;
  // Weekly call with Mum, Sunday evening.
  if (day.weekday === 0 && rng.chance(0.7)) {
    const span = kit.timed(day.date, 18, 0, 45);
    kit.events.push({ uid: kit.uid(), summary: "Call Mum", ...span, created: kit.createdBefore(span.start) });
  }

  // Game night with the Discord crew.
  if ((day.weekday === 5 || day.weekday === 3) && rng.chance(0.18)) {
    const crew = (["theo", "omar", "sam", "jordan"] as const).map((k) => asAttendee(personByKey(k)));
    const span = kit.timed(day.date, 19, 30, 180);
    kit.events.push({
      uid: kit.uid(),
      summary: rng.pick(["Game night", "Game night 🎲", "Minecraft night on Theo's server", "Board games at Sam's"]),
      ...span,
      description: rng.pick(["Bring snacks!", "Discord voice, usual channel.", "Wingspan + Catan if we have time.", ""]),
      organizer: asAttendee(personByKey("theo")),
      attendees: [kit.me, ...rng.sample(crew, rng.int(2, 4))],
      created: kit.createdBefore(span.start),
    });
  }

  // Climbing with Priya.
  if ((day.weekday === 2 || day.weekday === 4) && rng.chance(0.07)) {
    const span = kit.timed(day.date, 18, 30, 120);
    kit.events.push({
      uid: kit.uid(),
      summary: "Climbing w/ Priya",
      ...span,
      location: `${CLIMBING_GYM.name}, ${CLIMBING_GYM.address}`,
      organizer: kit.me,
      attendees: [kit.me, asAttendee(personByKey("priya"))],
      created: kit.createdBefore(span.start),
    });
  }

  if (rng.chance(0.035)) {
    const errand = rng.pick(ERRANDS);
    const hour = day.isWeekend ? rng.int(10, 15) : rng.pick([8, 12, 17]);
    const span = kit.timed(day.date, hour, rng.pick([0, 15, 30, 45]), errand.minutes);
    kit.events.push({ uid: kit.uid(), summary: errand.summary, ...span, location: errand.location, created: kit.createdBefore(span.start) });
  }

  if (day.date.endsWith("-01")) kit.allDay("Rent due", day.date);
  if (day.date.endsWith("-04-15")) kit.allDay("Tax day", day.date);
}

/** Hikes and trips from the shared location plan. */
function addFromPlan(kit: Kit, plan: LocationPlan): void {
  const { rng } = kit;
  for (const hike of plan.hikes) {
    const trail = hike.trailhead.name.replace(/ Trailhead$/, "");
    kit.events.push({
      uid: kit.uid(),
      summary: `Hike: ${trail}`,
      start: new Date(hike.start.getTime() - 75 * 60_000),
      end: new Date(hike.end.getTime() + 60 * 60_000),
      description: rng.pick([
        "Meet at Alex's at 7. Rowan's bringing sandwiches.",
        "Check WTA trip reports the night before. Microspikes if it's icy.",
        "Carpool from Capitol Hill. Discover Pass is in the glovebox.",
        "Ten essentials! Weather looks dry.",
      ]),
      location: hike.trailhead.address,
      organizer: asAttendee(personByKey("rowan")),
      attendees: [kit.me, ...hike.companions.map((k) => asAttendee(personByKey(k)))],
      created: kit.createdBefore(hike.start),
    });
  }
  for (const trip of plan.trips) {
    if (trip.destination === "Portland") {
      kit.allDay("Portland: visiting Mei", trip.startDate, trip.endDate, "Drive down Friday morning, back Sunday afternoon.");
    } else {
      kit.allDay("San Francisco trip", trip.startDate, trip.endDate, "Alaska flight from SEA. Hotel near Union Square.");
    }
  }
}

/** Birthdays calendar, auto-generated from contacts: no description or attendees. */
function birthdayEvents(ctx: SeedContext): CalEvent[] {
  const out: CalEvent[] = [];
  for (const person of PEOPLE) {
    const md = person.dateOfBirth?.slice(5);
    if (!md) continue;
    for (const day of ctx.days) {
      if (day.date.slice(5) !== md) continue;
      out.push({
        uid: `BIRTHDAY_${person.numericId}_${day.date.slice(0, 4)}@google.com`,
        summary: `${person.name}'s birthday`,
        start: day.date,
        end: nextDate(day.date),
        created: new Date(`${ctx.startDate}T00:00:00Z`),
      });
    }
  }
  return out;
}

function nextDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function icsUtc(at: Date): string {
  return `${at.toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;
}

function escapeText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

/** Fold a content line every 74 code points, per RFC 5545 (never splitting a surrogate pair). */
function fold(line: string): string {
  const chars = Array.from(line);
  const parts: string[] = [];
  for (let i = 0; i < chars.length; i += 74) parts.push(chars.slice(i, i + 74).join(""));
  return parts.join("\r\n ");
}

function toIcs(ctx: SeedContext, events: readonly CalEvent[], calName: string): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(calName)}`,
    `X-WR-TIMEZONE:America/Los_Angeles`,
  ];
  const stamp = icsUtc(ctx.localDate(ctx.anchorDate, 12));
  for (const e of events) {
    lines.push("BEGIN:VEVENT");
    if (typeof e.start === "string" && typeof e.end === "string") {
      lines.push(`DTSTART;VALUE=DATE:${e.start.replace(/-/g, "")}`, `DTEND;VALUE=DATE:${e.end.replace(/-/g, "")}`);
    } else if (e.start instanceof Date && e.end instanceof Date) {
      lines.push(`DTSTART:${icsUtc(e.start)}`, `DTEND:${icsUtc(e.end)}`);
    }
    if (e.rrule) lines.push(`RRULE:${e.rrule}`);
    lines.push(`DTSTAMP:${stamp}`);
    if (e.organizer) lines.push(`ORGANIZER;CN=${e.organizer.name}:mailto:${e.organizer.email}`);
    lines.push(`UID:${e.uid}`);
    for (const a of e.attendees ?? []) {
      lines.push(
        `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=${a.name};X-NUM-GUESTS=0:mailto:${a.email}`,
      );
    }
    lines.push(`CREATED:${icsUtc(e.created)}`);
    lines.push(`DESCRIPTION:${escapeText(e.description ?? "")}`);
    lines.push(`LAST-MODIFIED:${icsUtc(e.created)}`);
    lines.push(`LOCATION:${escapeText(e.location ?? "")}`);
    lines.push("SEQUENCE:0", "STATUS:CONFIRMED", `SUMMARY:${escapeText(e.summary)}`, "TRANSP:OPAQUE", "END:VEVENT");
  }
  lines.push("END:VCALENDAR", "");
  return lines.map(fold).join("\r\n");
}
