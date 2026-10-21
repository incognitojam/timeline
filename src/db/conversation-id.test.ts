import { describe, test, expect } from "bun:test";
import { extractConversationId } from "./conversation-id";

describe("extractConversationId", () => {
  test("discord returns _channel.id", () => {
    expect(extractConversationId("discord", { _channel: { id: "9100000000000000000", name: "x" } })).toBe(
      "9100000000000000000",
    );
  });

  test("skype returns _conversation.id", () => {
    expect(extractConversationId("skype", { _conversation: { id: "19:abc@thread.skype" } })).toBe(
      "19:abc@thread.skype",
    );
  });

  test("skype modern _conversation.id wins over legacy fields", () => {
    expect(
      extractConversationId("skype", {
        _conversation: { id: "8:alice" },
        dialog_partner: "bob",
        chatname: "#alice/$bob;1a2b3c",
      }),
    ).toBe("8:alice");
  });

  test("skype legacy DM normalizes dialog_partner to 8:<skypename>", () => {
    expect(
      extractConversationId("skype", {
        dialog_partner: "bob",
        chatname: "#alice/$bob;1a2b3c4d5e6f7890",
        convo_id: 29,
      }),
    ).toBe("8:bob");
  });

  test("skype legacy xmpp chatname wins over dialog_partner", () => {
    expect(
      extractConversationId("skype", {
        chatname: "xmpp:-100000123456789@chat.facebook.com",
        dialog_partner: "xmpp:-100000123456789@chat.facebook.com",
      }),
    ).toBe("xmpp:-100000123456789@chat.facebook.com");
  });

  test("skype legacy group falls back to chatname when dialog_partner is null", () => {
    expect(
      extractConversationId("skype", {
        dialog_partner: null,
        chatname: "#alice/$bob;1a2b3c4d5e6f7890",
        convo_id: 2278,
      }),
    ).toBe("#alice/$bob;1a2b3c4d5e6f7890");
  });

  test("skype legacy returns null when chatname and dialog_partner are empty", () => {
    expect(extractConversationId("skype", { dialog_partner: null, chatname: "", convo_id: 240 })).toBeNull();
    expect(extractConversationId("skype", { convo_id: 240 })).toBeNull();
  });

  test("claude returns conversation_uuid", () => {
    expect(extractConversationId("claude", { conversation_uuid: "uuid-1" })).toBe("uuid-1");
  });

  test("chatgpt returns conversation_id", () => {
    expect(extractConversationId("chatgpt", { conversation_id: "conv-1" })).toBe("conv-1");
  });

  test.each([["conductor"], ["claude-code"], ["opencode"]])(
    "%s returns session_id",
    (source) => {
      expect(extractConversationId(source, { session_id: "sess-1" })).toBe("sess-1");
    },
  );

  test("amp returns thread_id", () => {
    expect(extractConversationId("amp", { thread_id: "T-abc123" })).toBe("T-abc123");
  });

  test("linkedin returns the CONVERSATION ID column", () => {
    expect(
      extractConversationId("linkedin", {
        "CONVERSATION ID": "2-abc123==",
        "CONVERSATION TITLE": "Job opportunity",
        FROM: "Alice Example",
      }),
    ).toBe("2-abc123==");
  });

  test("linkedin returns null for rows without a CONVERSATION ID (connections, positions)", () => {
    expect(
      extractConversationId("linkedin", { "First Name": "Alice", "Last Name": "Example" }),
    ).toBeNull();
    expect(extractConversationId("linkedin", { "CONVERSATION ID": "" })).toBeNull();
  });

  test("instagram returns the conversation thread_path", () => {
    expect(
      extractConversationId("instagram", {
        sender_name: "Alice",
        conversation: {
          title: "Alice",
          participants: ["Alice", "Bob"],
          thread_path: "inbox/alice_123456789",
          category: "inbox",
        },
      }),
    ).toBe("inbox/alice_123456789");
  });

  test("instagram returns null when thread_path is missing or empty", () => {
    expect(extractConversationId("instagram", { sender_name: "Alice" })).toBeNull();
    expect(extractConversationId("instagram", { conversation: { thread_path: "" } })).toBeNull();
    expect(extractConversationId("instagram", { conversation: { thread_path: 42 } })).toBeNull();
  });

  test("phone normalizes the sms/mms address", () => {
    expect(extractConversationId("phone", { address: "07700900123", body: "hi" })).toBe(
      "+447700900123",
    );
    expect(extractConversationId("phone", { address: "+44 (7700) 900-123" })).toBe(
      "+447700900123",
    );
  });

  test("phone reads call rows from the number field", () => {
    expect(extractConversationId("phone", { number: "07700900123", duration: "30" })).toBe(
      "+447700900123",
    );
  });

  test("phone keys group MMS on the sorted normalized participant list", () => {
    expect(extractConversationId("phone", { address: "+15550001111~07700900123" })).toBe(
      "+15550001111~+447700900123",
    );
    // Same participants in a different order produce the same key.
    expect(extractConversationId("phone", { address: "07700900123~+15550001111" })).toBe(
      "+15550001111~+447700900123",
    );
  });

  test("phone passes non-phone sender ids through verbatim", () => {
    expect(extractConversationId("phone", { address: "ExampleCo" })).toBe("ExampleCo");
    // normalizePhoneNumber would strip this to "2".
    expect(extractConversationId("phone", { address: "Example 2 UK" })).toBe("Example 2 UK");
    expect(extractConversationId("phone", { address: "abc7group3id@rcs.example.com" })).toBe(
      "abc7group3id@rcs.example.com",
    );
  });

  test("phone returns null without an address or number", () => {
    expect(extractConversationId("phone", {})).toBeNull();
    expect(extractConversationId("phone", { address: "" })).toBeNull();
    expect(extractConversationId("phone", { address: 42 })).toBeNull();
  });

  test("google-chat returns the space id segment of message_id", () => {
    expect(
      extractConversationId("google-chat", {
        message_id: "AAAAexample1/TopicExample1/MsgExample1",
        topic_id: "TopicExample1",
        group: "Study Group",
      }),
    ).toBe("AAAAexample1");
  });

  test("google-chat returns null when message_id is missing or unsegmented", () => {
    expect(extractConversationId("google-chat", { group: "Study Group" })).toBeNull();
    expect(extractConversationId("google-chat", { message_id: 42 })).toBeNull();
    expect(extractConversationId("google-chat", { message_id: "no-slash-here" })).toBeNull();
    expect(extractConversationId("google-chat", { message_id: "/TopicExample1" })).toBeNull();
  });

  test("reddit keys messages on the sorted normalized participants", () => {
    expect(
      extractConversationId("reddit", {
        id: "abc123",
        thread_id: "",
        from: "bob",
        to: "alice",
        subject: "hello",
      }),
    ).toBe("alice~bob");
    // Reply direction and u/ prefixes produce the same key.
    expect(extractConversationId("reddit", { from: "u/alice", to: "bob" })).toBe("alice~bob");
  });

  test("reddit keys subreddit modmail on the r/ participant", () => {
    expect(extractConversationId("reddit", { from: "/r/somesub", to: "alice" })).toBe(
      "alice~r/somesub",
    );
  });

  test("reddit returns null for rows without participants (posts, comments, votes)", () => {
    expect(
      extractConversationId("reddit", { id: "p1", subreddit: "somesub", title: "A post" }),
    ).toBeNull();
    expect(extractConversationId("reddit", { from: "", to: "" })).toBeNull();
    expect(extractConversationId("reddit", { from: 42 })).toBeNull();
  });

  test("facebook keys on first_message_ts across export-era folder names", () => {
    expect(
      extractConversationId("facebook", {
        sender_name: "Alice",
        conversation: {
          title: "Study Group",
          first_message_ts: 1700000001000,
          thread_path: "inbox/studygroup_ab12cd-ef0",
        },
      }),
    ).toBe("1700000001000");
    // The same thread in a newer export has a numeric folder id but retains
    // the same oldest-message timestamp.
    expect(
      extractConversationId("facebook", {
        conversation: {
          first_message_ts: 1700000001000,
          thread_path: "archived_threads/studygroup_1234567890123456",
        },
      }),
    ).toBe("1700000001000");
  });

  test("facebook falls back to the thread_path rule before first_message_ts capture", () => {
    // Bare numeric folders (threads with no title slug) carry the id alone.
    expect(
      extractConversationId("facebook", {
        conversation: { thread_path: "inbox/1234567890123456" },
      }),
    ).toBe("1234567890123456");
    // A rename or category move between exports keeps the same fallback key.
    expect(
      extractConversationId("facebook", {
        conversation: { thread_path: "archived_threads/renamedgroup_1234567890123456" },
      }),
    ).toBe("1234567890123456");
  });

  test("facebook keys old-format folders (no numeric id) on the whole folder", () => {
    expect(
      extractConversationId("facebook", {
        conversation: { thread_path: "inbox/studygroup_ab12cd-ef0" },
      }),
    ).toBe("studygroup_ab12cd-ef0");
  });

  test("facebook returns null for rows predating thread_path capture", () => {
    expect(extractConversationId("facebook", { sender_name: "Alice", title: "Group" })).toBeNull();
    expect(
      extractConversationId("facebook", { conversation: { title: "Group", category: "inbox" } }),
    ).toBeNull();
    expect(extractConversationId("facebook", { conversation: { thread_path: "" } })).toBeNull();
    expect(extractConversationId("facebook", { conversation: { thread_path: 42 } })).toBeNull();
  });

  test("returns null when rawData is missing the expected key", () => {
    expect(extractConversationId("discord", { other: "field" })).toBeNull();
    expect(extractConversationId("claude", {})).toBeNull();
  });

  test("returns null when rawData is not an object", () => {
    expect(extractConversationId("discord", null)).toBeNull();
    expect(extractConversationId("discord", undefined)).toBeNull();
    expect(extractConversationId("discord", "string")).toBeNull();
    expect(extractConversationId("discord", 123)).toBeNull();
  });

  test("returns null when value is the wrong type", () => {
    expect(extractConversationId("discord", { _channel: { id: 123 } })).toBeNull();
    expect(extractConversationId("claude", { conversation_uuid: null })).toBeNull();
    expect(extractConversationId("amp", { thread_id: 42 })).toBeNull();
  });

  test("returns null for unknown source", () => {
    expect(extractConversationId("unknown-source", { _channel: { id: "x" } })).toBeNull();
  });
});
