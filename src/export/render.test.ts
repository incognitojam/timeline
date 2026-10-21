import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initDb, type TimelineEvent } from "../db/schema";
import { wrapDatabase } from "../db/pool";
import { upsertIdentity } from "../db/identities";
import { loadAttachmentDescriptionsForEvents } from "./attachment-descriptions";
import { resolveRenderIdentities } from "./display-names";
import { loadReplyQuotesForEvents } from "./reply-quotes";
import { renderConversationTranscript, renderEvent, renderEvents } from "./render";

function makeEvent(overrides: Partial<TimelineEvent>): TimelineEvent {
  return {
    id: 1,
    source: "google-calendar",
    source_id: "event-1",
    source_account: null,
    type: "event",
    timestamp: "2026-01-01T09:00:00Z",
    end_timestamp: "2026-01-01T10:30:00Z",
    duration_ms: null,
    title: "Planning",
    content: null,
    latitude: null,
    longitude: null,
    location_name: null,
    people: null,
    tags: null,
    raw_data: "{}",
    imported_at: "2026-01-01T00:00:00Z",
    import_batch: null,
    conversation_id: null,
    source_deleted_observed_at: null,
    ...overrides,
  };
}

describe("renderEvents", () => {
  test("renders inline Discord timestamps in the export's timezone", () => {
    const event = makeEvent({
      source: "discord",
      type: "message:dm",
      timestamp: "2023-06-13T19:10:00Z",
      title: null,
      content: "court on <t:1686682800:F>, relative <t:1686682800:R>",
      people: JSON.stringify(["discord:111"]),
    });

    expect(renderEvent(event)).toBe(
      "2023-06-13 19:10 <discord:111> court on 2023-06-13 19:00, relative 2023-06-13 19:00",
    );
    expect(renderEvent(event, { timeZone: "America/New_York" })).toBe(
      "2023-06-13 15:10 <discord:111> court on 2023-06-13 15:00, relative 2023-06-13 15:00",
    );
  });

  test("renders Discord mentions and senders with resolved identities", async () => {
    const db = new Database(":memory:");
    initDb(db);
    try {
      db.prepare(`
        INSERT INTO identities (platform, platform_id, display_name)
        VALUES ('discord', '111', 'Alice'), ('discord', '222', 'Bob')
      `).run();
      const event = makeEvent({
        source: "discord",
        type: "message:guild",
        timestamp: "2026-01-01T19:10:00Z",
        title: null,
        content: "Hi <@222> and <@333> in <#444> <@&555> <:wave:666>",
        people: JSON.stringify(["discord:111"]),
        raw_data: JSON.stringify({
          mentions: [{ id: "333", username: "Carol" }],
          mention_channels: [{ id: "444", name: "general" }],
          mention_roles: [{ id: "555", name: "Members" }],
        }),
      });
      const renderIdentities = await resolveRenderIdentities(wrapDatabase(db), [event]);

      expect(renderEvent(event, renderIdentities)).toBe(
        "2026-01-01 19:10 <Alice> Hi @Bob and @Carol in #general @Members :wave:",
      );
      expect(renderEvents([event], {
        compactAuthors: true,
        noSummaries: true,
        fullTimestamps: false,
        ...renderIdentities,
      })).toContain("<Alice> Hi @Bob and @Carol in #general @Members :wave:");
    } finally {
      db.close();
    }
  });

  test("default compact output keeps the date on the first timed event in a group", () => {
    const text = renderEvents([makeEvent({})], {
        compactAuthors: true,
      noSummaries: true,
      fullTimestamps: false,
    });

    expect(text).toContain("2026-01-01 09:00-10:30 Planning");
    expect(text).not.toContain("[09:00-10:30] Planning");
  });

  test("compacts same-day authors across a multi-hour gap", () => {
    const events = [
      makeEvent({
        source: "discord",
        type: "message:guild",
        timestamp: "2026-01-01T09:00:00Z",
        title: "General",
        content: "morning",
        people: JSON.stringify(["Alice"]),
      }),
      makeEvent({
        id: 2,
        source: "discord",
        type: "message:guild",
        timestamp: "2026-01-01T18:00:00Z",
        title: "General",
        content: "afternoon",
        people: JSON.stringify(["Alice"]),
      }),
    ];

    const compact = renderEvents(events, {
      compactAuthors: true,
      noSummaries: true,
      fullTimestamps: false,
    });
    expect(compact).toContain("18:00 afternoon");
    expect(compact).not.toContain("18:00 <Alice> afternoon");

    expect(renderEvents(events, {
      compactAuthors: false,
      noSummaries: true,
      fullTimestamps: false,
    })).toContain("18:00 <Alice> afternoon");
  });

  test("date headers keep time ranges for the first timed event on a date", () => {
    const text = renderEvents([makeEvent({})], {
        compactAuthors: true,
      noSummaries: true,
      fullTimestamps: false,
      dateHeaders: true,
    });

    expect(text).toContain("## google-calendar: Planning");
    expect(text).toContain("### 2026-01-01");
    expect(text).toContain("09:00-10:30 Planning");
    expect(text).not.toContain("09:00 Planning");
  });

  test("full timestamps keep the date on timed events", () => {
    const text = renderEvents([makeEvent({})], {
        compactAuthors: true,
      noSummaries: true,
      fullTimestamps: true,
    });

    expect(text).toContain("2026-01-01 09:00-10:30 Planning");
    expect(text).not.toContain("[09:00-10:30] Planning");
  });

  test("default compact output uses day offsets for cross-day timed events", () => {
    const text = renderEvents([makeEvent({
      timestamp: "2026-01-01T23:30:00Z",
      end_timestamp: "2026-01-02T00:30:00Z",
      title: "Late planning",
    })], {
        compactAuthors: true,
      noSummaries: true,
      fullTimestamps: false,
    });

    expect(text).toContain("2026-01-01 23:30-00:30(+1) Late planning");
    expect(text).not.toContain("2026-01-02 00:30");
  });

  test("date-header output uses day offsets for cross-day timed events", () => {
    const text = renderEvents([makeEvent({
      timestamp: "2026-01-01T23:30:00Z",
      end_timestamp: "2026-01-02T00:30:00Z",
      title: "Late planning",
    })], {
        compactAuthors: true,
      noSummaries: true,
      fullTimestamps: false,
      dateHeaders: true,
    });

    expect(text).toContain("### 2026-01-01");
    expect(text).toContain("23:30-00:30(+1) Late planning");
    expect(text).not.toContain("2026-01-02 00:30");
  });

  test("full timestamp output uses day offsets for cross-day timed events", () => {
    const text = renderEvents([makeEvent({
      timestamp: "2026-01-01T23:30:00Z",
      end_timestamp: "2026-01-02T00:30:00Z",
      title: "Late planning",
    })], {
        compactAuthors: true,
      noSummaries: true,
      fullTimestamps: true,
    });

    expect(text).toContain("2026-01-01 23:30-00:30(+1) Late planning");
    expect(text).not.toContain("2026-01-02 00:30");
  });

  test("timed event ranges use explicit end dates after the next day", () => {
    const text = renderEvents([makeEvent({
      timestamp: "2026-01-01T09:00:00Z",
      end_timestamp: "2026-01-03T10:30:00Z",
      title: "Retreat",
    })], {
        compactAuthors: true,
      noSummaries: true,
      fullTimestamps: true,
    });

    expect(text).toContain("2026-01-01 09:00-2026-01-03 10:30 Retreat");
    expect(text).not.toContain("(+2)");
  });

  test("default compact timed ranges use explicit end dates after the next day", () => {
    const text = renderEvents([makeEvent({
      timestamp: "2026-01-01T09:00:00Z",
      end_timestamp: "2026-01-03T10:30:00Z",
      title: "Retreat",
    })], {
        compactAuthors: true,
      noSummaries: true,
      fullTimestamps: false,
    });

    expect(text).toContain("2026-01-01 09:00-2026-01-03 10:30 Retreat");
    expect(text).not.toContain("(+2)");
  });

  test("date-header timed ranges use offsets after the next day", () => {
    const text = renderEvents([makeEvent({
      timestamp: "2026-01-01T09:00:00Z",
      end_timestamp: "2026-01-03T10:30:00Z",
      title: "Retreat",
    })], {
        compactAuthors: true,
      noSummaries: true,
      fullTimestamps: false,
      dateHeaders: true,
    });

    expect(text).toContain("09:00-10:30(+2) Retreat");
    expect(text).not.toContain("2026-01-03 10:30");
  });

  test("conversation summary headers name the speakers, not the roster", () => {
    // people[] is sender-first followed by the thread roster. Five people are
    // on this thread; only Alice and Bob spoke, so the header stays under the
    // three-name cap that keeps big-group headers to a message count.
    const roster = ["Alice", "Bob", "Carol", "Dave", "Erin"];
    const speak = (id: number, minute: number, sender: string) => makeEvent({
      id,
      source: "facebook",
      source_id: `m-${id}`,
      type: "message:dm",
      timestamp: `2026-01-01T12:0${minute}:00Z`,
      title: "Weekend plans",
      content: `message ${id}`,
      conversation_id: "conv-1",
      people: JSON.stringify([sender, ...roster.filter((p) => p !== sender)]),
    });

    const text = renderEvents([speak(1, 0, "Alice"), speak(2, 1, "Bob"), speak(3, 2, "Alice")], {
      compactAuthors: true,
      noSummaries: false,
      fullTimestamps: false,
    });

    expect(text).toContain("## facebook: Weekend plans (3 messages, Alice, Bob)");
    expect(text).not.toContain("Carol");
  });

  test("conversation summary headers omit names once four people have spoken", () => {
    const speak = (id: number, minute: number, sender: string) => makeEvent({
      id,
      source: "facebook",
      source_id: `m-${id}`,
      type: "message:dm",
      timestamp: `2026-01-01T12:0${minute}:00Z`,
      title: "Weekend plans",
      content: `message ${id}`,
      conversation_id: "conv-1",
      people: JSON.stringify([sender]),
    });

    const text = renderEvents([
      speak(1, 0, "Alice"),
      speak(2, 1, "Bob"),
      speak(3, 2, "Carol"),
      speak(4, 3, "Dave"),
    ], {
      compactAuthors: true,
      noSummaries: false,
      fullTimestamps: false,
    });

    expect(text).toContain("## facebook: Weekend plans (4 messages)");
    expect(text).not.toContain("Alice, Bob");
  });

  test("suppresses the summary header when noSummaries is set", () => {
    const text = renderEvents([makeEvent({
      source: "facebook",
      type: "message:dm",
      timestamp: "2026-01-01T12:00:00Z",
      title: "Weekend plans",
      content: "hello",
      conversation_id: "conv-1",
      people: JSON.stringify(["Alice", "Bob"]),
    })], {
      compactAuthors: true,
      noSummaries: true,
      fullTimestamps: false,
    });

    expect(text).toContain("## facebook: Weekend plans");
    expect(text).not.toContain("(1 message");
  });

  test("single-event rendering uses day offsets for cross-day timed events", () => {
    const text = renderEvent(makeEvent({
      timestamp: "2026-01-01T23:30:00Z",
      end_timestamp: "2026-01-02T00:30:00Z",
      title: "Late planning",
    }));

    expect(text).toBe("2026-01-01 23:30-00:30(+1) Late planning");
  });

  test("message rendering appends attachment and embed markers", () => {
    const event = makeEvent({
      source: "discord",
      type: "message:guild",
      timestamp: "2026-01-01T19:10:00Z",
      title: null,
      content: "https://example.com/post",
      people: JSON.stringify(["Alice"]),
      raw_data: JSON.stringify({
        attachments: [{ filename: "notes.pdf", content_type: "application/pdf" }],
        embeds: [
          {
            type: "link",
            url: "https://example.com/post",
            title: "Example post",
            description: "A useful description",
          },
        ],
      }),
    });

    expect(renderEvent(event)).toBe(
      "2026-01-01 19:10 <Alice> https://example.com/post [file: notes.pdf] [embed: Example post — A useful description]",
    );
  });

  test("renders rcs messages as messages and calls as calls", () => {
    const rcs = makeEvent({
      source: "google-messages",
      type: "rcs:received",
      timestamp: "2026-01-01T19:10:00Z",
      title: "Alice",
      content: "on my way",
      people: JSON.stringify(["phone:+447700900001", "phone:+447700900000"]),
    });
    expect(renderEvent(rcs)).toBe("2026-01-01 19:10 <phone:+447700900001> on my way");

    const call = makeEvent({
      source: "phone",
      type: "call:missed",
      timestamp: "2026-01-01T19:12:00Z",
      title: "Alice",
      people: JSON.stringify(["phone:+447700900001", "phone:+447700900000"]),
    });
    expect(renderEvent(call)).toBe("2026-01-01 19:12 missed call with phone:+447700900001");
  });

  test("source-deleted messages get a [deleted] marker", () => {
    const event = makeEvent({
      source: "discord",
      type: "message:guild",
      timestamp: "2026-01-01T19:10:00Z",
      title: null,
      content: "gone soon",
      people: JSON.stringify(["Alice"]),
      raw_data: "{}",
      source_deleted_observed_at: "2026-01-02T00:00:00.000Z",
    });

    expect(renderEvent(event)).toBe("2026-01-01 19:10 <Alice> gone soon [deleted]");
  });

  test("message rendering includes stickers alongside attachment markers", () => {
    const event = makeEvent({
      source: "discord",
      type: "message:guild:attachment",
      timestamp: "2026-01-01T19:10:00Z",
      title: null,
      content: "Look at this",
      people: JSON.stringify(["Alice"]),
      raw_data: JSON.stringify({
        attachments: [{ filename: "photo.jpg", content_type: "image/jpeg" }],
        sticker_items: [{ id: "sticker-1", name: "Wave", format_type: 1 }],
      }),
    });

    expect(renderEvent(event)).toBe("2026-01-01 19:10 <Alice> Look at this [photo] [sticker: Wave]");
  });

  test("conversation transcripts render Discord call and sticker markers", () => {
    const call = makeEvent({
      source: "discord",
      type: "message:dm:call",
      timestamp: "2026-01-01T19:10:00Z",
      title: "Alice",
      content: null,
      duration_ms: null,
      source_account: "1",
      people: JSON.stringify(["Alice"]),
      raw_data: JSON.stringify({ call: { participants: ["1", "2"], ended_timestamp: "2026-01-01T19:13:12Z" } }),
    });
    const missedCall = makeEvent({
      ...call,
      id: 2,
      timestamp: "2026-01-01T19:15:00Z",
      raw_data: JSON.stringify({ call: { participants: ["2"], ended_timestamp: "2026-01-01T19:18:12Z" } }),
    });
    const callWithoutEnd = makeEvent({
      ...call,
      id: 3,
      timestamp: "2026-01-01T19:18:00Z",
      raw_data: JSON.stringify({ call: { participants: ["1", "2"] } }),
    });
    const sticker = makeEvent({
      id: 4,
      source: "discord",
      type: "message:guild:sticker",
      timestamp: "2026-01-01T19:20:00Z",
      title: "General",
      content: "Look at this",
      people: JSON.stringify(["Alice"]),
      raw_data: JSON.stringify({ sticker_items: [{ id: "sticker-1", name: "Wave", format_type: 1 }] }),
    });

    const text = renderConversationTranscript([call, missedCall, callWithoutEnd, sticker], {
      source: "discord",
      title: "General",
      timestampStyle: "date-headers",
      includeReactions: true,
      compactAuthors: false,
    });

    expect(text).toContain("19:10 <Alice> [call: 3m 12s]");
    expect(text).toContain("19:15 <Alice> [missed call]");
    expect(text).toContain("19:18 <Alice> [call: answered; duration unavailable]");
    expect(text).toContain("19:20 <Alice> Look at this [sticker: Wave]");
  });

  test("conversation transcripts compact same-day authors across a multi-hour gap", () => {
    const events = [
      makeEvent({
        source: "discord",
        type: "message:guild",
        timestamp: "2026-01-01T19:00:00Z",
        title: "General",
        content: "one",
        people: JSON.stringify(["Alice"]),
      }),
      makeEvent({
        id: 2,
        source: "discord",
        type: "message:guild",
        timestamp: "2026-01-01T19:03:00Z",
        title: "General",
        content: "two",
        people: JSON.stringify(["Alice"]),
      }),
      makeEvent({
        id: 3,
        source: "discord",
        type: "reaction:like",
        timestamp: "2026-01-01T19:04:00Z",
        title: "an earlier message",
        content: null,
      }),
      makeEvent({
        id: 4,
        source: "discord",
        type: "message:guild",
        timestamp: "2026-01-01T19:05:00Z",
        title: "General",
        content: "three",
        people: JSON.stringify(["Alice"]),
      }),
      makeEvent({
        id: 5,
        source: "discord",
        type: "message:guild",
        timestamp: "2026-01-01T23:00:00Z",
        title: "General",
        content: "four",
        people: JSON.stringify(["Alice"]),
      }),
      makeEvent({
        id: 6,
        source: "discord",
        type: "message:guild",
        timestamp: "2026-01-02T00:00:00Z",
        title: "General",
        content: "tomorrow",
        people: JSON.stringify(["Alice"]),
      }),
    ];

    expect(renderConversationTranscript(events, {
      source: "discord",
      title: "General",
      timestampStyle: "date-headers",
      includeReactions: true,
      compactAuthors: true,
    })).toBe(`## discord: General
### 2026-01-01
19:00 <Alice> one
19:03 two
19:04 Reacted 👍 to: "an earlier message"
19:05 <Alice> three
23:00 four
### 2026-01-02
00:00 <Alice> tomorrow`);

    expect(renderConversationTranscript(events, {
      source: "discord",
      title: "General",
      timestampStyle: "date-headers",
      includeReactions: true,
      compactAuthors: false,
    })).toBe(`## discord: General
### 2026-01-01
19:00 <Alice> one
19:03 <Alice> two
19:04 Reacted 👍 to: "an earlier message"
19:05 <Alice> three
23:00 <Alice> four
### 2026-01-02
00:00 <Alice> tomorrow`);
  });

  test("keeps SMS call rendering unchanged", () => {
    const event = makeEvent({
      source: "sms",
      type: "call:incoming",
      timestamp: "2026-01-01T19:10:00Z",
      people: JSON.stringify(["Alice"]),
      duration_ms: 192_000,
    });

    expect(renderEvent(event)).toBe("2026-01-01 19:10 incoming call with Alice (3m)");
  });

  test("conversation transcript includes forwarded embed markers", () => {
    const content = "Original message text";
    const event = makeEvent({
      source: "discord",
      type: "message:guild:forward",
      timestamp: "2026-01-01T19:10:00Z",
      title: null,
      content,
      people: JSON.stringify(["Alice"]),
      raw_data: JSON.stringify({
        content: "",
        message_snapshots: [
          {
            message: {
              content,
              embeds: [
                {
                  title: "Forwarded page",
                  description: "Forwarded description",
                },
              ],
            },
          },
        ],
      }),
    });

    const text = renderConversationTranscript([event], {
      source: "discord",
      title: "General",
      timestampStyle: "date-headers",
      includeReactions: true,
      compactAuthors: true,
    });

    expect(text).toContain(
      '19:10 <Alice> ↗ (forwarded: "Original message text [embed: Forwarded page — Forwarded description]")',
    );
  });

  test("conversation transcript derives historical forwarded text and attachment markers", () => {
    const event = makeEvent({
      source: "discord",
      type: "message:guild:forward",
      timestamp: "2026-01-01T19:10:00Z",
      title: "General",
      content: null,
      people: JSON.stringify(["Alice"]),
      raw_data: JSON.stringify({
        attachments: [],
        message_snapshots: [{
          message: {
            content: "Forwarded body",
            attachments: [{
              id: "attachment-1",
              filename: "photo.jpg",
              size: 1234,
              url: "https://cdn.discordapp.com/attachments/channel-1/attachment-1/photo.jpg",
              content_type: "image/jpeg",
            }],
          },
        }],
      }),
    });

    const text = renderConversationTranscript([event], {
      source: "discord",
      title: "General",
      timestampStyle: "date-headers",
      includeReactions: true,
      compactAuthors: true,
    });

    expect(text).toContain('19:10 <Alice> ↗ (forwarded: "Forwarded body [photo]")');
  });

  test("forward quotes normalize Discord tokens and flatten whitespace", () => {
    const body = "Ask <@222> about <t:1686682800:F> <:wave:666>\nMore context.";
    const event = makeEvent({
      source: "discord",
      type: "message:dm:forward",
      people: JSON.stringify(["Alice"]),
      content: body,
      raw_data: JSON.stringify({ message_snapshots: [{ message: { content: body } }] }),
    });

    expect(renderEvent(event, {
      discordUserResolver: (id) => id === "222" ? "Bob" : null,
      timeZone: "America/New_York",
    })).toBe(
      '2026-01-01 04:00 <Alice> ↗ (forwarded: "Ask @Bob about 2023-06-13 15:00 :wave: More context.")',
    );
  });

  test("media-only forwards keep their markers and missing snapshots are explicit", () => {
    const event = makeEvent({
      source: "discord",
      type: "message:group:forward",
      title: "General",
      people: JSON.stringify(["Alice"]),
      raw_data: JSON.stringify({
        message_snapshots: [{ message: { embeds: [{ title: "Shared page" }] } }],
      }),
    });

    expect(renderEvent(event)).toBe('2026-01-01 09:00 <Alice> ↗ (forwarded: "[embed: Shared page]")');
    expect(renderEvent({ ...event, raw_data: "{}" })).toBe(
      '2026-01-01 09:00 <Alice> ↗ (forwarded: "[content unavailable]")',
    );
  });

  test("compact exports keep forward quotes separate from reactions and deletion markers", () => {
    const event = makeEvent({
      source: "discord",
      type: "message:dm:forward",
      people: JSON.stringify(["Alice"]),
      content: "Shared text",
      source_deleted_observed_at: "2026-01-02T00:00:00Z",
      raw_data: JSON.stringify({ reactions: [{ emoji: { name: "👍" }, count: 2 }] }),
    });

    const text = renderConversationTranscript([
      { ...event, id: 2, type: "message:dm", content: "Look at this", raw_data: "{}", source_deleted_observed_at: null },
      event,
    ], {
      source: "discord",
      title: "Alice",
      timestampStyle: "full-timestamps",
      includeReactions: true,
      compactAuthors: true,
    });

    expect(text).toBe(
      '## discord: Alice\n2026-01-01 09:00 <Alice> Look at this\n2026-01-01 09:00 ↗ (forwarded: "Shared text") [deleted] [reactions: 👍 ×2]',
    );
  });

  test("conversation transcript renders Discord polls with captured voters", () => {
    const event = makeEvent({
      source: "discord",
      type: "message:guild:poll",
      timestamp: "2026-01-01T19:10:00Z",
      title: "General",
      content: "Which activity should we choose?",
      people: JSON.stringify(["Alice"]),
      raw_data: JSON.stringify({
        poll: {
          question: { text: "Which activity should we choose?" },
          answers: [
            { answer_id: 1, poll_media: { text: "Board games", emoji: { id: null, name: "🎲" } } },
            { answer_id: 2, poll_media: { text: "Puzzles" } },
            { answer_id: 3, poll_media: { text: "Reading" } },
          ],
          expiry: "2026-01-02T19:10:00Z",
          allow_multiselect: true,
          layout_type: 1,
          results: {
            answer_counts: [
              { id: 1, count: 2, me_voted: true },
              { id: 2, count: 1, me_voted: false },
            ],
            is_finalized: true,
          },
          voters: {
            captured_at: "2026-01-02T00:00:00Z",
            answers: {
              "1": [
                { id: "1", name: "Alice", username: "alice", avatar: null },
                { id: "2", name: "Bob", username: "bob", avatar: null },
              ],
              "2": [{ id: "3", name: "Carol", username: "carol", avatar: null }],
            },
          },
        },
      }),
    });

    const text = renderConversationTranscript([event], {
      source: "discord",
      title: "General",
      timestampStyle: "date-headers",
      includeReactions: true,
      compactAuthors: true,
    });

    expect(text).toContain(
      "19:10 <Alice> [poll: Which activity should we choose? — 🎲 Board games (2 votes: Alice, Bob) — Puzzles (1 vote: Carol) — Reading (0 votes) — multiple selections allowed; finalized]",
    );
    expect(text.match(/\[poll:/g)).toHaveLength(1);

    // A resolver renames the voters it knows and leaves the rest as captured.
    const resolved = renderConversationTranscript([event], {
      source: "discord",
      title: "General",
      timestampStyle: "date-headers",
      includeReactions: true,
      compactAuthors: true,
      discordUserResolver: (id) => (id === "2" ? "Bobby Contact" : null),
    });

    expect(resolved).toContain("🎲 Board games (2 votes: Alice, Bobby Contact)");
    expect(resolved).toContain("Puzzles (1 vote: Carol)");
  });

  test("conversation transcript renders Discord polls without results or captured voters", () => {
    const event = makeEvent({
      source: "discord",
      type: "message:dm:poll",
      timestamp: "2026-01-01T19:10:00Z",
      title: "Alice",
      content: "Which day works?",
      people: JSON.stringify(["Alice"]),
      raw_data: JSON.stringify({
        poll: {
          question: { text: "Which day works?" },
          answers: [
            { answer_id: 1, poll_media: { text: "Saturday" } },
            { answer_id: 2, poll_media: { text: "Sunday" } },
          ],
          expiry: "2026-01-02T19:10:00Z",
          allow_multiselect: false,
          layout_type: 1,
        },
      }),
    });

    const text = renderConversationTranscript([event], {
      source: "discord",
      title: "Alice",
      timestampStyle: "date-headers",
      includeReactions: true,
      compactAuthors: true,
    });

    expect(text).toContain("19:10 <Alice> [poll: Which day works? — Saturday — Sunday]");
    expect(text).not.toContain("votes");
  });

  test("conversation transcript keeps vote status when poll voters were not captured", () => {
    const event = makeEvent({
      source: "discord",
      type: "message:guild:poll",
      timestamp: "2026-01-01T19:10:00Z",
      title: "General",
      content: "Which activity?",
      people: JSON.stringify(["Alice"]),
      raw_data: JSON.stringify({
        poll: {
          question: { text: "Which activity?" },
          answers: [{ answer_id: 1, poll_media: { text: "Board games" } }],
          expiry: "2026-01-02T19:10:00Z",
          allow_multiselect: false,
          layout_type: 1,
          results: {
            answer_counts: [{ id: 1, count: 2, me_voted: true }],
            is_finalized: true,
          },
        },
      }),
    });

    expect(renderEvent(event)).toBe(
      "2026-01-01 19:10 <Alice> [poll: Which activity? — Board games (2 votes, you voted) — finalized]",
    );
  });

  test("conversation transcript renders partial captured poll voters", () => {
    const event = makeEvent({
      source: "discord",
      type: "message:guild:poll",
      timestamp: "2026-01-01T19:10:00Z",
      title: "General",
      content: "Which activity?",
      people: JSON.stringify(["Alice"]),
      raw_data: JSON.stringify({
        poll: {
          question: { text: "Which activity?" },
          answers: [
            { answer_id: 1, poll_media: { text: "Board games" } },
            { answer_id: 2, poll_media: { text: "Puzzles" } },
          ],
          expiry: "2026-01-02T19:10:00Z",
          allow_multiselect: false,
          layout_type: 1,
          results: {
            answer_counts: [
              { id: 1, count: 2, me_voted: true },
              { id: 2, count: 1, me_voted: true },
            ],
            is_finalized: true,
          },
          voters: {
            captured_at: "2026-01-02T00:00:00Z",
            answers: {
              "1": [
                { id: "1", name: "Alice", username: "alice", avatar: null },
                { id: "2", name: "Bob", username: "bob", avatar: null },
              ],
            },
          },
        },
      }),
    });

    expect(renderEvent(event)).toBe(
      "2026-01-01 19:10 <Alice> [poll: Which activity? — Board games (2 votes: Alice, Bob) — Puzzles (1 vote, you voted) — finalized]",
    );
  });

  test("conversation transcript ignores malformed poll voter entries", () => {
    const event = makeEvent({
      source: "discord",
      type: "message:guild:poll",
      timestamp: "2026-01-01T19:10:00Z",
      title: "General",
      content: "Which activity?",
      people: JSON.stringify(["Alice"]),
      raw_data: JSON.stringify({
        poll: {
          question: { text: "Which activity?" },
          answers: [{ answer_id: 1, poll_media: { text: "Board games" } }],
          expiry: "2026-01-02T19:10:00Z",
          allow_multiselect: false,
          layout_type: 1,
          results: {
            answer_counts: [{ id: 1, count: 2, me_voted: true }],
            is_finalized: true,
          },
          voters: {
            captured_at: "2026-01-02T00:00:00Z",
            answers: { "1": [{ id: "1", name: "Alice" }] },
          },
        },
      }),
    });

    expect(renderEvent(event)).toBe(
      "2026-01-01 19:10 <Alice> [poll: Which activity? — Board games (2 votes, you voted) — finalized]",
    );
  });

  test("conversation transcript renders polls with results but no answer counts", () => {
    const event = makeEvent({
      source: "discord",
      type: "message:group:poll",
      timestamp: "2026-01-01T19:10:00Z",
      title: "General",
      content: "Where should we meet?",
      people: JSON.stringify(["Alice"]),
      raw_data: JSON.stringify({
        poll: {
          question: { text: "Where should we meet?" },
          answers: [
            { answer_id: 1, poll_media: { text: "Park" } },
            { answer_id: 2, poll_media: { text: "Library" } },
          ],
          expiry: "2026-01-02T19:10:00Z",
          allow_multiselect: false,
          layout_type: 1,
          results: { is_finalized: true },
        },
      }),
    });

    expect(renderConversationTranscript([event], {
      source: "discord",
      title: "General",
      timestampStyle: "date-headers",
      includeReactions: true,
      compactAuthors: true,
    })).toContain("19:10 <Alice> [poll: Where should we meet? — Park — Library — finalized]");
  });

  test("discord replies render an inline quote of the resolved target", async () => {
    const db = new Database(":memory:");
    initDb(db);
    try {
      db.prepare(`
        INSERT INTO events (source, source_id, source_account, type, timestamp, title, content, raw_data, conversation_id)
        VALUES ('discord', '100', 'alice', 'message:guild', '2026-01-01T19:00:00Z', 'General',
          'Does the example build pass?', json(?), '9100000000000000000')
      `).run(JSON.stringify({ author: { username: "alice", global_name: "Alice" } }));

      const reply = makeEvent({
        id: 2,
        source: "discord",
        source_account: "alice",
        type: "message:guild",
        timestamp: "2026-01-01T19:04:00Z",
        title: "General",
        content: "yes, all checks pass",
        people: JSON.stringify(["discord:222"]),
        raw_data: JSON.stringify({ message_reference: { type: 0, message_id: "100" } }),
        conversation_id: "9100000000000000000",
      });

      const replyQuotes = await loadReplyQuotesForEvents(wrapDatabase(db), [reply]);
      const text = renderConversationTranscript([reply], {
        source: "discord",
        title: "General",
        timestampStyle: "date-headers",
        displayNames: { "discord:222": "Bob" },
        includeReactions: false,
        compactAuthors: true,
        replyQuotes,
      });

      expect(text).toContain(
        '19:04 <Bob> ↪ (to Alice: "Does the example build pass?") yes, all checks pass',
      );
    } finally {
      db.close();
    }
  });

  test("reply quotes render inline timestamps in the same zone as the message body", async () => {
    const db = new Database(":memory:");
    initDb(db);
    try {
      db.prepare(`
        INSERT INTO events (source, source_id, source_account, type, timestamp, title, content, raw_data, conversation_id)
        VALUES ('discord', '100', 'alice', 'message:guild', '2023-06-13T19:00:00Z', 'General',
          'court on <t:1686682800:F>', json(?), '9100000000000000000')
      `).run(JSON.stringify({ author: { username: "alice", global_name: "Alice" } }));

      const reply = makeEvent({
        id: 2,
        source: "discord",
        source_account: "alice",
        type: "message:guild",
        timestamp: "2023-06-13T19:04:00Z",
        title: "General",
        content: "same time as <t:1686682800:R>",
        people: JSON.stringify(["discord:222"]),
        raw_data: JSON.stringify({ message_reference: { type: 0, message_id: "100" } }),
        conversation_id: "9100000000000000000",
      });

      const timeZone = "America/New_York";
      const replyQuotes = await loadReplyQuotesForEvents(wrapDatabase(db), [reply], { timeZone });
      const text = renderConversationTranscript([reply], {
        source: "discord",
        title: "General",
        timestampStyle: "date-headers",
        displayNames: { "discord:222": "Bob" },
        includeReactions: false,
        compactAuthors: true,
        timeZone,
        replyQuotes,
      });

      expect(text).toContain(
        '15:04 <Bob> ↪ (to Alice: "court on 2023-06-13 15:00") same time as 2023-06-13 15:00',
      );
    } finally {
      db.close();
    }
  });

  test("discord replies fall back to the embedded snapshot and quote nothing when unresolvable", async () => {
    const db = new Database(":memory:");
    initDb(db);
    try {
      const snapshotReply = makeEvent({
        id: 2,
        source: "discord",
        source_account: "alice",
        type: "message:guild",
        content: "agreed",
        people: JSON.stringify(["discord:222"]),
        raw_data: JSON.stringify({
          message_reference: { type: 0, message_id: "404" },
          referenced_message: {
            id: "404",
            author: { username: "bob" },
            content: "unindexed original",
          },
        }),
      });
      const unresolvableReply = makeEvent({
        id: 3,
        source: "discord",
        source_account: "alice",
        type: "message:guild",
        timestamp: "2026-01-01T19:05:00Z",
        content: "no idea what this replied to",
        people: JSON.stringify(["discord:222"]),
        raw_data: JSON.stringify({ message_reference: { type: 0, message_id: "405" } }),
      });

      const replyQuotes = await loadReplyQuotesForEvents(
        wrapDatabase(db),
        [snapshotReply, unresolvableReply],
      );

      expect(renderEvent(snapshotReply, { replyQuotes })).toBe(
        '2026-01-01 09:00 <discord:222> ↪ (to bob: "unindexed original") agreed',
      );
      // No local row and no snapshot: the line renders exactly as a non-reply.
      expect(renderEvent(unresolvableReply, { replyQuotes })).toBe(
        renderEvent(unresolvableReply),
      );
      expect(renderEvent(unresolvableReply, { replyQuotes })).not.toContain("↪");
    } finally {
      db.close();
    }
  });

  test("discord forwards never get reply quotes", async () => {
    const db = new Database(":memory:");
    initDb(db);
    try {
      db.prepare(`
        INSERT INTO events (source, source_id, source_account, type, timestamp, title, content, raw_data, conversation_id)
        VALUES ('discord', '100', 'alice', 'message:guild', '2026-01-01T19:00:00Z', 'General',
          'Original', json(?), '9100000000000000000')
      `).run(JSON.stringify({ author: { username: "alice" } }));

      const forward = makeEvent({
        id: 2,
        source: "discord",
        source_account: "alice",
        type: "message:guild:forward",
        content: null,
        title: "General",
        people: JSON.stringify(["discord:222"]),
        raw_data: JSON.stringify({
          flags: 1 << 14,
          message_reference: { type: 0, message_id: "100" },
          message_snapshots: [{ message: { content: "Forwarded body" } }],
        }),
      });

      const replyQuotes = await loadReplyQuotesForEvents(wrapDatabase(db), [forward]);
      expect(replyQuotes.size).toBe(0);
      expect(renderEvent(forward, { replyQuotes })).not.toContain("↪");
    } finally {
      db.close();
    }
  });

  test("reply quotes truncate long content and flatten mention/emoji tokens", async () => {
    const db = new Database(":memory:");
    initDb(db);
    try {
      db.prepare(`
        INSERT INTO identities (platform, platform_id, display_name)
        VALUES ('discord', '333', 'Carol')
      `).run();
      const longContent = `hey <@333> look at this <:wave:666>\n${"x".repeat(120)}`;
      db.prepare(`
        INSERT INTO events (source, source_id, source_account, type, timestamp, title, content, raw_data, conversation_id)
        VALUES ('discord', '100', 'alice', 'message:guild', '2026-01-01T19:00:00Z', 'General',
          ?, json(?), '9100000000000000000')
      `).run(longContent, JSON.stringify({ author: { username: "bob" } }));

      const reply = makeEvent({
        id: 2,
        source: "discord",
        source_account: "alice",
        type: "message:guild",
        content: "nice",
        people: JSON.stringify(["discord:222"]),
        raw_data: JSON.stringify({ message_reference: { type: 0, message_id: "100" } }),
      });

      const renderIdentities = await resolveRenderIdentities(wrapDatabase(db), [reply]);
      const replyQuotes = await loadReplyQuotesForEvents(wrapDatabase(db), [reply], {
        discordUserResolver: renderIdentities.discordUserResolver,
      });
      const quote = replyQuotes.get(2);

      expect(quote).toBeDefined();
      expect(quote).toContain('(to bob: "hey @Carol look at this :wave: x');
      expect(quote).toContain("…");
      expect(quote).not.toContain("<@333>");
      expect(quote).not.toContain("<:wave:666>");
      expect(quote).not.toContain("\n");
      // 70 chars of quoted text plus the marker chrome.
      const quoteText = quote ?? "";
      expect(quoteText.length).toBeLessThanOrEqual(70 + '↪ (to bob: "")'.length);
    } finally {
      db.close();
    }
  });

  test("quoted authors are named by their resolved identity, not the captured name", async () => {
    const db = new Database(":memory:");
    initDb(db);
    try {
      upsertIdentity(db, { platform: "discord", platformId: "111", displayName: "Alice" });
      // Discord stamped the name it held when the message was synced; the
      // transcript's own author lines use the resolved identity instead.
      db.prepare(`
        INSERT INTO events (source, source_id, source_account, type, timestamp, title, content, raw_data, conversation_id)
        VALUES ('discord', '100', 'alice', 'message:guild', '2026-01-01T19:00:00Z', 'General',
          'Does the example build pass?', json(?), '9100000000000000000')
      `).run(JSON.stringify({ author: { id: "111", username: "alice_2019", global_name: "alice_2019" } }));

      const reply = makeEvent({
        id: 2,
        source: "discord",
        source_account: "alice",
        type: "message:guild",
        content: "yes, all checks pass",
        people: JSON.stringify(["discord:222"]),
        raw_data: JSON.stringify({ message_reference: { type: 0, message_id: "100" } }),
      });

      const replyQuotes = await loadReplyQuotesForEvents(wrapDatabase(db), [reply]);
      expect(replyQuotes.get(2)).toBe('↪ (to Alice: "Does the example build pass?")');
    } finally {
      db.close();
    }
  });

  test("quoted mentions resolve from the target's own mentions array", async () => {
    const db = new Database(":memory:");
    initDb(db);
    try {
      // "777" is absent from the identities table and any caller resolver; the
      // only source of its name is the replied-to message's mentions array.
      db.prepare(`
        INSERT INTO events (source, source_id, source_account, type, timestamp, title, content, raw_data, conversation_id)
        VALUES ('discord', '100', 'alice', 'message:guild', '2026-01-01T19:00:00Z', 'General',
          'ask <@777> about it', json(?), '9100000000000000000')
      `).run(JSON.stringify({
        author: { username: "bob" },
        mentions: [{ id: "777", name: "Dave" }],
      }));

      const reply = makeEvent({
        id: 2,
        source: "discord",
        source_account: "alice",
        type: "message:guild",
        content: "will do",
        people: JSON.stringify(["discord:222"]),
        raw_data: JSON.stringify({ message_reference: { type: 0, message_id: "100" } }),
      });

      const replyQuotes = await loadReplyQuotesForEvents(wrapDatabase(db), [reply]);
      expect(replyQuotes.get(2)).toBe('↪ (to bob: "ask @Dave about it")');
    } finally {
      db.close();
    }
  });

  test("reply quote truncation never splits an emoji surrogate pair", async () => {
    const db = new Database(":memory:");
    initDb(db);
    try {
      // 68 chars + astral emoji: a UTF-16 slice at 69 would cut the emoji in
      // half and leave a lone surrogate; code-point slicing keeps it whole.
      const content = `${"x".repeat(68)}😀${"y".repeat(10)}`;
      db.prepare(`
        INSERT INTO events (source, source_id, source_account, type, timestamp, title, content, raw_data, conversation_id)
        VALUES ('discord', '100', 'alice', 'message:guild', '2026-01-01T19:00:00Z', 'General',
          ?, json(?), '9100000000000000000')
      `).run(content, JSON.stringify({ author: { username: "bob" } }));

      const reply = makeEvent({
        id: 2,
        source: "discord",
        source_account: "alice",
        type: "message:guild",
        content: "ha",
        people: JSON.stringify(["discord:222"]),
        raw_data: JSON.stringify({ message_reference: { type: 0, message_id: "100" } }),
      });

      const replyQuotes = await loadReplyQuotesForEvents(wrapDatabase(db), [reply]);
      const quote = replyQuotes.get(2) ?? "";

      expect(quote).toContain("😀…");
      // No unpaired surrogate anywhere in the marker.
      expect(quote).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    } finally {
      db.close();
    }
  });

  test("replies quoting attachment-only messages use an attachment marker", async () => {
    const db = new Database(":memory:");
    initDb(db);
    try {
      db.prepare(`
        INSERT INTO events (source, source_id, source_account, type, timestamp, title, content, raw_data, conversation_id)
        VALUES ('discord', '100', 'alice', 'message:guild:attachment', '2026-01-01T19:00:00Z', 'General',
          NULL, json(?), '9100000000000000000')
      `).run(JSON.stringify({
        author: { username: "bob" },
        attachments: [{
          id: "att-1",
          filename: "photo.jpg",
          size: 1234,
          url: "https://cdn.example.com/photo.jpg",
          content_type: "image/jpeg",
        }],
      }));

      const reply = makeEvent({
        id: 2,
        source: "discord",
        source_account: "alice",
        type: "message:guild",
        content: "cute!",
        people: JSON.stringify(["discord:222"]),
        raw_data: JSON.stringify({ message_reference: { type: 0, message_id: "100" } }),
      });

      const replyQuotes = await loadReplyQuotesForEvents(wrapDatabase(db), [reply]);
      expect(replyQuotes.get(2)).toBe('↪ (to bob: "[attachment]")');
    } finally {
      db.close();
    }
  });

  test("message image attachment descriptions render in photo markers", async () => {
    const db = new Database(":memory:");
    initDb(db);
    try {
      const event = makeEvent({
        id: 1,
        source: "discord",
        source_id: "message-1",
        type: "message:dm",
        title: "Chat",
        content: "look at this",
        people: JSON.stringify(["Alice"]),
        raw_data: JSON.stringify({
          attachments: [{ content_type: "image/png", filename: "diagram.png" }],
        }),
      });
      db.prepare(`
        INSERT INTO attachments (
          event_id, source, source_id, content_hash, filename,
          mime_type, storage_path, status
        ) VALUES (?, 'discord', 'attachment-1', 'hash-described', 'diagram.png',
          'image/png', 'discord/diagram.png', 'stored')
      `).run(event.id);
      db.prepare(`
        INSERT INTO attachment_descriptions (content_hash, model, description, created_at)
        VALUES ('hash-described', 'old-model', 'An older description.', '2026-01-01T00:00:00Z')
      `).run();
      db.prepare(`
        INSERT INTO attachment_descriptions (content_hash, model, description, created_at)
        VALUES ('hash-described', 'new-model', 'A whiteboard covered in a hand-drawn database schema.', '2026-01-02T00:00:00Z')
      `).run();

      const attachmentDescriptions = await loadAttachmentDescriptionsForEvents(wrapDatabase(db), [event]);
      const text = renderEvents([event], {
        compactAuthors: true,
        noSummaries: true,
        fullTimestamps: false,
        attachmentDescriptions,
      });

      expect(text).toContain("<Alice> look at this [photo: A whiteboard covered in a hand-drawn database schema.]");
      expect(text).not.toContain("[photo]");

      const forwarded = {
        ...event,
        type: "message:dm:forward",
        content: null,
        raw_data: JSON.stringify({
          attachments: [],
          message_snapshots: [{
            message: {
              content: `${"x".repeat(68)}😀${"y".repeat(10)}`,
              attachments: [{
                id: "attachment-1",
                filename: "diagram.png",
                size: 1234,
                url: "https://cdn.example.com/diagram.png",
                content_type: "image/png",
              }],
            },
          }],
        }),
      };
      const forwardedText = renderConversationTranscript([forwarded], {
        source: "discord",
        title: "Chat",
        timestampStyle: "date-headers",
        compactAuthors: true,
        includeReactions: true,
        attachmentDescriptions,
      });
      expect(forwardedText).toContain(
        `<Alice> ↗ (forwarded: "${"x".repeat(68)}😀… [photo: A whiteboard covered in a hand-drawn database schema.]")`,
      );
      expect(forwardedText).not.toContain("[photo]");
    } finally {
      db.close();
    }
  });

  test("message image attachments without descriptions keep current rendering", async () => {
    const db = new Database(":memory:");
    initDb(db);
    try {
      const event = makeEvent({
        id: 1,
        source: "discord",
        source_id: "message-1",
        type: "message:dm",
        title: "Chat",
        content: "look at this",
        people: JSON.stringify(["Alice"]),
        raw_data: JSON.stringify({
          attachments: [{ content_type: "image/png", filename: "diagram.png" }],
        }),
      });
      db.prepare(`
        INSERT INTO attachments (
          event_id, source, source_id, content_hash, filename,
          mime_type, storage_path, status
        ) VALUES (?, 'discord', 'attachment-1', 'hash-undescribed', 'diagram.png',
          'image/png', 'discord/diagram.png', 'stored')
      `).run(event.id);

      const before = renderEvents([event], {
        compactAuthors: true,
        noSummaries: true,
        fullTimestamps: false,
      });
      const attachmentDescriptions = await loadAttachmentDescriptionsForEvents(wrapDatabase(db), [event]);
      const after = renderEvents([event], {
        compactAuthors: true,
        noSummaries: true,
        fullTimestamps: false,
        attachmentDescriptions,
      });

      expect(after).toBe(before);
      expect(after).toContain("<Alice> look at this [photo]");
    } finally {
      db.close();
    }
  });
});
