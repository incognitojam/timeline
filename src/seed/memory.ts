import type { Database } from "bun:sqlite";
import { deleteMemoryNote, saveMemoryNote, setProjectUsesAccountMemory } from "../db/memory-notes";
import type { MemoryKind } from "../shared/memory";
import type { SeedContext } from "./context";
import { CAREER, personByKey, type PersonKey } from "./persona";

interface SeedNote {
  project?: string;
  name: string;
  kind: MemoryKind;
  title: string;
  summary: string;
  details: string;
  /** Links the note to this person's seeded contact. */
  contact?: PersonKey;
}

const NOTES: readonly SeedNote[] = [
  {
    name: "writing-style",
    kind: "you",
    title: "Writing style",
    summary: "Short sentences",
    details: "- Lead with the answer.",
  },
  {
    name: "working-hours",
    kind: "you",
    title: "Working hours",
    summary: "Pacific time, focus mornings, no meetings before 10",
    details: "Alex blocks 9–12 for deep work. Weekends are for hiking ([[hiking-gear]]), usually with [[rowan]].",
  },
  {
    name: "hiking-gear",
    kind: "topic",
    title: "Hiking gear",
    summary: "Trusted pack list for day hikes in the Cascades",
    details: "## Pack list\n\n- Trail runners, not boots\n- Two litres of water and a filter\n- Microspikes from November\n\nShared trips are planned with [[rowan]]. See also [[sourdough]] for trail snacks.",
  },
  {
    name: "learning-rust",
    kind: "topic",
    title: "Learning Rust",
    summary: "Working through ownership by building a budgeting CLI",
    details: "Prefers explanations that compare with TypeScript. Stuck points so far: lifetimes in iterators.",
  },
  {
    name: "work",
    kind: "area",
    title: `Work at ${CAREER.employer}`,
    summary: `${CAREER.title} on the platform squad`,
    details: "Owns the ingest service with [[jordan]]. Code review happens in the afternoon.",
  },
  {
    name: "health",
    kind: "area",
    title: "Health and running",
    summary: "Training for a half marathon alongside Mei",
    details: "Runs Tuesday, Thursday and Saturday. Tracks sleep with a Fitbit. Training plan shared with [[mei]].",
  },
  {
    name: "rowan",
    kind: "person",
    title: "Rowan Hale",
    summary: "Climbing partner who organises the hiking group",
    details: "- Prefers early starts for hikes\n- Allergic to peanuts",
    contact: "rowan",
  },
  {
    name: "jordan",
    kind: "person",
    title: "Jordan Lee",
    summary: "Teammate who runs the ingest on-call rota",
    details: "Likes design docs before code. Based in the same office.",
    contact: "jordan",
  },
  {
    name: "mei",
    kind: "person",
    title: "Mei Rivera",
    summary: "Younger sister in Portland",
    details: "Moved to Portland in spring. Sunday brunch group with [[rowan]].",
    contact: "mei",
  },
  {
    project: "trailhead",
    name: "overview",
    kind: "project",
    title: "Trailhead",
    summary: "Hiking trip planner in TypeScript",
    details: "Plans day hikes from saved routes. Data model in [[route-data]]; releases in [[deploys]]. Gear defaults come from [[hiking-gear]].",
  },
  {
    project: "trailhead",
    name: "route-data",
    kind: "topic",
    title: "Route data",
    summary: "Routes are GPX files cached in SQLite",
    details: "Elevation is resampled every 25 m. Never commit real GPX files; use the fixtures.",
  },
  {
    project: "trailhead",
    name: "deploys",
    kind: "area",
    title: "Deploys",
    summary: "Tags on main deploy to the staging site first",
    details: "Run the e2e suite before tagging. Rollbacks go back to the previous tag; see [[overview]].",
  },
  {
    project: "northwind-ingest",
    name: "overview",
    kind: "project",
    title: "Northwind ingest",
    summary: "Work data pipeline in Go",
    details: "A work repository: keep personal notes out of it. On-call questions go to [[jordan]].",
  },
];

/** More account notes and projects, so the Memory page is long enough to scroll. */
const EXTRA_ACCOUNT_NOTES: readonly SeedNote[] = [
  { name: "coffee-order", kind: "you", title: "Coffee order", summary: "Flat white, oat milk, no sugar", details: "Switches to decaf after 2pm." },
  { name: "travel-preferences", kind: "you", title: "Travel preferences", summary: "Window seat, carry-on only, trains over short flights", details: "- Prefers arriving the night before\n- Books refundable fares" },
  { name: "tooling", kind: "you", title: "Editor and tooling", summary: "Neovim, tmux, fish shell", details: "Explain shell snippets for fish, not bash, unless it's a script." },
  { name: "dietary", kind: "you", title: "Dietary notes", summary: "Vegetarian on weekdays", details: "Fish at weekends is fine." },
  { name: "baking", kind: "topic", title: "Baking", summary: "Bakes bread on Sundays from a rye starter", details: "Overnight cold retard in the fridge." },
  { name: "home-network", kind: "topic", title: "Home network", summary: "Mesh Wi-Fi with a separate IoT VLAN", details: "The printer lives on the IoT network." },
  { name: "film-photography", kind: "topic", title: "Film photography", summary: "Shoots Portra 400 on a 35mm rangefinder", details: "Develops colour at the lab, black and white at home." },
  { name: "spanish", kind: "topic", title: "Learning Spanish", summary: "Thirty minutes a day, aiming for B1", details: "Conversation practice with a tutor on Wednesdays." },
  { name: "board-games", kind: "topic", title: "Board games", summary: "Hosts a monthly game night", details: "Favourites: co-op games and short worker placement." },
  { name: "home", kind: "area", title: "Home", summary: "One-bedroom apartment, renting", details: "Lease renews in the spring. Landlord prefers email." },
  { name: "finances", kind: "area", title: "Finances", summary: "Budgets monthly in a spreadsheet", details: "Building the Rust CLI from [[learning-rust]] to replace it." },
  { name: "volunteering", kind: "area", title: "Volunteering", summary: "Trail maintenance one Saturday a month", details: "Organised through the hiking group with [[rowan]]." },
];

const EXTRA_PROJECTS: ReadonlyArray<{ key: string; title: string; summary: string; notes: number }> = [
  { key: "budget-cli", title: "Budget CLI", summary: "A Rust command-line budgeting tool", notes: 3 },
  { key: "dotfiles", title: "Dotfiles", summary: "Shell, editor and terminal configuration", notes: 2 },
  { key: "recipe-box", title: "Recipe box", summary: "A small web app for family recipes", notes: 4 },
  { key: "photo-archive", title: "Photo archive", summary: "Scripts that file scanned negatives by date", notes: 2 },
  { key: "garden-sensors", title: "Garden sensors", summary: "Soil moisture sensors on a microcontroller", notes: 3 },
  { key: "blog", title: "Blog", summary: "A static site about hikes and baking", notes: 1 },
];

const EXTRA_TOPICS = [
  { name: "conventions", title: "Conventions", summary: "Formatting and naming rules for this repository" },
  { name: "testing", title: "Testing", summary: "How tests are run and what they cover" },
  { name: "release", title: "Releases", summary: "How a version is tagged and published" },
];

const EXTRA_PROJECT_NOTES: readonly SeedNote[] = EXTRA_PROJECTS.flatMap((project) => [
  { project: project.key, name: "overview", kind: "project" as const, title: project.title, summary: project.summary, details: `${project.summary}.` },
  ...EXTRA_TOPICS.slice(0, project.notes - 1).map((topic) => ({
    project: project.key,
    name: topic.name,
    kind: "topic" as const,
    title: topic.title,
    summary: topic.summary,
    details: `${topic.summary} in ${project.title}.`,
  })),
]);

/**
 * Alex's shared agent memory: notes of every kind, a project with an overview
 * and two notes, links between notes (one to a note never written), a note
 * with previous versions, a deleted note, and a project with account memory off.
 */
export function seedMemory(ctx: SeedContext, db: Database): void {
  const contactId = ctx.db.prepare("SELECT id FROM contacts WHERE display_name = ?");
  for (const note of [...NOTES, ...EXTRA_ACCOUNT_NOTES, ...EXTRA_PROJECT_NOTES]) {
    // A contact exists only when the person's sources were seeded (see --only).
    const contact = note.contact ? (contactId.get(personByKey(note.contact).name) as { id: number } | null) : null;
    saveMemoryNote(db, {
      project: note.project ?? "",
      name: note.name,
      kind: note.kind,
      title: note.title,
      summary: note.summary,
      details: note.details,
      contactId: contact?.id ?? null,
    });
  }

  // An agent refines the writing style twice, keeping two previous versions.
  saveMemoryNote(db, { project: "", name: "writing-style", summary: "Short sentences, US spelling" });
  saveMemoryNote(db, {
    project: "",
    name: "writing-style",
    summary: "Short sentences, US spelling, no exclamation marks",
    details: "- Lead with the answer, then the reasoning.\n- Code comments explain why, never what.",
  });

  saveMemoryNote(db, {
    project: "",
    name: "laptop-setup",
    kind: "topic",
    title: "Laptop setup",
    summary: "Old notes on the previous laptop's dotfiles",
    details: "Superseded by the dotfiles repository.",
  });
  deleteMemoryNote(db, "", "laptop-setup");

  setProjectUsesAccountMemory(db, "northwind-ingest", false);
}
