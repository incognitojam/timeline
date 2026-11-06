import { describe, expect, it } from "bun:test";
import {
  type ContentBlock,
  extractText,
  toContentBlocks,
} from "./format-content";

describe("extractText", () => {
  it("returns empty string for empty array", () => {
    expect(extractText([])).toBe("");
  });

  it("joins multiple text blocks with double newlines", () => {
    const blocks: ContentBlock[] = [
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ];
    expect(extractText(blocks)).toBe("first\n\nsecond");
  });

  it("ignores thinking, tool_use, and tool_result blocks", () => {
    const blocks: ContentBlock[] = [
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "visible" },
      { type: "tool_use", name: "Bash", input: { command: "ls" } },
      { type: "tool_result", tool_use_id: "abc", content: "file.txt" },
    ];
    expect(extractText(blocks)).toBe("visible");
  });

  it("returns empty string when there are no text blocks", () => {
    const blocks: ContentBlock[] = [
      { type: "tool_use", name: "Bash", input: { command: "ls" } },
      { type: "tool_result", tool_use_id: "abc", content: "file.txt" },
    ];
    expect(extractText(blocks)).toBe("");
  });

  it("skips text blocks with missing or empty text", () => {
    const blocks: ContentBlock[] = [
      { type: "text" },
      { type: "text", text: "" },
      { type: "text", text: "real" },
    ];
    expect(extractText(blocks)).toBe("real");
  });

  it("includes summary block text but ignores image blocks", () => {
    const blocks: ContentBlock[] = [
      { type: "image", media_type: "image/png" },
      { type: "summary", summary_type: "message", text: "conversation summary" },
    ];
    expect(extractText(blocks)).toBe("conversation summary");
  });
});

describe("toContentBlocks", () => {
  it("wraps a plain string as a single text block", () => {
    expect(toContentBlocks("hello world")).toEqual([
      { type: "text", text: "hello world" },
    ]);
  });

  it("returns an empty array for an empty string", () => {
    expect(toContentBlocks("")).toEqual([]);
  });

  it("parses a valid ContentBlock[]", () => {
    const blocks = [
      { type: "text", text: "hi" },
      { type: "tool_use", name: "Bash", id: "t1", input: { command: "ls" } },
      { type: "tool_result", tool_use_id: "t1", content: "ok" },
    ] satisfies ContentBlock[];
    expect(toContentBlocks(blocks)).toEqual(blocks);
  });

  it("preserves unknown source fields on valid blocks", () => {
    const blocks = [
      {
        type: "text",
        text: "hi",
        source_metadata: { provider: "example" },
      },
    ] satisfies ContentBlock[];
    expect(toContentBlocks(blocks)).toEqual(blocks);
  });

  it("accepts explicit nulls for nullable source fields", () => {
    const blocks = toContentBlocks([
      {
        type: "tool_use",
        name: "Web Fetch",
        id: null,
        message: null,
        integration_name: null,
        integration_icon_url: null,
        input: null,
      },
      {
        type: "tool_result",
        tool_use_id: null,
        error: null,
        content: "ok",
      },
      {
        type: "flag",
        flag: null,
        helpline: {
          name: "Support",
          url: null,
          web_chat_url: null,
        },
      },
    ]);

    expect(blocks).toHaveLength(3);
    expect(blocks[0]?.id).toBeUndefined();
    expect(blocks[0]?.message).toBeUndefined();
    expect(blocks[0]?.integration_name).toBeUndefined();
    expect(blocks[0]?.integration_icon_url).toBeUndefined();
    expect(blocks[0]?.input).toBeUndefined();
    expect(blocks[1]?.tool_use_id).toBeUndefined();
    expect(blocks[1]?.error).toBeUndefined();
    expect(blocks[2]?.flag).toBeUndefined();
    expect(JSON.stringify(blocks)).not.toContain("null");
  });

  it("accepts non-record tool inputs", () => {
    expect(toContentBlocks([
      { type: "tool_use", name: "WeirdTool", input: "raw input" },
    ])).toEqual([
      { type: "tool_use", name: "WeirdTool", input: "raw input" },
    ]);
  });

  it("preserves invalid blocks as unknown blocks", () => {
    expect(toContentBlocks([{ text: "missing type" }])).toEqual([
      { type: "unknown", raw: { text: "missing type" } },
    ]);
  });

  it("keeps valid siblings when one block is invalid", () => {
    expect(toContentBlocks([
      { type: "text", text: "visible" },
      { text: "missing type" },
      { type: "tool_result", tool_use_id: "t1", content: "ok" },
    ])).toEqual([
      { type: "text", text: "visible" },
      { type: "unknown", raw: { text: "missing type" } },
      { type: "tool_result", tool_use_id: "t1", content: "ok" },
    ]);
  });

  it("returns an empty array for null or undefined", () => {
    expect(toContentBlocks(null)).toEqual([]);
    expect(toContentBlocks(undefined)).toEqual([]);
  });
});
