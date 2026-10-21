import type { ReleaseStatus } from "@shared/releases";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import ReleaseCard from "./ReleaseCard";

const status: ReleaseStatus = {
  latest: {
    version: "0.10.0",
    url: "https://github.com/example/timeline/releases/tag/v0.10.0",
    publishedAt: "2026-01-15T12:00:00Z",
    notes: "## Changes\n\n- **Faster searches.**\n\n<script>bad()</script>\n\n[unsafe](javascript:bad())",
    downloadUrl: "https://github.com/example/timeline/releases/download/v0.10.0/Timeline-0.10.0-macos-arm64.dmg",
  },
  comparison: "update-available",
  checkedAt: "2026-01-15T12:00:00Z",
};

describe("ReleaseCard", () => {
  afterEach(cleanup);

  it("shows a downloadable update and safe release notes", () => {
    const view = render(() => <ReleaseCard status={status} error={null} checking={false} onCheck={() => {}} />);
    expect(view.getByRole("status")).toHaveTextContent("An update is available.");
    expect(view.getByRole("link", { name: "Download for macOS" })).toHaveAttribute("href", status.latest.downloadUrl);
    expect(view.getByText("Faster searches.", { selector: "strong" })).toBeInTheDocument();
    expect(view.container.querySelector("script")).toBeNull();
    expect(view.container.querySelector('a[href^="javascript:"]')).toBeNull();
  });

  it("updates reactively when packaging finishes and the running version changes", () => {
    const [data, setData] = createSignal<ReleaseStatus>({ ...status, latest: { ...status.latest, downloadUrl: null } });
    const view = render(() => <ReleaseCard status={data()} error={null} checking={false} onCheck={() => {}} />);
    expect(view.getByRole("status")).toHaveTextContent("being packaged");
    expect(view.queryByRole("link", { name: "Download for macOS" })).toBeNull();
    setData(status);
    expect(view.getByRole("status")).toHaveTextContent("An update is available.");
    setData({ ...status, comparison: "current" });
    expect(view.getByRole("status")).toHaveTextContent("You’re running the latest release.");
    setData({ ...status, comparison: "ahead" });
    expect(view.getByRole("status")).toHaveTextContent("newer than the latest release");
    setData({ ...status, comparison: "unknown" });
    expect(view.getByRole("status")).toHaveTextContent("Latest published release");
  });

  it("reports a failed refresh without claiming the cached release is current", () => {
    const onCheck = vi.fn();
    const view = render(() => <ReleaseCard status={{ ...status, comparison: "current" }} error={new Error("GitHub denied access.")} checking={false} onCheck={onCheck} />);
    expect(view.getByRole("status")).toHaveTextContent("Could not check releases.");
    expect(view.getByText("GitHub denied access.")).toBeInTheDocument();
    fireEvent.click(view.getByRole("button", { name: "Check for updates" }));
    expect(onCheck).toHaveBeenCalledOnce();
  });

  it("disables duplicate checks while loading", () => {
    const view = render(() => <ReleaseCard status={undefined} error={null} checking={true} onCheck={() => {}} />);
    expect(view.getByRole("status")).toHaveTextContent("Checking releases");
    expect(view.getByRole("button", { name: "Checking…" })).toBeDisabled();
  });
});
