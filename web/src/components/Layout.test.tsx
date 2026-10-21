import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { afterEach, describe, expect, test, vi } from "vitest";
import Layout from "./Layout";

function renderLayout() {
  const history = createMemoryHistory();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(() => (
    <QueryClientProvider client={client}>
      <MemoryRouter history={history}>
        <Route path="*all" component={() => <Layout>App content</Layout>} />
      </MemoryRouter>
    </QueryClientProvider>
  ));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Layout authentication state", () => {
  test("shows the login form only after the API confirms the user is signed out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({
        authenticated: false,
        authEnabled: true,
      })),
    );

    renderLayout();

    expect(await screen.findByText("Enter password to continue")).toBeInTheDocument();
    expect(screen.queryByText("Service unavailable")).not.toBeInTheDocument();
  });

  test("shows an unavailable state when the auth check cannot reach the API", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    renderLayout();

    expect(await screen.findByText("Service unavailable")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Password")).not.toBeInTheDocument();
    expect(screen.queryByText("App content")).not.toBeInTheDocument();
  });

  test("retries the auth check from the unavailable state", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(Response.json({ authenticated: false, authEnabled: true }));
    vi.stubGlobal("fetch", fetchMock);

    renderLayout();
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Enter password to continue")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
