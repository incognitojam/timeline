import * as KDialog from "@kobalte/core/dialog";
import { A, useLocation } from "@solidjs/router";
import { type Component, createSignal, For, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import {
  MOBILE_MORE_ITEMS,
  MOBILE_NAV_ITEMS,
  type NavigationIcon,
  type NavigationItem,
  PRIMARY_NAV_ITEMS,
  isNavigationItemActive,
  UTILITY_NAV_ITEMS,
} from "../lib/routes";
import {
  IconAttachFile,
  IconChat,
  IconClose,
  IconCode,
  IconFactCheck,
  IconFavorite,
  IconHub,
  IconLogout,
  IconMoreHoriz,
  IconMusicNote,
  IconPerson,
  IconSearch,
  IconSettings,
  IconSync,
  IconTimeline,
} from "../ui/icons";

type NavigationIconComponent = Component<{ class?: string; "aria-hidden"?: boolean }>;

const NAVIGATION_ICONS: Record<NavigationIcon, NavigationIconComponent> = {
  timeline: IconTimeline,
  people: IconPerson,
  conversations: IconChat,
  search: IconSearch,
  health: IconFavorite,
  coding: IconCode,
  music: IconMusicNote,
  sync: IconSync,
  settings: IconSettings,
  attachments: IconAttachFile,
  mcp: IconHub,
  eval: IconFactCheck,
};

interface NavigationProps {
  statsSummary: string;
  authEnabled: boolean;
  onLogout: () => void;
}

interface NavigationLinkProps {
  item: NavigationItem;
  variant: "rail" | "bar" | "sheet";
  onNavigate?: () => void;
}

function NavigationLink(props: NavigationLinkProps) {
  const location = useLocation();
  const active = () => isNavigationItemActive(props.item, location.pathname);

  const linkClass = () => {
    if (props.variant === "rail") {
      return "group flex min-h-12 w-full flex-col items-center justify-center gap-0.5 rounded-2xl px-2 py-1 text-[0.6875rem] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring 2xl:flex-row 2xl:justify-start 2xl:gap-3 2xl:rounded-full 2xl:px-4 2xl:text-sm";
    }
    if (props.variant === "bar") {
      return "flex min-h-20 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 py-1 text-[0.6875rem] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";
    }
    return "flex min-h-14 items-center gap-3 rounded-2xl px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
  };

  return (
    <A
      href={props.item.path}
      preload={false}
      class={linkClass()}
      classList={{
        "text-foreground 2xl:bg-secondary 2xl:text-secondary-foreground":
          props.variant === "rail" && active(),
        "text-foreground": props.variant !== "rail" && active(),
        "bg-secondary text-secondary-foreground": props.variant === "sheet" && active(),
      }}
      aria-current={active() ? "page" : undefined}
      end={props.item.path === "/"}
      onClick={() => props.onNavigate?.()}
    >
      <span
        class="flex h-8 w-14 shrink-0 items-center justify-center rounded-full transition-colors"
        classList={{
          "2xl:w-6": props.variant === "rail",
          "bg-secondary text-secondary-foreground": active() && props.variant !== "sheet",
          "2xl:bg-transparent": active() && props.variant === "rail",
          "h-10 w-10 bg-accent text-foreground": props.variant === "sheet" && !active(),
          "h-10 w-10": props.variant === "sheet" && active(),
        }}
      >
        <Dynamic
          component={NAVIGATION_ICONS[props.item.icon]}
          class={props.variant === "sheet" ? "h-5 w-5" : "h-6 w-6"}
          aria-hidden
        />
      </span>
      <span
        class={
          props.variant === "bar"
            ? "max-w-full truncate text-center"
            : props.variant === "rail"
              ? "text-center 2xl:truncate 2xl:text-left"
              : "2xl:truncate"
        }
      >
        {props.item.label}
      </span>
    </A>
  );
}

export function TimelineBrand(props: { statsSummary: string }) {
  const compactStats = () => props.statsSummary.split(" · ")[0];

  return (
    <A
      href="/"
      preload={false}
      class="flex min-h-20 w-full flex-col items-center justify-center px-2 text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring 2xl:min-h-24 2xl:items-start 2xl:px-5"
      aria-label="Timeline home"
      end
    >
      <span class="min-w-0 text-center 2xl:text-left">
        <span class="block font-display text-sm font-semibold 2xl:text-xl">Timeline</span>
        <span class="block font-mono text-[0.5625rem] text-muted-foreground 2xl:hidden">
          {compactStats()}
        </span>
        <span class="hidden max-w-44 truncate font-mono text-[0.625rem] text-muted-foreground 2xl:block">
          {props.statsSummary}
        </span>
      </span>
    </A>
  );
}

function DesktopNavigation(props: NavigationProps) {
  return (
    <aside
      aria-label="App navigation"
      class="hidden h-full w-[5.5rem] shrink-0 flex-col border-r border-border bg-card min-[600px]:flex 2xl:w-60"
    >
      <TimelineBrand statsSummary={props.statsSummary} />

      <nav aria-label="Primary" class="scrollbar-hide flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 pb-2">
        <span class="hidden px-4 pb-1 pt-2 font-mono text-[0.625rem] uppercase tracking-[0.16em] text-muted-foreground 2xl:block">
          Explore
        </span>
        <For each={PRIMARY_NAV_ITEMS}>
          {(item) => <NavigationLink item={item} variant="rail" />}
        </For>
      </nav>

      <nav aria-label="Utilities" class="shrink-0 border-t border-border px-2 py-2">
        <span class="hidden px-4 pb-1 pt-1 font-mono text-[0.625rem] uppercase tracking-[0.16em] text-muted-foreground 2xl:block">
          Utilities
        </span>
        <For each={UTILITY_NAV_ITEMS}>
          {(item) => <NavigationLink item={item} variant="rail" />}
        </For>
      </nav>

      <Show when={props.authEnabled}>
        <div class="shrink-0 border-t border-border p-2">
          <button
            type="button"
            onClick={props.onLogout}
            class="flex min-h-12 w-full flex-col items-center justify-center gap-0.5 rounded-2xl px-2 py-1 text-[0.6875rem] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring 2xl:flex-row 2xl:justify-start 2xl:gap-3 2xl:rounded-full 2xl:px-4 2xl:text-sm"
          >
            <span class="flex h-8 w-14 shrink-0 items-center justify-center 2xl:w-6">
              <IconLogout class="h-5 w-5" aria-hidden />
            </span>
            <span>Sign out</span>
          </button>
        </div>
      </Show>
    </aside>
  );
}

function MobileNavigation(props: NavigationProps) {
  const location = useLocation();
  const [moreOpen, setMoreOpen] = createSignal(false);
  const moreActive = () =>
    MOBILE_MORE_ITEMS.some((item) => isNavigationItemActive(item, location.pathname));
  const exploreItems = MOBILE_MORE_ITEMS.filter((item) => item.section === "primary");
  const utilityItems = MOBILE_MORE_ITEMS.filter((item) => item.section === "utility");

  return (
    <KDialog.Root open={moreOpen()} onOpenChange={setMoreOpen}>
      <nav
        aria-label="Primary"
        class="mobile-navigation-bar order-last w-full shrink-0 border-t border-border bg-card min-[600px]:hidden"
      >
        <div class="flex min-h-20 items-stretch">
          <For each={MOBILE_NAV_ITEMS}>
            {(item) => <NavigationLink item={item} variant="bar" />}
          </For>
          <KDialog.Trigger
            class="flex min-h-20 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 py-1 text-[0.6875rem] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
            classList={{ "text-foreground": moreActive() }}
            aria-label="More destinations"
            aria-pressed={moreActive()}
          >
            <span
              class="flex h-8 w-14 items-center justify-center rounded-full transition-colors"
              classList={{ "bg-secondary text-secondary-foreground": moreActive() }}
            >
              <IconMoreHoriz class="h-6 w-6" aria-hidden />
            </span>
            <span>More</span>
          </KDialog.Trigger>
        </div>
      </nav>

      <KDialog.Portal>
        <KDialog.Overlay class="fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px]" />
        <KDialog.Content class="fixed inset-x-3 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-50 max-h-[calc(100dvh-6rem)] overflow-y-auto rounded-[1.75rem] border border-border bg-popover p-5 text-popover-foreground shadow-2xl focus:outline-none">
          <div class="mb-4 pr-12">
            <KDialog.Title class="font-display text-xl font-semibold">
              More destinations
            </KDialog.Title>
            <KDialog.Description class="mt-1 text-xs text-muted-foreground">
              Explore your data and manage Timeline.
            </KDialog.Description>
          </div>

          <section aria-labelledby="more-explore-heading">
            <h2
              id="more-explore-heading"
              class="px-3 pb-1 font-mono text-[0.625rem] uppercase tracking-[0.16em] text-muted-foreground"
            >
              Explore
            </h2>
            <div class="grid gap-1 sm:grid-cols-2">
              <For each={exploreItems}>
                {(item) => (
                  <NavigationLink
                    item={item}
                    variant="sheet"
                    onNavigate={() => setMoreOpen(false)}
                  />
                )}
              </For>
            </div>
          </section>

          <section
            aria-labelledby="more-utilities-heading"
            class="mt-4 border-t border-border pt-4"
          >
            <h2
              id="more-utilities-heading"
              class="px-3 pb-1 font-mono text-[0.625rem] uppercase tracking-[0.16em] text-muted-foreground"
            >
              Utilities
            </h2>
            <div class="grid gap-1 sm:grid-cols-2">
              <For each={utilityItems}>
                {(item) => (
                  <NavigationLink
                    item={item}
                    variant="sheet"
                    onNavigate={() => setMoreOpen(false)}
                  />
                )}
              </For>
            </div>
          </section>

          <Show when={props.authEnabled}>
            <div class="mt-4 border-t border-border pt-4">
              <button
                type="button"
                onClick={() => {
                  setMoreOpen(false);
                  props.onLogout();
                }}
                class="flex min-h-14 w-full items-center gap-3 rounded-2xl px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <span class="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-foreground">
                  <IconLogout class="h-5 w-5" aria-hidden />
                </span>
                <span>Sign out</span>
              </button>
            </div>
          </Show>

          <KDialog.CloseButton
            class="absolute right-3 top-3 flex h-12 w-12 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            aria-label="Close more destinations"
          >
            <IconClose class="h-5 w-5" aria-hidden />
          </KDialog.CloseButton>
        </KDialog.Content>
      </KDialog.Portal>
    </KDialog.Root>
  );
}

export default function Navigation(props: NavigationProps) {
  return (
    <>
      <DesktopNavigation {...props} />
      <MobileNavigation {...props} />
    </>
  );
}
