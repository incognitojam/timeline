import { describe, it, expect } from "vitest";
import {
  applySuggestion,
  getAutocompleteSuggestions,
  getFilterChips,
  parseContactFilterId,
  parseQuery,
  removeFilter,
} from "./query-parser";

describe("parseQuery", () => {
  it("extracts source filter", () => {
    const result = parseQuery("hello source:discord world");
    expect(result.source).toBe("discord");
    expect(result.text).toBe("hello world");
  });

  it("handles multiple sources", () => {
    const result = parseQuery("source:discord source:spotify test");
    expect(result.source).toBe("discord,spotify");
    expect(result.text).toBe("test");
  });

  it("extracts type filter", () => {
    const result = parseQuery("type:message hello");
    expect(result.type).toBe("message");
    expect(result.text).toBe("hello");
  });

  it("parses date filter with full date", () => {
    const result = parseQuery("date:2024-01-15");
    expect(result.date).toBe("2024-01-15");
    expect(result.startDate).toBe("2024-01-15");
    expect(result.endDate).toBe("2024-01-15");
  });

  it("parses date filter with year-month", () => {
    const result = parseQuery("date:2024-01");
    expect(result.date).toBe("2024-01");
    expect(result.startDate).toBe("2024-01-01");
    expect(result.endDate).toBe("2024-01-31");
  });

  it("parses date filter with year only", () => {
    const result = parseQuery("date:2024");
    expect(result.date).toBe("2024");
    expect(result.startDate).toBe("2024-01-01");
    expect(result.endDate).toBe("2024-12-31");
  });

  it("handles quoted values", () => {
    const result = parseQuery('chat:"team discussion"');
    expect(result.chat).toBe("team discussion");
  });

  it("normalizes sort values", () => {
    expect(parseQuery("sort:oldest").sort).toBe("asc");
    expect(parseQuery("sort:newest").sort).toBe("desc");
    expect(parseQuery("sort:asc").sort).toBe("asc");
    expect(parseQuery("sort:desc").sort).toBe("desc");
  });

  it("extracts from filter", () => {
    const result = parseQuery("from:alice hello");
    expect(result.from).toBe("alice");
    expect(result.text).toBe("hello");
  });

  it("extracts location filter", () => {
    const result = parseQuery("at:london");
    expect(result.location).toBe("london");
  });

  it("extracts contact filter", () => {
    const result = parseQuery("contact:42");
    expect(result.contact).toBe("42");
  });

  it("preserves a bare contact filter for validation", () => {
    const result = parseQuery("contact:");
    expect(result.contact).toBe("");
    expect(result.text).toBe("");
  });

  it("handles after and before filters", () => {
    const result = parseQuery("after:2024-01-01 before:2024-12-31");
    expect(result.startDate).toBe("2024-01-01");
    expect(result.endDate).toBe("2024-12-31");
  });

  it("returns empty text for filter-only queries", () => {
    const result = parseQuery("source:discord");
    expect(result.text).toBe("");
    expect(result.source).toBe("discord");
  });

  it("handles complex mixed queries", () => {
    const result = parseQuery("source:discord type:message from:bob hello world");
    expect(result.source).toBe("discord");
    expect(result.type).toBe("message");
    expect(result.from).toBe("bob");
    expect(result.text).toBe("hello world");
  });
});

describe("getFilterChips", () => {
  it("creates chips for each filter", () => {
    const parsed = parseQuery("source:discord type:message from:alice");
    const chips = getFilterChips(parsed);

    expect(chips).toHaveLength(3);
    expect(chips.map((c) => c.key)).toContain("source");
    expect(chips.map((c) => c.key)).toContain("type");
    expect(chips.map((c) => c.key)).toContain("from");
  });

  it("creates separate chips for multiple sources", () => {
    const parsed = parseQuery("source:discord source:spotify");
    const chips = getFilterChips(parsed);

    expect(chips).toHaveLength(2);
    expect(chips[0]).toEqual({
      key: "source",
      value: "discord",
      label: "Source · Discord",
    });
    expect(chips[1]).toEqual({
      key: "source",
      value: "spotify",
      label: "Source · Spotify",
    });
  });

  it("shows date chip instead of after/before when date: was used", () => {
    const parsed = parseQuery("date:2024-01");
    const chips = getFilterChips(parsed);

    expect(chips).toHaveLength(1);
    expect(chips[0].key).toBe("date");
    expect(chips[0].label).toBe("date:2024-01");
  });

  it("shows after/before chips when used directly", () => {
    const parsed = parseQuery("after:2024-01-01 before:2024-12-31");
    const chips = getFilterChips(parsed);

    expect(chips).toHaveLength(2);
    expect(chips.map((c) => c.key)).toContain("after");
    expect(chips.map((c) => c.key)).toContain("before");
  });

  it("shows a contact name while preserving the contact ID", () => {
    const chips = getFilterChips(
      parseQuery("contact:42"),
      new Map([[42, "Alice Example"]]),
    );

    expect(chips).toEqual([{
      key: "contact",
      value: "42",
      label: "Contact · Alice Example",
    }]);
  });
});

describe("contact filters", () => {
  it("suggests contacts by name and inserts their stable ID", () => {
    const suggestions = getAutocompleteSuggestions(
      "contact:ali",
      "contact:ali".length,
      [],
      [],
      [{
        id: 42,
        displayName: "Alice Example",
        eventCount: 12,
        avatarUrl: null,
      }],
    );

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].value).toBe("Alice Example");
    expect(suggestions[0].insertText).toBe("contact:42");
    expect(applySuggestion("contact:ali", "contact:ali".length, suggestions[0])).toEqual({
      newQuery: "contact:42 ",
      newCursorPosition: "contact:42 ".length,
    });
  });

  it("replaces the whole active token when the cursor is in the middle", () => {
    const suggestion = getAutocompleteSuggestions(
      "contact:alic typo",
      "contact:ali".length,
      [],
      [],
      [{
        id: 42,
        displayName: "Alice Example",
        eventCount: 12,
        avatarUrl: null,
      }],
    )[0];

    expect(applySuggestion("contact:alic typo", "contact:ali".length, suggestion)).toEqual({
      newQuery: "contact:42 typo",
      newCursorPosition: "contact:42 ".length,
    });
  });

  it("requires a positive integer contact ID", () => {
    expect(parseContactFilterId("42")).toBe(42);
    expect(parseContactFilterId("Alice")).toBeUndefined();
    expect(parseContactFilterId("42junk")).toBeUndefined();
    expect(parseContactFilterId("0")).toBeUndefined();
  });

  it("removes a bare contact filter", () => {
    expect(removeFilter("contact: term", "contact", "")).toBe("term");
  });
});

describe("source suggestions", () => {
  it("shows the source label while inserting its stable ID", () => {
    const suggestions = getAutocompleteSuggestions(
      "source:google-m",
      "source:google-m".length,
      ["google-messages"],
      [],
    );

    expect(suggestions).toEqual([{
      type: "value",
      value: "source:google-messages",
      description: "Source: Google Messages",
      insertText: "source:google-messages",
      replaceFrom: 0,
    }]);
  });

  it.each([
    ["American", "amex", "American Express"],
    ["Offsite", "backup-offsite", "Offsite Backup"],
  ])("matches %s against the display label", (query, id, label) => {
    const suggestions = getAutocompleteSuggestions(
      `source:${query}`,
      `source:${query}`.length,
      [id],
      [],
    );

    expect(suggestions).toEqual([{
      type: "value",
      value: `source:${id}`,
      description: `Source: ${label}`,
      insertText: `source:${id}`,
      replaceFrom: 0,
    }]);
  });

  it("matches and replaces a multi-word display label", () => {
    const query = "notes source:Google M";
    const suggestions = getAutocompleteSuggestions(
      query,
      query.length,
      ["google-messages"],
      [],
    );

    expect(suggestions).toEqual([{
      type: "value",
      value: "source:google-messages",
      description: "Source: Google Messages",
      insertText: "source:google-messages",
      replaceFrom: "notes ".length,
    }]);
    expect(applySuggestion(query, query.length, suggestions[0])).toEqual({
      newQuery: "notes source:google-messages ",
      newCursorPosition: "notes source:google-messages ".length,
    });
  });
});

describe("removeFilter", () => {
  it("removes specific filter value", () => {
    const result = removeFilter(
      "source:discord source:spotify test",
      "source",
      "discord"
    );
    expect(result).toBe("source:spotify test");
  });

  it("removes all instances of filter type", () => {
    const result = removeFilter("source:discord source:spotify test", "source");
    expect(result).toBe("test");
  });

  it("handles quoted values", () => {
    const result = removeFilter('chat:"team discussion" hello', "chat", "team discussion");
    expect(result).toBe("hello");
  });

  it("preserves other filters when removing one", () => {
    const result = removeFilter(
      "source:discord type:message from:alice",
      "type",
      "message"
    );
    expect(result).toBe("source:discord from:alice");
  });
});
