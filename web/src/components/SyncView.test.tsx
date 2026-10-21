import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import type { ParentProps } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxSourceInfo, Job, SchedulerSourceStatus, ServiceStatus, SyncHistoryEntry, SyncSourceInfo } from "../lib/api";
import SyncView from "./SyncView";

const testState = vi.hoisted(() => ({
  historyEntries: [] as SyncHistoryEntry[],
  inboxSources: [] as InboxSourceInfo[],
  statusQuery: {} as unknown,
  syncSources: [] as SyncSourceInfo[],
  triggerSync: vi.fn(),
  waitForJob: vi.fn(),
}));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, waitForJob: testState.waitForJob };
});

vi.mock("@solidjs/router", () => ({
  A: (props: ParentProps<{ href: string; class?: string; style?: string; "aria-label"?: string }>) => (
    <a href={props.href} class={props.class} style={props.style} aria-label={props["aria-label"]}>
      {props.children}
    </a>
  ),
}));

vi.mock("../lib/queries", () => ({
  useServiceStatus: () => testState.statusQuery,
  useSyncHistory: () => loadedQuery({ entries: testState.historyEntries, count: testState.historyEntries.length }),
  useInboxSources: () => loadedQuery({ basePath: "/tmp/inbox", archivePath: null, sources: testState.inboxSources }),
  useSyncSources: () => loadedQuery({ sources: testState.syncSources }),
  useTriggerSyncSource: () => ({ mutateAsync: testState.triggerSync }),
  useUploadInboxFile: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("./SourceIcon", () => ({
  default: () => <span>icon</span>,
}));

function loadedQuery<T>(data: T) {
  return {
    data,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    refetch: vi.fn(),
  };
}

function source(overrides?: Partial<SchedulerSourceStatus>): SchedulerSourceStatus {
  return {
    source: "backup",
    description: "Backup timeline database",
    enabled: true,
    isRunning: false,
    intervalMs: 1_800_000,
    lastRun: null,
    nextRunAt: null,
    ...overrides,
  };
}

function syncSource(overrides?: Partial<SyncSourceInfo>): SyncSourceInfo {
  return {
    name: "backup",
    description: "Backup timeline database",
    configured: true,
    enabled: true,
    interval: null,
    effectiveInterval: "30m",
    effectiveIntervalMs: 1_800_000,
    defaultInterval: "30m",
    settings: {},
    settingsSchema: [],
    ...overrides,
  };
}

function job(status: "queued" | "running"): Job {
  return {
    id: 42,
    kind: "sync",
    source: "backup",
    payload: {},
    dedupeKey: "sync:backup",
    status,
    priority: 0,
    attempt: 0,
    maxAttempts: 3,
    enqueuedAt: "2026-07-10 12:00:00",
    notBefore: "2026-07-10 12:00:00",
    startedAt: status === "running" ? "2026-07-10 12:01:00" : null,
    finishedAt: null,
    workerId: status === "running" ? "worker-1" : null,
    workerLeaseUntil: null,
    result: null,
    error: null,
    trigger: "manual",
  };
}

function completedJob(sourceName: string, id: number, eventsAdded: number): Job {
  return {
    ...job("running"),
    id,
    source: sourceName,
    dedupeKey: `sync:${sourceName}`,
    status: "succeeded",
    finishedAt: "2026-07-10 12:02:00",
    result: { eventsAdded },
  };
}

function historyEntry(sourceName: string, id: number): SyncHistoryEntry {
  return {
    id,
    job_id: id,
    source: sourceName,
    started_at: "2026-07-10 12:00:00",
    finished_at: "2026-07-10 12:01:00",
    success: 1,
    skipped: 0,
    events_added: 1,
    events_updated: 0,
    error: null,
    duration_ms: 60_000,
    metadata: null,
  };
}

function status(sourceStatuses: SchedulerSourceStatus[], queue: Job[] = []): ServiceStatus {
  return {
    service: {
      uptime: 60,
      startedAt: "2026-07-10T12:00:00Z",
      version: null,
    },
    scheduler: { enabled: true, sources: sourceStatuses },
    inbox: { enabled: true, watchedDirs: [], sources: [] },
    queue,
  };
}

function renderWith(sourceStatus: SchedulerSourceStatus | SchedulerSourceStatus[], queue: Job[] = []) {
  const sourceStatuses = Array.isArray(sourceStatus) ? sourceStatus : [sourceStatus];
  testState.statusQuery = loadedQuery(status(sourceStatuses, queue));
  return render(() => <SyncView />);
}

describe("SyncView source actions", () => {
  beforeEach(() => {
    testState.historyEntries = [];
    testState.inboxSources = [];
    testState.syncSources = [syncSource()];
    testState.triggerSync.mockReset();
    testState.waitForJob.mockReset();
  });

  it("allows an existing queued job to be manually prioritized", async () => {
    testState.triggerSync.mockResolvedValue({
      success: true,
      jobId: 42,
      deduped: true,
      message: "Sync already queued (job #42)",
    });
    testState.waitForJob.mockReturnValue(new Promise(() => {}));
    const { getAllByText, getByRole, getByText, queryByText } = renderWith(source(), [job("queued")]);

    const button = getByRole("button", { name: "Queued" });
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute("title", "Prioritize this queued sync");
    expect(getByRole("link", { name: "View Backup sync details" })).toHaveAttribute(
      "href",
      "/sync/backup",
    );
    expect(queryByText("Sync queued")).not.toBeInTheDocument();
    expect(getAllByText("#42")).toHaveLength(1);

    fireEvent.click(button);
    expect(testState.triggerSync).toHaveBeenCalledWith("backup");
    await waitFor(() => {
      expect(getByRole("button", { name: "Queued" })).toBeDisabled();
      expect(getByRole("button", { name: "Queued" })).toHaveAttribute(
        "title",
        "A sync run is already queued for this source",
      );
      expect(getByText("Sync already queued (job #42)")).toBeInTheDocument();
    });
  });

  it("labels a running job without duplicating the running card status", () => {
    const runningSource = source({
      isRunning: true,
      lastRun: {
        time: "2026-07-10T12:01:00Z",
        success: false,
        skipped: false,
        isRunning: true,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: null,
        durationMs: 0,
      },
    });
    const { getByRole, getAllByText, queryByText } = renderWith(runningSource, [job("running")]);

    expect(getByRole("button", { name: "Running…" })).toBeDisabled();
    expect(getAllByText("Running")).toHaveLength(1);
    expect(queryByText("Sync running")).not.toBeInTheDocument();
  });

  it("explains that a disabled source cannot be synced", () => {
    const { getByRole } = renderWith(source({ enabled: false }));

    expect(getByRole("button", { name: "Disabled" })).toBeDisabled();
  });

  it("shows Queueing only while the trigger request is in flight", async () => {
    testState.triggerSync.mockReturnValue(new Promise(() => {}));
    const { getByRole } = renderWith(source());

    const button = getByRole("button", { name: "Sync Now" });
    expect(button).toBeEnabled();
    fireEvent.click(button);

    expect(getByRole("button", { name: "Queueing…" })).toBeDisabled();
  });

  it("keeps completion messages for concurrent sources", async () => {
    testState.syncSources = [syncSource(), syncSource({ name: "archive" })];
    testState.triggerSync.mockImplementation(async (sourceName: string) => ({
      success: true,
      jobId: sourceName === "backup" ? 42 : 43,
      deduped: false,
      message: "Sync queued",
    }));
    testState.waitForJob.mockImplementation(async (id: number) => (
      id === 42 ? completedJob("backup", 42, 2) : completedJob("archive", 43, 3)
    ));
    const { getAllByRole, getByText } = renderWith([
      source(),
      source({ source: "archive", description: "Archive data" }),
    ]);

    for (const button of getAllByRole("button", { name: "Sync Now" })) {
      fireEvent.click(button);
    }

    await waitFor(() => {
      expect(getByText("Sync completed: +2 events")).toBeInTheDocument();
      expect(getByText("Sync completed: +3 events")).toBeInTheDocument();
    });
  });

  it("uses polled job updates to show a running action", async () => {
    testState.triggerSync.mockResolvedValue({
      success: true,
      jobId: 42,
      deduped: false,
      message: "Sync queued",
    });
    testState.waitForJob.mockImplementation(
      async (_id: number, options?: { onUpdate?: (job: Job) => void }) => {
        options?.onUpdate?.(job("running"));
        return new Promise<Job>(() => {});
      },
    );
    const { getByRole } = renderWith(source());

    fireEvent.click(getByRole("button", { name: "Sync Now" }));

    await waitFor(() => expect(getByRole("button", { name: "Running…" })).toBeDisabled());
  });

  it("links history only for configured sync sources", () => {
    testState.historyEntries = [historyEntry("backup", 1), historyEntry("google-takeout", 2)];
    const { getByRole, queryByRole } = renderWith(source());

    expect(getByRole("link", { name: "View Backup sync details" })).toHaveAttribute("href", "/sync/backup");
    expect(queryByRole("link", { name: "View Google Takeout sync details" })).not.toBeInTheDocument();
    expect(getByRole("cell", { name: /Google Takeout/ })).toBeInTheDocument();
  });

  it("shows proper names for built-in upload parsers", () => {
    testState.inboxSources = [
      {
        name: "google-takeout",
        parser: "google-takeout",
        account: null,
        patterns: ["*.zip"],
        enabled: true,
      },
    ];

    const { getByRole } = renderWith(source());
    const option = getByRole("option", { name: "Google Takeout" });

    expect(option).toHaveValue("google-takeout");
  });
});
