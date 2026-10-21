import { render } from "@solidjs/testing-library";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { Suspense } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import ContactConversations from "./ContactConversations";
import ContactSpotifySummary from "./ContactSpotifySummary";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    fetchContactSpotifySummary: vi.fn(() => new Promise(() => {})),
    fetchContactConversations: vi.fn(() => new Promise(() => {})),
  };
});

function renderUnderRouteSuspense(component: () => import("solid-js").JSX.Element) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(() => (
    <QueryClientProvider client={queryClient}>
      <Suspense fallback={<div>Loading route...</div>}>
        {component()}
      </Suspense>
    </QueryClientProvider>
  ));
}

describe("contact activity suspense", () => {
  it("does not suspend the route for pending secondary activity", () => {
    const { queryByText } = renderUnderRouteSuspense(() => (
      <>
        <ContactSpotifySummary contactId={1} />
        <ContactConversations contactId={1} />
      </>
    ));

    expect(queryByText("Loading route...")).not.toBeInTheDocument();
  });
});
