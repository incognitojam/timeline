import { importLinkedInData } from "./parser";
import type { SeedContext, SeedDay, SeedSource } from "../../seed/context";
import type { PersonKey } from "../../seed/persona";
import { CAREER, personByKey, SELF } from "../../seed/persona";

const NAME = "linkedin";

/** Persona members Alex is connected with, and where they work. */
const PERSONA_CONNECTIONS: readonly (readonly [PersonKey, string, string])[] = [
  ["jordan", CAREER.employer, "Staff Software Engineer"],
  ["nadia", CAREER.employer, "Engineering Manager"],
  ["hannah", "Pinecrest Software", "Product Designer"],
  ["rowan", "Evergreen Outdoor Co-op", "Operations Lead"],
  ["priya", "Harborview Health Data", "Data Scientist"],
  ["theo", "Cascade Robotics", "Embedded Engineer"],
  ["omar", "Rainier Cloud", "Site Reliability Engineer"],
];

const FIRST_NAMES = [
  "Avery", "Blake", "Casey", "Dana", "Elliot", "Finley", "Gray", "Harper", "Iris", "Jamie", "Kai", "Logan", "Marisol",
  "Nico", "Owen", "Paige", "Quinn", "Reese", "Sasha", "Tariq", "Uma", "Vera", "Wes", "Ximena", "Yusuf", "Zoe",
  "Anika", "Bruno", "Celeste", "Dev", "Esme", "Felix", "Greta", "Hiro", "Ines", "Jonah", "Keiko", "Leon", "Maya",
] as const;

const LAST_NAMES = [
  "Abbott", "Bishop", "Castillo", "Dalton", "Ellison", "Fischer", "Garland", "Holloway", "Ibarra", "Jensen", "Kowalski",
  "Lindqvist", "Mendez", "Nakamura", "Osei", "Prescott", "Quintero", "Rasmussen", "Sorensen", "Thornton", "Underwood",
  "Valdez", "Whitfield", "Yamada", "Zielinski", "Achebe", "Brandt", "Chowdhury", "Delacroix", "Esposito",
] as const;

/** Invented companies. */
const COMPANIES = [
  CAREER.employer,
  CAREER.previousEmployer,
  "Rainier Cloud",
  "Cascade Robotics",
  "Pinecrest Software",
  "Harborview Health Data",
  "Evergreen Outdoor Co-op",
  "Larchwood Games",
  "Tidewater Logistics",
  "Summit Ledger",
  "Orca Bay Media",
  "Foundry Nine",
] as const;

const TITLES = [
  "Software Engineer",
  "Senior Software Engineer",
  "Staff Engineer",
  "Engineering Manager",
  "Product Manager",
  "Data Engineer",
  "Technical Recruiter",
  "Product Designer",
  "DevOps Engineer",
  "Frontend Engineer",
  "Developer Advocate",
  "Director of Engineering",
] as const;

const RECRUITER_PITCHES = [
  "Hi Alex, I came across your profile and think you'd be a great fit for a Senior Backend Engineer role on our data platform team. Open to a quick chat?",
  "Hi Alex! We're growing our infrastructure team in Seattle (hybrid, 2 days in office). Your Go and TypeScript background stood out. Would you be interested in learning more?",
  "Hey Alex, I'm hiring for a Staff Engineer to lead our ingestion pipeline work. Fully remote within the US. Any interest?",
  "Hi Alex, hope you're well! We have a few senior roles opening up next quarter and I'd love to tell you about them.",
] as const;

const ALEX_REPLIES = [
  "Thanks for reaching out! I'm happy where I am for now, but feel free to keep me in mind for the future.",
  "Appreciate the note. Not looking right now, but good luck with the search!",
  "Thanks! Could you share the salary range and team size before we set up a call?",
] as const;

const RECRUITER_FOLLOWUPS = [
  "Totally understand, thanks for getting back to me. I'll keep in touch!",
  "No problem at all. Wishing you the best!",
] as const;

const SALARY_FOLLOWUP = "Of course: the range is $185k-$215k base plus equity, team of eight. Happy to send the full description.";

interface Contact {
  name: string;
  url: string;
}

function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function csv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return [header.join(","), ...rows.map((row) => row.map(csvField).join(","))].join("\n");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** "13 Dec 2025", as in Connections.csv. */
function dayMonthYear(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return `${String(d).padStart(2, "0")} ${MONTHS[m - 1]} ${y}`;
}

/** "Mar 2025", as in Positions.csv. */
function monthYear(date: string): string {
  const [y, m] = date.split("-").map(Number) as [number, number];
  return `${MONTHS[m - 1]} ${y}`;
}

/** "2025-12-15 20:39:35 UTC", as in messages.csv. */
function utcStamp(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

function profileUrl(slug: string): string {
  return `https://www.linkedin.com/in/${slug}`;
}

export const linkedinSeed: SeedSource = {
  name: NAME,
  produces: { linkedin: ["message", "connection", "job", "education"] },
  async seed(ctx: SeedContext) {
    const rng = ctx.rng(NAME);
    const days = ctx.days;
    const dayAt = (daysAgo: number): SeedDay => {
      const day = days[Math.max(0, days.length - 1 - daysAgo)];
      if (!day) throw new Error("linkedin seed has no days");
      return day;
    };
    // Alex moved from Bluefin Labs to Northwind ~20 months before the anchor.
    const switchDay = dayAt(600);

    const alex: Contact = { name: SELF.name, url: profileUrl(SELF.handle) };
    const personaContact = (key: PersonKey): Contact => {
      const person = personByKey(key);
      return { name: person.name, url: profileUrl(person.handle) };
    };

    // Connections.
    const connectionRows: string[][] = [];
    for (const [key, company, title] of PERSONA_CONNECTIONS) {
      const person = personByKey(key);
      const connected = key === "jordan" || key === "nadia" ? dayAt(600 - rng.int(5, 40)) : rng.pick(days);
      connectionRows.push([person.first, person.last, profileUrl(person.handle), "", company, title, dayMonthYear(connected.date)]);
    }
    const strangers: Contact[] = [];
    const usedNames = new Set<string>();
    while (connectionRows.length < 85) {
      const first = rng.pick(FIRST_NAMES);
      const last = rng.pick(LAST_NAMES);
      if (usedNames.has(`${first} ${last}`)) continue;
      usedNames.add(`${first} ${last}`);
      const url = profileUrl(`${first}-${last}-${rng.hex(6)}`.toLowerCase());
      // New colleagues cluster around the job change; the rest trickle in.
      const connected = rng.chance(0.3) ? dayAt(600 - rng.int(0, 90)) : rng.pick(days);
      const company = rng.pick(COMPANIES);
      const title = rng.pick(TITLES);
      strangers.push({ name: `${first} ${last}`, url });
      connectionRows.push([first, last, url, "", company, title, dayMonthYear(connected.date)]);
    }
    const connectionsCsv = [
      "Notes:",
      '"When exporting your connection data, you may notice that some of the email addresses are missing. You will only see email addresses for connections who have allowed their connections to see or download their email address using this setting https://www.linkedin.com/psettings/privacy/email. You can learn more here https://www.linkedin.com/help/linkedin/answer/261"',
      "",
      csv(["First Name", "Last Name", "URL", "Email Address", "Company", "Position", "Connected On"], connectionRows),
    ].join("\n");

    // Messages.
    const messageRows: string[][] = [];
    const thread = (other: Contact, subject: string, startDaysAgo: number, lines: readonly (readonly ["me" | "them", string])[]) => {
      const id = `2-${Buffer.from(rng.hex(24), "hex").toString("base64")}`;
      let day = dayAt(startDaysAgo);
      let hour = rng.int(9, 17);
      lines.forEach(([speaker, content], index) => {
        const iso = ctx.localIso(day.date, hour, rng.int(0, 59), rng.int(0, 59));
        const [from, to] = speaker === "me" ? [alex, other] : [other, alex];
        messageRows.push([id, "", from.name, from.url, to.name, to.url, utcStamp(iso), index === 0 ? subject : "", content, "INBOX"]);
        day = dayAt(Math.max(0, day.daysAgo - rng.int(0, 2)));
        hour = rng.int(8, 21);
      });
    };

    const jordan = personaContact("jordan");
    const nadia = personaContact("nadia");
    const hannah = personaContact("hannah");
    thread(jordan, "Platform squad is hiring", 680, [
      ["them", "Hey Alex! Saw your post about wanting to work on data infrastructure. Northwind's platform squad has an opening, want me to refer you?"],
      ["me", "Jordan! Yes, that would be amazing. What's the team like?"],
      ["them", "Small, about six of us. We own ingest and the query layer. Lots of Go, some TypeScript. Nadia is a great manager."],
      ["me", "Sounds right up my alley. I'll send over my resume tonight."],
      ["them", "Perfect. I'll put the referral in tomorrow morning."],
    ]);
    thread(jordan, "", 615, [
      ["them", "Heard the offer went out 🎉 Hope you say yes"],
      ["me", "Signed this morning! Starting in two weeks. Thanks so much for the referral."],
      ["them", "Welcome aboard! First coffee's on me."],
    ]);
    thread(nadia, "Welcome to Northwind", 598, [
      ["them", "Hi Alex, welcome to the team! Your onboarding buddy is Jordan. Let me know if anything is unclear in the first week."],
      ["me", "Thanks Nadia, excited to get started!"],
    ]);
    thread(nadia, "", 230, [
      ["them", "Congrats on the promotion, well deserved. The ingest rewrite made a huge difference."],
      ["me", "Thank you! Couldn't have done it without the team."],
    ]);
    thread(hannah, "Seattle TypeScript meetup", 420, [
      ["them", "Hi Alex, great talk at the meetup last night! Would you share the slides on incremental parsing?"],
      ["me", "Thanks Hannah! Here you go: https://example.com/slides/incremental-parsing"],
      ["them", "Amazing, thank you. Would you be up for speaking at our design + engineering night in the spring?"],
      ["me", "I'd love to. Send me the details when you have them."],
    ]);
    thread(hannah, "", 120, [
      ["them", "We're running the design + engineering night again on the 14th, want to come along?"],
      ["me", "Count me in!"],
    ]);
    if (strangers.length < 6) throw new Error("linkedin seed needs more stranger connections");
    const [oldColleague, student, ...others] = rng.shuffle(strangers);
    if (!oldColleague || !student) throw new Error("linkedin seed needs more stranger connections");
    thread(oldColleague, "", 590, [
      ["them", "Saw the news about Northwind, congrats! Bluefin won't be the same without you."],
      ["me", "Thanks! I'll miss the team. Let's grab lunch soon."],
      ["them", "Definitely, I'll ping you next month."],
    ]);
    thread(student, "Coffee chat?", 300, [
      ["them", "Hi Alex, I'm a CS student at UW and would love 20 minutes of your time to hear how you got into data infrastructure."],
      ["me", "Happy to! How about a call next Tuesday at noon?"],
      ["them", "That works perfectly, thank you so much!"],
      ["them", "Thanks again for the chat today, the advice about side projects was really helpful."],
    ]);
    for (let daysAgo = 1050; daysAgo > 10; daysAgo -= rng.int(45, 80)) {
      const recruiter = others.pop();
      if (!recruiter) break;
      const lines: ["me" | "them", string][] = [["them", rng.pick(RECRUITER_PITCHES)]];
      if (rng.chance(0.7)) {
        const reply = rng.pick(ALEX_REPLIES);
        lines.push(["me", reply]);
        if (rng.chance(0.6)) lines.push(["them", reply.includes("salary") ? SALARY_FOLLOWUP : rng.pick(RECRUITER_FOLLOWUPS)]);
      }
      thread(recruiter, rng.pick(["Opportunity at a fast-growing startup", "Senior Engineer role", "Quick question", "Exciting role in Seattle"]), daysAgo, lines);
    }
    const messagesCsv = csv(
      ["CONVERSATION ID", "CONVERSATION TITLE", "FROM", "SENDER PROFILE URL", "TO", "RECIPIENT PROFILE URLS", "DATE", "SUBJECT", "CONTENT", "FOLDER"],
      messageRows,
    );

    // Positions and education.
    const switchMonth = monthYear(switchDay.date);
    const beforeSwitch = monthYear(dayAt(630).date);
    const positionsCsv = csv(
      ["Company Name", "Title", "Description", "Location", "Started On", "Finished On"],
      [
        [CAREER.employer, CAREER.title, "Platform squad: event ingestion, query layer, and on-call tooling (Go, TypeScript, Postgres).", "Seattle, Washington, United States", switchMonth, ""],
        [CAREER.previousEmployer, "Software Engineer", "Built the analytics dashboard and its reporting API. Led the migration to managed Postgres.", "Seattle, Washington, United States", "Aug 2016", beforeSwitch],
        ["Pinecrest Software", "Software Engineering Intern", "Internal tooling for the QA team.", "Bellevue, Washington, United States", "Jun 2015", "Sep 2015"],
      ],
    );
    const educationCsv = csv(
      ["School Name", "Start Date", "End Date", "Notes", "Degree Name", "Activities"],
      [[CAREER.school, "Sep 2012", "Jun 2016", "Capstone: real-time trail conditions map", CAREER.degree, "Outdoors club, ACM chapter"]],
    );

    ctx.writeStaged(NAME, "export/messages.csv", messagesCsv);
    ctx.writeStaged(NAME, "export/Connections.csv", connectionsCsv);
    ctx.writeStaged(NAME, "export/Positions.csv", positionsCsv);
    ctx.writeStaged(NAME, "export/Education.csv", educationCsv);
    await ctx.inTransaction(() => importLinkedInData(ctx.db, `${ctx.stage(NAME)}/export`, SELF.handle));

    ctx.identify("alex", `linkedin:name:${SELF.name}`);
    for (const [key] of PERSONA_CONNECTIONS) ctx.identify(key, `linkedin:${personByKey(key).handle}`);
    for (const key of ["jordan", "nadia", "hannah"] as const) ctx.identify(key, `linkedin:name:${personByKey(key).name}`);
  },
};
