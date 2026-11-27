import { cleanup, render } from "@solidjs/testing-library";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpConnectInfo } from "../lib/api";
import McpConnectGuide, { mcpServerUrl } from "./McpConnectGuide";

const apiMocks = vi.hoisted(() => ({ fetchMcpConnectInfo: vi.fn() }));

vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  ...apiMocks,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function show(info: McpConnectInfo) {
  apiMocks.fetchMcpConnectInfo.mockResolvedValue(info);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(() => <QueryClientProvider client={client}><McpConnectGuide /></QueryClientProvider>);
}

describe("mcpServerUrl", () => {
  const at = (href: string) => new URL(href) as unknown as Location;
  it("prefers the configured public URL, then a tailnet page address", () => {
    expect(mcpServerUrl("https://timeline.example.ts.net/", at("http://127.0.0.1:3001/mcp-sessions"))).toBe("https://timeline.example.ts.net/mcp");
    expect(mcpServerUrl(null, at("https://timeline.example.ts.net/mcp-sessions"))).toBe("https://timeline.example.ts.net/mcp");
    expect(mcpServerUrl(null, at("http://127.0.0.1:3001/mcp-sessions"))).toBeNull();
  });

  it("uses only an https .ts.net address on the default port, page first", () => {
    const local = at("http://127.0.0.1:3001/mcp-sessions");
    expect(mcpServerUrl("https://other.example.ts.net", at("https://timeline.example.ts.net/x"))).toBe("https://timeline.example.ts.net/mcp");
    for (const configured of ["timeline.example.ts.net", "http://timeline.example.ts.net", "https://timeline.example.com", "https://timeline.example.ts.net:8443"]) {
      expect(mcpServerUrl(configured, local)).toBeNull();
    }
  });
});

describe("McpConnectGuide", () => {
  it("is folded away, and gives the steps with a token placeholder that cannot be copied", async () => {
    const view = show({ public_url: "https://timeline.example.ts.net", public_access: { state: "off" } });
    const details = view.container.querySelector("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(await view.findByText("Public access is off", { exact: false })).toBeTruthy();
    expect(view.getAllByTestId("mcp-server-url").map(url => url.textContent)).toEqual(["https://timeline.example.ts.net/mcp", "https://timeline.example.ts.net/mcp"]);
    expect(view.getByTestId("mcp-header-value").textContent).toBe("Bearer <token>");
    expect(view.getByTestId("mcp-tailnet-header").textContent).toBe("Authorization: Bearer <token>");
    expect(view.getAllByRole("button").map(button => button.getAttribute("aria-label"))).toEqual(["Copy URL", "Copy URL"]);
  });

  it("says when public access ends, and falls back to a placeholder URL without a copy button", async () => {
    const view = show({ public_url: null, public_access: { state: "on", until: "2026-07-01T11:00:00.000Z" } });
    expect(await view.findByText("Public access is on until", { exact: false })).toBeTruthy();
    expect(view.getAllByTestId("mcp-server-url")[0].textContent).toBe("https://<node>.ts.net/mcp");
    expect(view.queryByRole("button")).toBeNull();
  });

  it("says when Remote Access is not set up", async () => {
    const view = show({ public_url: null, public_access: { state: "unavailable" } });
    expect(await view.findAllByText("Remote Access is not set up", { exact: false })).toHaveLength(1);
  });
});
