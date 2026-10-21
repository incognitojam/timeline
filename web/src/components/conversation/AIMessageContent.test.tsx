import { fireEvent, render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import type { Attachment } from "../../lib/api";
import type { ContentBlock } from "../../lib/content-blocks";
import { AIMessageContent } from "./AIMessageContent";

function imageAttachment(): Attachment {
  return {
    id: 3,
    event_id: 1,
    source: "claude-code",
    source_id: "0",
    filename: "screenshot.png",
    mime_type: "image/png",
    file_size: 100,
    storage_path: "claude-code/tester/s/m/screenshot.png",
    status: "stored",
    width: null,
    height: null,
    thumbhash: null,
    description: null,
  };
}

describe("AIMessageContent", () => {
  it("renders a text block as markdown", () => {
    const blocks: ContentBlock[] = [{ type: "text", text: "Hello **world**" }];
    const { getByText } = render(() => <AIMessageContent blocks={blocks} />);
    expect(getByText("world")).toBeInTheDocument();
  });

  it("renders a thinking block preview as the full trace with newlines collapsed", () => {
    const blocks: ContentBlock[] = [
      { type: "thinking", thinking: "Reasoning step one\nand then step two" },
    ];
    const { getByText } = render(() => <AIMessageContent blocks={blocks} />);
    expect(getByText("Reasoning step one and then step two")).toBeInTheDocument();
  });

  it("uses the last thinking summary as the preview when present", () => {
    const blocks: ContentBlock[] = [
      {
        type: "thinking",
        thinking: "Long internal trace",
        summaries: [{ summary: "Considered options" }, { summary: "Picked approach X" }],
      },
    ];
    const { getByText } = render(() => <AIMessageContent blocks={blocks} />);
    expect(getByText("Picked approach X")).toBeInTheDocument();
  });

  it("renders a tool_use block as a flat row with summary visible inline", () => {
    const blocks: ContentBlock[] = [
      { type: "tool_use", name: "Read", id: "t1", input: { file_path: "/src/lib/foo.ts" } },
    ];
    const { getByText } = render(() => <AIMessageContent blocks={blocks} />);
    // Summary is visible inline (last two path segments).
    expect(getByText("Read lib/foo.ts")).toBeInTheDocument();
  });

  it("expands a tool_use row on click to reveal raw input", () => {
    const blocks: ContentBlock[] = [
      { type: "tool_use", name: "Read", id: "t1", input: { file_path: "/src/lib/foo.ts" } },
    ];
    const { getByText, queryByText } = render(() => <AIMessageContent blocks={blocks} />);
    // The raw input details are not visible until the row is expanded.
    expect(queryByText("input")).toBeNull();
    fireEvent.click(getByText("Read lib/foo.ts"));
    expect(getByText("input")).toBeInTheDocument();
  });

  it("drops a tool_result when its match is resolvable elsewhere", () => {
    const blocks: ContentBlock[] = [
      { type: "tool_result", tool_use_id: "t1", content: "file contents" },
    ];
    const resolveToolResult = (id: string) =>
      id === "t1" ? { type: "tool_result" as const, tool_use_id: "t1", content: "x" } : undefined;
    const { queryByText } = render(() => (
      <AIMessageContent blocks={blocks} resolveToolResult={resolveToolResult} />
    ));
    expect(queryByText(/Tool result/i)).toBeNull();
  });

  it("renders an orphan tool_result collapsed, revealing content on click", () => {
    const blocks: ContentBlock[] = [
      { type: "tool_result", tool_use_id: "t-missing", content: "something" },
    ];
    const { getByText, queryByText } = render(() => (
      <AIMessageContent blocks={blocks} />
    ));
    expect(getByText(/Tool result/i)).toBeInTheDocument();
    expect(queryByText("something")).toBeNull();
    fireEvent.click(getByText(/Tool result/i));
    expect(getByText("something")).toBeInTheDocument();
  });

  it("positionally pairs id-less tool_use with the next tool_result", () => {
    const blocks: ContentBlock[] = [
      { type: "tool_use", name: "Search", id: null as unknown as string, input: { q: "x" } },
      { type: "tool_result", tool_use_id: null as unknown as string, content: "result body" },
    ];
    const { queryAllByText } = render(() => (
      <AIMessageContent blocks={blocks} />
    ));
    // The paired result is consumed by its tool_use and not rendered as an
    // orphan tool_result row.
    expect(queryAllByText(/Tool result/i)).toHaveLength(0);
  });

  it("renders a summary block with text as message text", () => {
    const blocks: ContentBlock[] = [
      { type: "summary", summary_type: "message", text: "Recap of the **thread**" },
    ];
    const { getByText } = render(() => <AIMessageContent blocks={blocks} />);
    expect(getByText("thread")).toBeInTheDocument();
  });

  it("renders a thread summary without text as a placeholder naming the thread", () => {
    const blocks: ContentBlock[] = [
      { type: "summary", summary_type: "thread", thread_id: "T-123" },
    ];
    const { getByText } = render(() => <AIMessageContent blocks={blocks} />);
    expect(getByText(/Summary of thread T-123/)).toBeInTheDocument();
  });

  it("renders an image block as a metadata-only placeholder", () => {
    const blocks: ContentBlock[] = [{ type: "image", media_type: "image/png" }];
    const { getByText, queryByText } = render(() => <AIMessageContent blocks={blocks} />);
    expect(getByText("Image (image/png)")).toBeInTheDocument();
    // Base64 data must never be surfaced.
    expect(queryByText(/base64|data:/i)).toBeNull();
  });

  it("renders the stored image inline when its block index is in inlineImages", () => {
    const blocks: ContentBlock[] = [{ type: "image", media_type: "image/png" }];
    const inlineImages = new Map<string, Attachment>([["0", imageAttachment()]]);
    const { getByAltText, queryByText } = render(() => (
      <AIMessageContent blocks={blocks} inlineImages={inlineImages} />
    ));
    // The metadata placeholder is replaced by the real image.
    expect(queryByText("Image (image/png)")).toBeNull();
    const img = getByAltText("screenshot.png");
    expect(img).toBeInTheDocument();
    expect(img.getAttribute("src")).toContain(
      "/api/media/claude-code/tester/s/m/screenshot.png"
    );
  });

  it("renders consecutive tool_use blocks as separate flat rows", () => {
    const blocks: ContentBlock[] = [
      { type: "tool_use", name: "WebSearch", input: { query: "a" } },
      { type: "tool_use", name: "WebSearch", input: { query: "b" } },
      { type: "text", text: "result text" },
    ];
    const { getByText } = render(() => <AIMessageContent blocks={blocks} />);
    // Each tool_use is visible by default — no collapsing chain.
    expect(getByText('WebSearch "a"')).toBeInTheDocument();
    expect(getByText('WebSearch "b"')).toBeInTheDocument();
    expect(getByText("result text")).toBeInTheDocument();
  });
});
