/**
 * Tests for the conversation scopes: Messages excludes coding-agent sessions,
 * and the coding-agent list carries each conversation's coding project
 * (derived once into `coding_agent_conversations`) for filtering.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { getCodingProjectConversations } from "./coding-projects";
import {
  listCodingAgentConversationProjects,
  listCodingAgentConversations,
  listConversationSources,
  listConversations,
} from "./conversations";
import { wrapDatabase } from "./pool";
import { initDb } from "./schema";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  initDb(db);
});

afterEach(() => {
  db.close();
});

let nextId = 0;

function insertMessage(args: {
  source: string;
  type: string;
  conversationId: string;
  title: string;
  timestamp: string;
  rawData?: Record<string, unknown> | string;
}): void {
  nextId += 1;
  const rawData = typeof args.rawData === "string" ? args.rawData : JSON.stringify(args.rawData ?? {});
  db.prepare(`
    INSERT INTO events (source, source_id, source_account, type, timestamp, title, content, raw_data, conversation_id)
    VALUES (?, ?, 'test-account', ?, ?, ?, 'hello', ?, ?)
  `).run(args.source, `msg-${nextId}`, args.type, args.timestamp, args.title, rawData, args.conversationId);
}

function seed(): void {
  insertMessage({ source: "discord", type: "message:dm", conversationId: "dm-1", title: "Alice", timestamp: "2026-01-01T10:00:00Z" });
  insertMessage({ source: "phone", type: "sms:received", conversationId: "sms-1", title: "Bob", timestamp: "2026-01-02T10:00:00Z" });
  insertMessage({
    source: "claude-code", type: "claude-code:message:user", conversationId: "cc-1",
    title: "example-app (brave-otter)", timestamp: "2026-01-03T10:00:00Z", rawData: { cwd: "/srv/code/example-app" },
  });
  insertMessage({
    source: "codex", type: "codex:message:user", conversationId: "codex-1",
    title: "Fix the build", timestamp: "2026-01-04T10:00:00Z",
    rawData: { cwd: "/srv/code/conductor/workspaces/example-app/lima-v2" },
  });
  insertMessage({
    source: "conductor", type: "conductor:message:user", conversationId: "cond-1",
    title: "other-app / oslo: Plan", timestamp: "2026-01-05T10:00:00Z", rawData: { repo_name: "other-app" },
  });
  insertMessage({
    source: "claude", type: "claude:message:user", conversationId: "chat-1",
    title: "Recipe ideas", timestamp: "2026-01-06T10:00:00Z",
  });
}

describe("conversation scopes", () => {
  test("Messages list and sources exclude coding-agent sessions", async () => {
    seed();
    const { conversations, total } = await listConversations(wrapDatabase(db));
    expect(total).toBe(3);
    expect(conversations.map((c) => c.source)).toEqual(["claude", "phone", "discord"]);
    expect(await listConversationSources(wrapDatabase(db), "messages")).toEqual(["claude", "discord", "phone"]);
  });

  test("coding-agent list returns only coding-agent conversations with their project", async () => {
    seed();
    const { conversations, total } = await listCodingAgentConversations(wrapDatabase(db));
    expect(total).toBe(3);
    expect(conversations.map((c) => [c.source, c.project])).toEqual([
      ["conductor", "other-app"],
      ["codex", "example-app"],
      ["claude-code", "example-app"],
    ]);
    expect(await listConversationSources(wrapDatabase(db), "coding")).toEqual(["claude-code", "codex", "conductor"]);
  });

  test("coding-agent list filters by project, unassigned, source, and search", async () => {
    seed();
    const ai = (options: Parameters<typeof listCodingAgentConversations>[1]) => listCodingAgentConversations(wrapDatabase(db), options);

    const project = await ai({ project: { kind: "project", name: "example-app" } });
    expect(project.total).toBe(2);
    expect(project.conversations.map((c) => c.conversationId)).toEqual(["codex-1", "cc-1"]);

    insertMessage({
      source: "amp", type: "amp:message:user", conversationId: "amp-1",
      title: "Scratch idea", timestamp: "2026-01-07T10:00:00Z",
    });
    const unassigned = await ai({ project: { kind: "unassigned" } });
    expect(unassigned.conversations.map((c) => c.conversationId)).toEqual(["amp-1"]);

    const source = await ai({ source: "codex" });
    expect(source.conversations.map((c) => c.conversationId)).toEqual(["codex-1"]);

    const search = await ai({ search: "build" });
    expect(search.conversations.map((c) => c.conversationId)).toEqual(["codex-1"]);

    // Other scopes never leak into the coding-agent list, even when asked for.
    expect((await ai({ source: "discord" })).total).toBe(0);
    expect((await ai({ source: "claude" })).total).toBe(0);
  });

  test("project counts include an unassigned bucket", async () => {
    seed();
    expect(await listCodingAgentConversationProjects(wrapDatabase(db))).toEqual({
      projects: [
        { name: "example-app", count: 2 },
        { name: "other-app", count: 1 },
      ],
      unassigned: 0,
    });
  });

  test("project filter agrees with the coding project page", async () => {
    seed();
    const page = await getCodingProjectConversations(wrapDatabase(db), "example-app");
    const list = await listCodingAgentConversations(wrapDatabase(db), { project: { kind: "project", name: "example-app" } });
    const listIds: (string | null)[] = list.conversations.map((c) => c.conversationId);
    expect(listIds.sort()).toEqual(page.conversations.map((c) => c.conversationId).sort());
  });

  test("the first event carrying a project assigns it", async () => {
    insertMessage({
      source: "conductor", type: "conductor:message:assistant", conversationId: "cond-2",
      title: "late / x: y", timestamp: "2026-01-01T10:00:00Z",
    });
    insertMessage({
      source: "conductor", type: "conductor:message:user", conversationId: "cond-2",
      title: "late / x: y", timestamp: "2026-01-01T10:01:00Z", rawData: { repo_name: "late-app" },
    });
    insertMessage({
      source: "conductor", type: "conductor:message:user", conversationId: "cond-2",
      title: "late / x: y", timestamp: "2026-01-01T10:02:00Z", rawData: { repo_name: "other" },
    });
    const { conversations } = await listCodingAgentConversations(wrapDatabase(db));
    expect(conversations[0].project).toBe("late-app");
  });

  const projectOf = async (conversationId: string) => {
    const { conversations } = await listCodingAgentConversations(wrapDatabase(db));
    return conversations.find((c) => c.conversationId === conversationId)?.project;
  };

  test("an earlier event inserted later takes over the project, matching a rebuild", async () => {
    insertMessage({
      source: "codex", type: "codex:message:user", conversationId: "codex-order",
      title: "Order", timestamp: "2026-01-02T10:00:00Z", rawData: { cwd: "/srv/code/newer-app" },
    });
    insertMessage({
      source: "codex", type: "codex:message:user", conversationId: "codex-order",
      title: "Order", timestamp: "2026-01-01T10:00:00Z", rawData: { cwd: "/srv/code/older-app" },
    });
    expect(await projectOf("codex-order")).toBe("older-app");

    db.exec("DELETE FROM coding_agent_conversations");
    initDb(db);
    expect(await projectOf("codex-order")).toBe("older-app");
  });

  test("deleting and re-importing a session reassigns its project", async () => {
    insertMessage({
      source: "codex", type: "codex:message:user", conversationId: "codex-reimport",
      title: "Reimport", timestamp: "2026-01-01T10:00:00Z", rawData: { cwd: "/srv/code/first-app" },
    });
    db.exec("DELETE FROM events WHERE conversation_id = 'codex-reimport'");
    insertMessage({
      source: "codex", type: "codex:message:user", conversationId: "codex-reimport",
      title: "Reimport", timestamp: "2026-01-01T10:00:00Z", rawData: { cwd: "/srv/code/second-app" },
    });
    expect(await projectOf("codex-reimport")).toBe("second-app");
  });

  test("correcting the anchor event's raw_data updates the project", async () => {
    insertMessage({
      source: "conductor", type: "conductor:message:user", conversationId: "cond-fix",
      title: "fix / x: y", timestamp: "2026-01-01T10:00:00Z", rawData: { repo_name: "wrong-app" },
    });
    insertMessage({
      source: "conductor", type: "conductor:message:assistant", conversationId: "cond-fix",
      title: "fix / x: y", timestamp: "2026-01-01T10:01:00Z", rawData: { repo_name: "right-app" },
    });
    db.prepare("UPDATE events SET raw_data = ? WHERE conversation_id = 'cond-fix' AND timestamp = '2026-01-01T10:00:00Z'")
      .run(JSON.stringify({ note: "repo unknown" }));
    expect(await projectOf("cond-fix")).toBe("right-app");
  });

  test("project names are kept as-is, matching the coding project page", async () => {
    insertMessage({
      source: "t3code", type: "t3code:message:user", conversationId: "t3-space",
      title: "Thread", timestamp: "2026-01-01T10:00:00Z", rawData: { project_title: " spaced app " },
    });
    expect(await projectOf("t3-space")).toBe(" spaced app ");
    const page = await getCodingProjectConversations(wrapDatabase(db), " spaced app ");
    expect(page.conversations.map((c) => c.conversationId)).toEqual(["t3-space"]);
  });

  test("backfill assigns projects to legacy sessions without a source account", async () => {
    db.exec("DROP TRIGGER IF EXISTS events_conversation_source_account_bi"); // Simulates pre-enforcement legacy rows.
    db.prepare(`
      INSERT INTO events (source, source_id, source_account, type, timestamp, title, content, raw_data, conversation_id)
      VALUES ('codex', 'legacy-1', NULL, 'codex:message:user', '2026-01-01T10:00:00Z', 'Legacy', 'hi', ?, 'codex-legacy')
    `).run(JSON.stringify({ cwd: "/srv/code/legacy-app" }));
    db.exec("DELETE FROM coding_agent_conversations");
    initDb(db);
    expect(await projectOf("codex-legacy")).toBe("legacy-app");
  });

  test("incremental maintenance matches a fresh backfill after mixed writes", () => {
    // Deterministic LCG so failures reproduce.
    let state = 42;
    const random = (n: number) => {
      state = (state * 1103515245 + 12345) % 2 ** 31;
      return state % n;
    };
    const conversations = ["c-1", "c-2", "c-3", "c-4"];
    const projects = [null, "alpha", "beta", "gamma"];
    const rawData = () => {
      const project = projects[random(projects.length)];
      return JSON.stringify(project ? { cwd: `/srv/code/${project}` } : {});
    };
    const timestamp = () => `2026-01-0${1 + random(3)}T10:0${random(6)}:00Z`;

    for (let step = 0; step < 300; step++) {
      const ids = (db.prepare("SELECT id FROM events").all() as { id: number }[]).map((row) => row.id);
      const id = ids.length > 0 ? ids[random(ids.length)] : null;
      switch (id === null ? 0 : random(6)) {
        case 0:
          insertMessage({
            source: "codex", type: "codex:message:user", conversationId: conversations[random(conversations.length)],
            title: "Session", timestamp: timestamp(), rawData: JSON.parse(rawData()),
          });
          break;
        case 1:
          db.prepare("UPDATE events SET raw_data = ? WHERE id = ?").run(rawData(), id);
          break;
        case 2:
          db.prepare("UPDATE events SET timestamp = ? WHERE id = ?").run(timestamp(), id);
          break;
        case 3:
          db.prepare("UPDATE events SET conversation_id = ? WHERE id = ?").run(conversations[random(conversations.length)], id);
          break;
        case 4:
          db.prepare("UPDATE events SET content = ? WHERE id = ?").run(`edit ${step}`, id);
          break;
        default:
          db.prepare("DELETE FROM events WHERE id = ?").run(id);
      }
    }

    const snapshot = () => db.prepare(`
      SELECT cac.conversation_id, cac.project, cac.project_event_id
      FROM coding_agent_conversations cac
      JOIN conversation_summaries cs USING (source, source_account_key, conversation_id)
      ORDER BY cac.conversation_id
    `).all();
    const incremental = snapshot();
    db.exec("DELETE FROM coding_agent_conversations");
    initDb(db);
    expect(incremental).toEqual(snapshot());
  });

  test("malformed raw_data leaves the project unassigned instead of failing the insert", async () => {
    insertMessage({
      source: "codex", type: "codex:message:user", conversationId: "codex-bad",
      title: "Broken", timestamp: "2026-01-01T10:00:00Z", rawData: "not json",
    });
    const { conversations } = await listCodingAgentConversations(wrapDatabase(db));
    expect(conversations.map((c) => [c.conversationId, c.project])).toEqual([["codex-bad", null]]);
  });

  test("workspace paths resolve to their basename, ignoring trailing slashes", async () => {
    insertMessage({
      source: "opencode", type: "opencode:message:user", conversationId: "oc-1",
      title: "Session", timestamp: "2026-01-01T10:00:00Z", rawData: { project_path: "/srv/code/sample-repo/" },
    });
    const { conversations } = await listCodingAgentConversations(wrapDatabase(db));
    expect(conversations[0].project).toBe("sample-repo");
  });

  test("initDb backfills conversations missing a row", async () => {
    seed();
    db.exec("DELETE FROM coding_agent_conversations WHERE conversation_id = 'codex-1'");
    initDb(db);
    const { conversations } = await listCodingAgentConversations(wrapDatabase(db), { source: "codex" });
    expect(conversations.map((c) => c.project)).toEqual(["example-app"]);
  });

  test("initDb backfills projects for conversations that predate the table", async () => {
    seed();
    db.exec("DROP TABLE coding_agent_conversations");
    initDb(db);
    const { projects, unassigned } = await listCodingAgentConversationProjects(wrapDatabase(db));
    expect(projects).toEqual([
      { name: "example-app", count: 2 },
      { name: "other-app", count: 1 },
    ]);
    expect(unassigned).toBe(0);
  });
});
