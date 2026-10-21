import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { DiscordEmbed, type DiscordEmbedData } from "./DiscordEmbed";

describe("DiscordEmbed", () => {
  it("renders an article link preview with title, description, and banner", () => {
    const embed: DiscordEmbedData = {
      type: "article",
      url: "https://example.com/article",
      title: "Example Article",
      description: "An interesting piece about something.",
      provider: { name: "Example" },
      image: {
        url: "https://example.com/banner.jpg",
        proxy_url: "https://images-ext-1.discordapp.net/proxy/banner.jpg",
        width: 1200,
        height: 630,
      },
    };

    const { getByText, container } = render(() => <DiscordEmbed embed={embed} />);
    expect(getByText("Example Article")).toBeInTheDocument();
    expect(getByText("An interesting piece about something.")).toBeInTheDocument();
    expect(getByText("Example")).toBeInTheDocument();
    // Banner image prefers proxy_url
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", "https://images-ext-1.discordapp.net/proxy/banner.jpg");
    // Title link points to article url and opens in new tab
    const link = getByText("Example Article").closest("a");
    expect(link).toHaveAttribute("href", "https://example.com/article");
    expect(link).toHaveAttribute("target", "_blank");
    // No play-overlay SVG for non-video embeds (the overlay is rendered as an
    // inline SVG element, not a ▶ character).
    expect(container.querySelector("svg")).toBeNull();
  });

  it("renders a video embed with a play overlay on top of the thumbnail", () => {
    const embed: DiscordEmbedData = {
      type: "video",
      url: "https://youtube.com/watch?v=abc",
      title: "A video",
      provider: { name: "YouTube" },
      thumbnail: {
        url: "https://i.ytimg.com/vi/abc/hq.jpg",
        proxy_url: "https://images-ext-1.discordapp.net/proxy/hq.jpg",
      },
      video: { url: "https://youtube.com/embed/abc", width: 1280, height: 720 },
    };

    const { container } = render(() => <DiscordEmbed embed={embed} />);
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", "https://images-ext-1.discordapp.net/proxy/hq.jpg");
    // Play-button SVG marks this as video-like content.
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("renders a gifv embed as an autoplaying looping muted video with no card chrome", () => {
    // Shape matches what Discord attaches for Tenor/Giphy GIF links.
    const embed: DiscordEmbedData = {
      type: "gifv",
      url: "https://tenor.com/view/example-gif-123",
      provider: { name: "Tenor", url: "https://tenor.co" },
      thumbnail: {
        url: "https://media.tenor.com/abc/example.png",
        proxy_url: "https://images-ext-1.discordapp.net/proxy/example.png",
        width: 640,
        height: 360,
      },
      video: {
        url: "https://media.tenor.com/abc/example.mp4",
        proxy_url: "https://images-ext-1.discordapp.net/proxy/example.mp4",
        width: 640,
        height: 360,
      },
    };

    const { container, queryByText } = render(() => <DiscordEmbed embed={embed} />);
    const video = container.querySelector("video");
    expect(video).not.toBeNull();
    expect(video).toHaveAttribute("src", "https://images-ext-1.discordapp.net/proxy/example.mp4");
    expect(video).toHaveAttribute("poster", "https://images-ext-1.discordapp.net/proxy/example.png");
    expect(video?.autoplay).toBe(true);
    expect(video?.loop).toBe(true);
    // jsdom doesn't propagate the parsed `muted` content attribute into the IDL
    // property the way browsers do, so assert the attribute.
    expect(video).toHaveAttribute("muted");
    // No card chrome or play overlay — the gif plays inline like an image.
    expect(queryByText("Tenor")).toBeNull();
    expect(container.querySelector("svg")).toBeNull();
  });

  it("falls back to the thumbnail card when a gifv embed has no video url", () => {
    const embed: DiscordEmbedData = {
      type: "gifv",
      url: "https://tenor.com/view/example-gif-123",
      provider: { name: "Tenor" },
      thumbnail: { url: "https://media.tenor.com/abc/example.png" },
    };

    const { container } = render(() => <DiscordEmbed embed={embed} />);
    expect(container.querySelector("video")).toBeNull();
    const img = container.querySelector("img");
    expect(img).toHaveAttribute("src", "https://media.tenor.com/abc/example.png");
    // Play-button overlay marks it as video-like content.
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("renders a rich embed with color stripe, author, fields, and footer", () => {
    const embed: DiscordEmbedData = {
      type: "rich",
      url: "https://twitter.com/tester/status/123",
      description: "Just tweeting into the void",
      color: 0x1da1f2,
      author: {
        name: "Tester (@tester)",
        url: "https://twitter.com/tester",
        icon_url: "https://pbs.twimg.com/avatar.jpg",
        proxy_icon_url: "https://images-ext-1.discordapp.net/proxy/avatar.jpg",
      },
      fields: [
        { name: "Likes", value: "42", inline: true },
        { name: "Retweets", value: "7", inline: true },
      ],
      footer: { text: "Twitter" },
      timestamp: "2026-04-15T21:54:00Z",
    };

    const { getByText, container } = render(() => <DiscordEmbed embed={embed} />);
    expect(getByText("Tester (@tester)")).toBeInTheDocument();
    expect(getByText("Just tweeting into the void")).toBeInTheDocument();
    expect(getByText("Likes")).toBeInTheDocument();
    expect(getByText("42")).toBeInTheDocument();
    expect(getByText("Retweets")).toBeInTheDocument();
    expect(getByText("Twitter")).toBeInTheDocument();

    // Author name is bold
    const authorEl = getByText("Tester (@tester)");
    expect(authorEl.className).toMatch(/\bfont-semibold\b/);

    // Timestamp rendered next to footer text, separated by a middot
    expect(container.textContent ?? "").toMatch(/Twitter\s*·\s*\d{2}\/\d{2}\/\d{4}/);

    // Color stripe rendered as a left border on the outer card
    const card = container.firstElementChild as HTMLElement | null;
    // jsdom normalizes hex to rgb in inline style attributes.
    expect(card?.getAttribute("style") ?? "").toMatch(
      /border-left:\s*4px solid (#1da1f2|rgb\(29,\s*161,\s*242\))/i
    );
  });

  it("renders a pure image embed as a linked image with no card chrome", () => {
    const embed: DiscordEmbedData = {
      type: "image",
      url: "https://gyazo.com/abc",
      title: "Gyazo",
      thumbnail: {
        url: "https://i.gyazo.com/thumb/abc.jpg",
        proxy_url: "https://images-ext-1.discordapp.net/proxy/abc.jpg",
      },
    };

    const { container, queryByText } = render(() => <DiscordEmbed embed={embed} />);
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", "https://images-ext-1.discordapp.net/proxy/abc.jpg");
    // No title/description/card — "Gyazo" provider name shouldn't appear for a bare image share.
    expect(queryByText("Gyazo")).toBeNull();
  });

  it("falls back to origin url when proxy_url is missing", () => {
    const embed: DiscordEmbedData = {
      type: "link",
      url: "https://example.com",
      title: "No proxy",
      thumbnail: { url: "https://example.com/thumb.png" },
    };

    const { container } = render(() => <DiscordEmbed embed={embed} />);
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", "https://example.com/thumb.png");
  });

  it("drops unsafe link URLs (e.g. javascript:)", () => {
    const embed: DiscordEmbedData = {
      type: "link",
      url: "javascript:alert(1)",
      title: "Dangerous",
    };

    const { getByText } = render(() => <DiscordEmbed embed={embed} />);
    // Title still renders, but without a link wrapper since the href was unsafe.
    const title = getByText("Dangerous");
    expect(title.closest("a")).toBeNull();
  });

  it("renders a poll_result embed as a poll-closed card, not generic fields", () => {
    // Field set matches what Discord attaches to type-46 poll result messages.
    const embed: DiscordEmbedData = {
      type: "poll_result",
      fields: [
        { name: "poll_question_text", value: "pineapple on pizza", inline: false },
        { name: "victor_answer_votes", value: "3", inline: false },
        { name: "total_votes", value: "4", inline: false },
        { name: "victor_answer_id", value: "1", inline: false },
        { name: "victor_answer_text", value: "yes", inline: false },
        { name: "victor_answer_emoji_name", value: "🔴", inline: false },
      ],
    };

    const { getByText, queryByText } = render(() => <DiscordEmbed embed={embed} />);
    expect(getByText("pineapple on pizza")).toBeInTheDocument();
    expect(getByText("has closed.", { exact: false })).toBeInTheDocument();
    expect(getByText("yes")).toBeInTheDocument();
    expect(getByText("🔴")).toBeInTheDocument();
    expect(getByText("3 of 4 votes (75%)", { exact: false })).toBeInTheDocument();
    // Raw field names must not leak into the UI.
    expect(queryByText("victor_answer_text")).not.toBeInTheDocument();
    expect(queryByText("poll_question_text")).not.toBeInTheDocument();
  });

  it("renders a poll_result embed with no winner", () => {
    const embed: DiscordEmbedData = {
      type: "poll_result",
      fields: [
        { name: "poll_question_text", value: "anyone?", inline: false },
        { name: "total_votes", value: "0", inline: false },
      ],
    };

    const { getByText } = render(() => <DiscordEmbed embed={embed} />);
    expect(getByText("anyone?")).toBeInTheDocument();
    expect(getByText("No winning answer · 0 votes")).toBeInTheDocument();
  });
});
