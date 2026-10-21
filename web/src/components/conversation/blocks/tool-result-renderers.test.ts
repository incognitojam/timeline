import { describe, expect, it } from "vitest";
import {
  extractResultText,
  parseConversationSearchResults,
  parseWebSearchResults,
} from "./tool-result-renderers";

describe("extractResultText", () => {
  it("returns string content as-is", () => {
    expect(
      extractResultText({ type: "tool_result", content: "hello" })
    ).toBe("hello");
  });

  it("concatenates text blocks from array content", () => {
    expect(
      extractResultText({
        type: "tool_result",
        content: [
          { type: "text", text: "one" },
          { type: "text", text: "two" },
          { type: "knowledge", text: "ignored" } as unknown,
        ],
      })
    ).toBe("one\ntwo");
  });

  it("returns null when nothing matches", () => {
    expect(extractResultText({ type: "tool_result", content: null })).toBeNull();
    expect(extractResultText({ type: "tool_result", content: [] })).toBeNull();
  });
});

describe("parseConversationSearchResults", () => {
  it("extracts chat entries with url, timestamp, title, and preview", () => {
    const text = `<chat url='https://claude.ai/chat/abc' updated_at=2099-01-05T12:33:43.196132+00:00>Example project notification
Body text here that goes on for a while.
<chat_conversation>Inner body that should be stripped.</chat_conversation></chat>

<chat url='https://claude.ai/chat/def' updated_at=2099-01-01T08:00:00+00:00>Another conversation title
Some more detail.</chat>`;

    const hits = parseConversationSearchResults(text);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({
      url: "https://claude.ai/chat/abc",
      updatedAt: "2099-01-05T12:33:43.196132+00:00",
      title: "Example project notification",
    });
    expect(hits[0].preview).toContain("Body text here");
    expect(hits[0].preview).not.toContain("Inner body");
    expect(hits[1].title).toBe("Another conversation title");
  });

  it("returns empty array when no chat tags are present", () => {
    expect(parseConversationSearchResults("just plain text")).toEqual([]);
  });
});

describe("parseWebSearchResults", () => {
  it("extracts knowledge entries from structured content", () => {
    const hits = parseWebSearchResults({
      type: "tool_result",
      content: [
        {
          type: "knowledge",
          title: "Getting Started with Local MCP Servers",
          url: "https://support.claude.com/en/articles/10949351",
          metadata: {
            type: "webpage_metadata",
            site_domain: "claude.com",
            favicon_url: "https://www.google.com/s2/favicons?sz=64&domain=claude.com",
            site_name: "Claude",
          },
          is_missing: false,
          text: "The Model Context Protocol (MCP) is an open protocol...",
        },
        { type: "text", text: "ignored" },
      ],
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      title: "Getting Started with Local MCP Servers",
      url: "https://support.claude.com/en/articles/10949351",
      siteName: "Claude",
      siteDomain: "claude.com",
      faviconUrl: "https://www.google.com/s2/favicons?sz=64&domain=claude.com",
      isMissing: false,
    });
  });

  it("tolerates missing metadata fields", () => {
    const hits = parseWebSearchResults({
      type: "tool_result",
      content: [{ type: "knowledge", title: "Bare entry", url: "https://x" }],
    });
    expect(hits[0]).toMatchObject({
      title: "Bare entry",
      url: "https://x",
      siteName: null,
      faviconUrl: null,
    });
  });

  it("returns empty array when content is not an array", () => {
    expect(
      parseWebSearchResults({ type: "tool_result", content: "string" })
    ).toEqual([]);
  });
});
