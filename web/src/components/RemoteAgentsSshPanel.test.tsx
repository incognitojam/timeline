import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteAgentsSshState } from "../lib/api";
import RemoteAgentsSshPanel from "./RemoteAgentsSshPanel";

const testState = vi.hoisted(() => ({
  setSsh: (_state: RemoteAgentsSshState) => {},
  generate: vi.fn(),
  test: vi.fn(),
  trust: vi.fn(),
}));

vi.mock("../lib/queries", async () => {
  const { createSignal } = await import("solid-js");
  const [ssh, setSsh] = createSignal<RemoteAgentsSshState>();
  testState.setSsh = setSsh;
  const mutation = (fn: (...args: unknown[]) => unknown) => ({ mutateAsync: fn, isPending: false });
  return {
    useRemoteAgentsSsh: () => ({
      get data() {
        return ssh();
      },
      isError: false,
    }),
    useGenerateRemoteAgentsKey: () => mutation(testState.generate),
    useTestRemoteAgentsConnection: () => mutation(testState.test),
    useTrustRemoteAgentsHost: () => mutation(testState.trust),
  };
});

const line = 'restrict,command="~/.local/bin/timeline-export" ssh-ed25519 AAAAexample timeline@host';

describe("RemoteAgentsSshPanel", () => {
  beforeEach(() => {
    testState.generate.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("offers to generate a key when none exists", async () => {
    testState.setSsh({ publicKey: null, authorizedKeysLine: null, host: null });
    const view = render(() => <RemoteAgentsSshPanel />);
    fireEvent.click(view.getByRole("button", { name: "Generate key" }));
    await waitFor(() => expect(testState.generate).toHaveBeenCalledWith(false));
  });

  it("shows the authorized_keys line and walks through trusting the host", async () => {
    testState.setSsh({
      publicKey: "ssh-ed25519 AAAAexample timeline@host",
      authorizedKeysLine: line,
      host: { label: "alice@agent-host", trusted: false },
    });
    testState.test.mockResolvedValue({
      status: "untrusted",
      host: "alice@agent-host",
      fingerprint: "SHA256:abc123",
      changed: false,
    });
    testState.trust.mockResolvedValue({
      status: "ok",
      host: "alice@agent-host",
      targets: { "claude-code": { available: true }, codex: { available: false, detail: "/home/alice/.codex/sessions" } },
    });

    const view = render(() => <RemoteAgentsSshPanel />);
    expect(view.getByLabelText("authorized_keys line").textContent).toBe(line);
    expect(view.getByText("alice@agent-host: host key not trusted yet")).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Test connection" }));
    expect(await view.findByText("SHA256:abc123")).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Trust host and test" }));
    await waitFor(() => expect(testState.trust).toHaveBeenCalledWith("SHA256:abc123"));
    const status = await view.findByRole("status");
    expect(status.textContent).toContain("claude-code: available");
    expect(status.textContent).toContain("codex: missing (/home/alice/.codex/sessions)");
  });

  it("shows connection errors", async () => {
    testState.setSsh({
      publicKey: "ssh-ed25519 AAAAexample timeline@host",
      authorizedKeysLine: line,
      host: { label: "alice@agent-host", trusted: true },
    });
    testState.test.mockResolvedValue({ status: "error", host: "alice@agent-host", error: "Permission denied (publickey)." });
    const view = render(() => <RemoteAgentsSshPanel />);
    fireEvent.click(view.getByRole("button", { name: "Test connection" }));
    expect((await view.findByRole("alert")).textContent).toBe("Permission denied (publickey).");
  });

  it("warns when a trusted host's key has changed", async () => {
    testState.setSsh({
      publicKey: "ssh-ed25519 AAAAexample timeline@host",
      authorizedKeysLine: line,
      host: { label: "alice@agent-host", trusted: true },
    });
    testState.test.mockResolvedValue({
      status: "untrusted",
      host: "alice@agent-host",
      fingerprint: "SHA256:new456",
      changed: true,
    });
    const view = render(() => <RemoteAgentsSshPanel />);
    fireEvent.click(view.getByRole("button", { name: "Test connection" }));
    expect(await view.findByText(/has changed since it was trusted/)).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Trust new host key and test" }));
    await waitFor(() => expect(testState.trust).toHaveBeenCalledWith("SHA256:new456"));
  });

  it("drops a connection result once a different host is saved", async () => {
    testState.setSsh({
      publicKey: "ssh-ed25519 AAAAexample timeline@host",
      authorizedKeysLine: line,
      host: { label: "alice@agent-host", trusted: true },
    });
    testState.test.mockResolvedValue({ status: "error", host: "alice@agent-host", error: "Connection refused" });
    const view = render(() => <RemoteAgentsSshPanel />);
    fireEvent.click(view.getByRole("button", { name: "Test connection" }));
    expect(await view.findByRole("alert")).toBeTruthy();

    testState.setSsh({
      publicKey: "ssh-ed25519 AAAAexample timeline@host",
      authorizedKeysLine: line,
      host: { label: "alice@other-host", trusted: false },
    });
    await waitFor(() => expect(view.queryByRole("alert")).toBeNull());
    expect(view.getByText("alice@other-host: host key not trusted yet")).toBeTruthy();
  });

  it("disables Test connection until a host is saved", () => {
    testState.setSsh({ publicKey: "ssh-ed25519 AAAAexample", authorizedKeysLine: line, host: null });
    const view = render(() => <RemoteAgentsSshPanel />);
    expect((view.getByRole("button", { name: "Test connection" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
