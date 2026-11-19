import { join } from "node:path";
import { importClaudeExport } from "./parser";
import type { SeedSource } from "../../seed/context";
import { SELF } from "../../seed/persona";
import { planChatConversations, zipFlat } from "../../seed/sources/assistant-chat-data";
import { iso } from "../../seed/sources/coding-data";

/** A stable operator-supplied account name, independent of the export UUID. */
const ACCOUNT = SELF.email;

export const claudeSeed: SeedSource = {
  name: "claude",
  produces: { claude: ["claude:message:user", "claude:message:assistant", "claude:memory", "claude:project"] },
  async seed(ctx) {
    const rng = ctx.rng("claude");
    const conversations = planChatConversations(ctx, ctx.rng("claude:plan"), {
      fromDaysAgo: 900,
      toDaysAgo: 0,
      conversations: 180,
      extraTurns: [1, 3],
    });
    const accountUuid = rng.uuid();
    const projectUuid = rng.uuid();

    const exported = conversations.map((conv, index) => {
      const messages: Record<string, unknown>[] = [];
      for (const turn of conv.turns) {
        messages.push({
          uuid: rng.uuid(),
          text: turn.ask,
          content: [{ type: "text", text: turn.ask, citations: [] }],
          sender: "human",
          created_at: iso(turn.askAt),
          updated_at: iso(turn.askAt),
          attachments: [],
          files: [],
        });
        const content: Record<string, unknown>[] = [];
        if (turn.thinking) {
          content.push({ type: "thinking", thinking: turn.thinking, summaries: [{ summary: "Thinking about the user's request" }], cut_off: false });
        }
        if (turn.search) {
          content.push({ type: "text", text: "Let me check what's current.", citations: [] });
          content.push({
            type: "tool_use",
            name: "web_search",
            input: { query: turn.search.query },
            message: "Searching the web",
            integration_name: "Web Search",
          });
          content.push({
            type: "tool_result",
            name: "web_search",
            content: turn.search.results.map((r) => ({ type: "knowledge", title: r.title, url: r.url, text: `${r.title} — latest information.` })),
            is_error: false,
          });
        }
        content.push({
          type: "text",
          text: turn.answer,
          citations: turn.search ? turn.search.results.slice(0, 1).map((r) => ({ url: r.url, title: r.title, start_index: 0, end_index: 20 })) : [],
        });
        messages.push({
          uuid: rng.uuid(),
          text: turn.answer,
          content,
          sender: "assistant",
          created_at: iso(turn.answerAt),
          updated_at: iso(turn.answerAt),
          attachments: [],
          files: [],
        });
      }
      if (index % 12 === 0) {
        const assistant = messages[1];
        if (!assistant || !Array.isArray(assistant.content)) throw new Error("Missing synthetic assistant response");
        assistant.content.push({ type: "tool_result", name: "memory", structured_content: { documents: [{ path_segments: ["projects", projectUuid, "notes.md"] }] } });
      }
      const first = conv.turns[0];
      const last = conv.turns.at(-1);
      if (!first || !last) throw new Error("empty Claude conversation");
      return {
        uuid: rng.uuid(),
        name: conv.title,
        summary: "",
        created_at: iso(first.askAt),
        updated_at: iso(last.answerAt),
        account: { uuid: accountUuid },
        chat_messages: messages,
      };
    });

    const anchor = ctx.localIso(ctx.anchorDate, 6);
    const memories = [
      {
        conversations_memory:
          "**Work context**\nAlex is a senior software engineer at Northwind Analytics in Seattle, working on the Go ingest pipeline (Kafka consumers, batch writers, schema validation).\n\n**Personal context**\nAlex hikes most weekends with a small group of friends, is building a hiking trip planner called trailhead in TypeScript, keeps a Rust budgeting CLI (pocket-ledger), and monitors balcony plants with a Python sensor project. Their sister Mei lives in Portland and is training for a half marathon.\n\n**Preferences**\nPrefers concise answers with code examples, Scoped Commits-style messages,, and hiking stats in miles and feet.",
        project_memories: {},
        account_uuid: accountUuid,
        updated_at: anchor,
        key_facts: ["Lives on Capitol Hill, Seattle", "Hikes most weekends", "Works in Go at Northwind Analytics", "Side projects in TypeScript, Rust, and Python"],
      },
    ];

    const dir = ctx.stage("claude");
    const conversationsPath = ctx.writeStaged("claude", "export/conversations.json", JSON.stringify(exported));
    ctx.writeStaged("claude", "export/memories.json", JSON.stringify(memories));
    ctx.writeStaged(
      "claude",
      "export/users.json",
      JSON.stringify([{ uuid: accountUuid, full_name: SELF.name, email_address: SELF.email, verified_phone_number: null }]),
    );
    const zipPath = join(dir, "conversations-000.zip");
    await zipFlat(zipPath, [conversationsPath]);
    const legacyZip = join(dir, "legacy.zip");
    await zipFlat(legacyZip, [conversationsPath, join(dir, "export/memories.json"), join(dir, "export/users.json")]);
    await importClaudeExport(ctx.db, legacyZip, ACCOUNT);
    ctx.writeStaged("claude", `new-memories/memories/${accountUuid}.json`, JSON.stringify({
      account_uuid: accountUuid, conversations_memory: memories[0].conversations_memory,
      project_memories: { [projectUuid]: "A synthetic planning project." }, memory_files: [{ path: `/notes/${projectUuid}/preferences.md`, content: "Prefer concise examples.", updated_at: anchor }],
    }));
    const memoryZip = join(dir, "memories-000.zip");
    const proc = Bun.spawn(["zip", "-q", memoryZip, `memories/${accountUuid}.json`], { cwd: join(dir, "new-memories") });
    if (await proc.exited !== 0) throw new Error("Could not create synthetic Claude memory ZIP");
    ctx.writeStaged("claude", `new-projects/projects/${projectUuid}.json`, JSON.stringify({ uuid: projectUuid, name: "Synthetic planner", description: "Plan fictional walks", prompt_template: "Use concise examples", is_private: true, is_starter_project: false, created_at: anchor, updated_at: anchor, creator: { uuid: accountUuid, full_name: "Alice" }, docs: [{ uuid: rng.uuid(), filename: "notes.md", content: "Fictional project notes", created_at: anchor }] }));
    const projectZip = join(dir, "projects-000.zip");
    const projectProc = Bun.spawn(["zip", "-q", projectZip, `projects/${projectUuid}.json`], { cwd: join(dir, "new-projects") });
    if (await projectProc.exited !== 0) throw new Error("Could not create synthetic project ZIP");
    await importClaudeExport(ctx.db, projectZip, ACCOUNT);
    await importClaudeExport(ctx.db, memoryZip, ACCOUNT);
    await importClaudeExport(ctx.db, zipPath, ACCOUNT);
    ctx.identify("alex", `claude:${ACCOUNT}`);
  },
};
