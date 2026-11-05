import { render, screen } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { DiscordForwardedMessage } from "./DiscordForwardedMessage";

describe("DiscordForwardedMessage", () => {
  it("labels and groups forwarded content", () => {
    render(() => (
      <DiscordForwardedMessage forwarded source={null}>
        <span>Original message</span>
      </DiscordForwardedMessage>
    ));

    const group = screen.getByRole("group", { name: "Forwarded message" });
    expect(group).toHaveTextContent("Forwarded");
    expect(group).toHaveTextContent("Original message");
    expect(group).toHaveClass("border-l-2");
  });

  it("links the source footer to the original Timeline message", () => {
    render(() => (
      <DiscordForwardedMessage
        forwarded
        source={{
          url: "/conversation/discord/original-thread#event-42",
          name: "Example Server",
          iconUrl: null,
          timestamp: "2024-06-12T08:00:00Z",
        }}
      >
        <span>Original message</span>
      </DiscordForwardedMessage>
    ));

    const link = screen.getByRole("link", {
      name: "View original message from Example Server in Timeline",
    });
    expect(link).toHaveAttribute("href", "/conversation/discord/original-thread#event-42");
    expect(link).toHaveTextContent("Example Server");
    expect(link).not.toHaveTextContent("Forwarded");
    expect(link.querySelector("time")).toHaveAttribute("datetime", "2024-06-12T08:00:00Z");
  });

  it("leaves ordinary message content unlabelled", () => {
    render(() => (
      <DiscordForwardedMessage forwarded={false} source={null}>
        <span>Ordinary message</span>
      </DiscordForwardedMessage>
    ));

    expect(screen.queryByText("Forwarded")).not.toBeInTheDocument();
    expect(screen.getByText("Ordinary message")).toBeInTheDocument();
  });
});
