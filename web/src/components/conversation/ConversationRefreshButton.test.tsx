import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job, SyncSourceInfo } from "../../lib/api";
import { ConversationRefreshButton } from "./ConversationRefreshButton";

const testState = vi.hoisted(() => ({
  syncSources: [] as Pick<SyncSourceInfo, "name" | "enabled">[],
  triggerSync: vi.fn(),
  listJobs: vi.fn(),
  waitForJob: vi.fn(),
}));

vi.mock("../../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../lib/api")>("../../lib/api");
  return { ...actual, listJobs: testState.listJobs, waitForJob: testState.waitForJob };
});

vi.mock("../../lib/queries", () => ({
  useSyncSources: () => ({ isSuccess: true, data: { sources: testState.syncSources } }),
  useTriggerSyncSource: () => ({ mutateAsync: testState.triggerSync }),
}));

function job(overrides: Partial<Job>): Job {
  return {
    id: 7,
    kind: "sync",
    source: "discord",
    payload: {},
    dedupeKey: "sync:discord",
    status: "queued",
    priority: 0,
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

function renderButton(counts: number[] = [10, 13]) {
  const countMessages = vi.fn(async () => counts.shift() ?? 0);
  const onSynced = vi.fn(async () => {});
  const view = render(() => (
    <ConversationRefreshButton source="discord" countMessages={countMessages} onSynced={onSynced} />
  ));
  return { view, countMessages, onSynced };
}

describe("ConversationRefreshButton", () => {
  beforeEach(() => {
    testState.syncSources = [{ name: "discord", enabled: true }];
    testState.triggerSync.mockReset();
    testState.listJobs.mockReset().mockResolvedValue({ jobs: [], count: 0 });
    testState.waitForJob.mockReset();
  });
  afterEach(cleanup);

  it("is absent for sources without a sync, or with sync turned off", () => {
    testState.syncSources = [{ name: "google-messages", enabled: true }];
    const { view } = renderButton();
    expect(view.queryByRole("button", { name: "Refresh" })).toBeNull();
    cleanup();

    testState.syncSources = [{ name: "discord", enabled: false }];
    expect(renderButton().view.queryByRole("button", { name: "Refresh" })).toBeNull();
  });

  it("shows progress while the sync runs, then reloads and reports new messages", async () => {
    testState.triggerSync.mockResolvedValue({ success: true, jobId: 7, deduped: false, message: "Sync queued" });
    let finish: (job: Job) => void = () => {};
    testState.waitForJob.mockImplementation((_id: number, options: { onUpdate: (job: Job) => void }) => {
      options.onUpdate(job({ status: "running" }));
      return new Promise<Job>((resolve) => { finish = resolve; });
    });
    const { view, onSynced } = renderButton([10, 13]);

    fireEvent.click(view.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(view.getByRole("status").textContent).toBe("Syncing…"));
    expect(view.getByRole("button", { name: "Refresh" })).toBeDisabled();
    expect(testState.triggerSync).toHaveBeenCalledWith("discord");

    finish(job({ status: "succeeded", result: { eventsAdded: 3, skipped: false } }));

    await waitFor(() => expect(view.getByRole("status").textContent).toBe("3 new messages"));
    expect(onSynced).toHaveBeenCalledOnce();
    expect(view.getByRole("button", { name: "Refresh" })).not.toBeDisabled();
  });

  it("joins a sync that is already running instead of queueing another", async () => {
    testState.listJobs.mockResolvedValue({ jobs: [job({ id: 42, status: "running" })], count: 1 });
    testState.waitForJob.mockResolvedValue(job({ id: 42, status: "succeeded", result: { eventsAdded: 0 } }));
    const { view } = renderButton([10, 10]);

    fireEvent.click(view.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(view.getByRole("status").textContent).toBe("Up to date"));
    expect(testState.triggerSync).not.toHaveBeenCalled();
    expect(testState.waitForJob).toHaveBeenCalledWith(42, expect.anything());
  });

  it("reports a failed sync with its error and does not reload", async () => {
    testState.triggerSync.mockResolvedValue({ success: true, jobId: 7, deduped: false, message: "Sync queued" });
    testState.waitForJob.mockResolvedValue(job({ status: "failed", error: "DISCORD_TOKEN environment variable not set" }));
    const { view, onSynced } = renderButton();

    fireEvent.click(view.getByRole("button", { name: "Refresh" }));

    await waitFor(() =>
      expect(view.getByRole("status").textContent).toBe("Sync failed: DISCORD_TOKEN environment variable not set"),
    );
    expect(onSynced).not.toHaveBeenCalled();
  });
});
