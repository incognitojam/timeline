import type { DiscordComponent } from "@platforms/discord/shared/components";
import { parseDiscordComponents } from "@platforms/discord/shared/components";
import { fireEvent, render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { DiscordComponents, splitDiscordSubtext } from "./DiscordComponents";

function renderComponents(raw: unknown[], rawData: unknown = {}) {
  const components: DiscordComponent[] = parseDiscordComponents(raw);
  return render(() => <DiscordComponents components={components} rawData={rawData} />);
}

const media = {
  url: "https://example.com/original.png",
  proxy_url: "https://proxy.example.com/thumb.png",
};

describe("DiscordComponents", () => {
  it("renders a Container with its accent, Section text and Thumbnail accessory", () => {
    const { getByRole, getByText, container } = renderComponents([
      {
        type: 17,
        accent_color: 0x123456,
        components: [
          {
            type: 9,
            components: [{ type: 10, content: "### Build passed\nAll checks **green**" }],
            accessory: { type: 11, media, description: "Status icon" },
          },
        ],
      },
    ]);

    expect(getByRole("heading", { level: 3, name: "Build passed" })).toBeInTheDocument();
    expect(getByText("green").tagName).toBe("STRONG");
    expect(getByRole("img", { name: "Status icon" })).toHaveAttribute("src", media.proxy_url);
    expect(container.querySelector("[style*='border-left']")?.getAttribute("style")).toContain("rgb(18, 52, 86)");
  });

  it("resolves mentions from raw_data and keeps Markdown links safe", () => {
    const { getByText, container } = renderComponents(
      [
        { type: 10, content: "Ping <@111>" },
        { type: 10, content: "[bad](javascript:alert(1))" },
      ],
      { mentions: [{ id: "111", name: "Alice" }] },
    );

    expect(getByText("Ping @Alice")).toBeInTheDocument();
    expect(getByText("bad")).toBeInTheDocument();
    expect(container.querySelector("a[href^='javascript']")).toBeNull();
  });

  it("shows subtext as its own muted line rather than a literal -#", () => {
    const { getByText, queryByText } = renderComponents([
      { type: 10, content: "Body\n-# Small print" },
    ]);

    expect(queryByText(/-#/)).toBeNull();
    expect(getByText("Small print").closest("div")).toHaveClass("text-muted-foreground");
    expect(splitDiscordSubtext("```\n-# code\n```")).toEqual([{ subtext: false, text: "```\n-# code\n```" }]);
  });

  it("renders buttons and selects inertly, with link buttons as real links only when safe", () => {
    const { getByText, getByRole, queryByRole } = renderComponents([
      {
        type: 1,
        components: [
          { type: 2, style: 1, label: "Approve", custom_id: "approve" },
          { type: 2, style: 5, label: "Docs", url: "https://example.com/docs" },
          { type: 2, style: 5, label: "Unsafe", url: "javascript:alert(1)" },
        ],
      },
      { type: 1, components: [{ type: 3, placeholder: "Pick one", options: [] }] },
    ]);

    expect(queryByRole("button")).toBeNull();
    expect(getByText("Approve").closest("span[title]")).toHaveAttribute("title", "Interactive only in Discord");
    expect(getByRole("link", { name: "Docs" })).toHaveAttribute("href", "https://example.com/docs");
    expect(queryByRole("link", { name: "Unsafe" })).toBeNull();
    expect(getByText("Unsafe")).toBeInTheDocument();
    expect(getByText("Pick one")).toBeInTheDocument();
  });

  it("renders a gallery, a file and a separator", () => {
    const { getAllByRole, getByRole, getByText } = renderComponents([
      {
        type: 12,
        items: [
          { media, description: "One" },
          { media: { ...media, url: "https://example.com/two.png" }, description: "Two" },
        ],
      },
      { type: 14, divider: true },
      {
        type: 13,
        file: { url: "https://example.com/notes.txt" },
        name: "notes.txt",
        size: 2048,
      },
    ]);

    expect(getAllByRole("img").map((img) => img.getAttribute("alt"))).toEqual(["One", "Two"]);
    expect(getByRole("separator")).toBeInTheDocument();
    expect(getByText("notes.txt")).toBeInTheDocument();
    expect(getByText("2.0 KB")).toBeInTheDocument();
  });

  it("swaps an image that fails to load, such as an expired URL, for a placeholder", () => {
    const { getByRole, getByText, container } = renderComponents([
      { type: 12, items: [{ media, description: "Expired photo" }] },
    ]);

    const image = container.querySelector("img");
    if (!image) throw new Error("expected an image");
    fireEvent.error(image);

    expect(container.querySelector("img")).toBeNull();
    expect(getByRole("img", { name: "Expired photo" })).toBeInTheDocument();
    expect(getByText("Image unavailable")).toBeInTheDocument();
  });

  it("conceals spoilers until they are clicked", () => {
    const { getByRole, queryByRole, container } = renderComponents([
      { type: 12, items: [{ media, description: "Secret", spoiler: true }] },
    ]);

    expect(container.querySelector(".blur-xl")).not.toBeNull();
    fireEvent.click(getByRole("button", { name: "Spoiler" }));
    expect(container.querySelector(".blur-xl")).toBeNull();
    expect(queryByRole("button", { name: "Spoiler" })).toBeNull();
  });

  it("does not crash on unknown types or malformed entries, and still renders their neighbours", () => {
    const { getAllByText, getByText } = renderComponents([
      null,
      { type: 99 },
      { type: 16, content_inventory_entry: {} },
      { id: 5 },
      {
        type: 17,
        components: [
          { type: 10 },
          { type: 9, components: "nope", accessory: { type: 98 } },
          { type: 10, content: "Still here" },
        ],
      },
    ]);

    expect(getByText("Unsupported Discord component (type 99)")).toBeInTheDocument();
    expect(getByText("Unsupported Discord component (type 16)")).toBeInTheDocument();
    expect(getByText("Unsupported Discord component (type 98)")).toBeInTheDocument();
    expect(getAllByText(/Unsupported Discord component/)).toHaveLength(5);
    expect(getByText("Still here")).toBeInTheDocument();
  });
});
