import type { MemoryImportResult } from "@shared/memory";
import { fireEvent, render, screen, within } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import MemoryImport from "./MemoryImport";

const PREVIEW: MemoryImportResult = {
  imported: false,
  planId: "plan-1",
  projects: { "garden-planner-2-0": "Garden Planner 2.0" },
  add: [
    { project: "", name: "profile", kind: "you", title: "Profile" },
    { project: "", name: "home", kind: "area", title: "Home" },
    { project: "", name: "alice-b", kind: "person", title: "Alice B" },
    { project: "", name: "bob", kind: "person", title: "Bob" },
    { project: "garden-planner-2-0", name: "overview", kind: "project", title: "Garden Planner 2.0" },
    { project: "garden-planner-2-0", name: "carol", kind: "person", title: "Carol" },
  ],
  people: [
    { project: "", name: "alice-b", kind: "person", title: "Alice B", aliases: [], match: { by: "alias", alias: "Alice Brown" }, contact: { id: 1, name: "Alice Brown", hidden: false } },
    { project: "", name: "bob", kind: "person", title: "Bob", aliases: ["Bobby"], match: { by: "several", count: 2, hidden: 1 }, contact: null },
    { project: "garden-planner-2-0", name: "carol", kind: "person", title: "Carol", aliases: [], match: { by: "title" }, contact: { id: 3, name: "Carol", hidden: true } },
  ],
  existing: [{ project: "", name: "climbing", kind: "topic", title: "Climbing" }],
  problems: [],
  overLimit: null,
};

const runMutate = vi.fn();
let imported: MemoryImportResult | undefined;

vi.mock("../lib/queries", () => ({
  usePreviewClaudeMemoryImport: () => ({ isPending: false, error: null, data: PREVIEW, mutate: vi.fn() }),
  useClaudeMemoryImport: () => ({ isPending: false, error: null, data: imported, mutate: runMutate, reset: vi.fn() }),
  // Hidden contacts only when asked for, as GET /api/contacts does.
  useContacts: (options?: () => { includeHidden?: boolean }) => ({
    isLoading: false,
    get data() {
      return [
        { id: 1, display_name: "Alice Brown", notes: null, hidden: 0 },
        { id: 2, display_name: "Bobby Tables", notes: null, hidden: 0 },
        { id: 3, display_name: "Carol", notes: null, hidden: 1 },
        { id: 4, display_name: "Bob Hidden", notes: null, hidden: 1 },
      ].filter((contact) => options?.().includeHidden || !contact.hidden);
    },
  }),
}));

function choose() {
  render(() => <MemoryImport onClose={() => {}} />);
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [new File(["zip"], "claude-memory-2026-11-27.zip")], configurable: true });
  fireEvent.change(input);
  return screen.getByRole("region", { name: "Import from Claude" });
}

describe("Import from Claude preview", () => {
  it("counts notes per place in words, with titles on expanding a line", () => {
    const panel = choose();
    expect(panel.textContent).toContain("Adds 6 notes to memory. 1 note already there is left as it is.");
    // The first "Your account" lists what is added; the second, what is already in memory.
    const account = within(panel).getAllByRole("region", { name: "Your account" })[0];
    const lines = within(account).getAllByRole("group").map((line) => line.querySelector("summary")?.textContent);
    expect(lines).toEqual(["1 note about you", "1 area of your life · ongoing parts of life, such as home or work", "2 people"]);
    expect(within(account).getByText("Alice B")).toBeTruthy();
    const project = within(panel).getByRole("region", { name: "Garden Planner 2.0" });
    expect(project.textContent).toContain("1 note about the project");
    expect(project.textContent).toContain("1 person");
  });

  it("says why each person is linked or not, and imports the links the owner chose", () => {
    const panel = choose();
    expect(panel.textContent).toContain("Contacts · 2 of 3 people will be linked, 1 to a hidden contact");
    const row = (index: number) => panel.querySelectorAll<HTMLElement>("li.py-2")[index];
    const rows = () => [0, 1, 2].map((index) => row(index).textContent);
    expect(rows()).toEqual([
      expect.stringContaining("Linked to Alice Brown · by the alias “Alice Brown”"),
      expect.stringContaining("Not linked · 2 contacts have this name, 1 hidden · agents will be able to read this note"),
      expect.stringContaining("Linked to Carol · same name · hidden contact, so this note will be kept from agents"),
    ]);

    // The search offers hidden contacts only once asked to, marked as hidden.
    within(row(1)).getByRole("button", { name: "Choose a contact" }).click();
    const options = () => within(row(1)).queryAllByRole("option").map((option) => option.textContent);
    fireEvent.input(within(row(1)).getByRole("combobox"), { target: { value: "bob" } });
    expect(options()).toEqual(["Bobby Tables"]);
    within(row(1)).getByRole("button", { name: "Cancel" }).click();
    within(panel).getByRole("checkbox", { name: "Show hidden contacts when choosing" }).click();
    within(row(1)).getByRole("button", { name: "Choose a contact" }).click();
    fireEvent.input(within(row(1)).getByRole("combobox"), { target: { value: "bob" } });
    expect(options()).toEqual(["Bobby Tables", "Bob HiddenHidden"]);
    within(row(1)).getByRole("button", { name: "Cancel" }).click();

    // Bob: choose a contact by keyboard.
    within(row(1)).getByRole("button", { name: "Choose a contact" }).click();
    const search = within(row(1)).getByRole("combobox", { name: "Contact for Bob" });
    fireEvent.input(search, { target: { value: "bob" } });
    fireEvent.keyDown(search, { key: "Enter" });
    // Carol: don't link.
    within(row(2)).getByRole("button", { name: "Don't link" }).click();
    expect(rows()[1]).toContain("Linked to Bobby Tables · your choice");
    expect(rows()[2]).toContain("Not linked · your choice · agents will be able to read this note");
    expect(panel.textContent).toContain("2 of 3 people will be linked");
    expect(panel.textContent).not.toContain("hidden contact,");

    within(panel).getByRole("button", { name: "Import" }).click();
    expect(runMutate).toHaveBeenCalledWith({
      file: expect.any(File),
      planId: "plan-1",
      links: [1, 2, null],
    });
  });

  it("after an import, shows the contact each note was saved with and whether agents can read it", () => {
    imported = {
      ...PREVIEW,
      imported: true,
      people: [
        { ...PREVIEW.people[0], saved: PREVIEW.people[0].contact },
        { ...PREVIEW.people[1], saved: { id: 4, name: "Bob Hidden", hidden: true } },
        { ...PREVIEW.people[2], saved: null },
      ],
    };
    const panel = choose();
    imported = undefined;
    expect(panel.textContent).toContain("Contacts · 2 of 3 people linked, 1 to a hidden contact");
    const rows = [...panel.querySelectorAll<HTMLElement>("li.py-2")].map((row) => row.textContent);
    expect(rows).toEqual([
      expect.stringContaining("Linked to Alice Brown · by the alias “Alice Brown”"),
      expect.stringContaining("Linked to Bob Hidden · your choice · hidden contact, so this note is kept from agents"),
      expect.stringContaining("Not linked · your choice · agents can read this note"),
    ]);
    expect(within(panel).queryByRole("button", { name: "Import" })).toBeNull();
  });
});
