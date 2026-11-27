import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Contact, ContactWithStats, UnlinkedIdentity } from "../lib/types";
import ContactsView from "./ContactsView";

const testState = vi.hoisted(() => ({
  searchParams: {} as Record<string, string | undefined>,
  navigate: vi.fn(),
  setSearchParams: vi.fn(),
  contactsQuery: {} as unknown,
  contactQuery: {} as unknown,
  contactEventsQuery: {} as unknown,
  contactSuggestionsQuery: {} as unknown,
  unlinkedQuery: {} as unknown,
  skippedQuery: {} as unknown,
  identityEventsQuery: {} as unknown,
  suggestedContactsQuery: {} as unknown,
  linkSuggestionsQuery: {} as unknown,
  createContact: vi.fn(),
  updateContact: vi.fn(),
  deleteContact: vi.fn(),
  createMemory: vi.fn(),
  deleteMemory: vi.fn(),
  linkIdentity: vi.fn(),
  batchLinkIdentities: vi.fn(),
  unlinkIdentity: vi.fn(),
  skipIdentity: vi.fn(),
  unskipIdentity: vi.fn(),
  refreshCache: vi.fn(),
  updateContactPending: false,
}));

vi.mock("@solidjs/router", async () => {
  const { createStore } = await import("solid-js/store");

  return {
    useNavigate: () => testState.navigate,
    useSearchParams: () => {
      const [params, setParams] = createStore<Record<string, string | undefined>>({
        ...testState.searchParams,
      });
      const setSearchParams = (updates: Record<string, string | number | undefined>, options?: unknown) => {
        testState.setSearchParams(updates, options);
        const normalized: Record<string, string | undefined> = {};
        for (const [key, value] of Object.entries(updates)) {
          normalized[key] = value === undefined ? undefined : String(value);
        }
        setParams(normalized);
      };

      return [params, setSearchParams] as const;
    },
  };
});

vi.mock("./Avatar", () => ({
  default: (props: { name?: string | null }) => <span>{props.name}</span>,
}));

vi.mock("../platforms/spotify/ContactSpotifySummary", () => ({
  default: () => <div>Spotify Summary</div>,
}));

vi.mock("./ContactConversations", () => ({
  default: () => <div>Conversations</div>,
}));

vi.mock("../lib/queries", () => ({
  useContacts: () => testState.contactsQuery,
  useContact: () => testState.contactQuery,
  useContactEvents: () => testState.contactEventsQuery,
  useContactSuggestions: () => testState.contactSuggestionsQuery,
  useUnlinkedIdentities: () => testState.unlinkedQuery,
  useSkippedIdentities: () => testState.skippedQuery,
  useIdentityEvents: () => testState.identityEventsQuery,
  useSuggestedContactsForIdentity: () => testState.suggestedContactsQuery,
  useLinkSuggestions: () => testState.linkSuggestionsQuery,
  useCreateContact: () => ({ mutateAsync: testState.createContact, isPending: false }),
  useUpdateContact: () => ({ mutateAsync: testState.updateContact, isPending: testState.updateContactPending }),
  useDeleteContact: () => ({ mutateAsync: testState.deleteContact, reset: vi.fn(), error: null, isPending: false }),
  useCreateContactMemory: () => ({ mutateAsync: testState.createMemory, isPending: false }),
  useDeleteContactMemory: () => ({ mutateAsync: testState.deleteMemory, isPending: false }),
  useLinkIdentity: () => ({ mutateAsync: testState.linkIdentity, isPending: false }),
  useBatchLinkIdentities: () => ({ mutateAsync: testState.batchLinkIdentities, isPending: false }),
  useUnlinkIdentity: () => ({ mutateAsync: testState.unlinkIdentity, isPending: false }),
  useSkipIdentity: () => ({ mutateAsync: testState.skipIdentity, isPending: false }),
  useUnskipIdentity: () => ({ mutateAsync: testState.unskipIdentity, isPending: false }),
  useRefreshCache: () => ({ mutateAsync: testState.refreshCache, isPending: false }),
}));

function loadedQuery<T>(data: T, isPlaceholderData = false) {
  return {
    data,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isPlaceholderData,
  };
}

function makeContact(id: number, name: string): Contact {
  return {
    id,
    display_name: name,
    notes: "panel-only notes",
    date_of_birth: null,
    hidden: 0,
    is_self: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function makeContactListItem(contact: Contact): ContactWithStats {
  return {
    ...contact,
    identityCount: 0,
    eventCount: 0,
    avatarUrl: null,
  };
}

function contactDetail(contact: Contact, memoryNoteCount = 0) {
  return {
    contact,
    identities: [],
    memories: [],
    avatarUrl: null,
    memoryNoteCount,
  };
}

describe("ContactsView", () => {
  beforeEach(() => {
    const contact = makeContact(1, "Alice Example");

    testState.searchParams = { id: "1" };
    testState.contactsQuery = loadedQuery([makeContactListItem(contact)]);
    testState.contactQuery = loadedQuery(contactDetail(contact));
    testState.contactEventsQuery = loadedQuery({ events: [] });
    testState.contactSuggestionsQuery = loadedQuery({ suggestions: [] });
    testState.unlinkedQuery = loadedQuery([]);
    testState.skippedQuery = loadedQuery([]);
    testState.identityEventsQuery = loadedQuery({ events: [], count: 0 });
    testState.suggestedContactsQuery = loadedQuery({ suggestions: [] });
    testState.linkSuggestionsQuery = loadedQuery({ suggestions: [] });
    testState.updateContactPending = false;

    testState.updateContact.mockReset().mockResolvedValue(undefined);
    testState.deleteContact.mockResolvedValue(undefined);
    testState.refreshCache.mockResolvedValue(undefined);
    vi.stubGlobal("confirm", vi.fn(() => true));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("clears the contact panel after deleting even if the contact query still has cached data", async () => {
    const { getByRole, queryByRole } = render(() => <ContactsView />);

    expect(getByRole("button", { name: "Delete" })).toBeInTheDocument();

    fireEvent.click(getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(testState.deleteContact).toHaveBeenCalledWith({ id: 1 });
      expect(queryByRole("button", { name: "Delete" })).toBeNull();
    });
  });

  it("asks what happens to a hidden contact's linked notes, keeping them by default", async () => {
    testState.contactQuery = loadedQuery(contactDetail({ ...makeContact(1, "Alice Example"), hidden: 1 }, 2));
    const { getByRole } = render(() => <ContactsView />);

    fireEvent.click(getByRole("button", { name: "Delete" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("2 memory notes are linked to this contact.");
    expect(dialog).toHaveTextContent("agents will be able to read these notes");
    expect(screen.getByRole("radio", { name: /Keep the notes, unlinked/ })).toBeChecked();
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Delete contact"));
    await waitFor(() => expect(testState.deleteContact).toHaveBeenCalledWith({ id: 1, choice: { notes: "keep", count: 2, hidden: true } }));
  });

  it("deletes the linked notes when chosen, without the hidden warning for a visible contact", async () => {
    testState.contactQuery = loadedQuery(contactDetail(makeContact(1, "Alice Example"), 1));
    const { getByRole } = render(() => <ContactsView />);

    fireEvent.click(getByRole("button", { name: "Delete" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("1 memory note is linked to this contact.");
    expect(dialog).not.toHaveTextContent("agents will be able to read");
    fireEvent.click(screen.getByRole("radio", { name: /Delete the note too/ }));
    fireEvent.click(screen.getByText("Delete contact"));
    await waitFor(() => expect(testState.deleteContact).toHaveBeenCalledWith({ id: 1, choice: { notes: "delete", count: 1, hidden: false } }));
  });

  it("asks about notes linked since the contact loaded, when the delete is refused for them", async () => {
    testState.deleteContact.mockResolvedValueOnce({ memoryNoteCount: 1, hidden: false });
    const { getByRole } = render(() => <ContactsView />);

    fireEvent.click(getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.getByRole("dialog")).toHaveTextContent("1 memory note is linked to this contact."));
    expect(testState.deleteContact).toHaveBeenCalledWith({ id: 1 });
  });

  it("asks again, with the warning, when the contact was hidden since the dialog opened", async () => {
    testState.contactQuery = loadedQuery(contactDetail(makeContact(1, "Alice Example"), 1));
    testState.deleteContact.mockResolvedValueOnce({ memoryNoteCount: 1, hidden: true });
    const { getByRole } = render(() => <ContactsView />);

    fireEvent.click(getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).not.toHaveTextContent("agents will be able to read");
    fireEvent.click(screen.getByText("Delete contact"));

    await waitFor(() => expect(dialog).toHaveTextContent("agents will be able to read this note"));
    expect(dialog).toHaveTextContent("changed since this opened");
    fireEvent.click(screen.getByText("Delete contact"));
    await waitFor(() => expect(testState.deleteContact).toHaveBeenLastCalledWith({ id: 1, choice: { notes: "keep", count: 1, hidden: true } }));
  });

  it("marks a contact as self via the This is me action", async () => {
    testState.updateContact.mockResolvedValue(undefined);

    const { getByRole } = render(() => <ContactsView />);

    fireEvent.click(getByRole("button", { name: "This is me" }));

    await waitFor(() => {
      expect(testState.updateContact).toHaveBeenCalledWith({ id: 1, updates: { isSelf: true } });
    });
  });

  it("shows the You badge and unmark action for the self contact", () => {
    const contact = { ...makeContact(1, "Alice Example"), is_self: 1 };
    testState.contactsQuery = loadedQuery([makeContactListItem(contact)]);
    testState.contactQuery = loadedQuery(contactDetail(contact));

    const { getAllByText, getByRole } = render(() => <ContactsView />);

    expect(getAllByText("You")).toHaveLength(2);
    expect(getByRole("button", { name: "Not me" })).toBeInTheDocument();
    expect(getByRole("heading", { name: "Alice Example" })).toBeInTheDocument();
  });

  it("disables the self action while a contact update is pending", () => {
    testState.updateContactPending = true;

    const { getByRole } = render(() => <ContactsView />);

    expect(getByRole("button", { name: "This is me" })).toBeDisabled();
  });

  it("shows an error when marking the contact as self fails", async () => {
    testState.updateContact.mockRejectedValue(new Error("Contact update failed"));

    const { findByRole, getByRole } = render(() => <ContactsView />);
    fireEvent.click(getByRole("button", { name: "This is me" }));

    expect(await findByRole("alert")).toHaveTextContent("Contact update failed");
  });

  it("marks placeholder contact detail as stale and non-interactive while switching contacts", () => {
    testState.searchParams = { id: "2" };
    testState.contactQuery = loadedQuery(contactDetail(makeContact(1, "Alice Example")), true);

    const { container, getByRole } = render(() => <ContactsView />);

    const stalePanel = container.querySelector(".opacity-50.pointer-events-none[aria-busy='true']");

    expect(stalePanel).not.toBeNull();
    expect(stalePanel).toContainElement(getByRole("button", { name: "Delete" }));
  });

  it("shows platform labels while retaining stable selector values", () => {
    const identity = (platform: string): UnlinkedIdentity => ({
      identifier: `${platform}:example`,
      platform,
      platformId: "example",
      displayName: "Example",
      username: null,
      eventCount: 1,
      avatarUrl: null,
    });
    testState.searchParams = { view: "unlinked" };
    testState.unlinkedQuery = loadedQuery([
      identity("google-messages"),
      identity("amex"),
      identity("live"),
    ]);

    const { getByRole } = render(() => <ContactsView />);
    const selector = getByRole("combobox") as HTMLSelectElement;

    expect(Array.from(selector.options).map((option) => [option.value, option.textContent])).toEqual([
      ["", "All platforms"],
      ["amex", "American Express"],
      ["google-messages", "Google Messages"],
      ["live", "Microsoft Live"],
    ]);
  });
});
