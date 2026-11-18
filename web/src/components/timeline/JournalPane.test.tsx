import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import JournalPane from "./JournalPane";

const DATE = "2025-01-15";

describe("JournalPane", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders unfinished Markdown in a reflection as formatting while it streams", async () => {
    let reflection: ReadableStreamDefaultController<Uint8Array> | undefined;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path === "/api/summary/models") {
        return Promise.resolve(Response.json({ models: [{ id: "example-model", name: "Example", provider: "Example" }] }));
      }
      if (path === `/api/journal/${DATE}`) {
        return Promise.resolve(Response.json({
          date: DATE,
          questions: [{ question: "What helped today?", category: "activity", group_ids: [], answered: true, answer: "A walk.", event_id: 1 }],
          contextGroups: {},
          reflection: null,
          cached: true,
        }));
      }
      if (path === `/api/journal/${DATE}/reflection`) {
        return Promise.resolve(new Response(new ReadableStream<Uint8Array>({ start: (controller) => { reflection = controller; } })));
      }
      return new Promise<Response>(() => {});
    }));

    render(() => (
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <JournalPane date={DATE} onClose={() => {}} />
      </QueryClientProvider>
    ));
    fireEvent.click(await screen.findByRole("button", { name: "Generate Reflection (1 answer)" }));
    await waitFor(() => expect(reflection).toBeDefined());
    reflection?.enqueue(new TextEncoder().encode("Today was **mostly calm"));

    const strong = await screen.findByText("mostly calm");
    expect(strong.tagName).toBe("STRONG");
    expect(screen.queryByText(/\*\*/)).toBeNull();
  });
});
