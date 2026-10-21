import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { DiscordReplyPreview } from "./DiscordReplyPreview";
import type { ReplyTarget } from "../../lib/conversation";

const resolvedReply: ReplyTarget = {
  url: "/conversation/discord/thread-1#event-42",
  eventId: 42,
  conversationId: "thread-1",
  authorName: "Alice",
  content: "The original message",
  hasAttachment: false,
};

describe("DiscordReplyPreview", () => {
  it("renders the author and a truncated preview of a resolved reply", () => {
    render(() => <DiscordReplyPreview reply={resolvedReply} />);

    const link = screen.getByRole("link", {
      name: "Replying to Alice — jump to the original message",
    });
    expect(link).toHaveAttribute("href", "/conversation/discord/thread-1#event-42");
    expect(link).toHaveTextContent("Alice");
    expect(link).toHaveTextContent("The original message");
  });

  it("renders custom emoji tokens as inline images inside the truncated line", () => {
    render(() => (
      <DiscordReplyPreview
        reply={{
          ...resolvedReply,
          content: "long reply text before the emoji <:blobwave:9500000000000000000> and after <a:party:9500000000000000001>",
        }}
      />
    ));

    const link = screen.getByRole("link");
    const blobwave = screen.getByAltText(":blobwave:");
    expect(blobwave).toHaveAttribute("src", "/api/discord/emoji/9500000000000000000");
    expect(screen.getByAltText(":party:")).toBeInTheDocument();
    // Raw tokens must not leak into the text, and the single-line ellipsis
    // wrapper still applies around the mixed text/emoji content.
    expect(link.textContent).not.toContain("<:blobwave:");
    expect(link).toHaveTextContent("long reply text before the emoji");
    expect(blobwave.closest(".truncate")).not.toBeNull();
  });

  it("shows an Attachment label when the reply has no text but has attachments", () => {
    render(() => (
      <DiscordReplyPreview
        reply={{ ...resolvedReply, content: null, hasAttachment: true }}
      />
    ));

    expect(screen.getByRole("link")).toHaveTextContent("Attachment");
  });

  it("suppresses navigation when onJump handles a plain click", () => {
    const onJump = vi.fn(() => true);
    render(() => (
      <DiscordReplyPreview reply={resolvedReply} onJump={onJump} />
    ));

    const link = screen.getByRole("link");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(link, event);

    expect(onJump).toHaveBeenCalledWith(resolvedReply);
    expect(event.defaultPrevented).toBe(true);
  });

  it("falls through to navigation when onJump doesn't handle the click", () => {
    const onJump = vi.fn(() => false);
    render(() => (
      <DiscordReplyPreview reply={resolvedReply} onJump={onJump} />
    ));

    const link = screen.getByRole("link");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(link, event);

    expect(onJump).toHaveBeenCalledWith(resolvedReply);
    expect(event.defaultPrevented).toBe(false);
  });

  it("keeps native link behavior for modified clicks", () => {
    const onJump = vi.fn(() => true);
    render(() => (
      <DiscordReplyPreview reply={resolvedReply} onJump={onJump} />
    ));

    const link = screen.getByRole("link");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true });
    fireEvent(link, event);

    expect(onJump).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("renders a non-clickable preview when the reply is unresolved", () => {
    render(() => (
      <DiscordReplyPreview
        reply={{
          url: null,
          eventId: null,
          conversationId: null,
          authorName: "Bob",
          content: "Ghost message",
          hasAttachment: false,
        }}
      />
    ));

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Replying to Bob")).toHaveTextContent("Ghost message");
  });
});
