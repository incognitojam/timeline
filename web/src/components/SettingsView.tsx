import { useNetworkSettings, useReleaseStatus, useServiceStatus, useUpdateNetworkSettings } from "../lib/queries";
import { IconSettings } from "../ui/icons";
import NetworkSettingsCard from "./NetworkSettingsCard";
import ServiceVersionCard from "./ServiceVersionCard";
import ReleaseCard from "./ReleaseCard";

export default function SettingsView() {
  const statusQuery = useServiceStatus();
  const releaseQuery = useReleaseStatus();
  const networkQuery = useNetworkSettings();
  const updateNetwork = useUpdateNetworkSettings();

  return (
    <div class="h-full overflow-auto">
      <div class="mx-auto max-w-4xl px-4 pt-6 pb-12">
        <header class="mb-8 flex items-start gap-3">
          <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm bg-secondary text-secondary-foreground">
            <IconSettings class="h-5 w-5" aria-hidden />
          </span>
          <div class="min-w-0">
            <h1 class="font-display text-2xl font-medium">Settings</h1>
            <p class="mt-1 text-sm text-muted-foreground">
              Configuration and build details for this Timeline instance.
            </p>
          </div>
        </header>

        <div class="space-y-10">
          <section
            aria-labelledby="settings-version-heading"
            class="grid gap-4 border-t border-border pt-6 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] md:gap-8"
          >
            <div class="min-w-0">
              <h2 id="settings-version-heading" class="text-sm font-medium text-foreground">
                Version &amp; build
              </h2>
              <p class="mt-1 text-xs text-muted-foreground">
                The build this Timeline service is running, and where it came from.
              </p>
            </div>

            <div class="min-w-0">
              <ServiceVersionCard
                service={statusQuery.data?.service ?? null}
                isError={statusQuery.isError}
              />
            </div>
          </section>
          <section
            aria-labelledby="settings-network-heading"
            class="grid gap-4 border-t border-border pt-6 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] md:gap-8"
          >
            <div class="min-w-0">
              <h2 id="settings-network-heading" class="text-sm font-medium text-foreground">Network</h2>
              <p class="mt-1 text-xs text-muted-foreground">Wi-Fi networks that scheduled syncs can avoid, such as phone hotspots.</p>
            </div>
            <NetworkSettingsCard
              settings={networkQuery.data}
              loadError={networkQuery.error}
              saving={updateNetwork.isPending}
              saveError={updateNetwork.error}
              onSave={(settings) => updateNetwork.mutateAsync(settings)}
            />
          </section>
          <section
            aria-labelledby="settings-releases-heading"
            class="grid gap-4 border-t border-border pt-6 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] md:gap-8"
          >
            <div class="min-w-0">
              <h2 id="settings-releases-heading" class="text-sm font-medium text-foreground">Updates &amp; changes</h2>
              <p class="mt-1 text-xs text-muted-foreground">Release notes and downloads for Timeline for macOS.</p>
            </div>
            <ReleaseCard
              status={releaseQuery.data}
              error={releaseQuery.error}
              checking={releaseQuery.isFetching}
              onCheck={() => { void releaseQuery.refetch(); }}
            />
          </section>
        </div>
      </div>
    </div>
  );
}
