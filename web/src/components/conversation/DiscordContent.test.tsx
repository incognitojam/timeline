import { fireEvent, render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import {
  formatDiscordTimestamp,
  formatDiscordTimestampTooltip,
} from "../../lib/discord-timestamps";
import { DiscordContent } from "./DiscordContent";
import { DiscordEmoji } from "./DiscordEmoji";

describe("DiscordContent", () => {
  it("renders text and custom emoji as <img> with the emoji endpoint", () => {
    const { container } = render(() => (
      <DiscordContent content="hi <:smile:111>" rawData={null} />
    ));
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", "/api/discord/emoji/111");
    expect(img).toHaveAttribute("alt", ":smile:");
    expect(img).toHaveAttribute("title", ":smile:");
  });

  it("renders animated custom emoji using the same endpoint (the API resolves the extension)", () => {
    const { container } = render(() => (
      <DiscordContent content="<a:wave:222>" rawData={null} />
    ));
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", "/api/discord/emoji/222");
    expect(img).toHaveAttribute("alt", ":wave:");
  });

  it("renders mentions and channels alongside emoji without losing other tokens", () => {
    const raw = JSON.stringify({
      mentions: [{ id: "1", name: "Alice" }],
      mention_channels: [{ id: "2", name: "general" }],
    });
    const { container, getByText } = render(() => (
      <DiscordContent content="<@1> in <#2> with <:tada:333>" rawData={raw} />
    ));
    expect(getByText("@Alice")).toBeInTheDocument();
    expect(getByText("#general")).toBeInTheDocument();
    expect(container.querySelector("img")).toHaveAttribute("src", "/api/discord/emoji/333");
  });

  it("renders a timestamp token as a <time> element with a machine-readable value", () => {
    const { container } = render(() => (
      <DiscordContent content="court on <t:1686682800:F>" rawData={null} />
    ));
    const time = container.querySelector("time");
    expect(time).not.toBeNull();
    expect(time).toHaveAttribute("datetime", "2023-06-13T19:00:00.000Z");
    expect(time?.textContent).toBe(formatDiscordTimestamp(1686682800, "F"));
    expect(time).toHaveAttribute("title", formatDiscordTimestampTooltip(1686682800));
  });
});

describe("DiscordEmoji", () => {
  it("falls back to :name: text when the image fails to load", () => {
    const { container, queryByText } = render(() => (
      <DiscordEmoji id="404" name="ghost" size="inline" />
    ));
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(queryByText(":ghost:")).toBeNull();
    fireEvent.error(img!);
    expect(container.querySelector("img")).toBeNull();
    expect(queryByText(":ghost:")).toBeInTheDocument();
  });
});
