/**
 * Deterministic synthetic OpenCode data directory for importer tests: a
 * legacy storage/ tree plus an opencode.db holding either or both table
 * generations.
 *
 * DDL is copied from what OpenCode's own migrations produce:
 *   - v1: sst/opencode v1.2.27 (4ee426ba549131c4903a71dfb6259200467aca81),
 *     packages/opencode/migration/*.sql applied in order.
 *   - v2: the opencode v2.0.28 binary (sst/opencode 026b106bc5d41b679ffc413264229c340871e4d3)
 *     run against an empty data directory.
 * Only the tables the importer reads are created. The DDL is exported for the
 * synthetic seed (src/platforms/opencode/seed.ts), which writes the same stores.
 *
 * Scenario (all content synthetic):
 *   ses_alpha — Alice's garden project. In storage/, v1, and v2 (as OpenCode
 *     2's V1Migration leaves it), with a subagent child session, then
 *     continued under OpenCode 2 with messages only v2 holds.
 *   ses_bravo — Bob's session in the "global" project, created by OpenCode 2
 *     (v2 only), including non-chat message types.
 */

import { Database } from "bun:sqlite";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";

export const V1_PROJECT_DDL = `
CREATE TABLE \`project\` (
	\`id\` text PRIMARY KEY,
	\`worktree\` text NOT NULL,
	\`vcs\` text,
	\`name\` text,
	\`icon_url\` text,
	\`icon_color\` text,
	\`time_created\` integer NOT NULL,
	\`time_updated\` integer NOT NULL,
	\`time_initialized\` integer,
	\`sandboxes\` text NOT NULL,
	\`commands\` text
);`;

export const V1_SESSION_DDL = `
CREATE TABLE \`session\` (
	\`id\` text PRIMARY KEY,
	\`project_id\` text NOT NULL,
	\`parent_id\` text,
	\`slug\` text NOT NULL,
	\`directory\` text NOT NULL,
	\`title\` text NOT NULL,
	\`version\` text NOT NULL,
	\`share_url\` text,
	\`summary_additions\` integer,
	\`summary_deletions\` integer,
	\`summary_files\` integer,
	\`summary_diffs\` text,
	\`revert\` text,
	\`permission\` text,
	\`time_created\` integer NOT NULL,
	\`time_updated\` integer NOT NULL,
	\`time_compacting\` integer,
	\`time_archived\` integer, \`workspace_id\` text,
	CONSTRAINT \`fk_session_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
);
CREATE INDEX \`session_project_idx\` ON \`session\` (\`project_id\`);
CREATE INDEX \`session_parent_idx\` ON \`session\` (\`parent_id\`);
CREATE INDEX \`session_workspace_idx\` ON \`session\` (\`workspace_id\`);
CREATE TABLE \`message\` (
	\`id\` text PRIMARY KEY,
	\`session_id\` text NOT NULL,
	\`time_created\` integer NOT NULL,
	\`time_updated\` integer NOT NULL,
	\`data\` text NOT NULL,
	CONSTRAINT \`fk_message_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
);
CREATE INDEX \`message_session_time_created_id_idx\` ON \`message\` (\`session_id\`,\`time_created\`,\`id\`);
CREATE TABLE \`part\` (
	\`id\` text PRIMARY KEY,
	\`message_id\` text NOT NULL,
	\`session_id\` text NOT NULL,
	\`time_created\` integer NOT NULL,
	\`time_updated\` integer NOT NULL,
	\`data\` text NOT NULL,
	CONSTRAINT \`fk_part_message_id_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`message\`(\`id\`) ON DELETE CASCADE
);
CREATE INDEX \`part_session_idx\` ON \`part\` (\`session_id\`);
CREATE INDEX \`part_message_id_id_idx\` ON \`part\` (\`message_id\`,\`id\`);`;

export const V2_DDL = `
CREATE TABLE IF NOT EXISTS "migration" (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL);
CREATE TABLE \`kv\` (
  \`key\` text PRIMARY KEY,
  \`value\` text NOT NULL,
  \`time_created\` integer NOT NULL,
  \`time_updated\` integer NOT NULL
);
CREATE TABLE \`project\` (
  \`id\` text PRIMARY KEY,
  \`worktree\` text NOT NULL,
  \`vcs\` text,
  \`name\` text,
  \`icon_url\` text,
  \`icon_url_override\` text,
  \`icon_color\` text,
  \`time_created\` integer NOT NULL,
  \`time_updated\` integer NOT NULL,
  \`time_initialized\` integer,
  \`time_active\` integer DEFAULT 0 NOT NULL,
  \`time_archived\` integer,
  \`sandboxes\` text NOT NULL,
  \`commands\` text
);
CREATE TABLE \`session_v2\` (
  \`id\` text PRIMARY KEY,
  \`project_id\` text NOT NULL,
  \`workspace_id\` text,
  \`parent_id\` text,
  \`fork_session_id\` text,
  \`fork_boundary\` text,
  \`slug\` text NOT NULL,
  \`directory\` text NOT NULL,
  \`path\` text,
  \`title\` text,
  \`version\` text NOT NULL,
  \`share_url\` text,
  \`summary_additions\` integer,
  \`summary_deletions\` integer,
  \`summary_files\` integer,
  \`summary_diffs\` text,
  \`metadata\` text,
  \`cost\` real DEFAULT 0 NOT NULL,
  \`tokens_input\` integer DEFAULT 0 NOT NULL,
  \`tokens_output\` integer DEFAULT 0 NOT NULL,
  \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
  \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
  \`tokens_cache_write\` integer DEFAULT 0 NOT NULL,
  \`revert\` text,
  \`permission\` text,
  \`agent\` text,
  \`model\` text,
  \`time_created\` integer NOT NULL,
  \`time_updated\` integer NOT NULL,
  \`time_idle\` integer,
  \`time_viewed\` integer,
  \`idle_outcome\` text,
  \`time_compacting\` integer,
  \`time_archived\` integer,
  \`time_suspended\` integer,
  \`resume_attempts\` integer DEFAULT 0 NOT NULL,
  CONSTRAINT \`fk_session_v2_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
);
CREATE INDEX \`session_v2_project_idx\` ON \`session_v2\` (\`project_id\`);
CREATE INDEX \`session_v2_workspace_idx\` ON \`session_v2\` (\`workspace_id\`);
CREATE INDEX \`session_v2_parent_idx\` ON \`session_v2\` (\`parent_id\`);
CREATE TABLE \`session_message\` (
  \`id\` text PRIMARY KEY,
  \`session_id\` text NOT NULL,
  \`type\` text NOT NULL,
  \`seq\` integer NOT NULL,
  \`time_created\` integer NOT NULL,
  \`time_updated\` integer NOT NULL,
  \`data\` text NOT NULL,
  CONSTRAINT \`fk_session_message_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
);
CREATE UNIQUE INDEX \`session_message_session_seq_idx\` ON \`session_message\` (\`session_id\`,\`seq\`);
CREATE INDEX \`session_message_session_type_seq_idx\` ON \`session_message\` (\`session_id\`,\`type\`,\`seq\`);
CREATE INDEX \`session_message_session_time_created_id_idx\` ON \`session_message\` (\`session_id\`,\`time_created\`,\`id\`);
CREATE INDEX \`session_message_time_created_idx\` ON \`session_message\` (\`time_created\`);`;

export const LATEST_V2_MIGRATION = "20261010180456_project_time_archived";

const T0 = Date.UTC(2026, 0, 10, 9, 0, 0);
const at = (minutes: number) => T0 + minutes * 60_000;

const TOKENS = { input: 120, output: 40, reasoning: 8, cache: { read: 300, write: 50 } };

// ---- Projects and sessions ----

const PROJECTS = [
  { id: "prj_garden", worktree: "/home/alice/projects/garden" },
  { id: "global", worktree: "/" },
];

interface FixtureSession {
  id: string;
  projectID: string;
  parentID?: string;
  slug: string;
  directory: string;
  title: string;
  created: number;
}

const ALPHA: FixtureSession = {
  id: "ses_alpha",
  projectID: "prj_garden",
  slug: "quiet-meadow",
  directory: "/home/alice/projects/garden",
  title: "List garden beds",
  created: at(0),
};

const ALPHA_CHILD: FixtureSession = {
  id: "ses_alpha_child",
  projectID: "prj_garden",
  parentID: "ses_alpha",
  slug: "small-sparrow",
  directory: "/home/alice/projects/garden",
  title: "Explore subagent",
  created: at(2),
};

const BRAVO: FixtureSession = {
  id: "ses_bravo",
  projectID: "global",
  slug: "brave-otter",
  directory: "/home/bob/scratch",
  title: "Weather notes",
  created: at(60),
};

// ---- v1 / storage messages (legacy JSON shapes) ----

interface LegacyMessage {
  id: string;
  sessionID: string;
  data: Record<string, unknown>;
  parts: Record<string, unknown>[];
}

const LEGACY_MESSAGES: LegacyMessage[] = [
  {
    id: "msg_a1",
    sessionID: "ses_alpha",
    data: {
      role: "user",
      time: { created: at(1) },
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
    },
    parts: [{ id: "prt_a1_1", type: "text", text: "Alice here: which beds need watering?" }],
  },
  {
    id: "msg_a2",
    sessionID: "ses_alpha",
    data: {
      role: "assistant",
      parentID: "msg_a1",
      time: { created: at(1.5), completed: at(3) },
      modelID: "claude-sonnet-4-5",
      providerID: "anthropic",
      mode: "build",
      agent: "build",
      path: { cwd: "/home/alice/projects/garden", root: "/home/alice/projects/garden" },
      cost: 0.0125,
      tokens: TOKENS,
      finish: "stop",
    },
    parts: [
      { id: "prt_a2_1", type: "step-start", snapshot: "snap1" },
      { id: "prt_a2_2", type: "reasoning", text: "Check the beds file first.", time: { start: at(1.6), end: at(1.7) } },
      {
        id: "prt_a2_3",
        type: "tool",
        callID: "call_ls",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "ls beds" },
          output: "north.txt\nsouth.txt",
          title: "ls beds",
          metadata: { exit: 0 },
          time: { start: at(1.8), end: at(1.9) },
        },
      },
      {
        id: "prt_a2_4",
        type: "tool",
        callID: "call_read",
        tool: "read",
        state: {
          status: "error",
          input: { filePath: "beds/east.txt" },
          error: "File not found: beds/east.txt",
          time: { start: at(2), end: at(2.1) },
        },
      },
      { id: "prt_a2_5", type: "text", text: "The north and south beds need watering." },
      { id: "prt_a2_6", type: "step-finish", reason: "stop", cost: 0.0125, tokens: TOKENS },
    ],
  },
  {
    id: "msg_ac1",
    sessionID: "ses_alpha_child",
    data: {
      role: "assistant",
      time: { created: at(2.5), completed: at(2.8) },
      modelID: "claude-haiku-4-5",
      providerID: "anthropic",
      mode: "explore",
      agent: "explore",
      cost: 0.001,
      tokens: TOKENS,
    },
    parts: [{ id: "prt_ac1_1", type: "text", text: "Found two bed files." }],
  },
];

// ---- v2 rows ----

interface V2Row {
  id: string;
  sessionID: string;
  type: string;
  created: number;
  data: Record<string, unknown>;
}

/** v2 projection of the legacy messages, as V1Migration writes it. */
const V2_MIGRATED: V2Row[] = [
  {
    id: "msg_a1",
    sessionID: "ses_alpha",
    type: "user",
    created: at(1),
    data: { text: "Alice here: which beds need watering?", time: { created: at(1) } },
  },
  {
    id: "msg_a2",
    sessionID: "ses_alpha",
    type: "assistant",
    created: at(1.5),
    data: {
      agent: "build",
      model: { providerID: "anthropic", id: "claude-sonnet-4-5", variant: "default" },
      content: [
        { type: "reasoning", text: "Check the beds file first.", time: { created: at(1.6), completed: at(1.7) } },
        {
          type: "tool",
          id: "call_ls",
          name: "bash",
          state: { status: "completed", input: { command: "ls beds" }, content: [{ type: "text", text: "north.txt\nsouth.txt" }] },
          time: { created: at(1.8), completed: at(1.9) },
        },
        { type: "text", text: "The north and south beds need watering." },
      ],
      finish: "stop",
      cost: 0.0125,
      tokens: TOKENS,
      time: { created: at(1.5), completed: at(3) },
    },
  },
  {
    id: "msg_ac1",
    sessionID: "ses_alpha_child",
    type: "assistant",
    created: at(2.5),
    data: {
      agent: "explore",
      model: { providerID: "anthropic", id: "claude-haiku-4-5", variant: "default" },
      content: [{ type: "text", text: "Found two bed files." }],
      time: { created: at(2.5), completed: at(2.8) },
    },
  },
];

/** Messages written by OpenCode 2 after the upgrade (v2 only). */
const V2_NATIVE: V2Row[] = [
  {
    id: "msg_a3_sys",
    sessionID: "ses_alpha",
    type: "system",
    created: at(3.5),
    data: { text: "Some legacy tool calls were converted.", time: { created: at(3.5) } },
  },
  {
    id: "msg_a3",
    sessionID: "ses_alpha",
    type: "user",
    created: at(10),
    data: { text: "Now add a note for the east bed.", time: { created: at(10) } },
  },
  {
    id: "msg_a4",
    sessionID: "ses_alpha",
    type: "assistant",
    created: at(10.5),
    data: {
      agent: "build",
      model: { providerID: "anthropic", id: "claude-sonnet-4-5", variant: "default" },
      content: [
        { type: "text", text: "Creating the note." },
        {
          type: "tool",
          id: "call_write",
          name: "write",
          state: {
            status: "completed",
            input: { filePath: "beds/east.txt", content: "plant tomatoes" },
            content: [{ type: "text", text: "Wrote beds/east.txt" }],
          },
          time: { created: at(10.6), completed: at(10.7) },
        },
        { type: "text", text: "Done: the east bed note is in beds/east.txt." },
      ],
      finish: "stop",
      cost: 0.02,
      tokens: TOKENS,
      time: { created: at(10.5), completed: at(11) },
    },
  },
  {
    id: "msg_a4_idle",
    sessionID: "ses_alpha",
    type: "idle",
    created: at(11),
    data: { outcome: "succeeded", time: { created: at(11) } },
  },
  {
    id: "msg_b0",
    sessionID: "ses_bravo",
    type: "model-switched",
    created: at(60),
    data: { model: { providerID: "openai", id: "gpt-5" }, time: { created: at(60) } },
  },
  {
    id: "msg_b1",
    sessionID: "ses_bravo",
    type: "user",
    created: at(61),
    data: { text: "Bob asks: will it rain at example.com HQ?", time: { created: at(61) } },
  },
  {
    id: "msg_b2",
    sessionID: "ses_bravo",
    type: "assistant",
    created: at(61.5),
    data: {
      agent: "build",
      model: { providerID: "openai", id: "gpt-5", variant: "default" },
      content: [
        { type: "reasoning", text: "Need a forecast." },
        {
          type: "tool",
          id: "call_fetch",
          name: "webfetch",
          state: {
            status: "error",
            input: { url: "https://example.com/forecast" },
            error: { type: "Tool.Error", message: "Request timed out" },
          },
          time: { created: at(61.6), completed: at(61.9) },
        },
        {
          type: "tool",
          id: "call_retry",
          name: "webfetch",
          state: { status: "running", input: { url: "https://example.com/forecast" }, metadata: {} },
          time: { created: at(62) },
        },
        { type: "text", text: "I could not reach the forecast service." },
      ],
      finish: "stop",
      cost: 0.004,
      tokens: TOKENS,
      time: { created: at(61.5), completed: at(62.5) },
    },
  },
];

// ---- Writers ----

export interface OpenCodeFixtureOptions {
  /** Write the legacy storage/ JSON tree (ses_alpha and its child). */
  storage?: boolean;
  /** Create v1 tables holding ses_alpha and its child. */
  v1?: boolean;
  /** Create v2 tables: the migrated alpha rows plus the OpenCode 2 messages. */
  v2?: boolean;
  /**
   * Keep the v1 `session` table. Without it, v1 message/part remain beside v2
   * as OpenCode 2's loose_psylocke migration leaves a pre-release v2 database.
   */
  v1SessionTable?: boolean;
}

async function writeJson(dir: string, name: string, data: unknown): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.json`), JSON.stringify(data, null, 2));
}

const LEGACY_SESSIONS = [ALPHA, ALPHA_CHILD];
const V2_SESSIONS = [ALPHA, ALPHA_CHILD, BRAVO];

async function writeStorage(storageDir: string): Promise<void> {
  for (const project of PROJECTS.filter((p) => p.id === "prj_garden")) {
    await writeJson(join(storageDir, "project"), project.id, {
      ...project,
      time: { created: T0, updated: T0 },
    });
  }
  for (const s of LEGACY_SESSIONS) {
    await writeJson(join(storageDir, "session", s.projectID), s.id, {
      id: s.id,
      slug: s.slug,
      version: "0.15.0",
      projectID: s.projectID,
      directory: s.directory,
      ...(s.parentID ? { parentID: s.parentID } : {}),
      title: s.title,
      time: { created: s.created, updated: s.created },
    });
  }
  for (const m of LEGACY_MESSAGES) {
    await writeJson(join(storageDir, "message", m.sessionID), m.id, {
      id: m.id,
      sessionID: m.sessionID,
      ...m.data,
    });
    for (const part of m.parts) {
      await writeJson(join(storageDir, "part", m.id), String(part.id), {
        ...part,
        sessionID: m.sessionID,
        messageID: m.id,
      });
    }
  }
}

function writeDb(dbPath: string, options: { v1: boolean; v2: boolean; v1SessionTable: boolean }): void {
  const db = new Database(dbPath, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run(options.v2 ? V2_DDL : V1_PROJECT_DDL);
  if (options.v1) db.run(V1_SESSION_DDL);

  const insertProject = db.prepare(
    `INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, '[]')`
  );
  for (const project of PROJECTS) {
    insertProject.run(project.id, project.worktree, T0, T0);
  }

  if (options.v1) {
    const insertSession = db.prepare(`
      INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
      VALUES (?, ?, ?, ?, ?, ?, '1.2.27', ?, ?)
    `);
    for (const s of LEGACY_SESSIONS) {
      insertSession.run(s.id, s.projectID, s.parentID ?? null, s.slug, s.directory, s.title, s.created, s.created);
    }
    const insertMessage = db.prepare(
      `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`
    );
    const insertPart = db.prepare(
      `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const m of LEGACY_MESSAGES) {
      const created = (m.data.time as { created: number }).created;
      insertMessage.run(m.id, m.sessionID, created, created, JSON.stringify(m.data));
      for (const { id, ...part } of m.parts) {
        insertPart.run(String(id), m.id, m.sessionID, created, created, JSON.stringify(part));
      }
    }
    if (!options.v1SessionTable) db.run("DROP TABLE session");
  }

  if (options.v2) {
    db.prepare(`INSERT INTO migration (id, time_completed) VALUES (?, ?)`).run(LATEST_V2_MIGRATION, T0);
    if (options.v1) {
      db.prepare(`INSERT INTO kv (key, value, time_created, time_updated) VALUES (?, ?, ?, ?)`)
        .run("migration.v1-v2", JSON.stringify({ phase: "completed" }), T0, T0);
    }
    const insertSession = db.prepare(`
      INSERT INTO session_v2 (id, project_id, parent_id, slug, directory, title, version, model, time_created, time_updated)
      VALUES (?, ?, ?, ?, ?, ?, '2.0.28', ?, ?, ?)
    `);
    for (const s of V2_SESSIONS) {
      insertSession.run(
        s.id, s.projectID, s.parentID ?? null, s.slug, s.directory, s.title,
        JSON.stringify({ id: "claude-sonnet-4-5", providerID: "anthropic" }), s.created, s.created
      );
    }
    const insertMessage = db.prepare(`
      INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const seqBySession = new Map<string, number>();
    for (const row of [...V2_MIGRATED, ...V2_NATIVE]) {
      const seq = seqBySession.get(row.sessionID) ?? 0;
      seqBySession.set(row.sessionID, seq + 1);
      insertMessage.run(row.id, row.sessionID, row.type, seq, row.created, row.created, JSON.stringify(row.data));
    }
  }

  db.close();
}

/**
 * Write the fixture into `dataDir` (an OpenCode data directory). Defaults to
 * an upgraded install: storage/, v1, and v2 all present.
 */
export async function writeOpenCodeFixture(
  dataDir: string,
  options: OpenCodeFixtureOptions = {}
): Promise<void> {
  const { storage = true, v1 = true, v2 = true, v1SessionTable = true } = options;
  await mkdir(dataDir, { recursive: true });
  if (storage) await writeStorage(join(dataDir, "storage"));
  if (v1 || v2) writeDb(join(dataDir, "opencode.db"), { v1, v2, v1SessionTable });
}
