import { describe, it, expect } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { Markdown, sanitizeLinkUri } from "./Markdown";

describe("sanitizeLinkUri", () => {
  it("allows http links", () => {
    expect(sanitizeLinkUri("http://example.com")).toBe("http://example.com");
  });

  it("allows https links", () => {
    expect(sanitizeLinkUri("https://example.com/path?q=1")).toBe("https://example.com/path?q=1");
  });

  it("allows mailto links", () => {
    expect(sanitizeLinkUri("mailto:alice@example.com")).toBe("mailto:alice@example.com");
  });

  it("allows tel links", () => {
    expect(sanitizeLinkUri("tel:+12025550123")).toBe("tel:+12025550123");
  });

  it("allows root-relative URLs", () => {
    expect(sanitizeLinkUri("/foo/bar")).toBe("/foo/bar");
  });

  it("allows hash URLs", () => {
    expect(sanitizeLinkUri("#section")).toBe("#section");
  });

  it("blocks protocol-relative URLs", () => {
    expect(sanitizeLinkUri("//attacker.example")).toBe("");
  });

  it("blocks other relative URLs (no use case in AI summaries)", () => {
    expect(sanitizeLinkUri("./page")).toBe("");
    expect(sanitizeLinkUri("../page")).toBe("");
    expect(sanitizeLinkUri("page")).toBe("");
    expect(sanitizeLinkUri("?q=1")).toBe("");
  });

  it("blocks javascript: URIs", () => {
    expect(sanitizeLinkUri("javascript:alert(1)")).toBe("");
  });

  it("blocks javascript: with mixed case", () => {
    expect(sanitizeLinkUri("JavaScript:alert(1)")).toBe("");
  });

  it("blocks data: URIs", () => {
    expect(sanitizeLinkUri("data:text/html,<script>alert(1)</script>")).toBe("");
  });

  it("blocks vbscript: URIs", () => {
    expect(sanitizeLinkUri("vbscript:MsgBox")).toBe("");
  });

  it("returns empty string for empty input", () => {
    expect(sanitizeLinkUri("")).toBe("");
  });
});

describe("Markdown", () => {
  it("preserves mounted content and focus while streaming", () => {
    const prefix = [
      "# Summary",
      "",
      "[Example](https://example.com)",
      "",
      "![Example image](https://example.com/image.png)",
      "",
      "```text",
      "A long line of example code",
      "```",
      "",
    ].join("\n");
    const [markdown, setMarkdown] = createSignal(`${prefix}The answer`);
    const { container } = render(() => <Markdown markdown={markdown()} />);
    const heading = screen.getByRole("heading", { name: "Summary" });
    const link = screen.getByRole("link", { name: "Example" });
    const image = screen.getByRole("img", { name: "Example image" });
    const code = container.querySelector("pre")!;
    const paragraph = screen.getByText("The answer");
    const text = paragraph.firstChild;
    link.focus();
    code.scrollLeft = 40;

    for (const suffix of ["The answer is", "The answer is here.", "The answer is here.\n\n- Done"]) {
      setMarkdown(`${prefix}${suffix}`);
      expect(screen.getByRole("heading", { name: "Summary" })).toBe(heading);
      expect(screen.getByRole("link", { name: "Example" })).toBe(link);
      expect(screen.getByRole("img", { name: "Example image" })).toBe(image);
      expect(container.querySelector("pre")).toBe(code);
      expect(code.scrollLeft).toBe(40);
      expect(document.activeElement).toBe(link);
      expect(screen.getByText(/^The answer/)).toBe(paragraph);
      expect(paragraph.firstChild).toBe(text);
    }
    expect(paragraph).toHaveTextContent("The answer is here.");
    expect(screen.getByRole("listitem")).toHaveTextContent("Done");
  });

  it("renders a link with target and rel attributes", async () => {
    render(() => <Markdown markdown="[Example](https://example.com)" />);
    const link = await screen.findByRole("link", { name: "Example" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveAttribute("href", "https://example.com");
  });

  it("sanitizes javascript: links", async () => {
    render(() => <Markdown markdown='[click](javascript:alert(1))' />);
    const el = await screen.findByText("click");
    expect(el.tagName).toBe("A");
    expect(el).toHaveAttribute("href", "");
  });

  it("renders GFM tables", async () => {
    const md = [
      "| Col A | Col B |",
      "| ----- | ----- |",
      "| a1    | b1    |",
      "| a2    | b2    |",
    ].join("\n");
    const { container } = render(() => <Markdown markdown={md} />);
    const table = container.querySelector("table");
    expect(table).not.toBeNull();
    const headers = container.querySelectorAll("th");
    expect(headers.length).toBe(2);
    expect(headers[0].textContent).toBe("Col A");
    const cells = container.querySelectorAll("tbody td");
    expect(cells.length).toBe(4);
    expect(cells[0].textContent).toBe("a1");
    expect(cells[3].textContent).toBe("b2");
  });

  it("renders GFM strikethrough", async () => {
    const { container } = render(() => <Markdown markdown="~~gone~~" />);
    const del = container.querySelector("del");
    expect(del).not.toBeNull();
    expect(del?.textContent).toBe("gone");
  });

  it("renders CommonMark structure, code, and whitespace", () => {
    const markdown = [
      "## Heading",
      "",
      "**Bold**",
      "*emphasis* and `inline <code>` with &amp; an entity.  ",
      "Hard break.",
      "",
      "> Quoted text",
      "",
      "3. Third",
      "   - Nested",
      "4. Fourth",
      "",
      "---",
      "",
      "```js",
      'const value = "<script>example</script>";',
      "",
      "  indented();",
      "```",
    ].join("\n");
    const { container } = render(() => <Markdown markdown={markdown} />);

    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Heading");
    expect(container.querySelector("strong")).toHaveTextContent("Bold");
    expect(container.querySelector("em")).toHaveTextContent("emphasis");
    expect(container.querySelector("p")?.textContent).toContain("Bold\nemphasis");
    expect(container.querySelector("p code")).toHaveTextContent("inline <code>");
    expect(container.querySelector("p")).toHaveTextContent("& an entity.");
    expect(container.querySelector("br")).toBeInTheDocument();
    expect(container.querySelector("blockquote")).toHaveTextContent("Quoted text");
    expect(container.querySelector("ol")).toHaveAttribute("start", "3");
    expect(container.querySelector("ol ul li")).toHaveTextContent("Nested");
    expect(screen.getByRole("separator")).toBeInTheDocument();
    expect(container.querySelector("pre code")).toHaveClass("language-js");
    expect(container.querySelector("pre code")?.textContent).toBe(
      'const value = "<script>example</script>";\n\n  indented();\n',
    );
    expect(container.querySelector("script")).toBeNull();
  });

  it("discards raw HTML while retaining surrounding Markdown", () => {
    const markdown = [
      '<script>alert("example")</script>',
      "",
      '<iframe src="https://example.com"></iframe>',
      "",
      'Before <span onclick="alert(1)">inline **content**</span> after.',
      "",
      '<img src="invalid" onerror="alert(1)">',
      "",
      "<!-- hidden comment -->",
      "",
      "**Visible**",
    ].join("\n");
    const { container } = render(() => <Markdown markdown={markdown} />);
    expect(container.querySelector("script, iframe, span, img, [onclick], [onerror]")).toBeNull();
    expect(container).toHaveTextContent("Before inline content after.");
    expect(container).toHaveTextContent("Visible");
    expect(container).not.toHaveTextContent("alert");
    expect(container).not.toHaveTextContent("hidden comment");
  });

  it("renders GFM autolinks and accessible footnotes", () => {
    const { container } = render(() => (
      <Markdown markdown={"Visit https://example.com or alice@example.com.[^note]\n\n[^note]: A footnote."} />
    ));
    expect(screen.getByRole("link", { name: "https://example.com" })).toHaveAttribute("href", "https://example.com");
    expect(screen.getByRole("link", { name: "alice@example.com" })).toHaveAttribute("href", "mailto:alice@example.com");
    const reference = screen.getByRole("link", { name: "1" });
    const heading = screen.getByRole("heading", { name: "Footnotes" });
    expect(reference).toHaveAttribute("data-footnote-ref");
    expect(reference).toHaveAttribute("aria-describedby", heading.id);
    expect(heading).toHaveClass("sr-only");
    expect(container.querySelector(reference.getAttribute("href")!)).toHaveTextContent("A footnote.");
    const backReference = screen.getByRole("link", { name: "Back to reference 1" });
    expect(backReference).toHaveClass("data-footnote-backref");
    expect(backReference).toHaveAttribute("href", `#${reference.id}`);
  });

  it("renders and updates disabled GFM task checkboxes", () => {
    const [markdown, setMarkdown] = createSignal("- [x] Finished\n- [ ] Pending");
    const { container } = render(() => <Markdown markdown={markdown()} />);
    const checkboxes = screen.getAllByRole("checkbox");
    expect(container.querySelector("ul")).toHaveClass("contains-task-list");
    expect(container.querySelectorAll("li.task-list-item")).toHaveLength(2);
    expect(checkboxes[0]).toBeChecked();
    expect(checkboxes[1]).not.toBeChecked();
    for (const checkbox of checkboxes) expect(checkbox).toBeDisabled();

    setMarkdown("- [ ] Finished\n- [x] Pending");
    expect(screen.getAllByRole("checkbox")[0]).toBe(checkboxes[0]);
    expect(checkboxes[0]).not.toBeChecked();
    expect(checkboxes[1]).toBeChecked();
    expect(checkboxes[0]).toBeDisabled();
  });

  it("updates and removes link and image attributes without replacing the elements", () => {
    const [markdown, setMarkdown] = createSignal(
      '[Example](https://example.com/first "First link")\n\n![First image](/first.png "First image title")',
    );
    render(() => <Markdown markdown={markdown()} />);
    const link = screen.getByRole("link", { name: "Example" });
    const image = screen.getByRole("img", { name: "First image" });
    expect(link).toHaveAttribute("title", "First link");
    expect(image).toHaveAttribute("title", "First image title");

    setMarkdown("[Example](/second)\n\n![Second image](https://example.com/second.png)");
    expect(screen.getByRole("link", { name: "Example" })).toBe(link);
    expect(link).toHaveAttribute("href", "/second");
    expect(link).not.toHaveAttribute("title");
    expect(screen.getByRole("img", { name: "Second image" })).toBe(image);
    expect(image).toHaveAttribute("src", "https://example.com/second.png");
    expect(image).not.toHaveAttribute("title");

    setMarkdown("[Example](javascript:alert(1))\n\n![Second image](/second.png)");
    expect(link).toHaveAttribute("href", "");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("updates GFM table alignment and removes it when no longer present", () => {
    const [markdown, setMarkdown] = createSignal("| A | B | C |\n| :--- | :---: | ---: |\n| a | b | c |");
    const { container } = render(() => <Markdown markdown={markdown()} />);
    const headers = screen.getAllByRole("columnheader");
    for (const [index, align] of ["left", "center", "right"].entries()) {
      expect(headers[index]).toHaveStyle({ "text-align": align });
      expect(screen.getAllByRole("cell")[index]).toHaveStyle({ "text-align": align });
    }

    setMarkdown("| A | B | C |\n| --- | --- | --- |\n| a | b | c |");
    expect(screen.getAllByRole("columnheader")[0]).toBe(headers[0]);
    for (const cell of container.querySelectorAll<HTMLElement>("th, td")) {
      expect(cell.style.textAlign).toBe("");
    }
  });

  it("handles partial Markdown, changes of node type, and clearing content", () => {
    const [markdown, setMarkdown] = createSignal("");
    const { container } = render(() => <Markdown markdown={markdown()} />);
    const wrapper = container.firstElementChild;
    expect(wrapper).toBeEmptyDOMElement();

    setMarkdown("**Streaming");
    expect(container.querySelector("strong")).toBeNull();
    expect(container).toHaveTextContent("**Streaming");
    setMarkdown("**Streaming**");
    expect(container.querySelector("strong")).toHaveTextContent("Streaming");
    setMarkdown("Plain text");
    expect(container.querySelector("strong")).toBeNull();
    expect(container).toHaveTextContent("Plain text");
    setMarkdown("# Heading");
    expect(container.querySelector("p")).toBeNull();
    expect(screen.getByRole("heading")).toHaveTextContent("Heading");
    setMarkdown("```js\nconst value = 1;");
    expect(screen.queryByRole("heading")).toBeNull();
    const code = container.querySelector("pre code");
    expect(code).toHaveClass("language-js");
    setMarkdown("```\nconst value = 2;\n```");
    expect(container.querySelector("pre code")).toBe(code);
    expect(code).not.toHaveAttribute("class");
    expect(code).toHaveTextContent("const value = 2;");
    setMarkdown("");
    expect(container.firstElementChild).toBe(wrapper);
    expect(wrapper).toBeEmptyDOMElement();
  });

  it("resolves reference links as their definitions arrive", () => {
    const [markdown, setMarkdown] = createSignal("[Example][ref]");
    render(() => <Markdown markdown={markdown()} />);
    expect(screen.queryByRole("link")).toBeNull();
    setMarkdown("[Example][ref]\n\n[ref]: https://example.com");
    expect(screen.getByRole("link", { name: "Example" })).toHaveAttribute("href", "https://example.com");
    setMarkdown("[Example][ref]");
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("[Example][ref]")).toBeInTheDocument();
  });

  it("keeps Markdown instances independent and the wrapper class reactive", () => {
    const [markdown, setMarkdown] = createSignal("First");
    const [className, setClassName] = createSignal<string | undefined>("prose");
    const { container } = render(() => (
      <>
        <Markdown markdown={markdown()} class={className()} />
        <Markdown markdown="Second" />
      </>
    ));
    const wrapper = container.firstElementChild;
    const second = screen.getByText("Second");
    expect(wrapper).toHaveClass("prose");
    setClassName("compact");
    setMarkdown("Updated");
    expect(container.firstElementChild).toBe(wrapper);
    expect(wrapper).toHaveClass("compact");
    expect(wrapper).toHaveTextContent("Updated");
    expect(screen.getByText("Second")).toBe(second);
    setClassName(undefined);
    expect(wrapper).not.toHaveAttribute("class");
  });
});
