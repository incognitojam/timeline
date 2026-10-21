import {
  type DiscordPoll,
  type ParsedDiscordPoll,
  type PollVoter,
  parseDiscordPoll,
} from "@shared/discord-forward";
import { fireEvent, render, screen, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCache } from "../../lib/identities";
import { DiscordPoll as DiscordPollCard } from "./DiscordPoll";

type StoredPoll = DiscordPoll & {
  voters?: { captured_at: string; answers?: Record<string, PollVoter[]> };
};

function buildPoll(overrides: Partial<StoredPoll> = {}): StoredPoll {
  return {
    question: { text: "pineapple on pizza" },
    answers: [
      { answer_id: 1, poll_media: { text: "yes", emoji: { id: null, name: "🔴" } } },
      { answer_id: 2, poll_media: { text: "no", emoji: { id: null, name: "🟢" } } },
    ],
    expiry: "2020-01-02T00:00:00.000Z",
    allow_multiselect: false,
    layout_type: 1,
    results: {
      is_finalized: true,
      answer_counts: [
        { id: 1, count: 3, me_voted: true },
        { id: 2, count: 1, me_voted: false },
      ],
    },
    ...overrides,
  };
}

function parsePoll(poll: StoredPoll): ParsedDiscordPoll {
  const parsed = parseDiscordPoll({ poll });
  if (!parsed) throw new Error("Expected valid poll fixture");
  return parsed;
}

function DiscordPoll(props: { poll: StoredPoll }) {
  return <DiscordPollCard parsedPoll={parsePoll(props.poll)} />;
}

beforeEach(() => {
  // Both surfaces resolve identifiers, so every test here reaches the identity
  // endpoint; the ones that care about the response stub their own.
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ resolved: {} }), { status: 200 }),
    ),
  );
});

afterEach(() => {
  clearCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("DiscordPoll", () => {
  it("renders question, answers, counts, percentages, and winner check", () => {
    const { getByText, getByTitle } = render(() => <DiscordPoll poll={buildPoll()} />);

    expect(getByText("pineapple on pizza")).toBeInTheDocument();
    expect(getByText("yes")).toBeInTheDocument();
    expect(getByText("no")).toBeInTheDocument();
    expect(getByText("3 votes")).toBeInTheDocument();
    expect(getByText("75%")).toBeInTheDocument();
    expect(getByText("1 vote")).toBeInTheDocument();
    expect(getByText("25%")).toBeInTheDocument();
    expect(getByText("4 votes ·", { exact: false })).toBeInTheDocument();
    expect(getByText("Poll closed", { exact: false })).toBeInTheDocument();
    // Winner check on the finalized top answer
    expect(getByTitle("Winning answer")).toBeInTheDocument();
    // The voter's own answer is marked
    expect(getByText("· your vote")).toBeInTheDocument();
  });

  it("names every winning answer when the finalized result is tied", () => {
    const poll = buildPoll({
      results: {
        is_finalized: true,
        answer_counts: [
          { id: 1, count: 2, me_voted: false },
          { id: 2, count: 2, me_voted: false },
        ],
      },
    });

    render(() => <DiscordPoll poll={poll} />);

    expect(screen.getAllByText("Winning answer")).toHaveLength(2);
  });

  it("shows an open poll without a winner when expiry is in the future", () => {
    const future = new Date(Date.now() + 24 * 3600_000).toISOString();
    const poll = buildPoll({
      expiry: future,
      results: {
        is_finalized: false,
        answer_counts: [{ id: 1, count: 2, me_voted: false }],
      },
    });
    const { getByText, queryByTitle } = render(() => <DiscordPoll poll={poll} />);

    expect(getByText("Poll open", { exact: false })).toBeInTheDocument();
    expect(queryByTitle("Winning answer")).not.toBeInTheDocument();
  });

  it("renders an unknown state when results are missing (absent ≠ zero)", () => {
    const poll = buildPoll({ results: undefined });
    const { getByText, queryByText, queryByTitle } = render(() => <DiscordPoll poll={poll} />);

    expect(queryByText("0 votes")).not.toBeInTheDocument();
    expect(getByText("Vote counts not captured", { exact: false })).toBeInTheDocument();
    expect(queryByTitle("Winning answer")).not.toBeInTheDocument();
  });

  it("notes multiple answers allowed", () => {
    const poll = buildPoll({ allow_multiselect: true });
    const { getByText } = render(() => <DiscordPoll poll={poll} />);
    expect(getByText("Multiple answers allowed")).toBeInTheDocument();
  });

  it("makes the votes text a button only when voters were captured", () => {
    const captured = buildPoll({
      voters: {
        captured_at: "2020-01-02T00:00:00.000Z",
        answers: { "1": [{ id: "111", name: "Alice", username: "alice", avatar: null }], "2": [] },
      },
    });
    const { getByRole, unmount } = render(() => <DiscordPoll poll={captured} />);
    expect(getByRole("button", { name: "4 votes" })).toBeInTheDocument();
    unmount();

    const uncaptured = buildPoll();
    expect(uncaptured.voters).toBeUndefined();
    const { getByText, queryByRole } = render(() => <DiscordPoll poll={uncaptured} />);
    // Same text, but plain (non-interactive) — the card renders as before
    expect(getByText("4 votes", { exact: false })).toBeInTheDocument();
    expect(queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("survives a voter capture without an answers record", () => {
    const poll = buildPoll({
      voters: { captured_at: "2020-01-02T00:00:00.000Z" },
    });
    const { getByRole } = render(() => <DiscordPoll poll={poll} />);

    // Card renders and the dialog opens without crashing; every answer
    // degrades to an empty voter list
    fireEvent.click(getByRole("button", { name: "4 votes" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("No votes")).toBeInTheDocument();
  });

  it("shows summed voter counts when voters were captured but results are absent", () => {
    const poll = buildPoll({
      results: undefined,
      voters: {
        captured_at: "2020-01-02T00:00:00.000Z",
        answers: {
          "1": [{ id: "111", name: "Alice", username: "alice", avatar: null }],
          "2": [{ id: "222", name: "Bob", username: "bob", avatar: null }],
        },
      },
    });
    const { getByRole, queryByText } = render(() => <DiscordPoll poll={poll} />);

    // Not "Vote counts not captured" — the captured voter lists are the count
    expect(queryByText("Vote counts not captured", { exact: false })).not.toBeInTheDocument();
    fireEvent.click(getByRole("button", { name: "2 votes" }));
    expect(within(screen.getByRole("dialog")).getByText("Alice")).toBeInTheDocument();
  });

  it("resolves its voters on open and names them by the contact that comes back", async () => {
    const poll = buildPoll({
      voters: {
        captured_at: "2020-01-02T00:00:00.000Z",
        answers: {
          "1": [
            { id: "111", name: "alice_2019", username: "alice_w", avatar: null },
            { id: "222", name: "bob_2019", username: "bob_b", avatar: null },
          ],
          "2": [],
        },
      },
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          resolved: {
            "discord:111": { name: "Alice", username: null, contactId: 1, avatarUrl: null },
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(() => <DiscordPoll poll={poll} />);
    // Nothing is resolved until the reader opens the dialog.
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "4 votes" }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("alice_2019")).toBeInTheDocument();
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      identifiers: ["discord:111", "discord:222"],
    });

    await vi.waitFor(() => {
      expect(within(dialog).getByText("Alice")).toBeInTheDocument();
    });
    expect(within(dialog).queryByText("alice_2019")).not.toBeInTheDocument();
    // A voter the server knows nothing about keeps the name captured with them.
    expect(within(dialog).getByText("bob_2019")).toBeInTheDocument();
  });

  it("opens a voters dialog listing answers with counts, first answer selected", () => {
    const poll = buildPoll({
      voters: {
        captured_at: "2020-01-02T00:00:00.000Z",
        answers: {
          "1": [
            { id: "111", name: "Alice", username: "alice_w", avatar: "aaaa1111" },
            { id: "222", name: "Bob", username: "bob_b", avatar: null },
            { id: "333", name: "Carol", username: "carol", avatar: null },
          ],
          "2": [{ id: "444", name: "Dave", username: "dave", avatar: null }],
        },
      },
    });
    const { getByRole } = render(() => <DiscordPoll poll={poll} />);

    fireEvent.click(getByRole("button", { name: "4 votes" }));

    const dialog = screen.getByRole("dialog");
    // Header: question + total votes subtitle
    expect(within(dialog).getByText("pineapple on pizza")).toBeInTheDocument();
    expect(within(dialog).getByText("4 votes")).toBeInTheDocument();
    // Answer rows show label and count; the first answer is selected by
    // default, so its voters are listed and the other answer's are not
    const yes = within(dialog).getByRole("button", { name: /yes.*3/ });
    expect(yes).toHaveAttribute("aria-pressed", "true");
    expect(within(dialog).getByRole("button", { name: /no.*1/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(within(dialog).getByText("Alice")).toBeInTheDocument();
    expect(within(dialog).getByText("Bob")).toBeInTheDocument();
    expect(within(dialog).getByText("Carol")).toBeInTheDocument();
    expect(within(dialog).queryByText("Dave")).not.toBeInTheDocument();
  });

  it("renders a voter avatar image from the Discord CDN when a hash is present", () => {
    const poll = buildPoll({
      voters: {
        captured_at: "2020-01-02T00:00:00.000Z",
        answers: {
          "1": [{ id: "111", name: "Alice", username: "alice_w", avatar: "aaaa1111" }],
          "2": [],
        },
      },
    });
    const { getByRole } = render(() => <DiscordPoll poll={poll} />);
    fireEvent.click(getByRole("button", { name: "4 votes" }));
    const dialog = screen.getByRole("dialog");

    const img = within(dialog).getByRole("img", { name: "Alice" });
    expect(img).toHaveAttribute(
      "src",
      "https://cdn.discordapp.com/avatars/111/aaaa1111.png",
    );
  });

  it("falls back to initials (no image) when a voter has no avatar hash", () => {
    const poll = buildPoll({
      voters: {
        captured_at: "2020-01-02T00:00:00.000Z",
        answers: {
          "1": [{ id: "222", name: "Bob", username: "bob_b", avatar: null }],
          "2": [],
        },
      },
    });
    const { getByRole } = render(() => <DiscordPoll poll={poll} />);
    fireEvent.click(getByRole("button", { name: "4 votes" }));
    const dialog = screen.getByRole("dialog");

    expect(within(dialog).queryByRole("img", { name: "Bob" })).not.toBeInTheDocument();
    // getInitials("Bob") -> "BO"
    expect(within(dialog).getByText("BO")).toBeInTheDocument();
  });

  it("shows the username subtitle only when it differs from the display name", () => {
    const poll = buildPoll({
      voters: {
        captured_at: "2020-01-02T00:00:00.000Z",
        answers: {
          "1": [
            { id: "111", name: "Alice", username: "alice_w", avatar: null },
            { id: "222", name: "Bob", username: "Bob", avatar: null },
          ],
          "2": [],
        },
      },
    });
    const { getByRole } = render(() => <DiscordPoll poll={poll} />);
    fireEvent.click(getByRole("button", { name: "4 votes" }));
    const dialog = screen.getByRole("dialog");

    // Alice's handle differs, so it renders as a second line
    expect(within(dialog).getByText("alice_w")).toBeInTheDocument();
    // Bob's username equals his display name — no duplicate subtitle line
    expect(within(dialog).getAllByText("Bob")).toHaveLength(1);
  });

  it("selecting another answer shows its voters", () => {
    const poll = buildPoll({
      voters: {
        captured_at: "2020-01-02T00:00:00.000Z",
        answers: {
          "1": [{ id: "111", name: "Alice", username: "alice", avatar: null }],
          "2": [{ id: "444", name: "Dave", username: "dave", avatar: null }],
        },
      },
    });
    const { getByRole } = render(() => <DiscordPoll poll={poll} />);
    fireEvent.click(getByRole("button", { name: "4 votes" }));
    const dialog = screen.getByRole("dialog");

    fireEvent.click(within(dialog).getByRole("button", { name: /no.*1/ }));

    expect(within(dialog).getByText("Dave")).toBeInTheDocument();
    expect(within(dialog).queryByText("Alice")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /no.*1/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("shows no voter names for a zero-vote answer with an empty voters array", () => {
    const poll = buildPoll({
      voters: {
        captured_at: "2020-01-02T00:00:00.000Z",
        answers: {
          "1": [{ id: "111", name: "Alice", username: "alice", avatar: null }],
          "2": [],
        },
      },
    });
    const { getByRole } = render(() => <DiscordPoll poll={poll} />);
    fireEvent.click(getByRole("button", { name: "4 votes" }));
    const dialog = screen.getByRole("dialog");

    fireEvent.click(within(dialog).getByRole("button", { name: /no.*1/ }));

    expect(within(dialog).queryByText("Alice")).not.toBeInTheDocument();
    expect(within(dialog).getByText("No votes")).toBeInTheDocument();
  });

  it("renders the same voter under multiple answers for multiselect polls", () => {
    const poll = buildPoll({
      allow_multiselect: true,
      voters: {
        captured_at: "2020-01-02T00:00:00.000Z",
        answers: {
          "1": [{ id: "111", name: "Alice", username: "alice", avatar: null }],
          "2": [{ id: "111", name: "Alice", username: "alice", avatar: null }],
        },
      },
    });
    const { getByRole } = render(() => <DiscordPoll poll={poll} />);
    fireEvent.click(getByRole("button", { name: "4 votes" }));
    const dialog = screen.getByRole("dialog");

    expect(within(dialog).getByText("Alice")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: /no.*1/ }));
    expect(within(dialog).getByText("Alice")).toBeInTheDocument();
  });
});

describe("parseDiscordPoll", () => {
  it("parses serialized raw_data.poll into the structured poll and voters", () => {
    const parsed = parseDiscordPoll(JSON.stringify({
      poll: buildPoll({
        voters: {
          captured_at: "2020-01-02T00:00:00.000Z",
          answers: {
            "1": [{ id: "111", name: "Alice", username: "alice", avatar: null }],
          },
        },
      }),
    }));

    expect(parsed?.poll.question.text).toBe("pineapple on pizza");
    expect(parsed?.poll.answers).toHaveLength(2);
    expect(parsed?.votersByAnswerId.get("1")?.[0]?.name).toBe("Alice");
  });

  it("returns null when raw data has no poll", () => {
    expect(parseDiscordPoll(JSON.stringify({ content: "hello" }))).toBeNull();
  });

  it("returns null for malformed serialized raw data", () => {
    expect(parseDiscordPoll("not json")).toBeNull();
  });

  it("drops legacy voters missing canonical identity fields", () => {
    // This is deliberate: PollVoter requires these fields, and the voter
    // backfill means every persisted voter now has them.
    const poll = buildPoll({
      results: undefined,
      voters: {
        captured_at: "2020-01-02T00:00:00.000Z",
        answers: { "1": [{ id: "111", name: "Alice" } as PollVoter], "2": [] },
      },
    });
    const { getByRole } = render(() => <DiscordPoll poll={poll} />);

    expect(getByRole("button", { name: "0 votes" })).toBeInTheDocument();
    fireEvent.click(getByRole("button", { name: "0 votes" }));
    expect(
      within(screen.getByRole("dialog")).getByRole("button", { name: /yes.*0/ }),
    ).toBeInTheDocument();
  });
});
