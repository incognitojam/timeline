import { fireEvent, render, waitFor, within } from "@solidjs/testing-library";
import type { ParentProps } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SyncSourceConfigurationError,
  type SyncHistoryEntry,
  type SyncSourceInfo,
  type SyncSourcesResponse,
} from "../lib/api";
import SyncSourceDetailView from "./SyncSourceDetailView";

const testState = vi.hoisted(() => ({
  setRouteSource: (_source: string) => {},
  setSyncSourcesData: (_data: SyncSourcesResponse | undefined) => {},
  beforeLeave: undefined as unknown,
  statusQuery: {} as unknown,
  historyQuery: {} as unknown,
  triggerSync: vi.fn(),
  updateConfiguration: vi.fn(),
}));

vi.mock("@solidjs/router", async () => {
  const { createSignal } = await import("solid-js");
  const [routeSource, setRouteSource] = createSignal("backup");
  testState.setRouteSource = setRouteSource;

  return {
    useParams: () => ({
      get source() {
        return routeSource();
      },
    }),
    useBeforeLeave: (handler: unknown) => {
      testState.beforeLeave = handler;
    },
    A: (props: ParentProps<{ href: string; class?: string; title?: string }>) => (
      <a href={props.href} class={props.class} title={props.title}>
        {props.children}
      </a>
    ),
  };
});

vi.mock("../lib/queries", async () => {
  const { createSignal } = await import("solid-js");
  const [syncSourcesData, setSyncSourcesData] = createSignal<SyncSourcesResponse>();
  testState.setSyncSourcesData = (data) => setSyncSourcesData(data);

  const syncSourcesQuery = {
    get data() {
      return syncSourcesData();
    },
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    refetch: vi.fn(),
  };

  return {
    useServiceStatus: () => testState.statusQuery,
    useSyncSources: () => syncSourcesQuery,
    useSyncHistory: () => testState.historyQuery,
    useTriggerSyncSource: () => ({ mutateAsync: testState.triggerSync, isPending: false }),
    useUpdateSyncSourceConfiguration: () => ({ mutateAsync: testState.updateConfiguration }),
  };
});

vi.mock("../lib/echarts-theme", () => ({
  useChartTheme: () => ({
    option: (option: unknown) => option,
    palette: () => ["#625690"],
  }),
}));

vi.mock("../ui/echarts", () => ({
  EChartsAutoSize: (props: { option: unknown }) => (
    <div data-testid="queue-depth-chart" data-option={JSON.stringify(props.option)} />
  ),
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

function backupSource(overrides?: Partial<SyncSourceInfo>): SyncSourceInfo {
  return {
    name: "backup",
    description: "Backup timeline database",
    configured: true,
    enabled: true,
    interval: null,
    effectiveInterval: "30m",
    effectiveIntervalMs: 1_800_000,
    defaultInterval: "30m",
    settings: { destination: "/tmp/backups", keep_count: 24, compress: true, mode: "full" },
    settingsSchema: [
      { key: "destination", type: "string", label: "Backup directory", description: "Where backups go", required: true },
      { key: "keep_count", type: "number", label: "Backups to retain", integer: true, min: 1, default: 24 },
      { key: "compress", type: "boolean", label: "Compress backups", default: true },
      { key: "mode", type: "select", label: "Backup mode", options: ["full", "incremental"], default: "full" },
    ],
    ...overrides,
  };
}

function elsewhereSource(): SyncSourceInfo {
  return {
    ...backupSource(),
    name: "elsewhere",
    description: "Another sync source",
    settings: { destination: "/tmp/elsewhere", keep_count: 8, compress: false, mode: "incremental" },
  };
}

function renderWith(...sources: SyncSourceInfo[]) {
  testState.setSyncSourcesData({ sources });
  return render(() => <SyncSourceDetailView />);
}

function historyEntry(
  id: number,
  finishedAt: string,
  remainingQueueDepth: number,
  overrides?: Partial<SyncHistoryEntry>
): SyncHistoryEntry {
  return {
    id,
    job_id: null,
    source: "attachment-descriptions",
    started_at: finishedAt,
    finished_at: finishedAt,
    success: 1,
    skipped: 0,
    events_added: 10,
    events_updated: 0,
    error: null,
    duration_ms: 60_000,
    metadata: JSON.stringify({ remainingQueueDepth }),
    ...overrides,
  };
}

function configurationForm() {
  return within(document.body).getByRole("form", { name: "Source configuration" });
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface TestBeforeLeaveEvent {
  defaultPrevented: boolean;
  preventDefault: () => void;
  retry: (force: boolean) => void;
}

function beforeLeaveGuard(): (event: TestBeforeLeaveEvent) => void {
  if (typeof testState.beforeLeave !== "function") {
    throw new Error("expected useBeforeLeave to capture a navigation guard");
  }
  return testState.beforeLeave as (event: TestBeforeLeaveEvent) => void;
}

function leaveEvent() {
  const preventDefault = vi.fn();
  const retry = vi.fn();
  return {
    event: { defaultPrevented: false, preventDefault, retry },
    preventDefault,
    retry,
  };
}

describe("SyncSourceDetailView configuration form", () => {
  beforeEach(() => {
    testState.setRouteSource("backup");
    testState.setSyncSourcesData(undefined);
    testState.beforeLeave = undefined;
    testState.statusQuery = { data: undefined, isError: false, refetch: vi.fn() };
    testState.historyQuery = loadedQuery({ entries: [], count: 0 });
    testState.triggerSync.mockReset();
    testState.updateConfiguration.mockReset();
    testState.updateConfiguration.mockResolvedValue(backupSource());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders scheduling and every schema field in exactly one configuration form", () => {
    const { getAllByRole, getByLabelText, getByRole, getByText } = renderWith(backupSource());

    expect(getAllByRole("form", { name: "Source configuration" })).toHaveLength(1);
    expect(getByRole("switch", { name: "Automatic sync" })).toBeChecked();
    expect(getByLabelText("Sync interval")).toHaveValue("");
    expect(getByText("Backup directory")).toBeInTheDocument();
    expect(getByText("Backups to retain")).toBeInTheDocument();
    expect(getByText("Compress backups")).toBeInTheDocument();
    expect(getByText("Backup mode")).toBeInTheDocument();
    expect(getByRole("radiogroup", { name: "Backup mode" })).toBeInTheDocument();
    expect(getByLabelText("Backup directory")).toHaveValue("/tmp/backups");
    expect(getByLabelText("Backups to retain")).toHaveValue("24");
  });

  it("shows OAuth authentication status only when the API provides it", () => {
    const { getByText, queryByText } = renderWith(backupSource({ authStatus: "needs-reauth" }));

    expect(getByText("Re-auth required")).toBeInTheDocument();
    expect(queryByText("Connected")).not.toBeInTheDocument();
  });

  it("stages using a field default as override removal", async () => {
    const { getByText } = renderWith(backupSource());
    const row = getByText("Compress backups").closest(".grid");
    if (!(row instanceof HTMLElement)) throw new Error("expected the boolean setting row");

    fireEvent.click(within(row).getByRole("button", { name: "Use default for Compress backups" }));
    expect(row).toHaveTextContent("Using default, On");
    expect(testState.updateConfiguration).not.toHaveBeenCalled();
    fireEvent.click(within(configurationForm()).getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(testState.updateConfiguration).toHaveBeenCalledWith({
        source: "backup",
        patch: { settings: { compress: null } },
      });
    });
  });

  it("displays effective defaults when no override is stored", () => {
    const { getByLabelText, getByRole } = renderWith(backupSource({
      settings: { destination: "/tmp/backups" },
    }));
    const keepCountRow = getByLabelText("Backups to retain").closest(".grid");
    if (!(keepCountRow instanceof HTMLElement)) throw new Error("expected the number setting row");

    expect(getByLabelText("Backups to retain")).toHaveValue("24");
    expect(getByRole("switch", { name: "Compress backups" })).toBeChecked();
    expect(getByRole("radio", { name: "full" })).toBeChecked();
    expect(keepCountRow).toHaveTextContent("Using default, 24");
    expect(within(configurationForm()).getByRole("button", { name: "Use source defaults" })).toBeDisabled();
    expect(testState.updateConfiguration).not.toHaveBeenCalled();
  });

  it("removes a malformed stored override when staging source defaults", async () => {
    const { getByLabelText } = renderWith(backupSource({
      settings: { destination: "/tmp/backups", keep_count: "twenty-four" },
    }));
    const form = configurationForm();
    const keepCountRow = getByLabelText("Backups to retain").closest(".grid");
    if (!(keepCountRow instanceof HTMLElement)) throw new Error("expected the number setting row");

    expect(getByLabelText("Backups to retain")).toHaveValue("24");
    expect(keepCountRow).toHaveTextContent("Invalid stored override · Default is 24");

    fireEvent.click(within(form).getByRole("button", { name: "Use source defaults" }));
    expect(testState.updateConfiguration).not.toHaveBeenCalled();
    fireEvent.click(within(form).getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(testState.updateConfiguration).toHaveBeenCalledWith({
        source: "backup",
        patch: { settings: { keep_count: null } },
      });
    });
  });

  it("stages source defaults without changing enabled or required setup values", async () => {
    const { getByLabelText, getByRole } = renderWith(backupSource({
      enabled: false,
      interval: "2h",
      settings: {
        destination: "/mnt/required-backups",
        keep_count: 12,
        compress: false,
        mode: "incremental",
      },
    }));
    const form = configurationForm();
    const destinationRow = getByLabelText("Backup directory").closest(".grid");
    if (!(destinationRow instanceof HTMLElement)) throw new Error("expected the required setting row");

    expect(within(destinationRow).queryByRole("button", { name: /Use default|Remove override/ })).toBeNull();
    fireEvent.click(within(form).getByRole("button", { name: "Use source defaults" }));

    expect(getByRole("switch", { name: "Automatic sync" })).not.toBeChecked();
    expect(getByLabelText("Sync interval")).toHaveValue("");
    expect(getByLabelText("Backup directory")).toHaveValue("/mnt/required-backups");
    expect(getByLabelText("Backups to retain")).toHaveValue("24");
    expect(getByRole("switch", { name: "Compress backups" })).toBeChecked();
    expect(getByRole("radio", { name: "full" })).toBeChecked();
    expect(testState.updateConfiguration).not.toHaveBeenCalled();

    fireEvent.click(within(form).getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(testState.updateConfiguration).toHaveBeenCalledWith({
        source: "backup",
        patch: {
          interval: null,
          settings: {
            keep_count: null,
            compress: null,
            mode: null,
          },
        },
      });
    });
  });

  it("stages edits, toggles, and selections before sending one combined minimal PATCH", async () => {
    const { getByLabelText, getByRole } = renderWith(backupSource());
    const form = configurationForm();

    fireEvent.click(getByRole("switch", { name: "Automatic sync" }));
    fireEvent.input(getByLabelText("Sync interval"), { target: { value: " 45m " } });
    fireEvent.input(getByLabelText("Backup directory"), { target: { value: "  /mnt/new-backups  " } });
    fireEvent.click(getByRole("switch", { name: "Compress backups" }));
    fireEvent.click(getByRole("radio", { name: "incremental" }));

    expect(testState.updateConfiguration).not.toHaveBeenCalled();
    expect(within(form).getByRole("button", { name: "Save changes" })).toBeEnabled();

    fireEvent.click(within(form).getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(testState.updateConfiguration).toHaveBeenCalledTimes(1);
      expect(testState.updateConfiguration).toHaveBeenCalledWith({
        source: "backup",
        patch: {
          enabled: false,
          interval: "45m",
          settings: {
            destination: "/mnt/new-backups",
            compress: false,
            mode: "incremental",
          },
        },
      });
    });
  });

  it("returns to a clean state when a draft is manually restored exactly", () => {
    const { getByLabelText } = renderWith(backupSource());
    const form = configurationForm();
    const destination = getByLabelText("Backup directory");

    fireEvent.input(destination, { target: { value: "/mnt/temporary" } });
    expect(within(form).getByRole("button", { name: "Save changes" })).toBeEnabled();

    fireEvent.input(getByLabelText("Backup directory"), { target: { value: "/tmp/backups" } });

    expect(getByLabelText("Backup directory")).toHaveValue("/tmp/backups");
    expect(within(form).getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(within(form).getByRole("button", { name: "Discard changes" })).toBeDisabled();
    expect(testState.updateConfiguration).not.toHaveBeenCalled();
  });

  it("keeps a configuration input focused while typing", () => {
    const { getByLabelText } = renderWith(backupSource());
    const destination = getByLabelText("Backup directory");

    destination.focus();
    fireEvent.input(destination, { target: { value: "/tmp/backups-a" } });

    expect(getByLabelText("Backup directory")).toBe(destination);
    expect(destination).toHaveFocus();
  });

  it("discards the complete draft without saving", () => {
    const { getByLabelText, getByRole, queryByText } = renderWith(backupSource());
    const form = configurationForm();

    fireEvent.input(getByLabelText("Sync interval"), { target: { value: "2h" } });
    fireEvent.input(getByLabelText("Backup directory"), { target: { value: "/mnt/discarded" } });
    fireEvent.click(getByRole("switch", { name: "Automatic sync" }));
    fireEvent.click(within(form).getByRole("button", { name: "Discard changes" }));

    expect(getByLabelText("Sync interval")).toHaveValue("");
    expect(getByLabelText("Backup directory")).toHaveValue("/tmp/backups");
    expect(getByRole("switch", { name: "Automatic sync" })).toBeChecked();
    expect(within(form).getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(queryByText(/unsaved changes?/)).not.toBeInTheDocument();
    expect(testState.updateConfiguration).not.toHaveBeenCalled();
  });

  it("reseeds a pristine form from a background refetch", async () => {
    const { getByLabelText, getByRole } = renderWith(backupSource());

    testState.setSyncSourcesData({
      sources: [backupSource({
        enabled: false,
        interval: "2h",
        settings: { destination: "/mnt/refetched", keep_count: 10, compress: false, mode: "incremental" },
      })],
    });

    await waitFor(() => {
      expect(getByRole("switch", { name: "Automatic sync" })).not.toBeChecked();
      expect(getByLabelText("Sync interval")).toHaveValue("2h");
      expect(getByLabelText("Backup directory")).toHaveValue("/mnt/refetched");
      expect(getByLabelText("Backups to retain")).toHaveValue("10");
    });
  });

  it("preserves the whole local draft when a background refetch arrives while dirty", async () => {
    const { getByLabelText, getByRole } = renderWith(backupSource());

    fireEvent.input(getByLabelText("Backup directory"), { target: { value: "/mnt/local-draft" } });
    testState.setSyncSourcesData({
      sources: [backupSource({
        enabled: false,
        interval: "2h",
        settings: { destination: "/mnt/refetched", keep_count: 10, compress: false, mode: "incremental" },
      })],
    });

    await waitFor(() => {
      expect(getByLabelText("Backup directory")).toHaveValue("/mnt/local-draft");
      expect(getByLabelText("Sync interval")).toHaveValue("");
      expect(getByRole("switch", { name: "Automatic sync" })).toBeChecked();
      expect(within(configurationForm()).getByRole("button", { name: "Save changes" })).toBeEnabled();
    });
  });

  it("places a structured server error beside its field and clears it on edit", async () => {
    testState.updateConfiguration.mockRejectedValueOnce(
      new SyncSourceConfigurationError("Backup directory is not writable", "settings.destination")
    );
    const { findByText, getByLabelText, queryByText } = renderWith(backupSource());
    const destination = getByLabelText("Backup directory");

    fireEvent.input(destination, { target: { value: "/bad" } });
    fireEvent.click(within(configurationForm()).getByRole("button", { name: "Save changes" }));

    expect(await findByText("Backup directory is not writable")).toBeInTheDocument();
    expect(destination).toHaveValue("/bad");
    expect(getByLabelText("Backup directory")).toHaveAttribute("aria-invalid", "true");
    expect(getByLabelText("Backup directory")).toHaveAttribute(
      "aria-describedby",
      "sync-error-destination"
    );

    await waitFor(() => expect(getByLabelText("Backup directory")).toBeEnabled());
    fireEvent.input(getByLabelText("Backup directory"), { target: { value: "/better" } });

    await waitFor(() => {
      expect(queryByText("Backup directory is not writable")).not.toBeInTheDocument();
      expect(getByLabelText("Backup directory")).not.toHaveAttribute("aria-invalid");
    });
  });

  it("shows an unstructured submission failure in the form footer", async () => {
    testState.updateConfiguration.mockRejectedValueOnce(new Error("Network unavailable"));
    const { findByText, getByLabelText } = renderWith(backupSource());

    fireEvent.input(getByLabelText("Backup directory"), { target: { value: "/mnt/new" } });
    fireEvent.click(within(configurationForm()).getByRole("button", { name: "Save changes" }));

    expect(await findByText("Network unavailable")).toHaveAttribute("role", "alert");
    expect(getByLabelText("Backup directory")).toHaveValue("/mnt/new");
  });

  it("preserves non-decimal numeric input for server-authoritative validation", async () => {
    const { getByLabelText } = renderWith(backupSource());

    fireEvent.input(getByLabelText("Backups to retain"), { target: { value: "0x10" } });
    fireEvent.click(within(configurationForm()).getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(testState.updateConfiguration).toHaveBeenCalledWith({
        source: "backup",
        patch: { settings: { keep_count: "0x10" } },
      });
    });
  });

  it.each([
    {
      label: "an overflowing decimal",
      draft: `1${"0".repeat(309)}`,
      message: "Number is too large",
    },
    {
      label: "an unsafe integer",
      draft: "9007199254740993",
      message: "Must be a whole number in the safe integer range",
    },
  ])("blocks $label locally", ({ draft, message }) => {
    const { getByLabelText, getByText } = renderWith(backupSource());

    fireEvent.input(getByLabelText("Backups to retain"), { target: { value: draft } });
    fireEvent.click(within(configurationForm()).getByRole("button", { name: "Save changes" }));

    expect(getByText(message)).toBeInTheDocument();
    expect(testState.updateConfiguration).not.toHaveBeenCalled();
  });

  it("blocks duplicate submissions while the combined PATCH is pending", async () => {
    const pending = deferred<SyncSourceInfo>();
    testState.updateConfiguration.mockImplementationOnce(() => pending.promise);
    const { getByLabelText } = renderWith(backupSource());
    const form = configurationForm();

    fireEvent.input(getByLabelText("Backup directory"), { target: { value: "/mnt/pending" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(testState.updateConfiguration).toHaveBeenCalledTimes(1);
      expect(within(form).getByRole("button", { name: "Saving changes..." })).toBeDisabled();
      expect(within(form).getByRole("radio", { name: "incremental" })).toBeDisabled();
    });

    fireEvent.submit(form);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(testState.updateConfiguration).toHaveBeenCalledTimes(1);

    pending.resolve(backupSource({
      settings: { destination: "/mnt/pending", keep_count: 24, compress: true, mode: "full" },
    }));
    await waitFor(() => {
      expect(within(form).getByRole("button", { name: "Save changes" })).toBeDisabled();
    });
  });

  it("ignores an A-to-B-to-A stale save completion without overwriting the newer draft", async () => {
    const stale = deferred<SyncSourceInfo>();
    testState.updateConfiguration.mockImplementationOnce(() => stale.promise);
    const { getByLabelText } = renderWith(backupSource(), elsewhereSource());

    fireEvent.input(getByLabelText("Backup directory"), { target: { value: "/mnt/stale" } });
    fireEvent.click(within(configurationForm()).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(testState.updateConfiguration).toHaveBeenCalledTimes(1));

    testState.setRouteSource("elsewhere");
    await waitFor(() => expect(getByLabelText("Backup directory")).toHaveValue("/tmp/elsewhere"));
    testState.setRouteSource("backup");
    await waitFor(() => expect(getByLabelText("Backup directory")).toHaveValue("/tmp/backups"));

    const newerDraft = getByLabelText("Backup directory");
    expect(newerDraft).toBeEnabled();
    fireEvent.input(newerDraft, { target: { value: "/mnt/newer" } });
    expect(within(configurationForm()).getByRole("button", { name: "Save changes" })).toBeDisabled();

    stale.resolve(backupSource({
      settings: { destination: "/mnt/stale", keep_count: 24, compress: true, mode: "full" },
    }));

    await waitFor(() => {
      expect(getByLabelText("Backup directory")).toHaveValue("/mnt/newer");
      expect(within(configurationForm()).getByRole("button", { name: "Save changes" })).toBeEnabled();
    });

    fireEvent.click(within(configurationForm()).getByRole("button", { name: "Save changes" }));
    await waitFor(() => {
      expect(testState.updateConfiguration).toHaveBeenCalledTimes(2);
      expect(testState.updateConfiguration).toHaveBeenLastCalledWith({
        source: "backup",
        patch: { settings: { destination: "/mnt/newer" } },
      });
    });
  });

  it("guards dirty in-app navigation and browser unload, but leaves pristine navigation alone", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { getByLabelText } = renderWith(backupSource());
    const guard = beforeLeaveGuard();

    const pristineLeave = leaveEvent();
    guard(pristineLeave.event);
    expect(pristineLeave.preventDefault).not.toHaveBeenCalled();

    const pristineUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(pristineUnload);
    expect(pristineUnload.defaultPrevented).toBe(false);

    fireEvent.input(getByLabelText("Backup directory"), { target: { value: "/mnt/dirty" } });

    const cancelledLeave = leaveEvent();
    guard(cancelledLeave.event);
    expect(cancelledLeave.preventDefault).toHaveBeenCalledOnce();
    expect(cancelledLeave.retry).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    const acceptedLeave = leaveEvent();
    guard(acceptedLeave.event);
    expect(acceptedLeave.preventDefault).toHaveBeenCalledOnce();
    expect(acceptedLeave.retry).toHaveBeenCalledWith(true);

    const dirtyUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirtyUnload);
    expect(dirtyUnload.defaultPrevented).toBe(true);
  });

  it("keeps enabled and interval editable when the source has no settings schema", async () => {
    const { getAllByRole, getByLabelText, getByRole, queryByText } = renderWith(
      backupSource({ settings: {}, settingsSchema: [] })
    );

    expect(getAllByRole("form", { name: "Source configuration" })).toHaveLength(1);
    expect(getByRole("switch", { name: "Automatic sync" })).toBeChecked();
    expect(getByLabelText("Sync interval")).toHaveValue("");
    expect(queryByText("Backup directory")).not.toBeInTheDocument();

    fireEvent.click(getByRole("switch", { name: "Automatic sync" }));
    fireEvent.input(getByLabelText("Sync interval"), { target: { value: "1h" } });
    expect(testState.updateConfiguration).not.toHaveBeenCalled();
    fireEvent.click(within(configurationForm()).getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(testState.updateConfiguration).toHaveBeenCalledWith({
        source: "backup",
        patch: { enabled: false, interval: "1h" },
      });
    });
  });

  it("shows a queued sync job before its run-history row exists", () => {
    testState.statusQuery = loadedQuery({
      scheduler: { enabled: true, sources: [] },
      queue: [{
        id: 42,
        kind: "sync",
        source: "backup",
        status: "queued",
        enqueuedAt: "2026-07-10 12:00:00",
        startedAt: null,
      }],
    });

    const { getByText, queryByText } = renderWith(backupSource());

    expect(getByText("Queued")).toBeInTheDocument();
    expect(getByText("#42")).toBeInTheDocument();
    expect(queryByText("No runs recorded yet.")).not.toBeInTheDocument();
  });

  it("charts remaining queue depth metadata in chronological order", () => {
    testState.setRouteSource("attachment-descriptions");
    testState.historyQuery = loadedQuery({
      entries: [
        historyEntry(2, "2026-07-10 13:05:00", 1200),
        historyEntry(1, "2026-07-10 12:05:00", 1500),
      ],
      count: 2,
    });

    const { getByRole, getByTestId, getByText } = renderWith(backupSource({
      name: "attachment-descriptions",
      description: "Generate AI descriptions for new image attachments",
      settings: {},
      settingsSchema: [],
    }));

    expect(getByText("Remaining queue depth")).toBeInTheDocument();
    expect(getByText("1,200")).toBeInTheDocument();
    expect(getByText("300 fewer since first sample")).toBeInTheDocument();
    expect(getByRole("img")).toHaveAccessibleName(
      "Remaining queue depth over time. Latest 1,200; 300 fewer since first sample."
    );

    const option = JSON.parse(getByTestId("queue-depth-chart").dataset.option ?? "null");
    expect(option.series[0].data).toEqual([
      ["2026-07-10T12:05:00Z", 1500],
      ["2026-07-10T13:05:00Z", 1200],
    ]);
  });

  it("renders blocked and deferred skipped runs differently", () => {
    const reason = "Spotify missing refresh token. Run: bun run src/parsers/spotify-api.ts auth";
    testState.historyQuery = loadedQuery({
      entries: [
        historyEntry(2, "2026-07-10 13:05:00", 0, {
          skipped: 1,
          error: reason,
          metadata: null,
        }),
        historyEntry(1, "2026-07-10 12:05:00", 0, {
          skipped: 1,
          metadata: '{"guard":"network","skipReason":"offline"}',
        }),
      ],
      count: 2,
    });

    const { getByText } = renderWith(backupSource());
    const blocked = getByText(`Blocked: ${reason.slice(0, 60)}`);
    const deferred = getByText("Deferred");

    expect(blocked).toHaveClass("text-red-400");
    expect(blocked).toHaveAttribute("title", reason);
    expect(deferred).toHaveClass("text-yellow-400");
    expect(deferred).not.toHaveAttribute("title");
  });

  it("includes blocked runs in the success-rate breakdown", () => {
    testState.historyQuery = loadedQuery({
      entries: [
        historyEntry(4, "2026-07-10 15:05:00", 0),
        historyEntry(3, "2026-07-10 14:05:00", 0),
        historyEntry(2, "2026-07-10 13:05:00", 0, {
          success: 0,
          error: "Service unavailable",
        }),
        historyEntry(1, "2026-07-10 12:05:00", 0, {
          skipped: 1,
          error: "Authentication required",
        }),
      ],
      count: 4,
    });

    const { getByText } = renderWith(backupSource());

    expect(getByText("67%")).toBeInTheDocument();
    expect(getByText("2 ok / 1 fail / 1 blocked")).toBeInTheDocument();
  });
});
