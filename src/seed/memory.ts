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

/**
 * Alex's shared agent memory: notes of every kind, a project with an overview
 * and two notes, links between notes (one to a note never written), a note
 * with previous versions, a deleted note, and a project with account memory off.
 */
export function seedMemory(ctx: SeedContext, db: Database): void {
  const contactId = ctx.db.prepare("SELECT id FROM contacts WHERE display_name = ?");
  for (const note of NOTES) {
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
