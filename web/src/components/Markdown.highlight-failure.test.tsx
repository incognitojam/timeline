import { render, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "./Markdown";

// Loading the highlighter compiles WebAssembly, which can take seconds on a busy
// machine; the test timeout, not waitFor's one-second default, bounds a hang.
const HIGHLIGHTED = { timeout: 20_000 };

// The chunk fails to load once, as on a transient network error, then loads.
const chunk = vi.hoisted(() => ({ available: false }));
vi.mock("./markdown-highlighter", async (importOriginal) => {
  if (!chunk.available) throw new Error("Failed to fetch dynamically imported module");
  return importOriginal();
});

describe("Markdown when the highlighter fails to load", () => {
  afterEach(() => vi.restoreAllMocks());

  it("leaves code plain without an unhandled rejection, and a later message tries again", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = render(() => <Markdown markdown={"```ts\nconst x = 1;\n```"} />);
    await waitFor(() => expect(warn).toHaveBeenCalledOnce(), HIGHLIGHTED);
    expect(first.container.querySelector("pre code")?.textContent).toBe("const x = 1;\n");
    expect(first.container.querySelector("pre code span[style]")).toBeNull();

    chunk.available = true;
    const second = render(() => <Markdown markdown={"```ts\nconst y = 2;\n```"} />);
    await waitFor(() => expect(second.container.querySelector("pre code span[style]")).not.toBeNull(), HIGHLIGHTED);
  });
});
