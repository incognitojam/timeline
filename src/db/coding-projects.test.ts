/**
 * Tests for the unified coding-project list. Covers the cases that matter most
 * for the Coding tab:
 *   - WakaTime-only projects still appear and aggregate hours.
 *   - AI-only projects (claude-code, conductor, amp, opencode) appear even
 *     when there's no WakaTime session.
 *   - Mixed projects merge stats from both sides.
 *   - Search filters by name (and primary language for WakaTime).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initDb } from "./schema";
import { wrapDatabase } from "./pool";
import { getCodingProjects } from "./coding-projects";

let db: Database;

function setup(): void {
  db = new Database(":memory:");
  initDb(db);
}

function teardown(): void {
  db.close();
}

function insertWakaTimeSession(args: {
  sourceId: string;
  title: string;
  durationMs: number;
  timestamp: string;
  language?: string;
}): void {
  const tags = args.language ? JSON.stringify([`language:${args.language}`]) : null;
  const rawData = JSON.stringify({
    languages: args.language ? { [args.language]: 1 } : {},
  });
  db.prepare(`
    INSERT INTO events (
      source, source_id, source_account, type, timestamp, title, duration_ms, tags, raw_data
    ) VALUES ('wakatime', ?, 'test-account', 'code:session', ?, ?, ?, ?, ?)
  `).run(
    args.sourceId,
    args.timestamp,
    args.title,
    args.durationMs,
    tags,
    rawData,
  );
}

function insertClaudeCodeMessage(args: {
  sourceId: string;
  conversationId: string;
  title: string;
  timestamp: string;
  role: "user" | "assistant";
}): void {
  db.prepare(`
    INSERT INTO events (
      source, source_id, source_account, type, timestamp, title, raw_data, conversation_id
    ) VALUES ('claude-code', ?, 'test-account', ?, ?, ?, '{}', ?)
  `).run(
    args.sourceId,
    `claude-code:message:${args.role}`,
    args.timestamp,
    args.title,
    args.conversationId,
  );
}

function insertConductorMessage(args: {
  sourceId: string;
  conversationId: string;
  title: string;
  timestamp: string;
  repoName: string;
  role: "user" | "assistant";
}): void {
  db.prepare(`
    INSERT INTO events (
      source, source_id, source_account, type, timestamp, title, raw_data, conversation_id
    ) VALUES ('conductor', ?, 'test-account', ?, ?, ?, ?, ?)
  `).run(
    args.sourceId,
    `conductor:message:${args.role}`,
    args.timestamp,
    args.title,
    JSON.stringify({ repo_name: args.repoName }),
    args.conversationId,
  );
}

function insertAmpMessage(args: {
  sourceId: string;
  title: string;
  timestamp: string;
  workspaceRoots: string[];
  role: "user" | "assistant";
}): void {
  db.prepare(`
    INSERT INTO events (
      source, source_id, source_account, type, timestamp, title, raw_data, conversation_id
    ) VALUES ('amp', ?, 'test-account', ?, ?, ?, ?, ?)
  `).run(
    args.sourceId,
    `amp:message:${args.role}`,
    args.timestamp,
    args.title,
    JSON.stringify({ workspace_roots: args.workspaceRoots }),
    args.sourceId,
  );
}

function insertOpencodeMessage(args: {
  sourceId: string;
  conversationId: string;
  title: string;
  timestamp: string;
  projectPath: string;
  role: "user" | "assistant";
}): void {
  db.prepare(`
    INSERT INTO events (
      source, source_id, source_account, type, timestamp, title, raw_data, conversation_id
    ) VALUES ('opencode', ?, 'test-account', ?, ?, ?, ?, ?)
  `).run(
    args.sourceId,
    `opencode:message:${args.role}`,
    args.timestamp,
    args.title,
    JSON.stringify({ project_path: args.projectPath }),
    args.conversationId,
  );
}

describe("getCodingProjects", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("WakaTime-only project appears with duration and sessions", async () => {
    insertWakaTimeSession({
      sourceId: "w1",
      title: "timeline (TypeScript)",
      durationMs: 60_000,
      timestamp: "2026-01-01T10:00:00Z",
      language: "TypeScript",
    });
    insertWakaTimeSession({
      sourceId: "w2",
      title: "timeline (TypeScript)",
      durationMs: 30_000,
      timestamp: "2026-01-02T10:00:00Z",
      language: "TypeScript",
    });

    const { projects } = await getCodingProjects(wrapDatabase(db));

    expect(projects).toHaveLength(1);
    const p = projects[0];
    expect(p.name).toBe("timeline");
    expect(p.totalDuration).toBe(90_000);
    expect(p.sessionCount).toBe(2);
    expect(p.conversationCount).toBe(0);
    expect(p.aiSources).toEqual([]);
    expect(p.primaryLanguage).toBe("TypeScript");
  });

  test("session with no language: tag does not leak project name as language", async () => {
    // Regression for the example-project bug: a WakaTime session with no detected
    // language must NOT cause the project name to surface as primaryLanguage.
    db.prepare(`
      INSERT INTO events (
        source, source_id, type, timestamp, title, duration_ms, tags, raw_data
      ) VALUES ('wakatime', 'no-lang-1', 'code:session', '2026-03-01T10:00:00Z', 'example-project', 120000, ?, '{}')
    `).run(JSON.stringify(["project:example-project", "category:ai coding"]));

    const { projects } = await getCodingProjects(wrapDatabase(db));
    const p = projects.find((x) => x.name === "example-project");
    expect(p).toBeDefined();
    expect(p?.primaryLanguage).toBeNull();
  });

  test("multi-language session: primaryLanguage tracks the dominant language by heartbeat count", async () => {
    // A session tagged with both TypeScript and Markdown but with TypeScript
    // dominant in raw_data.languages must report TypeScript as primary.
    // (Tags alone would tie 1-1; the proportional ranking from raw_data
    //  resolves this correctly.)
    db.prepare(`
      INSERT INTO events (
        source, source_id, type, timestamp, title, duration_ms, tags, raw_data
      ) VALUES ('wakatime', 'multi-lang-1', 'code:session', '2026-03-02T10:00:00Z', 'timeline (TypeScript)', 600000, ?, ?)
    `).run(
      JSON.stringify(["language:TypeScript", "language:Markdown", "project:timeline"]),
      JSON.stringify({ languages: { TypeScript: 80, Markdown: 20 } }),
    );

    const { projects } = await getCodingProjects(wrapDatabase(db));
    const p = projects.find((x) => x.name === "timeline");
    expect(p?.primaryLanguage).toBe("TypeScript");
  });

  test("AI-only project (claude-code) appears even without WakaTime data", async () => {
    insertClaudeCodeMessage({
      sourceId: "cc1",
      conversationId: "conv-infra-1",
      title: "infra (abcd1234)",
      timestamp: "2026-02-01T10:00:00Z",
      role: "user",
    });
    insertClaudeCodeMessage({
      sourceId: "cc2",
      conversationId: "conv-infra-1",
      title: "infra (abcd1234)",
      timestamp: "2026-02-01T10:00:01Z",
      role: "assistant",
    });
    insertClaudeCodeMessage({
      sourceId: "cc3",
      conversationId: "conv-infra-2",
      title: "infra (abcd1234)",
      timestamp: "2026-02-02T10:00:00Z",
      role: "user",
    });

    const { projects } = await getCodingProjects(wrapDatabase(db));

    expect(projects).toHaveLength(1);
    const p = projects[0];
    expect(p.name).toBe("infra");
    expect(p.totalDuration).toBe(0);
    expect(p.sessionCount).toBe(0);
    expect(p.conversationCount).toBe(2);
    expect(p.messageCount).toBe(3);
    expect(p.aiSources).toEqual(["claude-code"]);
  });

  test("mixed project merges WakaTime + AI stats and dedupes sources", async () => {
    insertWakaTimeSession({
      sourceId: "w1",
      title: "timeline (TypeScript)",
      durationMs: 60_000,
      timestamp: "2026-01-01T10:00:00Z",
      language: "TypeScript",
    });
    insertClaudeCodeMessage({
      sourceId: "cc1",
      conversationId: "conv-tl-1",
      title: "timeline (slug)",
      timestamp: "2026-01-05T10:00:00Z",
      role: "user",
    });
    insertConductorMessage({
      sourceId: "cd1",
      conversationId: "conv-tl-cd-1",
      title: "timeline / main: Add tests",
      timestamp: "2026-01-10T10:00:00Z",
      repoName: "timeline",
      role: "user",
    });

    const { projects } = await getCodingProjects(wrapDatabase(db));

    expect(projects).toHaveLength(1);
    const p = projects[0];
    expect(p.name).toBe("timeline");
    expect(p.totalDuration).toBe(60_000);
    expect(p.sessionCount).toBe(1);
    expect(p.conversationCount).toBe(2);
    expect(p.aiSources).toEqual(["claude-code", "conductor"]);
    expect(p.lastActivity).toBe("2026-01-10T10:00:00Z");
    expect(p.firstActivity).toBe("2026-01-01T10:00:00Z");
  });

  test("amp under conductor/workspaces rolls up to the repo name", async () => {
    insertAmpMessage({
      sourceId: "a1",
      title: "infra: refactor",
      timestamp: "2026-03-01T10:00:00Z",
      workspaceRoots: ["/Users/x/conductor/workspaces/infra/work-v1"],
      role: "user",
    });
    insertAmpMessage({
      sourceId: "a2",
      title: "infra: refactor",
      timestamp: "2026-03-01T10:00:01Z",
      workspaceRoots: ["/Users/x/conductor/workspaces/infra/work-v2"],
      role: "user",
    });

    const { projects } = await getCodingProjects(wrapDatabase(db));

    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe("infra");
    expect(projects[0].aiSources).toEqual(["amp"]);
  });

  test("amp outside conductor uses path basename", async () => {
    insertAmpMessage({
      sourceId: "a1",
      title: "side-project: thing",
      timestamp: "2026-03-01T10:00:00Z",
      workspaceRoots: ["/Users/x/Developer/side-project"],
      role: "user",
    });

    const { projects } = await getCodingProjects(wrapDatabase(db));

    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe("side-project");
  });

  test("opencode under conductor/workspaces rolls up to the repo name", async () => {
    insertOpencodeMessage({
      sourceId: "o1",
      conversationId: "oc-1",
      title: "timeline: tweak",
      timestamp: "2026-04-01T10:00:00Z",
      projectPath: "/Users/x/conductor/workspaces/timeline/main",
      role: "user",
    });

    const { projects } = await getCodingProjects(wrapDatabase(db));

    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe("timeline");
    expect(projects[0].aiSources).toEqual(["opencode"]);
  });

  test("sorts by most recent activity descending", async () => {
    insertWakaTimeSession({
      sourceId: "w1",
      title: "old-project (TypeScript)",
      durationMs: 600_000,
      timestamp: "2025-01-01T10:00:00Z",
    });
    insertClaudeCodeMessage({
      sourceId: "cc1",
      conversationId: "conv-recent",
      title: "new-project (slug)",
      timestamp: "2026-05-01T10:00:00Z",
      role: "user",
    });

    const { projects } = await getCodingProjects(wrapDatabase(db));

    expect(projects).toHaveLength(2);
    expect(projects[0].name).toBe("new-project");
    expect(projects[1].name).toBe("old-project");
  });

  test("search filters by name (case-insensitive)", async () => {
    insertWakaTimeSession({
      sourceId: "w1",
      title: "timeline (TypeScript)",
      durationMs: 60_000,
      timestamp: "2026-01-01T10:00:00Z",
    });
    insertClaudeCodeMessage({
      sourceId: "cc1",
      conversationId: "conv-infra",
      title: "infra (slug)",
      timestamp: "2026-01-02T10:00:00Z",
      role: "user",
    });

    const { projects } = await getCodingProjects(wrapDatabase(db), { search: "INFRA" });

    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe("infra");
  });

  test("respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      insertWakaTimeSession({
        sourceId: `w${i}`,
        title: `project-${i} (TypeScript)`,
        durationMs: 10_000,
        timestamp: `2026-01-0${i + 1}T10:00:00Z`,
      });
    }

    const { projects } = await getCodingProjects(wrapDatabase(db), { limit: 3 });

    expect(projects).toHaveLength(3);
  });
});
