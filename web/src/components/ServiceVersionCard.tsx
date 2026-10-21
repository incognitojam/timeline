import { type JSX, Show } from "solid-js";
import type { ServiceStatus } from "../lib/api";
import { formatRelativeTime } from "../lib/format";
import { syncStatusBadgeClass } from "../lib/sync-auth-status";

// This card reports the build Timeline is currently running. It deliberately
// makes no claim about newer builds: there is no update discovery yet.
// The card is headless: whichever page renders it owns the section heading.

function relativeTime(value: string): string {
  return Number.isNaN(new Date(value).getTime()) ? value : formatRelativeTime(value);
}

function absoluteTime(value: string): string | undefined {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toLocaleString();
}

const metaRowClass = "flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs text-muted-foreground";
const metaItemClass = "flex min-w-0 items-baseline gap-1.5";
const metaValueClass = "font-mono text-foreground break-all";

function VersionPlate(props: { accent: string; children: JSX.Element }) {
  return (
    <div class="relative overflow-hidden rounded-lg border border-border bg-card p-4 pl-5">
      <span aria-hidden="true" class={`absolute inset-y-0 left-0 w-1 ${props.accent}`} />
      {props.children}
    </div>
  );
}

export default function ServiceVersionCard(props: {
  service: ServiceStatus["service"] | null;
  isError: boolean;
}) {
  const version = () => props.service?.version ?? null;
  // A packaged identity needs both halves; a lone version string is still a checkout.
  const isPackaged = () => Boolean(version()?.version && version()?.build);
  const hasMeta = () => {
    const info = version();
    if (!info) return false;
    if (info.branch || info.builtAt) return true;
    return Boolean(!isPackaged() && info.version);
  };
  // Provenance keyline: unknown/dirty builds read yellow, packaged green, checkouts neutral.
  const accentClass = () => {
    const info = version();
    if (!info) return "bg-yellow-400/70";
    if (info.dirty) return "bg-yellow-400/70";
    return isPackaged() ? "bg-green-400/70" : "bg-border";
  };

  return (
    <Show
      when={!props.isError}
      fallback={
        <VersionPlate accent="bg-red-400/70">
          <p role="status" class="text-sm text-red-400">
            Failed to load version information.
          </p>
          <p class="mt-1 text-xs text-muted-foreground">
            Timeline could not read the service status.
          </p>
        </VersionPlate>
      }
    >
      <Show
        when={props.service}
        fallback={
          <VersionPlate accent="bg-border">
            <p role="status" class="text-sm text-muted-foreground motion-safe:animate-pulse">
              Loading version information...
            </p>
          </VersionPlate>
        }
      >
        <VersionPlate accent={accentClass()}>
          <Show
            when={version()}
            fallback={
              <>
                <p class="text-sm text-yellow-400">
                  Timeline could not identify the build it is running.
                </p>
                <p class="mt-1 text-xs text-muted-foreground">
                  The service reported no version metadata.
                </p>
              </>
            }
          >
            {(info) => (
              <>
                {/* Primary identity: release + build when packaged, otherwise the commit. */}
                <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
                  <dl class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                    <Show
                      when={isPackaged()}
                      fallback={
                        <>
                          <dt class="sr-only">Commit</dt>
                          <dd
                            class="font-mono text-lg leading-none break-all"
                            title={info().commitFull}
                          >
                            {info().commit}
                          </dd>
                        </>
                      }
                    >
                      <dt class="sr-only">Version</dt>
                      <dd class="font-mono text-lg leading-none break-all">{info().version}</dd>
                      <dt class="text-xs text-muted-foreground">build</dt>
                      <dd class="font-mono text-sm">{info().build}</dd>
                    </Show>
                  </dl>

                  <div class="flex flex-wrap items-center gap-2">
                    <span
                      class={`${syncStatusBadgeClass} ${
                        isPackaged() ? "text-green-400" : "text-muted-foreground"
                      }`}
                    >
                      {isPackaged() ? "Packaged build" : "Source build"}
                    </span>
                    <Show when={info().dirty}>
                      <span class={`${syncStatusBadgeClass} text-yellow-400`}>Local changes</span>
                    </Show>
                  </div>
                </div>

                <dl class="mt-3 space-y-1.5">
                  {/* Secondary: what the build was cut from. */}
                  <Show when={isPackaged() || info().message}>
                    <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm text-muted-foreground">
                      <Show when={isPackaged()}>
                        <dt class="sr-only">Commit</dt>
                        <dd
                          class="font-mono text-xs text-foreground break-all"
                          title={info().commitFull}
                        >
                          {info().commit}
                        </dd>
                      </Show>
                      <Show when={info().message}>
                        <dt class="sr-only">Commit message</dt>
                        <dd class="min-w-0 break-words">{info().message}</dd>
                      </Show>
                    </div>
                  </Show>

                  {/* Provenance facts, deliberately quiet. */}
                  <Show when={hasMeta()}>
                    <div class={metaRowClass}>
                      <Show when={info().branch}>
                        {(branch) => (
                          <div class={metaItemClass}>
                            <dt>branch</dt>
                            <dd class={metaValueClass}>{branch()}</dd>
                          </div>
                        )}
                      </Show>
                      <Show when={!isPackaged() && info().version}>
                        {(release) => (
                          <div class={metaItemClass}>
                            <dt>version</dt>
                            <dd class={metaValueClass}>{release()}</dd>
                          </div>
                        )}
                      </Show>
                      <Show when={info().builtAt}>
                        {(builtAt) => (
                          <div class={metaItemClass}>
                            <dt>built</dt>
                            <dd class={metaValueClass} title={absoluteTime(builtAt())}>
                              {relativeTime(builtAt())}
                            </dd>
                          </div>
                        )}
                      </Show>
                    </div>
                  </Show>
                </dl>
              </>
            )}
          </Show>
        </VersionPlate>
      </Show>
    </Show>
  );
}
