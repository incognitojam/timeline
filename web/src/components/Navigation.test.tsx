import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router";
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { beforeAll, describe, expect, test, vi } from "vitest";
import Navigation from "./Navigation";

beforeAll(() => {
  vi.stubGlobal("scrollTo", vi.fn());
});

function renderNavigation(path = "/") {
  const history = createMemoryHistory();
  history.set({ value: path, replace: true });
  const onLogout = vi.fn();
  const result = render(() => (
    <MemoryRouter history={history}>
      <Route
        path="*all"
        component={() => (
          <Navigation
            statsSummary="24 events · 3 sources"
            authEnabled
            onLogout={onLogout}
          />
        )}
      />
    </MemoryRouter>
  ));
  return { ...result, onLogout };
}

describe("Navigation", () => {
  test("renders the six primary destinations and separates utilities", () => {
    const { container } = renderNavigation();
    const rail = container.querySelector<HTMLElement>("aside");
    expect(rail).not.toBeNull();
    if (!rail) throw new Error("Desktop navigation rail was not rendered");

    expect(within(rail).getByRole("navigation", { name: "Primary" }).querySelectorAll("a")).toHaveLength(6);
    expect(within(rail).getByRole("navigation", { name: "Utilities" }).querySelectorAll("a")).toHaveLength(6);
    expect(within(rail).getByRole("link", { name: "Timeline" })).toHaveAttribute("aria-current", "page");
  });

  test("does not preload route data from navigation intent", () => {
    const { container } = renderNavigation();

    for (const link of container.querySelectorAll("a")) {
      expect(link).toHaveAttribute("preload", "false");
    }
  });

  test("renders four compact destinations plus the More action", () => {
    const { container } = renderNavigation();
    const bar = container.querySelector<HTMLElement>(".mobile-navigation-bar");
    expect(bar).not.toBeNull();
    if (!bar) throw new Error("Mobile navigation bar was not rendered");

    expect(within(bar).getAllByRole("link").map((link) => link.textContent)).toEqual([
      "Timeline",
      "People",
      "Messages",
      "Health",
    ]);
    expect(within(bar).getByRole("button", { name: "More destinations" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(within(bar).getByRole("button", { name: "More destinations" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  test("keeps Health active in the compact bar and moves Search into More", async () => {
    const { container } = renderNavigation("/health");
    const bar = container.querySelector<HTMLElement>(".mobile-navigation-bar");
    if (!bar) throw new Error("Mobile navigation bar was not rendered");

    expect(within(bar).getByRole("link", { name: "Health" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    const moreButton = within(bar).getByRole("button", { name: "More destinations" });
    expect(moreButton).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(moreButton);
    const dialog = await screen.findByRole("dialog", { name: "More destinations" });
    expect(within(dialog).getByRole("link", { name: "Search" })).toBeVisible();
  });

  test("opens an accessible More sheet and exposes the active overflow destination", async () => {
    const { container } = renderNavigation("/music/playlist/focus-mix");
    const bar = container.querySelector<HTMLElement>(".mobile-navigation-bar");
    if (!bar) throw new Error("Mobile navigation bar was not rendered");
    const moreButton = within(bar).getByRole("button", { name: "More destinations" });
    expect(moreButton).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(moreButton);

    const dialog = await screen.findByRole("dialog", { name: "More destinations" });
    expect(within(dialog).getAllByRole("link")).toHaveLength(8);
    expect(within(dialog).getByRole("link", { name: "Music" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    fireEvent.click(within(dialog).getByRole("button", { name: "Close more destinations" }));
    await waitFor(() => expect(moreButton).toHaveAttribute("aria-expanded", "false"));
    expect(dialog).toHaveAttribute("data-closed");
  });
});
