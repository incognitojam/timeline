import type { MemoryIndex, MemoryNote } from "@shared/memory";
import { render, screen, within } from "@solidjs/testing-library";
import type { ParentProps } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import MemoryNoteView from "./MemoryNoteView";
import MemoryProjectView from "./MemoryProjectView";
import MemoryView from "./MemoryView";

vi.mock("@solidjs/router", () => ({
  useParams: () => ({ name: "overview", key: "garden-app" }),
  useLocation: () => ({ pathname: "/memory", search: "" }),
  useSearchParams: () => [{ project: "garden-app" }],
  useNavigate: () => vi.fn(),
  A: (props: ParentProps<{ href: string; class?: string }>) => (
    <a href={props.href} class={props.class}>
      {props.children}
    </a>
  ),
}));

function note(fields: Partial<MemoryNote> & Pick<MemoryNote, "name" | "kind" | "title">): MemoryNote {
  return {
    id: 1,
    project: "",
    summary: `${fields.title} summary`,
    details: "",
    contact_id: null,
    created_at: "2026-11-01T10:00:00.000Z",
    updated_at: "2026-11-20T10:00:00.000Z",
    ...fields,
  };
}

const overview = note({
  project: "garden-app",
  name: "overview",
  kind: "project",
  title: "Garden app",
  details: "Uses [[watering]], follows [[tone]] and needs [[soil-types]].",
});

const INDEX: MemoryIndex = {
  account: [
    note({ name: "bob", kind: "person", title: "Bob" }),
    note({ name: "cooking", kind: "topic", title: "Cooking" }),
    note({ name: "tone", kind: "you", title: "Tone [draft]" }),
  ],
  projects: [
    {
      key: "garden-app",
      useAccountMemory: false,
      notes: [note({ project: "garden-app", name: "watering", kind: "topic", title: "Watering" }), overview],
    },
  ],
  deleted: [{ ...note({ name: "old-laptop", kind: "topic", title: "Old laptop" }), replaced_at: "2026-11-24T10:00:00.000Z" }],
};

const idle = { isPending: false, error: null, mutate: vi.fn(), mutateAsync: vi.fn() };

vi.mock("../lib/queries", () => ({
  useMemoryIndex: () => ({ data: INDEX, error: null }),
  useMemoryNote: () => ({ data: overview, error: null }),
  useMemoryVersions: () => ({ data: [] }),
  useContact: () => ({ data: undefined }),
  useRestoreMemoryVersion: () => idle,
  useSetProjectUsesAccountMemory: () => idle,
  useUpdateMemoryNote: () => idle,
  useDeleteMemoryNote: () => idle,
  usePreviewClaudeMemoryImport: () => idle,
  useClaudeMemoryImport: () => idle,
}));

describe("Memory page", () => {
  it("groups account notes by kind, then links to each project, then deleted notes", () => {
    render(() => <MemoryView />);
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(["You", "Topics", "People", "Projects", "Recently deleted"]);

    const project = screen.getByRole("link", { name: /garden-app/ });
    expect(project.getAttribute("href")).toBe("/memory/project/garden-app");
    expect(project.textContent).toContain("2 notes · account memory off");
    expect(screen.queryByRole("link", { name: /Watering/ })).toBeNull();

    expect(screen.getByRole("link", { name: /Tone \[draft\]/ }).getAttribute("href")).toBe("/memory/note/tone");
    expect(screen.getByRole("button", { name: "Restore" })).toBeTruthy();
  });

  it("shows a project's account-memory setting and its notes, overview first, under a way back to Memory", () => {
    render(() => <MemoryProjectView />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("garden-app");
    expect(document.title).toBe("garden-app · Memory · Timeline");
    expect(screen.getByRole("link", { name: "Memory" }).getAttribute("href")).toBe("/memory");
    expect((screen.getByRole("checkbox", { name: /Use account memory/ }) as HTMLInputElement).checked).toBe(false);
    const rows = within(screen.getByRole("list")).getAllByRole("link").map((link) => link.textContent);
    expect(rows[0]).toContain("Garden app");
    expect(rows[1]).toContain("Watering");
  });

  it("leads a project's note back through its project", () => {
    render(() => <MemoryNoteView />);
    const crumbs = within(screen.getByRole("navigation", { name: "Breadcrumb" })).getAllByRole("link");
    expect(crumbs.map((link) => [link.textContent?.trim(), link.getAttribute("href")])).toEqual([
      ["Memory", "/memory"],
      ["garden-app", "/memory/project/garden-app"],
    ]);
    expect(document.title).toBe("Garden app · Memory · Timeline");
  });

  it("says which file Import from Claude takes before offering the picker", () => {
    render(() => <MemoryView />);
    expect(screen.queryByRole("region", { name: "Import from Claude" })).toBeNull();
    screen.getByRole("button", { name: "Import from Claude" }).click();
    const panel = screen.getByRole("region", { name: "Import from Claude" });
    expect(panel.textContent).toContain("Settings → Your Claude → Memory");
    expect(panel.textContent).toContain("claude-memory-<date>.zip");
    expect(panel.textContent).toContain("memories-000.zip");
    expect(within(panel).getByRole("button", { name: "Choose file" })).toBeTruthy();
    within(panel).getByRole("button", { name: "Cancel" }).click();
    expect(screen.queryByRole("region", { name: "Import from Claude" })).toBeNull();
  });

  it("links [[name]] to the project's note, falls back to the account, and leaves a missing note as text", async () => {
    render(() => <MemoryNoteView />);
    const watering = await screen.findByRole("link", { name: "Watering" });
    expect(watering.getAttribute("href")).toBe("/memory/note/watering?project=garden-app");
    expect(screen.getByRole("link", { name: "Tone [draft]" }).getAttribute("href")).toBe("/memory/note/tone");
    expect(screen.queryByRole("link", { name: /soil-types/ })).toBeNull();
    expect(screen.getByText(/needs soil-types\./)).toBeTruthy();
  });
});
