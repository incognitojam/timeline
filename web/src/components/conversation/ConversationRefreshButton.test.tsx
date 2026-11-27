import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationRefreshCheck, Job } from "../../lib/api";
import { ConversationRefreshButton } from "./ConversationRefreshButton";

const testState = vi.hoisted(() => ({
  check: { refreshable: true } as ConversationRefreshCheck,
  refreshConversation: vi.fn(),
  waitForJob: vi.fn(),
}));

vi.mock("../../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../lib/api")>("../../lib/api");
  return { ...actual, refreshConversation: testState.refreshConversation, waitForJob: testState.waitForJob };
});

vi.mock("../../lib/queries", () => ({
  useConversationRefresh: () => ({ isSuccess: true, data: testState.check }),
}));

function job(overrides: Partial<Job>): Job {
  return {
    id: 7,
    kind: "sync",
    source: "discord",
    payload: { refresh: { account: "user-1", conversationId: "c1" } },
    dedupeKey: "refresh:discord:user-1:c1",
    status: "queued",
    priority: 10,
    attempt: 0,
    maxAttempts: 1,
    enqueuedAt: "2026-01-01 00:00:00",
    notBefore: "2026-01-01 00:00:00",
    startedAt: null,
    finishedAt: null,
    workerId: null,
    workerLeaseUntil: null,
    result: null,
    error: null,
    trigger: "manual",
    ...overrides,
  };
}

function renderButton() {
  const onRefreshed = vi.fn(async () => {});
  const view = render(() => (
    <ConversationRefreshButton source="discord" conversationId="c1" onRefreshed={onRefreshed} />
  ));
  return { view, onRefreshed };
}

describe("ConversationRefreshButton", () => {
  beforeEach(() => {
    testState.check = { refreshable: true };
    testState.refreshConversation.mockReset().mockResolvedValue({ jobId: 7, joined: false });
    testState.waitForJob.mockReset();
  });
  afterEach(cleanup);

  it("is absent where the server says the conversation can't be refreshed", () => {
    testState.check = { refreshable: false, reason: "Conversations from this source can't be refreshed one at a time" };
    expect(renderButton().view.queryByRole("button", { name: "Refresh" })).toBeNull();
  });

  it("shows Queued while it waits, then reloads and reports new messages", async () => {
    let update: (job: Job) => void = () => {};
    let finish: (job: Job) => void = () => {};
    testState.waitForJob.mockImplementation((_id: number, options: { onUpdate: (job: Job) => void }) => {
      update = options.onUpdate;
      update(job({ status: "queued" }));
      return new Promise<Job>((resolve) => {
        finish = resolve;
      });
    });
    const { view, onRefreshed } = renderButton();

    fireEvent.click(view.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(view.getByRole("status").textContent).toBe("Queued…"));
    expect(testState.refreshConversation).toHaveBeenCalledWith("discord", "c1");
    expect(view.getByRole("button", { name: "Refresh" })).toBeDisabled();
    update(job({ status: "running" }));
    await waitFor(() => expect(view.getByRole("status").textContent).toBe("Refreshing…"));

    finish(job({ status: "succeeded", result: { eventsAdded: 3, metadata: { moreRemaining: false } } }));

    await waitFor(() => expect(view.getByRole("status").textContent).toBe("3 new messages"));
    expect(onRefreshed).toHaveBeenCalledOnce();
    expect(view.getByRole("button", { name: "Refresh" })).not.toBeDisabled();
  });

  it("says when more messages remain", async () => {
    testState.waitForJob.mockResolvedValue(job({ status: "succeeded", result: { eventsAdded: 500, metadata: { moreRemaining: true } } }));
    const { view } = renderButton();

    fireEvent.click(view.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(view.getByRole("status").textContent).toBe("500 new messages, more to fetch"));
  });

  it("reports an empty refresh as up to date", async () => {
    testState.waitForJob.mockResolvedValue(job({ status: "succeeded", result: { eventsAdded: 0, metadata: { moreRemaining: false } } }));
    const { view } = renderButton();

    fireEvent.click(view.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(view.getByRole("status").textContent).toBe("Up to date"));
  });

  it("reports a failed refresh with its error and does not reload", async () => {
    testState.waitForJob.mockResolvedValue(job({ status: "failed", error: "Discord refused access to this conversation" }));
    const { view, onRefreshed } = renderButton();

    fireEvent.click(view.getByRole("button", { name: "Refresh" }));

    await waitFor(() =>
      expect(view.getByRole("status").textContent).toBe("Refresh failed: Discord refused access to this conversation"),
    );
    expect(onRefreshed).not.toHaveBeenCalled();
  });

  it("reports a refused request", async () => {
    testState.refreshConversation.mockRejectedValue(new Error("The full Discord sync hasn't collected this conversation yet"));
    const { view } = renderButton();

    fireEvent.click(view.getByRole("button", { name: "Refresh" }));

    await waitFor(() =>
      expect(view.getByRole("status").textContent).toBe("The full Discord sync hasn't collected this conversation yet"),
    );
    expect(testState.waitForJob).not.toHaveBeenCalled();
  });
});
