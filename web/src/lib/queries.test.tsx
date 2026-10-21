import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationStats } from "./api";
import type { Contact, ContactWithStats } from "./types";
import {
  queryKeys,
  useBatchLinkIdentities,
  useConversationStats,
  useDeleteContact,
  useLinkIdentity,
  useUnlinkIdentity,
  useUpdateContact,
} from "./queries";

type MembershipMutations = {
  link: ReturnType<typeof useLinkIdentity>;
  batchLink: ReturnType<typeof useBatchLinkIdentities>;
  deleteContact: ReturnType<typeof useDeleteContact>;
  unlink: ReturnType<typeof useUnlinkIdentity>;
  updateContact: ReturnType<typeof useUpdateContact>;
};

let mutations: MembershipMutations;
let queryClient: QueryClient;

function MutationHarness() {
  mutations = {
    link: useLinkIdentity(),
    batchLink: useBatchLinkIdentities(),
    deleteContact: useDeleteContact(),
    unlink: useUnlinkIdentity(),
    updateContact: useUpdateContact(),
  };
  return null;
}

const membershipQueryKeys = [
  queryKeys.contacts(),
  queryKeys.contact(1),
  queryKeys.contactEvents(1, { limit: 20 }),
  queryKeys.contactSpotifySummary(1),
  queryKeys.contactConversations(1),
  queryKeys.contactSuggestions(1),
  queryKeys.suggestedContactsForIdentity("discord:alice"),
  queryKeys.linkSuggestions(),
  queryKeys.unlinkedIdentities(),
  queryKeys.musicFriendListens(),
];

function seedMembershipQueries() {
  for (const queryKey of membershipQueryKeys) {
    const data = queryKey[0] === "unlinkedIdentities"
      ? []
      : queryKey[0] === "linkSuggestions"
        ? { suggestions: [] }
        : {};
    queryClient.setQueryData(queryKey, data);
  }
}

function expectMembershipQueriesInvalidated() {
  for (const queryKey of membershipQueryKeys) {
    const query = queryClient.getQueryCache().find({ queryKey, exact: true });
    expect(query?.state.isInvalidated).toBe(true);
  }
}

function makeContact(id: number, displayName: string, isSelf: boolean): Contact {
  return {
    id,
    display_name: displayName,
    notes: null,
    date_of_birth: null,
    hidden: 0,
    is_self: isSelf ? 1 : 0,
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

describe("contact membership mutations", () => {
  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    vi.stubGlobal("fetch", vi.fn((url: string | URL, init?: RequestInit) => {
      if (String(url).includes("batch-link")) {
        return Promise.resolve(new Response(JSON.stringify({ success: true, linked: 2, errors: [] })));
      }
      if (init?.method === "PATCH") {
        return Promise.resolve(Response.json({ contact: { id: 1 } }));
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    }));
    render(() => (
      <QueryClientProvider client={queryClient}>
        <MutationHarness />
      </QueryClientProvider>
    ));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it.each([
    ["link", () => mutations.link.mutateAsync({ identifier: "discord:alice", contactId: 1 })],
    ["batch-link", () => mutations.batchLink.mutateAsync([
      { identifier: "discord:alice", contactId: 1 },
      { identifier: "steam:alice", contactId: 1 },
    ])],
    ["unlink", () => mutations.unlink.mutateAsync({ identifier: "discord:alice", contactId: 1 })],
  ])("invalidates every membership-derived query after %s succeeds", async (_name, mutate) => {
    seedMembershipQueries();

    await mutate();

    expectMembershipQueriesInvalidated();
  });

  it.each([
    ["rename", () => mutations.updateContact.mutateAsync({
      id: 1,
      updates: { displayName: "Alice Example" },
    })],
    ["delete", () => mutations.deleteContact.mutateAsync(1)],
  ])("invalidates cached friend display names after a contact %s", async (_name, mutate) => {
    const queryKey = queryKeys.musicFriendListens();
    queryClient.setQueryData(queryKey, { friends: [] });

    await mutate();

    const query = queryClient.getQueryCache().find({ queryKey, exact: true });
    expect(query?.state.isInvalidated).toBe(true);
  });

  it("optimistically moves the self flag across all cached contacts", async () => {
    const alice = makeContact(1, "Alice", true);
    const bob = makeContact(2, "Bob", false);
    queryClient.setQueryData(queryKeys.contacts(), [
      makeContactListItem(alice),
      makeContactListItem(bob),
    ]);
    queryClient.setQueryData(queryKeys.contact(1), {
      contact: alice,
      identities: [],
      memories: [],
      avatarUrl: null,
    });
    queryClient.setQueryData(queryKeys.contact(2), {
      contact: bob,
      identities: [],
      memories: [],
      avatarUrl: null,
    });

    let resolvePatch: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      resolvePatch = resolve;
    })));

    const mutation = mutations.updateContact.mutateAsync({ id: 2, updates: { isSelf: true } });

    await waitFor(() => {
      const contacts = queryClient.getQueryData<ContactWithStats[]>(queryKeys.contacts());
      expect(contacts?.filter((contact) => contact.is_self).map((contact) => contact.id)).toEqual([2]);
      expect(queryClient.getQueryData<{ contact: Contact }>(queryKeys.contact(1))?.contact.is_self).toBe(0);
      expect(queryClient.getQueryData<{ contact: Contact }>(queryKeys.contact(2))?.contact.is_self).toBe(1);
    });

    if (!resolvePatch) throw new Error("PATCH request did not start");
    resolvePatch(Response.json({ contact: { ...bob, is_self: 1 } }));
    await mutation;
  });
});

function conversationStats(totalMessages: number): ConversationStats {
  return {
    totalMessages,
    firstMessage: null,
    lastMessage: null,
    firstEventId: null,
    lastEventId: null,
    participants: [],
    attachmentCount: 0,
    activityByMonth: [],
    titles: [],
    tokenUsage: null,
  };
}

describe("conversation stats query", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("cancels obsolete requests when the conversation key changes", async () => {
    const [conversationId, setConversationId] = createSignal("conversation-a");
    let resolveFirst: ((response: Response) => void) | undefined;
    let firstSignal: AbortSignal | null = null;
    let statsQuery: ReturnType<typeof useConversationStats> | undefined;

    vi.stubGlobal("fetch", vi.fn((url: string | URL, init?: RequestInit) => {
      if (String(url).includes("conversation-a")) {
        firstSignal = init?.signal ?? null;
        return new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve(Response.json(conversationStats(22)));
    }));

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    function StatsHarness() {
      statsQuery = useConversationStats(() => ({
        conversationId: conversationId(),
        source: "discord",
      }));
      return null;
    }
    render(() => (
      <QueryClientProvider client={client}>
        <StatsHarness />
      </QueryClientProvider>
    ));

    await waitFor(() => expect(firstSignal).not.toBeNull());
    setConversationId("conversation-b");

    await waitFor(() => expect(firstSignal?.aborted).toBe(true));
    await waitFor(() => expect(statsQuery?.data?.totalMessages).toBe(22));

    resolveFirst?.(Response.json(conversationStats(11)));
    await Promise.resolve();

    expect(statsQuery?.data?.totalMessages).toBe(22);
  });
});
