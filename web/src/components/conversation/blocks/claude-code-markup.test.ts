import { describe, expect, it } from "vitest";
import { rewriteClaudeCodeMarkup } from "./claude-code-markup";

describe("rewriteClaudeCodeMarkup", () => {
  it("collapses a slash command triplet to a single bold token", () => {
    const input =
      "<command-name>/copy</command-name>\n            <command-message>copy</command-message>\n            <command-args></command-args>";
    expect(rewriteClaudeCodeMarkup(input)).toBe("**/copy**");
  });

  it("keeps args next to the command name when present", () => {
    const input =
      "<command-name>/review</command-name><command-message>review</command-message><command-args>PR 123</command-args>";
    expect(rewriteClaudeCodeMarkup(input)).toBe("**/review** PR 123");
  });

  it("renders local-command-stdout as a fenced code block", () => {
    const out = rewriteClaudeCodeMarkup("<local-command-stdout>hello</local-command-stdout>");
    expect(out).toContain("```\nhello\n```");
  });

  it("renders local-command-caveat as a blockquote", () => {
    const out = rewriteClaudeCodeMarkup(
      "<local-command-caveat>Line one\nLine two</local-command-caveat>"
    );
    expect(out).toContain("> Line one");
    expect(out).toContain("> Line two");
  });

  it("renders bash-input/stdout as code blocks", () => {
    const out = rewriteClaudeCodeMarkup(
      "<bash-input>ls -la</bash-input><bash-stdout>total 0</bash-stdout>"
    );
    expect(out).toContain("```bash\n$ ls -la\n```");
    expect(out).toContain("```\ntotal 0\n```");
  });

  it("leaves regular text untouched", () => {
    expect(rewriteClaudeCodeMarkup("# Heading\n\nparagraph")).toBe("# Heading\n\nparagraph");
  });
});
