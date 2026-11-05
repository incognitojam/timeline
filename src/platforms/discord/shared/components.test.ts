import { describe, expect, test } from "bun:test";
import {
  getDiscordComponentsText,
  getDiscordMessageComponents,
  parseDiscordComponents,
} from "./components";

const media = { url: "https://example.com/a.png", proxy_url: "https://proxy.example.com/a.png", width: 10 };

describe("parseDiscordComponents", () => {
  test("parses the Container > Section > Text Display + Thumbnail shape", () => {
    expect(parseDiscordComponents([
      {
        type: 17,
        id: 1,
        accent_color: 0x112233,
        spoiler: false,
        components: [
          {
            type: 9,
            id: 2,
            components: [{ type: 10, id: 3, content: "### Hello" }],
            accessory: { type: 11, id: 4, media, description: "Alt", spoiler: false },
          },
        ],
      },
    ])).toEqual([
      {
        kind: "container",
        accentColor: 0x112233,
        spoiler: false,
        components: [
          {
            kind: "section",
            components: [{ kind: "text", content: "### Hello" }],
            accessory: {
              kind: "thumbnail",
              media: { url: media.url, proxy_url: media.proxy_url, content_type: undefined },
              description: "Alt",
              spoiler: false,
            },
          },
        ],
      },
    ]);
  });

  test("keeps unknown types and malformed known types as unknown, without throwing", () => {
    expect(parseDiscordComponents([
      null,
      "text",
      { type: 99, content: "ignored" },
      { type: "10", content: "ignored" },
      { type: 10 },
      { type: 11, media: {} },
      { type: 12, items: "nope" },
      { type: 12, items: [{ media: null }] },
      { type: 13, file: { url: "https://example.com/f" } },
    ])).toEqual([
      { kind: "unknown", type: 99 },
      { kind: "unknown", type: null },
      { kind: "unknown", type: 10 },
      { kind: "unknown", type: 11 },
      { kind: "unknown", type: 12 },
      { kind: "unknown", type: 12 },
      { kind: "unknown", type: 13 },
    ]);
    expect(parseDiscordComponents("nope")).toEqual([]);
    expect(parseDiscordComponents(undefined)).toEqual([]);
  });

  test("defaults a separator to a small divider, per Discord's spec", () => {
    expect(parseDiscordComponents([{ type: 14 }, { type: 14, divider: false, spacing: 2 }])).toEqual([
      { kind: "separator", divider: true, large: false },
      { kind: "separator", divider: false, large: true },
    ]);
  });
});

describe("getDiscordComponentsText", () => {
  test("reads nested Text Displays in order and ignores buttons and media", () => {
    expect(getDiscordComponentsText({
      components: [
        { type: 10, content: "First" },
        {
          type: 17,
          components: [
            { type: 9, components: [{ type: 10, content: " Second " }], accessory: { type: 2, label: "Button" } },
            { type: 12, items: [{ media, description: "Not text" }] },
            { type: 10, content: "   " },
          ],
        },
        { type: 1, components: [{ type: 2, label: "Legacy button" }] },
      ],
    })).toBe("First\nSecond");
  });

  test("returns null for legacy action rows, invalid JSON and missing components", () => {
    expect(getDiscordComponentsText({ components: [{ type: 1, components: [{ type: 2, label: "Go" }] }] })).toBeNull();
    expect(getDiscordComponentsText("{not json")).toBeNull();
    expect(getDiscordComponentsText({})).toBeNull();
  });

  test("includes components from a forwarded snapshot", () => {
    const raw = JSON.stringify({
      components: [],
      message_snapshots: [{ message: { content: "", components: [{ type: 10, content: "Forwarded card" }] } }],
    });
    expect(getDiscordMessageComponents(raw)).toEqual([{ kind: "text", content: "Forwarded card" }]);
    expect(getDiscordComponentsText(raw)).toBe("Forwarded card");
  });
});
