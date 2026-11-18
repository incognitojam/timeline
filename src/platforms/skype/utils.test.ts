import { describe, test, expect } from "bun:test";
import {
  parsePartlist,
  getCallDuration,
  decodeHtmlEntities,
} from "./utils";

describe("decodeHtmlEntities", () => {
  test("decodes common HTML entities", () => {
    expect(decodeHtmlEntities("Alice &quot;AE&quot; Example")).toBe(
      'Alice "AE" Example'
    );
    expect(decodeHtmlEntities("Tom &amp; Jerry")).toBe("Tom & Jerry");
    expect(decodeHtmlEntities("&lt;script&gt;")).toBe("<script>");
    expect(decodeHtmlEntities("It&apos;s working")).toBe("It's working");
  });

  test("returns null for null/undefined input", () => {
    expect(decodeHtmlEntities(null)).toBe(null);
    expect(decodeHtmlEntities(undefined)).toBe(null);
    expect(decodeHtmlEntities("")).toBe(null);
  });

  test("returns unchanged string if no entities", () => {
    expect(decodeHtmlEntities("Hello World")).toBe("Hello World");
  });
});

describe("parsePartlist", () => {
  test("parses single participant with duration", () => {
    const xml = `<partlist alt="">
      <part identity="alice.example">
        <name>Alice Example</name>
        <duration>132</duration>
      </part>
    </partlist>`;

    const result = parsePartlist(xml);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      identity: "alice.example",
      name: "Alice Example",
      duration: 132000, // 132 seconds = 132000 ms
    });
  });

  test("parses single participant without duration (missed call)", () => {
    const xml = `<partlist alt="">
      <part identity="bob.example">
        <name>bob.example</name>
      </part>
    </partlist>`;

    const result = parsePartlist(xml);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      identity: "bob.example",
      name: "bob.example",
      duration: null,
    });
  });

  test("parses multi-party call with varying durations", () => {
    const xml = `<partlist alt="">
      <part identity="user_one">
        <name>User &quot;One&quot; Test</name>
        <duration>1113</duration>
      </part>
      <part identity="user_two">
        <name>user_two</name>
        <duration>1153</duration>
      </part>
      <part identity="user_three">
        <name>User &quot;Three&quot; Test</name>
        <duration>1150</duration>
      </part>
    </partlist>`;

    const result = parsePartlist(xml);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({
      identity: "user_one",
      name: 'User "One" Test',
      duration: 1113000,
    });
    expect(result[1]).toEqual({
      identity: "user_two",
      name: "user_two",
      duration: 1153000,
    });
    expect(result[2]).toEqual({
      identity: "user_three",
      name: 'User "Three" Test',
      duration: 1150000,
    });
  });

  test("parses phone number as identity", () => {
    const xml = `<partlist alt="">
      <part identity="testuser123">
        <name>Test User</name>
        <duration>5</duration>
      </part>
      <part identity="+12025550123">
        <name>Home</name>
      </part>
    </partlist>`;

    const result = parsePartlist(xml);

    expect(result).toHaveLength(2);
    expect(result[0].identity).toBe("testuser123");
    expect(result[0].duration).toBe(5000);
    expect(result[1].identity).toBe("+12025550123");
    expect(result[1].name).toBe("Home");
    expect(result[1].duration).toBe(null);
  });

  test("handles empty/null input", () => {
    expect(parsePartlist(null)).toEqual([]);
    expect(parsePartlist(undefined)).toEqual([]);
    expect(parsePartlist("")).toEqual([]);
  });

  test("handles empty partlist", () => {
    expect(parsePartlist('<partlist alt=""></partlist>')).toEqual([]);
    expect(parsePartlist('<partlist alt="">\n</partlist>')).toEqual([]);
  });

  test("handles decimal duration", () => {
    const xml = `<partlist alt="">
      <part identity="user">
        <name>User</name>
        <duration>123.456</duration>
      </part>
    </partlist>`;

    const result = parsePartlist(xml);
    expect(result[0].duration).toBe(123456);
  });
});

describe("getCallDuration", () => {
  test("returns max duration from participants", () => {
    const participants = [
      { identity: "a", name: "A", duration: 100000 },
      { identity: "b", name: "B", duration: 150000 },
      { identity: "c", name: "C", duration: 120000 },
    ];

    expect(getCallDuration(participants)).toBe(150000);
  });

  test("returns null when no one connected", () => {
    const participants = [
      { identity: "a", name: "A", duration: null },
      { identity: "b", name: "B", duration: null },
    ];

    expect(getCallDuration(participants)).toBe(null);
  });

  test("returns duration from single connected participant", () => {
    const participants = [
      { identity: "a", name: "A", duration: 5000 },
      { identity: "b", name: "B", duration: null },
    ];

    expect(getCallDuration(participants)).toBe(5000);
  });

  test("returns null for empty participants", () => {
    expect(getCallDuration([])).toBe(null);
  });
});
