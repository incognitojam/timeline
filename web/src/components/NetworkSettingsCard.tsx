import type { NetworkSettings } from "@shared/network-settings";
import { createSignal, Show } from "solid-js";

function parseNetworks(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

export default function NetworkSettingsCard(props: {
  settings: NetworkSettings | undefined;
  loadError: Error | null;
  saving: boolean;
  saveError: Error | null;
  onSave: (settings: NetworkSettings) => Promise<unknown>;
}) {
  // null = untouched, showing the saved list.
  const [draft, setDraft] = createSignal<string | null>(null);
  const savedText = () => props.settings?.blockedNetworks.join("\n") ?? "";
  const text = () => draft() ?? savedText();
  const changed = () => parseNetworks(text()).join("\n") !== savedText();

  async function save(event: SubmitEvent) {
    event.preventDefault();
    await props.onSave({ blockedNetworks: parseNetworks(text()) });
    setDraft(null);
  }

  return (
    <form class="min-w-0 rounded-lg border border-border bg-card p-4" onSubmit={(event) => void save(event).catch(() => {})}>
      <label for="settings-blocked-networks" class="text-sm font-medium text-foreground">
        Blocked Wi-Fi networks
      </label>
      <p id="settings-blocked-networks-description" class="mt-1 text-xs text-muted-foreground">
        One per line. A network is blocked when its name contains an entry, ignoring case, so “iPhone” also matches “Alice’s iPhone”. Sources with “Skip on blocked Wi-Fi networks” turned on wait while connected to one.
      </p>
      <Show when={props.loadError}>
        {(error) => <p role="alert" class="mt-3 text-xs text-destructive">{error().message}</p>}
      </Show>
      <textarea
        id="settings-blocked-networks"
        aria-describedby="settings-blocked-networks-description"
        class="mt-3 h-28 w-full rounded-sm border border-border bg-background px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
        placeholder="No networks blocked"
        value={text()}
        disabled={props.settings === undefined || props.saving}
        onInput={(event) => setDraft(event.currentTarget.value)}
      />
      <div class="mt-3 flex flex-wrap items-center justify-end gap-2">
        <Show when={props.saveError}>
          {(error) => <p role="alert" class="mr-auto text-xs text-destructive">{error().message}</p>}
        </Show>
        <button
          type="button"
          class="rounded-sm px-3 py-1.5 text-sm text-muted-foreground transition-colors enabled:hover:bg-accent enabled:hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          disabled={draft() === null || props.saving}
          onClick={() => setDraft(null)}
        >
          Discard changes
        </button>
        <button
          type="submit"
          class="rounded-sm bg-primary px-3.5 py-1.5 text-sm font-medium text-primary-foreground transition-colors enabled:hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          disabled={!changed() || props.saving}
        >
          {props.saving ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}
