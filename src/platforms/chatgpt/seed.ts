import { join } from "node:path";
import { importChatGPTExport } from "./parser";
import type { SeedSource } from "../../seed/context";
import { SELF } from "../../seed/persona";
import { planChatConversations, zipFlat } from "../../seed/sources/assistant-chat-data";

/** ChatGPT exports are imported under the account's email. */
const ACCOUNT = SELF.email;

/** Model in use for a conversation, by how long ago it happened. */
function modelFor(daysAgo: number, technical: boolean, roll: number): string {
  if (daysAgo > 870) return "gpt-4";
  if (daysAgo > 600) return roll < 0.15 ? "gpt-4o-mini" : "gpt-4o";
  if (technical && roll < 0.4) return daysAgo > 520 ? "o1-preview" : "o3-mini";
  return roll < 0.1 ? "gpt-4o-mini" : "gpt-4o";
}

export const chatgptSeed: SeedSource = {
  name: "chatgpt",
  produces: { chatgpt: ["chatgpt:message:user", "chatgpt:message:assistant"] },
  async seed(ctx) {
    const rng = ctx.rng("chatgpt");
    // Alex used ChatGPT before mostly switching to Claude.
    const conversations = planChatConversations(ctx, ctx.rng("chatgpt:plan"), {
      fromDaysAgo: 1090,
      toDaysAgo: 330,
      conversations: 135,
      extraTurns: [1, 3],
    });

    const exported = conversations.map((conv) => {
      const id = rng.uuid();
      const model = modelFor(conv.day.daysAgo, conv.technical, rng.next());
      const rootId = rng.uuid();
      const systemId = rng.uuid();
      const first = conv.turns[0];
      const last = conv.turns.at(-1);
      if (!first || !last) throw new Error("empty ChatGPT conversation");
      const mapping: Record<string, Record<string, unknown>> = {
        [rootId]: { id: rootId, message: null, parent: null, children: [systemId] },
        [systemId]: {
          id: systemId,
          message: {
            id: systemId,
            author: { role: "system", name: null, metadata: {} },
            create_time: null,
            update_time: null,
            content: { content_type: "text", parts: [""] },
            status: "finished_successfully",
            end_turn: true,
            weight: 0,
            metadata: { is_visually_hidden_from_conversation: true },
            recipient: "all",
          },
          parent: rootId,
          children: [],
        },
      };
      let parent = systemId;
      const addNode = (role: "user" | "assistant", text: string, at: number) => {
        const nodeId = rng.uuid();
        const parentNode = mapping[parent];
        if (!parentNode) throw new Error("ChatGPT mapping parent missing");
        parentNode.children = [nodeId];
        mapping[nodeId] = {
          id: nodeId,
          message: {
            id: nodeId,
            author: { role, name: null, metadata: {} },
            create_time: at / 1000,
            update_time: role === "assistant" ? at / 1000 : null,
            content: { content_type: "text", parts: [text] },
            status: "finished_successfully",
            end_turn: role === "assistant" ? true : null,
            weight: 1,
            metadata: role === "assistant" ? { model_slug: model, default_model_slug: model, finish_details: { type: "stop" } } : {},
            recipient: "all",
          },
          parent,
          children: [],
        };
        parent = nodeId;
      };
      for (const turn of conv.turns) {
        addNode("user", turn.ask, turn.askAt);
        addNode("assistant", turn.answer, turn.answerAt);
      }
      return {
        title: conv.title,
        create_time: first.askAt / 1000,
        update_time: last.answerAt / 1000,
        mapping,
        moderation_results: [],
        current_node: parent,
        plugin_ids: null,
        conversation_id: id,
        id,
        default_model_slug: model,
        is_archived: conv.day.daysAgo > 900 && rng.chance(0.2),
        is_starred: rng.chance(0.05),
      };
    });

    const dir = ctx.stage("chatgpt");
    const conversationsPath = ctx.writeStaged("chatgpt", "export/conversations.json", JSON.stringify(exported));
    const userPath = ctx.writeStaged("chatgpt", "export/user.json", JSON.stringify({ id: `user-${rng.hex(24)}`, email: SELF.email, chatgpt_plus_user: true }));
    const zipPath = join(dir, "chatgpt-export.zip");
    await zipFlat(zipPath, [conversationsPath, userPath]);

    await ctx.inTransaction(() => importChatGPTExport(ctx.db, zipPath, ACCOUNT));
    ctx.identify("alex", `chatgpt:${ACCOUNT}`);
  },
};
