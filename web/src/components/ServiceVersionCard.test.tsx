import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import type { ServiceStatus } from "../lib/api";
import ServiceVersionCard from "./ServiceVersionCard";

const COMMIT = "1111111111111111111111111111111111111111";

function service(
  version: ServiceStatus["service"]["version"],
): ServiceStatus["service"] {
  return {
    uptime: 60,
    startedAt: "2026-08-06T10:00:00Z",
    version,
  };
}

describe("ServiceVersionCard", () => {
  afterEach(() => cleanup());

  it("leads with release and build for a packaged install", () => {
    const view = render(() => (
      <ServiceVersionCard
        service={service({
          version: "0.8.1",
          build: "10",
          commit: COMMIT.slice(0, 7),
          commitFull: COMMIT,
          message: "Package the Timeline service",
          branch: "main",
          builtAt: "2026-08-06T12:00:00Z",
        })}
        isError={false}
      />
    ));

    expect(view.getByText("Packaged build")).toBeInTheDocument();
    // Release version and build number are the primary identity...
    expect(view.getByText("Version", { selector: "dt" })).toBeInTheDocument();
    expect(view.getByText("0.8.1")).toBeInTheDocument();
    expect(view.getByText("build", { selector: "dt" })).toBeInTheDocument();
    expect(view.getByText("10")).toBeInTheDocument();
    // ...with commit provenance kept as supporting detail.
    expect(view.getByText("1111111")).toBeInTheDocument();
    expect(view.getByText("Package the Timeline service")).toBeInTheDocument();
    expect(view.getByText("main")).toBeInTheDocument();
    expect(view.queryByText("Local changes")).not.toBeInTheDocument();
  });

  it("labels a checkout build without inventing a release", () => {
    const view = render(() => (
      <ServiceVersionCard
        service={service({
          commit: COMMIT.slice(0, 7),
          commitFull: COMMIT,
          message: "Run from source",
          branch: "feature",
          dirty: true,
        })}
        isError={false}
      />
    ));

    expect(view.getByText("Source build")).toBeInTheDocument();
    expect(view.getByText("Local changes")).toBeInTheDocument();
    expect(view.getByText("1111111")).toBeInTheDocument();
    expect(view.getByText("feature")).toBeInTheDocument();
    expect(view.queryByText("Version", { selector: "dt" })).not.toBeInTheDocument();
    expect(view.queryByText("build", { selector: "dt" })).not.toBeInTheDocument();
  });

  it("does not claim a packaged identity when the build number is missing", () => {
    const view = render(() => (
      <ServiceVersionCard
        service={service({
          version: "0.9.0",
          commit: COMMIT.slice(0, 7),
          commitFull: COMMIT,
          message: "Half-labelled build",
          branch: "main",
        })}
        isError={false}
      />
    ));

    expect(view.getByText("Source build")).toBeInTheDocument();
    expect(view.queryByText("Version", { selector: "dt" })).not.toBeInTheDocument();
    // The reported version is still shown honestly, as a secondary fact.
    expect(view.getByText("version", { selector: "dt" })).toBeInTheDocument();
    expect(view.getByText("0.9.0")).toBeInTheDocument();
  });

  it("reports unavailable version information", () => {
    const view = render(() => (
      <ServiceVersionCard service={service(null)} isError={false} />
    ));

    expect(view.getByText(/could not identify the build/)).toBeInTheDocument();
    expect(view.getByText(/no version metadata/i)).toBeInTheDocument();
  });

  it("keeps loading and error states", () => {
    const loading = render(() => <ServiceVersionCard service={null} isError={false} />);
    expect(loading.getByText(/Loading version information/)).toBeInTheDocument();
    cleanup();

    const failed = render(() => <ServiceVersionCard service={null} isError={true} />);
    expect(failed.getByText(/Failed to load version information/)).toBeInTheDocument();
  });

  it("offers no update affordance yet", () => {
    const view = render(() => (
      <ServiceVersionCard
        service={service({
          version: "0.8.1",
          build: "10",
          commit: COMMIT.slice(0, 7),
          commitFull: COMMIT,
          message: "Package the Timeline service",
          branch: "main",
        })}
        isError={false}
      />
    ));

    expect(view.queryByRole("button")).not.toBeInTheDocument();
    expect(view.queryByRole("link")).not.toBeInTheDocument();
    expect(view.container.textContent ?? "").not.toMatch(/update|changelog|upstream|behind/i);
  });
});
