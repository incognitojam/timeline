import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { createSignal, type JSX, Suspense } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportConversationRange } from "../../lib/api";
import { buildRangeExportFilename, ConversationRangeExportControls } from "./ConversationRangeExportControls";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    exportConversationRange: vi.fn(),
  };
});

const mockExportConversationRange = vi.mocked(exportConversationRange);
const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

function renderWithQueryClient(view: () => JSX.Element) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity, retry: false } },
  });
  return render(() => (
    <QueryClientProvider client={queryClient}>
      {view()}
    </QueryClientProvider>
  ));
}

function exportResponse(text: string) {
  return {
    text,
    eventCount: 2,
    tokenCount: 8,
    range: {
      startEventId: 11,
      endEventId: 12,
      requestedStartEventId: 11,
      requestedEndEventId: 12,
      source: "discord",
      sourceAccount: null,
      conversationId: "channel-1",
      title: "Project chat",
      startTimestamp: "2026-01-01T00:00:00Z",
      endTimestamp: "2026-01-01T00:01:00Z",
    },
  };
}

describe("ConversationRangeExportControls", () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

  beforeEach(() => {
    mockExportConversationRange.mockReset();
  });

  afterEach(() => {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    if (originalClipboard) {
      Object.defineProperty(navigator, "clipboard", originalClipboard);
    } else {
      Reflect.deleteProperty(navigator, "clipboard");
    }
    vi.restoreAllMocks();
  });

  it("opens a range preview and refreshes it when the format changes", async () => {
    mockExportConversationRange
      .mockResolvedValueOnce(exportResponse("## discord: Project chat\n### 2026-01-01\n00:00 <Alice> hello\n00:01 <Bob> hi"))
      .mockResolvedValueOnce(exportResponse("## discord: Project chat\n2026-01-01 00:00 <Alice> hello\n2026-01-01 00:01 <Bob> hi"))
      .mockResolvedValueOnce(exportResponse("## discord: Project chat\n2026-01-01 00:00 <Person 1> hello\n2026-01-01 00:01 <Person 2> hi"));

    const { container, getByText, getByRole } = renderWithQueryClient(() => (
      <ConversationRangeExportControls
        rangeMode={() => true}
        startEventId={() => 11}
        endEventId={() => 12}
        selectedLoadedCount={() => 2}
        conversationBounds={() => null}
        sidebarOpen={() => false}
        onSelectRange={vi.fn()}
        onClearSelection={vi.fn()}
      />
    ));

    expect(getByText("2 messages selected")).toBeInTheDocument();

    fireEvent.click(getByText("Preview"));

    await waitFor(() => {
      expect(getByRole("dialog")).toBeInTheDocument();
      expect(container.querySelector("textarea")?.textContent).toBe("## discord: Project chat\n### 2026-01-01\n00:00 <Alice> hello\n00:01 <Bob> hi");
    });
    expect(getByText("2 messages · 4 lines · 8 tokens")).toBeInTheDocument();
    expect(mockExportConversationRange.mock.calls.at(-1)?.[0]).toEqual({
      startEventId: 11,
      endEventId: 12,
      format: { timestampStyle: "date-headers", includeReactions: true, compactAuthors: true, anonymiseNames: false, timeZone: browserTimeZone },
    });

    fireEvent.click(getByText("Full timestamps"));

    await waitFor(() => {
      expect(container.querySelector("textarea")?.textContent).toBe("## discord: Project chat\n2026-01-01 00:00 <Alice> hello\n2026-01-01 00:01 <Bob> hi");
    });
    expect(mockExportConversationRange.mock.calls.at(-1)?.[0]).toEqual({
      startEventId: 11,
      endEventId: 12,
      format: { timestampStyle: "full-timestamps", includeReactions: true, compactAuthors: true, anonymiseNames: false, timeZone: browserTimeZone },
    });

    fireEvent.click(getByText("Anonymise names"));

    await waitFor(() => {
      expect(container.querySelector("textarea")?.textContent).toContain("<Person 1> hello");
    });
    expect(mockExportConversationRange.mock.calls.at(-1)?.[0]).toEqual({
      startEventId: 11,
      endEventId: 12,
      format: { timestampStyle: "full-timestamps", includeReactions: true, compactAuthors: true, anonymiseNames: true, timeZone: browserTimeZone },
    });
  });

  it("does not trip the surrounding Suspense boundary while the first preview loads", async () => {
    let resolveExport: (value: ReturnType<typeof exportResponse>) => void = () => {
      throw new Error("export promise not created yet");
    };
    mockExportConversationRange.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveExport = resolve;
        }),
    );

    const { getByText, queryByText, getByRole } = renderWithQueryClient(() => (
      <Suspense fallback={<div>route fallback</div>}>
        <div>route content</div>
        <ConversationRangeExportControls
          rangeMode={() => true}
          startEventId={() => 11}
          endEventId={() => 12}
          selectedLoadedCount={() => 2}
          conversationBounds={() => null}
          sidebarOpen={() => false}
          onSelectRange={vi.fn()}
          onClearSelection={vi.fn()}
        />
      </Suspense>
    ));

    fireEvent.click(getByText("Preview"));

    await waitFor(() => expect(getByRole("dialog")).toBeInTheDocument());
    expect(queryByText("route fallback")).not.toBeInTheDocument();
    expect(getByText("route content")).toBeInTheDocument();
    expect(getByText("Loading...")).toBeInTheDocument();

    resolveExport(exportResponse("Alice: hello\nBob: hi"));
    await waitFor(() => expect(getByText("2 messages · 2 lines · 8 tokens")).toBeInTheDocument());
  });

  it("allows authors to be repeated in the preview", async () => {
    mockExportConversationRange.mockResolvedValue(exportResponse("Alice: hello\nAlice: again"));

    const { getByText, getByRole } = renderWithQueryClient(() => (
      <ConversationRangeExportControls
        rangeMode={() => true}
        startEventId={() => 11}
        endEventId={() => 12}
        selectedLoadedCount={() => 2}
        conversationBounds={() => null}
        sidebarOpen={() => false}
        onSelectRange={vi.fn()}
        onClearSelection={vi.fn()}
      />
    ));

    fireEvent.click(getByText("Preview"));
    await waitFor(() => expect(getByRole("dialog")).toBeInTheDocument());

    fireEvent.click(getByText("Group messages"));

    await waitFor(() => {
      expect(mockExportConversationRange.mock.calls.at(-1)?.[0]).toEqual({
        startEventId: 11,
        endEventId: 12,
        format: { timestampStyle: "date-headers", includeReactions: true, compactAuthors: false, anonymiseNames: false, timeZone: browserTimeZone },
      });
    });
  });

  it("downloads the rendered export as a text file", async () => {
    mockExportConversationRange.mockResolvedValue(exportResponse("Alice: hello\nBob: hi"));

    const createObjectURL = vi.fn((_blob: Blob) => "blob:range-export");
    const revokeObjectURL = vi.fn();
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;

    let downloadName: string | undefined;
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        downloadName = this.download;
      });

    const { getByText, getByRole } = renderWithQueryClient(() => (
      <ConversationRangeExportControls
        rangeMode={() => true}
        startEventId={() => 11}
        endEventId={() => 12}
        selectedLoadedCount={() => 2}
        conversationBounds={() => null}
        sidebarOpen={() => false}
        onSelectRange={vi.fn()}
        onClearSelection={vi.fn()}
      />
    ));

    fireEvent.click(getByText("Preview"));
    await waitFor(() => expect(getByRole("dialog")).toBeInTheDocument());
    await waitFor(() => expect(getByText("2 messages · 2 lines · 8 tokens")).toBeInTheDocument());

    fireEvent.click(getByText("Download"));

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    const blob = createObjectURL.mock.calls[0]?.[0];
    if (!blob) throw new Error("expected createObjectURL to receive a blob");
    const blobText = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blob);
    });
    expect(blobText).toBe("Alice: hello\nBob: hi");
    expect(downloadName).toBe("discord-project-chat-2026-01-01.txt");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:range-export");

    clickSpy.mockRestore();
  });

  it("selects the entire conversation from stats bounds and previews it", async () => {
    mockExportConversationRange.mockResolvedValue(exportResponse("Alice: hello\nBob: hi"));
    const [startId, setStartId] = createSignal<number | null>(null);
    const [endId, setEndId] = createSignal<number | null>(null);

    const { getByText, getByRole } = renderWithQueryClient(() => (
      <ConversationRangeExportControls
        rangeMode={() => true}
        startEventId={startId}
        endEventId={endId}
        selectedLoadedCount={() => 0}
        conversationBounds={() => ({ startId: 5, endId: 99 })}
        sidebarOpen={() => false}
        onSelectRange={(s, e) => {
          setStartId(s);
          setEndId(e);
        }}
        onClearSelection={vi.fn()}
      />
    ));

    fireEvent.click(getByText("Select all"));

    await waitFor(() => expect(getByRole("dialog")).toBeInTheDocument());
    expect(startId()).toBe(5);
    expect(endId()).toBe(99);
    expect(mockExportConversationRange.mock.calls.at(-1)?.[0]).toEqual({
      startEventId: 5,
      endEventId: 99,
      format: { timestampStyle: "date-headers", includeReactions: true, compactAuthors: true, anonymiseNames: false, timeZone: browserTimeZone },
    });
  });

  it("disables Select all until the conversation bounds are known", () => {
    const { getByText } = renderWithQueryClient(() => (
      <ConversationRangeExportControls
        rangeMode={() => true}
        startEventId={() => null}
        endEventId={() => null}
        selectedLoadedCount={() => 0}
        conversationBounds={() => null}
        sidebarOpen={() => false}
        onSelectRange={vi.fn()}
        onClearSelection={vi.fn()}
      />
    ));

    expect(getByText("Select all")).toBeDisabled();
  });

  it("closes preview on Escape before clearing the selected range", async () => {
    mockExportConversationRange.mockResolvedValue(exportResponse("Alice: hello"));
    const onClearSelection = vi.fn();

    const { getByText, getByRole, queryByRole } = renderWithQueryClient(() => (
      <ConversationRangeExportControls
        rangeMode={() => true}
        startEventId={() => 11}
        endEventId={() => 12}
        selectedLoadedCount={() => 2}
        conversationBounds={() => null}
        sidebarOpen={() => false}
        onSelectRange={vi.fn()}
        onClearSelection={onClearSelection}
      />
    ));

    fireEvent.click(getByText("Preview"));
    await waitFor(() => expect(getByRole("dialog")).toBeInTheDocument());

    fireEvent.keyDown(window, { key: "Escape" });
    expect(queryByRole("dialog")).not.toBeInTheDocument();
    expect(onClearSelection).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClearSelection).toHaveBeenCalledTimes(1);
  });

  it("reuses a preview export for direct Copy", async () => {
    const response = exportResponse("Alice: hello\nBob: hi");
    mockExportConversationRange.mockResolvedValue(response);
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const { getByLabelText, getByRole, getByText } = renderWithQueryClient(() => (
      <ConversationRangeExportControls
        rangeMode={() => true}
        startEventId={() => 11}
        endEventId={() => 12}
        selectedLoadedCount={() => 2}
        conversationBounds={() => null}
        sidebarOpen={() => false}
        onSelectRange={vi.fn()}
        onClearSelection={vi.fn()}
      />
    ));

    fireEvent.click(getByText("Preview"));
    await waitFor(() => expect(getByRole("dialog")).toBeInTheDocument());
    await waitFor(() => expect(mockExportConversationRange).toHaveBeenCalledTimes(1));

    fireEvent.click(getByLabelText("Close range preview"));
    fireEvent.click(getByText("Copy"));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(response.text));
    expect(mockExportConversationRange).toHaveBeenCalledTimes(1);
  });
});

describe("buildRangeExportFilename", () => {
  const range = exportResponse("").range;

  it("uses a single date when the range stays within one day", () => {
    expect(buildRangeExportFilename(range)).toBe("discord-project-chat-2026-01-01.txt");
  });

  it("spans both dates when the range crosses days", () => {
    expect(buildRangeExportFilename({ ...range, endTimestamp: "2026-01-03T00:01:00Z" })).toBe(
      "discord-project-chat-2026-01-01-to-2026-01-03.txt",
    );
  });

  it("omits the title segment when there is no title", () => {
    expect(buildRangeExportFilename({ ...range, title: null })).toBe("discord-2026-01-01.txt");
  });
});
