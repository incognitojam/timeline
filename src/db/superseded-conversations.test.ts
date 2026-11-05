/**
 * End to end through the real importers: a T3 Code thread supersedes the
 * Claude Code / Codex transcripts of the sessions it drove, and T3's
 * title-generation sessions leave conversation lists, without any of their
 * events being deleted.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "crypto";
import { mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { importClaudeCode } from "../parsers/claude-code";
import { createT3CodeV2Fixture, FIXTURE } from "../parsers/fixtures/t3code/statev2-fixture";
import { importT3Code } from "../parsers/t3code";
import { getCodingProjectConversations, getCodingProjects } from "./coding-projects";
import { getContactConversations } from "./contacts";
import { listCodingAgentConversationProjects, listCodingAgentConversations, listConversationSources } from "./conversations";
import { wrapDatabase } from "./pool";
import { initDb } from "./schema";
import { changedSupersededConversations, markConversationsSuperseded } from "./superseded-conversations";

const TITLE_SESSION = "title-session-0001";

describe("superseded conversations", () => {
  let db: Database;
  let root: string;
  let claudeDir: string;
  let priorMediaPath: string | undefined;

  async function writeClaudeSession(projectDir: string, sessionId: string, cwd: string, text: string) {
    await mkdir(join(claudeDir, projectDir), { recursive: true });
    const line = JSON.stringify({
      type: "user",
      uuid: `${sessionId}-u1`,
      timestamp: "2026-05-01T10:00:05.000Z",
      sessionId,
      cwd,
      message: { role: "user", content: text },
    });
    await writeFile(join(claudeDir, projectDir, `${sessionId}.jsonl`), `${line}\n`);
  }

  function insertCodexEvent(conversationId: string): void {
    db.prepare(`
      INSERT INTO events (source, source_id, source_account, type, timestamp, title, raw_data, conversation_id)
      VALUES ('codex', ?, 'alice', 'codex:message:user', '2026-05-01T10:10:05.000Z', 'demo-1a2b', ?, ?)
    `).run(`${conversationId}:1`, JSON.stringify({ session_id: conversationId, cwd: "/home/alice/.t3/worktrees/demo-app/demo-1a2b" }), conversationId);
  }

  beforeEach(async () => {
    db = new Database(":memory:");
    initDb(db);
    root = join(tmpdir(), `superseded-${randomUUID()}`);
    claudeDir = join(root, "claude");
    priorMediaPath = process.env.TIMELINE_MEDIA_PATH;
    process.env.TIMELINE_MEDIA_PATH = join(root, "media");
    await mkdir(join(root, "t3", "attachments"), { recursive: true });
    await writeFile(join(root, "t3", "attachments", `${FIXTURE.image.id}.png`), FIXTURE.image.bytes);
    createT3CodeV2Fixture(join(root, "t3", "statev2.sqlite")).close();

    // The Claude Code transcript of MAIN's claudeAgent session, titled by
    // its worktree directory like any other session.
    await writeClaudeSession(
      "-home-alice--t3-worktrees-demo-app-demo-1a2b",
      FIXTURE.nativeSessions.claudeAgent,
      "/home/alice/.t3/worktrees/demo-app/demo-1a2b",
      "Please add a login form like this mockup"
    );
    // A title-generation session imported before the parser skipped them.
    db.prepare(`
      INSERT INTO events (source, source_id, source_account, type, timestamp, title, raw_data, conversation_id)
      VALUES ('claude-code', ?, 'alice', 'claude-code:message:user', '2026-05-01T10:00:01.000Z', 't3code-claude-title-AbC123', '{}', ?)
    `).run(`${TITLE_SESSION}:u1`, TITLE_SESSION);
    await writeClaudeSession(
      "-tmp-t3code-claude-title-AbC123",
      TITLE_SESSION,
      "/tmp/t3code-claude-title-AbC123",
      "Title this thread"
    );
    insertCodexEvent(FIXTURE.nativeSessions.codex);
  });

  afterEach(async () => {
    db.close();
    if (priorMediaPath === undefined) delete process.env.TIMELINE_MEDIA_PATH;
    else process.env.TIMELINE_MEDIA_PATH = priorMediaPath;
    await rm(root, { recursive: true, force: true });
  });

  async function importAll() {
    const claude = await importClaudeCode(db, claudeDir, "alice");
    const t3 = await importT3Code(db, join(root, "t3", "statev2.sqlite"), "alice");
    return { claude, t3 };
  }

  it("records provider sessions of imported threads and title-generation sessions", async () => {
    const { claude, t3 } = await importAll();
    expect(claude.titleGenerationSessions).toBe(1);
    // claudeAgent + codex; antigravity has no Timeline importer.
    expect(t3.supersededConversations).toBe(2);
    expect(
      db.prepare(`
        SELECT source, source_account, conversation_id, reason,
          canonical_source, canonical_source_account, canonical_conversation_id
        FROM superseded_conversations ORDER BY source, conversation_id
      `).all()
    ).toEqual([
      {
        source: "claude-code",
        source_account: "alice",
        conversation_id: FIXTURE.nativeSessions.claudeAgent,
        reason: "orchestrated",
        canonical_source: "t3code",
        canonical_source_account: "alice",
        canonical_conversation_id: FIXTURE.threads.main,
      },
      {
        source: "claude-code",
        source_account: "alice",
        conversation_id: TITLE_SESSION,
        reason: "title_generation",
        canonical_source: null,
        canonical_source_account: null,
        canonical_conversation_id: null,
      },
      {
        source: "codex",
        source_account: "alice",
        conversation_id: FIXTURE.nativeSessions.codex,
        reason: "orchestrated",
        canonical_source: "t3code",
        canonical_source_account: "alice",
        canonical_conversation_id: FIXTURE.threads.main,
      },
    ]);
  });

  it("lists the T3 thread once and keeps the superseded events", async () => {
    await importAll();
    const { conversations } = await listCodingAgentConversations(wrapDatabase(db), { limit: 100 });
    const keys = conversations.map((c) => `${c.source}:${c.conversationId}`);
    expect(keys).toContain(`t3code:${FIXTURE.threads.main}`);
    expect(keys).not.toContain(`claude-code:${FIXTURE.nativeSessions.claudeAgent}`);
    expect(keys).not.toContain(`codex:${FIXTURE.nativeSessions.codex}`);
    expect(keys).not.toContain(`claude-code:${TITLE_SESSION}`);

    const kept = db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE conversation_id IN (?, ?, ?)")
      .get(FIXTURE.nativeSessions.claudeAgent, FIXTURE.nativeSessions.codex, TITLE_SESSION);
    expect(kept).toEqual({ n: 3 });
  });

  it("drops worktree and title-generation phantom projects from the Coding tab", async () => {
    await importAll();
    const { projects } = await getCodingProjects(wrapDatabase(db));
    expect(projects.map((p) => p.name).sort()).toEqual([FIXTURE.projectTitle]);

    const { conversations } = await getCodingProjectConversations(wrapDatabase(db), FIXTURE.projectTitle);
    expect(new Set(conversations.map((c) => c.source))).toEqual(new Set(["t3code"]));
  });

  it("leaves superseded conversations out of project and source counts", async () => {
    await importAll();
    const read = wrapDatabase(db);
    const { conversations, total } = await listCodingAgentConversations(read, { limit: 100 });
    expect(total).toBe(conversations.length);

    const { projects: listed } = await getCodingProjects(read);
    const project = listed.find((p) => p.name === FIXTURE.projectTitle);
    expect(project?.aiSources).toEqual(["t3code"]);
    expect(project?.conversationCount).toBe(conversations.filter((c) => c.project === FIXTURE.projectTitle).length);

    const { projects, unassigned } = await listCodingAgentConversationProjects(read);
    expect(projects.reduce((sum, p) => sum + p.count, unassigned)).toBe(total);
    expect(await listConversationSources(read, "coding")).toEqual(["t3code"]);

    // Their rows stay in the maintained tables; only reads leave them out.
    const summaries = db
      .prepare("SELECT COUNT(*) AS n FROM conversation_summaries WHERE source IN ('claude-code', 'codex')")
      .get();
    expect(summaries).toEqual({ n: 3 });
  });

  it("only supersedes transcripts imported under the thread's account", async () => {
    await importClaudeCode(db, claudeDir, "alice");
    // The same T3 database imported as another machine's account.
    await importT3Code(db, join(root, "t3", "statev2.sqlite"), "alice@laptop");
    const { conversations } = await listCodingAgentConversations(wrapDatabase(db), { limit: 100 });
    const keys = conversations.map((c) => `${c.source}:${c.sourceAccount}:${c.conversationId}`);
    expect(keys).toContain(`claude-code:alice:${FIXTURE.nativeSessions.claudeAgent}`);
    expect(keys).toContain(`codex:alice:${FIXTURE.nativeSessions.codex}`);
  });

  it("supersedes only the host account sharing the thread's name, whichever imports first", async () => {
    await importT3Code(db, join(root, "t3", "statev2.sqlite"), "alice@laptop");
    await importClaudeCode(db, claudeDir, "alice@laptop");
    await importClaudeCode(db, claudeDir, "alice");
    const { conversations } = await listCodingAgentConversations(wrapDatabase(db), { limit: 100 });
    const keys = conversations.map((c) => `${c.source}:${c.sourceAccount}:${c.conversationId}`);
    expect(keys).not.toContain(`claude-code:alice@laptop:${FIXTURE.nativeSessions.claudeAgent}`);
    expect(keys).toContain(`claude-code:alice:${FIXTURE.nativeSessions.claudeAgent}`);
    expect(keys).toContain(`t3code:alice@laptop:${FIXTURE.threads.main}`);
  });

  it("lists a transcript again once its canonical thread's events are gone", async () => {
    await importAll();
    db.prepare("DELETE FROM events WHERE source = 't3code' AND conversation_id = ?").run(FIXTURE.threads.main);
    const { conversations } = await listCodingAgentConversations(wrapDatabase(db), { limit: 100 });
    const keys = conversations.map((c) => `${c.source}:${c.conversationId}`);
    expect(keys).toContain(`claude-code:${FIXTURE.nativeSessions.claudeAgent}`);
    expect(keys).not.toContain(`claude-code:${TITLE_SESSION}`);
  });

  it("hides title-generation sessions whose files are gone, by title", async () => {
    await rm(join(claudeDir, "-tmp-t3code-claude-title-AbC123"), { recursive: true });
    const stats = await importClaudeCode(db, claudeDir, "alice");
    expect(stats.titleGenerationSessions).toBe(0);
    const { conversations } = await listCodingAgentConversations(wrapDatabase(db), { limit: 100 });
    expect(conversations.map((c) => c.conversationId)).not.toContain(TITLE_SESSION);
  });

  it("leaves superseded conversations out of a contact's conversations", async () => {
    await importAll();
    db.prepare("UPDATE events SET people = ? WHERE conversation_id IN (?, ?)").run(
      JSON.stringify(["contact:42"]),
      FIXTURE.nativeSessions.claudeAgent,
      FIXTURE.threads.main,
    );
    const conversations = await getContactConversations(wrapDatabase(db), 42);
    expect(conversations.map((c) => c.source)).toEqual(["t3code"]);
  });

  it("keeps the last canonical thread when one session is linked twice", () => {
    const row = (conversationId: string) => ({
      source: "codex",
      sourceAccount: "alice",
      conversationId: "shared-session",
      reason: "orchestrated" as const,
      canonical: { source: "t3code", sourceAccount: "alice", conversationId },
    });
    const rows = [row("thread-a"), row("thread-b")];
    markConversationsSuperseded(db, rows);
    expect(changedSupersededConversations(db, rows)).toEqual([]);
    markConversationsSuperseded(db, changedSupersededConversations(db, rows));
    expect(db.prepare("SELECT canonical_conversation_id AS id FROM superseded_conversations WHERE conversation_id = 'shared-session'").get())
      .toEqual({ id: "thread-b" });
  });

  it("does not supersede transcripts of threads that were never imported", async () => {
    await importClaudeCode(db, claudeDir, "alice");
    await importT3Code(null, join(root, "t3", "statev2.sqlite"), "alice", { dryRun: true });
    const { conversations } = await listCodingAgentConversations(wrapDatabase(db), { limit: 100 });
    expect(conversations.map((c) => `${c.source}:${c.conversationId}`)).toContain(
      `claude-code:${FIXTURE.nativeSessions.claudeAgent}`
    );
  });
});
