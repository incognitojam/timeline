import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { initDb } from "../db/schema";
import { backfillClaudeCodeProjectNames } from "./backfill-claude-code-project-names";

interface SeedEvent {
  sourceId: string;
  conversationId: string;
  timestamp: string;
  title: string;
  tags: string[];
  cwd?: string;
}

describe("backfillClaudeCodeProjectNames", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initDb(db);
  });

  afterEach(() => {
    db.close();
  });

  function seed(events: SeedEvent[]) {
    const insert = db.prepare(`
      INSERT INTO events (
        source, source_id, source_account, type, timestamp,
        title, content, tags, raw_data, conversation_id
      ) VALUES ('claude-code', ?, 'tester', 'claude-code:message:assistant', ?, ?, '', ?, ?, ?)
    `);
    for (const e of events) {
      insert.run(
        e.sourceId,
        e.timestamp,
        e.title,
        JSON.stringify(e.tags),
        // Backfill groups by raw_data.session_id (always written by the parser),
        // not the conversation_id column (NULL on older rows).
        JSON.stringify({ cwd: e.cwd, session_id: e.conversationId }),
        e.conversationId
      );
    }
  }

  function row(sourceId: string): { title: string; tags: string } {
    return db
      .prepare("SELECT title, tags FROM events WHERE source_id = ?")
      .get(sourceId) as { title: string; tags: string };
  }

  it("rewrites a truncated title and project tag from the launch cwd", () => {
    seed([
      {
        sourceId: "s:1",
        conversationId: "s",
        timestamp: "2026-04-01T00:00:00.000Z",
        title: "api",
        tags: ["editor:claude-code", "project:api", "model:claude-opus-4-5"],
        cwd: "/Users/alice/Developer/example-service-api",
      },
    ]);

    const stats = backfillClaudeCodeProjectNames(db);

    expect(stats.rowsUpdated).toBe(1);
    expect(stats.sessions).toBe(1);
    const r = row("s:1");
    expect(r.title).toBe("example-service-api");
    expect(JSON.parse(r.tags)).toEqual([
      "editor:claude-code",
      "project:example-service-api",
      "model:claude-opus-4-5",
    ]);
  });

  it("uses the earliest message's cwd as the launch dir across a mid-session cd", () => {
    seed([
      {
        sourceId: "s:1",
        conversationId: "s",
        timestamp: "2026-04-01T00:00:00.000Z",
        title: "api",
        tags: ["editor:claude-code", "project:api"],
        cwd: "/Users/alice/Developer/example-service-api",
      },
      {
        sourceId: "s:2",
        conversationId: "s",
        timestamp: "2026-04-01T00:05:00.000Z",
        title: "api",
        tags: ["editor:claude-code", "project:api"],
        // user cd'd into a subdirectory partway through the session
        cwd: "/Users/alice/Developer/example-service-api/example-submodule",
      },
    ]);

    const stats = backfillClaudeCodeProjectNames(db);

    expect(stats.rowsUpdated).toBe(2);
    expect(row("s:1").title).toBe("example-service-api");
    expect(row("s:2").title).toBe("example-service-api"); // not "example-submodule"
  });

  it("preserves the slug suffix while swapping the project prefix", () => {
    seed([
      {
        sourceId: "s:1",
        conversationId: "s",
        timestamp: "2026-04-01T00:00:00.000Z",
        title: "client (sample-worktree)",
        tags: ["editor:claude-code", "project:client"],
        cwd: "/Users/alice/Developer/example-discord-client",
      },
    ]);

    backfillClaudeCodeProjectNames(db);

    const r = row("s:1");
    expect(r.title).toBe("example-discord-client (sample-worktree)");
    expect(JSON.parse(r.tags)).toContain("project:example-discord-client");
  });

  it("leaves already-correct names unchanged and is idempotent", () => {
    seed([
      {
        sourceId: "s:1",
        conversationId: "s",
        timestamp: "2026-04-01T00:00:00.000Z",
        title: "timeline",
        tags: ["editor:claude-code", "project:timeline"],
        cwd: "/Users/alice/Developer/timeline",
      },
      {
        sourceId: "t:1",
        conversationId: "t",
        timestamp: "2026-04-01T00:00:00.000Z",
        title: "api",
        tags: ["editor:claude-code", "project:api"],
        cwd: "/Users/alice/Developer/example-service-api",
      },
    ]);

    const first = backfillClaudeCodeProjectNames(db);
    expect(first.rowsUpdated).toBe(1); // only the truncated "api" row
    expect(first.rowsUnchanged).toBe(1); // the "timeline" row

    const second = backfillClaudeCodeProjectNames(db);
    expect(second.rowsUpdated).toBe(0);
    expect(second.rowsUnchanged).toBe(2);
    expect(row("t:1").title).toBe("example-service-api");
  });

  it("does not modify rows in a dry run", () => {
    seed([
      {
        sourceId: "s:1",
        conversationId: "s",
        timestamp: "2026-04-01T00:00:00.000Z",
        title: "api",
        tags: ["editor:claude-code", "project:api"],
        cwd: "/Users/alice/Developer/example-service-api",
      },
    ]);

    const stats = backfillClaudeCodeProjectNames(db, { dryRun: true });

    expect(stats.rowsUpdated).toBe(1); // counted, but not written
    expect(row("s:1").title).toBe("api");
  });

  it("skips sessions with no cwd recorded on any message", () => {
    seed([
      {
        sourceId: "s:1",
        conversationId: "s",
        timestamp: "2026-04-01T00:00:00.000Z",
        title: "api",
        tags: ["editor:claude-code", "project:api"],
        // cwd omitted entirely
      },
    ]);

    const stats = backfillClaudeCodeProjectNames(db);

    expect(stats.sessions).toBe(0);
    expect(stats.sessionsSkipped).toBe(1);
    expect(stats.rowsUpdated).toBe(0);
    expect(row("s:1").title).toBe("api"); // left as-is
  });
});
