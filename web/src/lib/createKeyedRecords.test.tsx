import { render } from "@solidjs/testing-library";
import { createMemo, createRoot, createSignal, For, onMount, Show } from "solid-js";
import { describe, expect, it } from "vitest";
import { createKeyedRecords } from "./createKeyedRecords";

interface Item {
  id: string;
  label: string;
}

describe("createKeyedRecords", () => {
  it("updates values without remounting records that retain their key", () => {
    const [items, setItems] = createSignal<Item[]>([
      { id: "a", label: "First" },
      { id: "b", label: "Second" },
    ]);
    const mounts = new Map<string, number>();

    function ItemRow(props: { item: Item }) {
      onMount(() => mounts.set(props.item.id, (mounts.get(props.item.id) ?? 0) + 1));
      return <div>{props.item.label}</div>;
    }

    function Harness() {
      const records = createKeyedRecords(items, (item) => item.id);
      return (
        <For each={records()}>
          {(record) => <ItemRow item={record.value()} />}
        </For>
      );
    }

    const view = render(() => <Harness />);
    const firstRecord = view.getByText("First");

    setItems([
      { id: "a", label: "Updated" },
      { id: "b", label: "Second" },
      { id: "c", label: "Third" },
    ]);

    expect(view.getByText("Updated")).toBe(firstRecord);
    expect(mounts).toEqual(new Map([
      ["a", 1],
      ["b", 1],
      ["c", 1],
    ]));
  });

  it("fails fast when the source contains duplicate keys", () => {
    expect(() => createRoot(() => createKeyedRecords(
      () => [
        { id: "a", label: "First" },
        { id: "a", label: "Duplicate" },
      ],
      (item) => item.id,
    ))).toThrow("Duplicate keyed record: a");
  });

  it("updates neighbor-derived UI while retaining the existing row", () => {
    const [items, setItems] = createSignal<Item[]>([{ id: "b", label: "New" }]);

    function Harness() {
      const records = createKeyedRecords(items, (item) => item.id);
      const dividerIds = createMemo(() => new Set(items().slice(0, 1).map((item) => item.id)));
      return (
        <For each={records()}>
          {(record) => (
            <div data-testid={`row-${record.key}`}>
              <Show when={dividerIds().has(record.key)}>
                <span>Model transition</span>
              </Show>
              {record.value().label}
            </div>
          )}
        </For>
      );
    }

    const view = render(() => <Harness />);
    const existingRow = view.getByTestId("row-b");

    setItems([
      { id: "a", label: "New" },
      { id: "b", label: "New" },
    ]);

    expect(view.getByTestId("row-b")).toBe(existingRow);
    expect(view.getByTestId("row-a")).toHaveTextContent("Model transition");
    expect(existingRow).not.toHaveTextContent("Model transition");
  });
});
