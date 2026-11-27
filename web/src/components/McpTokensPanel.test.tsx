import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpToken } from "../lib/api";
import { maskSecret } from "./McpConnectGuide";
import McpTokensPanel from "./McpTokensPanel";

const apiMocks = vi.hoisted(() => ({
  fetchMcpTokens: vi.fn(),
  createMcpToken: vi.fn(),
  revokeMcpToken: vi.fn(),
  fetchMcpConnectInfo: vi.fn(),
}));

vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  ...apiMocks,
}));

const SECRET = "tlm_exampleexampleexampleexampleexampleexample";
const writeText = vi.fn();

function token(overrides: Partial<McpToken> = {}): McpToken {
  return {
    id: 1, label: "laptop", read_only: false, tailnet_only: false, created_at: "2026-07-01 10:00:00",
    last_used_at: null, last_client: null, revoked_at: null, ...overrides,
  };
}

beforeEach(() => {
  apiMocks.fetchMcpConnectInfo.mockResolvedValue({ public_url: "https://timeline.example.ts.net", public_access: { state: "off" } });
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function show(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  const view = render(() => <QueryClientProvider client={client}><McpTokensPanel /></QueryClientProvider>);
  return { client, view };
}

async function openDialog() {
  fireEvent.click(await screen.findByRole("button", { name: "Create token" }));
  return screen.findByRole("dialog");
}

function submit(dialog: HTMLElement) {
  fireEvent.click(Array.from(dialog.querySelectorAll("button")).find(b => b.textContent === "Create token") as HTMLButtonElement);
}

describe("McpTokensPanel", () => {
  it("creates a token in a dialog, shows it once with the steps to connect, and forgets it on close", async () => {
    const tokens = [token()];
    apiMocks.fetchMcpTokens.mockImplementation(async () => ({ tokens, env_token_count: 2 }));
    apiMocks.createMcpToken.mockImplementation(async (input: { label: string; read_only: boolean }) => {
      tokens.unshift(token({ id: 2, label: input.label, read_only: input.read_only }));
      return { id: 2, token: SECRET };
    });
    const { client, view } = show();
    expect(await view.findByText("2 tokens", { exact: false })).toBeTruthy();

    const dialog = await openDialog();
    await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Label")));
    // An empty label is refused in the dialog, not by a disabled button.
    submit(dialog);
    expect(await screen.findByText("Enter a label.")).toBeTruthy();
    expect(apiMocks.createMcpToken).not.toHaveBeenCalled();

    fireEvent.input(screen.getByLabelText("Label"), { target: { value: "<b>claude-ai</b>" } });
    fireEvent.click(screen.getByLabelText("Read-only"));
    submit(dialog);

    // Masked by default: the full token is nowhere in the page, only its start.
    expect((await screen.findByTestId("new-mcp-token")).textContent).toBe(maskSecret(SECRET));
    expect(document.body.innerHTML).not.toContain(SECRET);
    expect(screen.getByText("The token is hidden. Copy copies it in full; Show token reveals it.")).toBeTruthy();
    expect(apiMocks.createMcpToken).toHaveBeenCalledWith({ label: "<b>claude-ai</b>", read_only: true, tailnet_only: false });
    expect(screen.getByRole("dialog").textContent).toContain("Token created");
    expect(screen.getByText("You won't be able to see it again", { exact: false })).toBeTruthy();
    await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Copy token" })));
    // The claude.ai steps, with the real URL and the header filled in.
    expect(within(dialog).getByText("Public access is off", { exact: false })).toBeTruthy();
    expect(within(dialog).getByTestId("mcp-header-value").textContent).toBe(`Bearer ${maskSecret(SECRET)}`);
    // A client on the tailnet can use it too.
    expect(within(dialog).getByTestId("mcp-tailnet-header").textContent).toBe(`Authorization: Bearer ${maskSecret(SECRET)}`);

    // Copying while masked copies the full values.
    fireEvent.click(screen.getByRole("button", { name: "Copy token" }));
    expect(await screen.findByText("Copied token")).toBeTruthy();
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Copy URL" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Copy header value" }));
    expect(await screen.findByText("Copied header value")).toBeTruthy();
    expect(writeText.mock.calls).toEqual([[SECRET], ["https://timeline.example.ts.net/mcp"], [`Bearer ${SECRET}`]]);

    // Show reveals every copy of it; Hide masks them again.
    fireEvent.click(screen.getByRole("button", { name: "Show token" }));
    expect(screen.getByTestId("new-mcp-token").textContent).toBe(SECRET);
    expect(within(dialog).getByTestId("mcp-header-value").textContent).toBe(`Bearer ${SECRET}`);
    fireEvent.click(screen.getByRole("button", { name: "Hide token" }));
    expect(document.body.innerHTML).not.toContain(SECRET);
    fireEvent.click(screen.getByRole("button", { name: "Show token" }));
    // The label is text, not markup.
    expect(await view.findByText("<b>claude-ai</b>")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.innerHTML).not.toContain(SECRET);
    // Nothing the query client keeps holds the token, so a later visit cannot show it.
    expect(JSON.stringify(client.getMutationCache().getAll().map(m => m.state))).not.toContain(SECRET);
    expect(JSON.stringify(client.getQueryCache().getAll().map(q => q.state.data))).not.toContain(SECRET);

    // Reopening starts a fresh form.
    await openDialog();
    expect((screen.getByLabelText("Label") as HTMLInputElement).value).toBe("");
    expect(screen.queryByTestId("new-mcp-token")).toBeNull();
  });

  it("gives a tailnet-only token the tailnet steps, not claude.ai's", async () => {
    apiMocks.fetchMcpTokens.mockResolvedValue({ tokens: [], env_token_count: 0 });
    apiMocks.createMcpToken.mockResolvedValue({ id: 3, token: SECRET });
    show();
    const dialog = await openDialog();
    fireEvent.input(screen.getByLabelText("Label"), { target: { value: "laptop" } });
    fireEvent.click(screen.getByLabelText("Tailnet only"));
    submit(dialog);

    expect(await screen.findByText("claude.ai cannot use this token", { exact: false })).toBeTruthy();
    expect(screen.getByText("Connect a client on your tailnet")).toBeTruthy();
    expect(document.body.innerHTML).not.toContain(SECRET);
    expect(within(dialog).queryByText("Choose No sign-in.")).toBeNull();
    expect(within(dialog).queryByText("Public access is off", { exact: false })).toBeNull();
    expect(within(dialog).getByTestId("mcp-tailnet-header").textContent).toBe(`Authorization: Bearer ${maskSecret(SECRET)}`);
    fireEvent.click(within(dialog).getByRole("button", { name: "Copy header" }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(`Authorization: Bearer ${SECRET}`));

    // Escape closes it too, and takes the token with it.
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it("closes without creating on Cancel or Escape", async () => {
    apiMocks.fetchMcpTokens.mockResolvedValue({ tokens: [], env_token_count: 0 });
    show();
    await openDialog();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await openDialog();
    fireEvent.keyDown(screen.getByLabelText("Label"), { key: "Escape" });
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(apiMocks.createMcpToken).not.toHaveBeenCalled();
  });

  it("does not show a token whose create finished after the dialog closed", async () => {
    apiMocks.fetchMcpTokens.mockResolvedValue({ tokens: [], env_token_count: 0 });
    let finish: (value: { id: number; token: string }) => void = () => {};
    apiMocks.createMcpToken.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    show();
    const dialog = await openDialog();
    fireEvent.input(screen.getByLabelText("Label"), { target: { value: "slow" } });
    submit(dialog);
    fireEvent.keyDown(screen.getByLabelText("Label"), { key: "Escape" });
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    finish({ id: 4, token: SECRET });
    await Promise.resolve();
    await openDialog();
    expect(screen.getByLabelText("Label")).toBeTruthy();
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it("revokes only after confirmation", async () => {
    let revoked: string | null = null;
    apiMocks.fetchMcpTokens.mockImplementation(async () => ({ tokens: [token({ revoked_at: revoked })], env_token_count: 0 }));
    apiMocks.revokeMcpToken.mockImplementation(async () => { revoked = "2026-07-02 10:00:00"; });
    const { view } = show();

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
    writeText.mockRejectedValue(new Error("denied"));
    show();
    const dialog = await openDialog();
    fireEvent.input(screen.getByLabelText("Label"), { target: { value: "phone" } });
    submit(dialog);
    fireEvent.click(await screen.findByRole("button", { name: "Copy token" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Could not copy. Show it, then select it and copy it.");
  });
});
