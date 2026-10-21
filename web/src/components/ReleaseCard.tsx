import type { ReleaseStatus } from "@shared/releases";
import { Match, Show, Switch } from "solid-js";
import { Markdown } from "./Markdown";

const linkClass = "rounded-sm text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export default function ReleaseCard(props: {
  status: ReleaseStatus | undefined;
  error: Error | null;
  checking: boolean;
  onCheck: () => void;
}) {
  return (
    <div class="min-w-0 rounded-lg border border-border bg-card p-4">
      <div class="flex flex-wrap items-baseline justify-between gap-3">
        <p role="status" class="text-sm">
          <Switch fallback="Checking releases…">
            <Match when={props.error}>
              Could not check releases.
            </Match>
            <Match when={props.status}>
              {(status) => (
                <Switch>
                  <Match when={status().comparison === "update-available"}>
                    <Show when={status().latest.downloadUrl} fallback="A new release is being packaged for macOS.">
                      An update is available.
                    </Show>
                  </Match>
                  <Match when={status().comparison === "current"}>You’re running the latest release.</Match>
                  <Match when={status().comparison === "ahead"}>This build is newer than the latest release.</Match>
                  <Match when={status().comparison === "unknown"}>Latest published release</Match>
                </Switch>
              )}
            </Match>
          </Switch>
        </p>
        <button
          type="button"
          onClick={props.onCheck}
          disabled={props.checking}
          class="shrink-0 rounded-sm px-2 py-1 text-xs text-primary enabled:hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {props.checking ? "Checking…" : "Check for updates"}
        </button>
      </div>

      <Show when={props.error}>
        {(error) => <p class="mt-2 text-xs text-muted-foreground">{error().message}</p>}
      </Show>
      <Show when={props.status}>
        {(status) => (
          <>
            <div class="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h3 class="font-display text-xl font-medium">Timeline {status().latest.version}</h3>
              <time class="text-xs text-muted-foreground" dateTime={status().latest.publishedAt}>
                {new Date(status().latest.publishedAt).toLocaleDateString()}
              </time>
            </div>
            <Show when={status().latest.notes} fallback={<p class="mt-3 text-sm text-muted-foreground">No release notes were published.</p>}>
              {(notes) => <Markdown markdown={notes()} class="prose prose-sm dark:prose-invert mt-3 max-w-none break-words" />}
            </Show>
            <div class="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-sm">
              <Show when={status().latest.downloadUrl}>
                {(url) => <a class={linkClass} href={url()} target="_blank" rel="noopener noreferrer">Download for macOS</a>}
              </Show>
              <a class={linkClass} href={status().latest.url} target="_blank" rel="noopener noreferrer">View release on GitHub</a>
            </div>
            <p class="mt-3 text-xs text-muted-foreground">
              Checking here does not install updates on the Timeline host.
            </p>
          </>
        )}
      </Show>
    </div>
  );
}
