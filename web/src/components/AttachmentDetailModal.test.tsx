import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttachmentDetail } from "../lib/api";
import AttachmentDetailModal from "./AttachmentDetailModal";

const MODELS = [
  { id: "test/model-a", name: "Model A", price: "", contextLength: 4096, provider: "test" },
  { id: "test/model-b", name: "Model B", price: "", contextLength: 8192, provider: "test" },
];

const IMAGE_DETAIL: AttachmentDetail = {
  id: 7,
  eventId: 42,
  source: "discord",
  filename: "photo.jpg",
  mimeType: "image/jpeg",
  fileSize: 2048,
  width: 800,
  height: 600,
  durationMs: null,
  storagePath: "media/photo.jpg",
  thumbhash: null,
  contentHash: "abc",
  status: "stored",
  timestamp: "2026-05-01T12:00:00Z",
  description: "A red bicycle",
  descriptionModel: "test/model-a",
  descriptions: [
    {
      model: "test/model-a",
      description: "A red bicycle leaning against a brick wall.",
      createdAt: "2026-05-01T12:00:00Z",
      durationMs: 3200,
    },
    {
      model: "test/model-b",
      description: "Bicycle parked outdoors near a wall.",
      createdAt: "2026-04-30T09:00:00Z",
      durationMs: null,
    },
  ],
};

const NEW_ROW = {
  model: "test/model-a",
  description: "A freshly generated description.",
  createdAt: "2026-05-02T12:00:00Z",
  durationMs: 2500,
};

interface DescribeCall {
  url: string;
  init?: RequestInit;
}

function stubFetch(detail: AttachmentDetail, describeCalls: DescribeCall[] = []) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/summary/models")) {
      return Promise.resolve(Response.json({ models: MODELS }));
    }
    if (url.includes("/describe")) {
      describeCalls.push({ url, init });
      return Promise.resolve(Response.json(NEW_ROW, { status: 201 }));
    }
    if (/\/api\/attachments\/\d+$/.test(url)) {
      return Promise.resolve(Response.json(detail));
    }
    return Promise.resolve(Response.json({ error: "unexpected" }, { status: 500 }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderModal(detail: AttachmentDetail) {
  const history = createMemoryHistory();
  history.set({ value: "/", replace: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(() => (
    <QueryClientProvider client={client}>
      <MemoryRouter history={history}>
        <Route
          path="/"
          component={() => (
            <AttachmentDetailModal attachment={detail} onClose={() => {}} />
          )}
        />
      </MemoryRouter>
    </QueryClientProvider>
  ));
}

describe("AttachmentDetailModal", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders metadata and every description entry", async () => {
    stubFetch(IMAGE_DETAIL);
    renderModal(IMAGE_DETAIL);

    // Metadata
    expect(await screen.findByText("image/jpeg")).toBeInTheDocument();
    expect(screen.getByText("800 × 600")).toBeInTheDocument();
    expect(screen.getByText("2.0 KB")).toBeInTheDocument();
    expect(screen.getByText("Discord")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /#42/ })).toHaveAttribute("href", "/event/42");

    // Both descriptions rendered side by side, with model + timing metadata
    expect(await screen.findByText("A red bicycle leaning against a brick wall.")).toBeInTheDocument();
    expect(screen.getByText("Bicycle parked outdoors near a wall.")).toBeInTheDocument();
    expect(screen.getByText("test/model-a")).toBeInTheDocument();
    expect(screen.getByText("test/model-b")).toBeInTheDocument();
    expect(screen.getByText("3.2s")).toBeInTheDocument();
  });

  it("shows the gallery image while attachment descriptions are still loading", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        if (String(input).includes("/api/summary/models")) {
          return Promise.resolve(Response.json({ models: MODELS }));
        }
        return new Promise<Response>(() => {});
      }),
    );
    renderModal(IMAGE_DETAIL);

    expect(screen.getByRole("img", { name: "photo.jpg" })).toHaveAttribute(
      "src",
      "/api/media/media/photo.jpg",
    );
    expect(screen.getByText("image/jpeg")).toBeInTheDocument();
    expect(screen.getByText("Loading descriptions…")).toBeInTheDocument();
    expect(screen.queryByText(/^Loading…$/)).not.toBeInTheDocument();
  });

  it("shows the generate section only for describable image attachments", async () => {
    stubFetch(IMAGE_DETAIL);
    renderModal(IMAGE_DETAIL);

    expect(await screen.findByRole("button", { name: /^Generate$/ })).toBeInTheDocument();
  });

  it("hides the generate section for non-describable attachments", async () => {
    const video: AttachmentDetail = {
      ...IMAGE_DETAIL,
      id: 8,
      filename: "clip.mp4",
      mimeType: "video/mp4",
      descriptions: [],
    };
    stubFetch(video);
    renderModal(video);

    // Wait for detail to load, then assert the generate affordance is absent.
    expect(await screen.findByText("video/mp4")).toBeInTheDocument();
    expect(screen.queryByText("Generate description")).not.toBeInTheDocument();
    expect(await screen.findByText("No descriptions generated yet.")).toBeInTheDocument();
  });

  it("fires the describe mutation when Generate is clicked", async () => {
    const describeCalls: DescribeCall[] = [];
    const fetchMock = stubFetch(IMAGE_DETAIL, describeCalls);
    renderModal(IMAGE_DETAIL);

    const button = await screen.findByRole("button", { name: /^Generate$/ });
    fireEvent.click(button);

    await waitFor(() => expect(describeCalls.length).toBe(1));
    expect(describeCalls[0].url).toContain("/api/attachments/7/describe");
    expect(describeCalls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(describeCalls[0].init?.body))).toEqual({ model: "test/model-a" });
    expect(await screen.findByText("A freshly generated description.")).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([input]) => /\/api\/attachments\/7$/.test(String(input)))).toHaveLength(1);
  });
});
