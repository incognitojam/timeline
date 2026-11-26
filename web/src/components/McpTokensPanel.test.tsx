import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpToken } from "../lib/api";
import McpTokensPanel from "./McpTokensPanel";

const apiMocks = vi.hoisted(() => ({
  fetchMcpTokens: vi.fn(),
  createMcpToken: vi.fn(),
  revokeMcpToken: vi.fn(),
}));

vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  ...apiMocks,
}));

const SECRET = "tlm_exampleexampleexampleexampleexampleexample";

function token(overrides: Partial<McpToken> = {}): McpToken {
  return {
    id: 1, label: "laptop", read_only: false, tailnet_only: false, created_at: "2026-07-01 10:00:00",
    last_used_at: null, last_client: null, revoked_at: null, ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("McpTokensPanel", () => {
  it("shows a created token once, then never again", async () => {
    const tokens = [token()];
    apiMocks.fetchMcpTokens.mockImplementation(async () => ({ tokens, env_token_count: 2 }));
    apiMocks.createMcpToken.mockImplementation(async (input: { label: string; read_only: boolean }) => {
      tokens.unshift(token({ id: 2, label: input.label, read_only: input.read_only }));
      return { id: 2, token: SECRET };
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(() => (
      <QueryClientProvider client={client}><McpTokensPanel /></QueryClientProvider>
    ));

    expect(await view.findByText("2 tokens", { exact: false })).toBeTruthy();
    fireEvent.input(view.getByLabelText("Label"), { target: { value: "<b>claude-ai</b>" } });
    fireEvent.click(view.getByLabelText("Read-only"));
    fireEvent.click(view.getByRole("button", { name: "Create token" }));

    expect((await view.findByTestId("new-mcp-token")).textContent).toBe(SECRET);
    expect(view.getByText("will not be shown again", { exact: false })).toBeTruthy();
    expect(apiMocks.createMcpToken).toHaveBeenCalledWith({ label: "<b>claude-ai</b>", read_only: true, tailnet_only: false });
    // The label is text, not markup.
    expect(await view.findByText("<b>claude-ai</b>")).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Done" }));
    expect(view.queryByTestId("new-mcp-token")).toBeNull();
    expect(view.container.textContent).not.toContain(SECRET);
    expect(view.getByRole("button", { name: "Create token" })).toBeTruthy();

    // Nothing the query client keeps holds the token, so a later visit cannot show it.
    expect(JSON.stringify(client.getMutationCache().getAll().map(m => m.state))).not.toContain(SECRET);
    expect(JSON.stringify(client.getQueryCache().getAll().map(q => q.state.data))).not.toContain(SECRET);
    view.unmount();
    const again = render(() => (
      <QueryClientProvider client={client}><McpTokensPanel /></QueryClientProvider>
    ));
    expect(await again.findByText("<b>claude-ai</b>")).toBeTruthy();
    expect(again.container.textContent).not.toContain(SECRET);
  });

  it("revokes only after confirmation", async () => {
    let revoked: string | null = null;
    apiMocks.fetchMcpTokens.mockImplementation(async () => ({ tokens: [token({ revoked_at: revoked })], env_token_count: 0 }));
    apiMocks.revokeMcpToken.mockImplementation(async () => { revoked = "2026-07-02 10:00:00"; });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(() => (
      <QueryClientProvider client={client}><McpTokensPanel /></QueryClientProvider>
    ));

    fireEvent.click(await view.findByRole("button", { name: "Revoke" }));
    expect(apiMocks.revokeMcpToken).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(Array.from(dialog.querySelectorAll("button")).find(b => b.textContent === "Revoke") as HTMLButtonElement);
    await vi.waitFor(() => expect(apiMocks.revokeMcpToken).toHaveBeenCalledWith(1));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await view.findByText("revoked", { exact: false })).toBeTruthy();
    expect(view.queryByRole("button", { name: "Revoke" })).toBeNull();
  });

  it("shows when copying fails", async () => {
    apiMocks.fetchMcpTokens.mockResolvedValue({ tokens: [], env_token_count: 0 });
    apiMocks.createMcpToken.mockResolvedValue({ id: 3, token: SECRET });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.reject(new Error("denied")) } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(() => (
      <QueryClientProvider client={client}><McpTokensPanel /></QueryClientProvider>
    ));
    fireEvent.input(view.getByLabelText("Label"), { target: { value: "phone" } });
    fireEvent.click(view.getByRole("button", { name: "Create token" }));
    fireEvent.click(await view.findByRole("button", { name: "Copy" }));
    expect(await view.findByText("Could not copy", { exact: false })).toBeTruthy();
  });
});
