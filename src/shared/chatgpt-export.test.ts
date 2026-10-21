import { describe, expect, test } from "bun:test";
import { findChatGPTConversationFiles } from "./chatgpt-export";

describe("findChatGPTConversationFiles", () => {
  test("finds supported names and sorts numbered chunks numerically", () => {
    expect(
      findChatGPTConversationFiles([
        "/export/conversations (10).json",
        "/export/shared_conversations.json",
        "/export/conversations_2.json",
        "/export/conversations.json",
        "/export/conversations-1.json",
      ])
    ).toEqual([
      "/export/conversations.json",
      "/export/conversations-1.json",
      "/export/conversations_2.json",
      "/export/conversations (10).json",
    ]);
  });
});
