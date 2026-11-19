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

  it("keeps the text of a javascript: link as plain text", async () => {
    const { container } = render(() => <Markdown markdown='[click](javascript:alert(1))' />);
    await screen.findByText("click");
    expect(container.querySelector("a")).toBeNull();
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
    expect(reference).toHaveAttribute("data-footnote-ref");
    expect(reference).not.toHaveAttribute("target");
    expect(container.querySelector(reference.getAttribute("href")!)).toHaveTextContent("A footnote.");
    const backReference = screen.getByRole("link", { name: "Back to reference 1" });
    expect(backReference).toHaveAttribute("href", `#${reference.id}`);
    expect(screen.getByRole("heading", { name: "Footnotes" })).toHaveClass("sr-only");
  });

  it("numbers the back-links of a footnote referenced more than once", () => {
    render(() => <Markdown markdown={"One[^n] and two[^n].\n\n[^n]: Shared."} />);
    const [first, second] = screen.getAllByRole("link", { name: "1" });
    expect(screen.getByRole("link", { name: "Back to reference 1" })).toHaveAttribute("href", `#${first.id}`);
    const secondBack = screen.getByRole("link", { name: "Back to reference 1-2" });
    expect(secondBack).toHaveAttribute("href", `#${second.id}`);
    expect(secondBack.querySelector("sup")).toHaveTextContent("2");
  });

  it("keeps footnote ids unique across instances", () => {
    const markdown = "Claim.[^1]\n\n[^1]: Source.";
    const { container } = render(() => (
      <>
        <Markdown markdown={markdown} />
        <Markdown markdown={markdown} />
      </>
    ));
    const [first, second] = screen.getAllByRole("link", { name: "1" });
    expect(first.id).not.toBe(second.id);
    expect(container.querySelector(first.getAttribute("href")!)?.closest("[data-markdown=root]")).toBe(
      container.firstElementChild,
    );
  });

  it("renders and updates disabled GFM task checkboxes", () => {
    const [markdown, setMarkdown] = createSignal("- [x] Finished\n- [ ] Pending");
    const { container } = render(() => <Markdown markdown={markdown()} />);
    const checkboxes = screen.getAllByRole("checkbox");
    expect(container.querySelectorAll("li")).toHaveLength(2);
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
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Example").tagName).toBe("P");
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

// Every caller renders untrusted text from other people and from LLMs through this component.
const HOSTILE: Record<string, string> = {
  "inline script": "Hello <script>alert(1)</script> world",
  "block script": "<script>\nalert(1)\n</script>\n\nafter",
  "inline img onerror": "x <img src=x onerror=alert(1)> y",
  "block img onerror": '<img src="x" onerror="alert(1)">',
  iframe: '<iframe src="https://evil.example"></iframe>',
  "block with handler": '<div onclick="alert(1)">click</div>',
  "inline handler": 'a <span onmouseover="alert(1)">b</span> c',
  "style block": "<style>body{display:none}</style>\n\ntext",
  "style attribute": 'a <span style="position:fixed;inset:0">x</span>',
  svg: "<svg onload=alert(1)><script>alert(1)</script></svg>",
  "html comment": "<!-- <img src=x onerror=alert(1)> -->",
  "javascript link": "[x](javascript:alert(1))",
  "mixed-case javascript link": "[x](JaVaScRiPt:alert(1))",
  "entity-encoded javascript link": "[x](javascript&#58;alert(1))",
  "javascript reference link": "[x][r]\n\n[r]: javascript:alert(1)",
  "javascript autolink": "<javascript:alert(1)>",
  "data link": "[x](data:text/html,<script>alert(1)</script>)",
  "vbscript link": "[x](vbscript:msgbox)",
  "protocol-relative link": "[x](//evil.example)",
  "javascript image": "![x](javascript:alert(1))",
  "data image": "![x](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)",
  "protocol-relative image": "![x](//evil.example/a.png)",
  "quote break in href": '[x](https://a.example/"onmouseover="alert(1))',
  "quote break in title": '[x](https://a.example "t\\" onmouseover=alert(1) x")',
  "html in fenced code": "```html\n<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n```",
  "html in inline code": "`<img src=x onerror=alert(1)>`",
};

const UNSAFE_URL = /^\s*(javascript|data|vbscript):|^\s*\/\//i;

describe("Markdown with untrusted input", () => {
  it.each(Object.entries(HOSTILE))("%s renders inert", (_name, markdown) => {
    for (const streaming of [false, true]) {
      const { container, unmount } = render(() => <Markdown markdown={markdown} streaming={streaming} />);
      expect(container.querySelector("script, iframe, style, svg, object, embed, form")).toBeNull();
      for (const element of container.querySelectorAll("*")) {
        for (const attribute of element.attributes) {
          expect(attribute.name, element.outerHTML).not.toMatch(/^on/i);
          if (attribute.name === "style") expect(element.matches("td, th"), element.outerHTML).toBe(true);
        }
      }
      for (const element of container.querySelectorAll("[href], [src]")) {
        expect(element.getAttribute("href") ?? element.getAttribute("src"), element.outerHTML).not.toMatch(UNSAFE_URL);
      }
      unmount();
    }
  });

  it("keeps HTML in code as text", () => {
    const { container } = render(() => <Markdown markdown={`${HOSTILE["html in fenced code"]}\n\n${HOSTILE["html in inline code"]}`} />);
    expect(container.querySelector("pre code")?.textContent).toBe(
      "<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n",
    );
    expect(container.querySelector("p code")?.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  // Words accepts these addresses on its own; only sanitizeLinkUri rejects them.
  it.each([
    ["ftp autolink", "<ftp://example.com/file>", "ftp://example.com/file"],
    ["bare ftp link", "ftp://example.com/file", "ftp://example.com/file"],
    ["xmpp autolink", "<xmpp:alice@example.com>", "xmpp:alice@example.com"],
    ["relative link", "[the page](./page)", "the page"],
    ["query-only link", "[search](?q=1)", "search"],
  ])("renders a %s as plain text", (_name, markdown, text) => {
    const { container } = render(() => <Markdown markdown={markdown} />);
    expect(container.querySelector("a")).toBeNull();
    expect(container).toHaveTextContent(text);
  });

  it.each([
    ["relative image", "![diagram](docs/d.png)"],
    ["ftp image", "![diagram](ftp://example.com/d.png)"],
    ["javascript image", "![diagram](javascript:alert(1))"],
  ])("shows the alt text of a rejected %s", (_name, markdown) => {
    const { container } = render(() => <Markdown markdown={`Before ${markdown} after`} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("p")?.textContent).toBe("Before diagram after");
  });

  it("keeps a link nested in a rejected link, and only that link", () => {
    const { container } = render(() => <Markdown markdown={"[see <https://example.com/x> here](./relative)"} />);
    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "https://example.com/x");
    expect(container.querySelector("p")?.textContent).toBe("see https://example.com/x here");
  });

  it("leaves no empty anchor when a rejected link contains a rejected autolink", () => {
    const { container } = render(() => <Markdown markdown={"[see <ftp://example.com/x>](./relative)"} />);
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("p")?.textContent).toBe("see ftp://example.com/x");
  });

  it("keeps a footnote reference inside a rejected link to itself", () => {
    const { container } = render(() => <Markdown markdown={"[a [^1] b](ftp://example.com)\n\n[^1]: Note."} />);
    const references = container.querySelectorAll("a[data-footnote-ref]");
    expect(references).toHaveLength(1);
    expect(references[0]).toHaveTextContent("1");
    const ids = [...container.querySelectorAll("[id]")].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(container.querySelector("p")?.textContent).toBe("a 1 b");
  });

  it("keeps a link around a rejected image readable", () => {
    render(() => <Markdown markdown={"[![preview <b>](relative.png)](https://example.com/page)"} />);
    const link = screen.getByRole("link", { name: "preview <b>" });
    expect(link).toHaveAttribute("href", "https://example.com/page");
    expect(link.querySelector("img, b")).toBeNull();
  });

  it("holds image addresses to the link rules", () => {
    render(() => <Markdown markdown={"![remote](https://example.com/a.png) ![local](/a.png) ![relative](a.png)"} />);
    expect(screen.getByRole("img", { name: "remote" })).toHaveAttribute("src", "https://example.com/a.png");
    expect(screen.getByRole("img", { name: "local" })).toHaveAttribute("src", "/a.png");
    expect(screen.queryByRole("img", { name: "relative" })).toBeNull();
    expect(screen.getByText(/relative/)).toBeInTheDocument();
  });
});

describe("Markdown while streaming", () => {
  it("keeps a text selection while content grows", () => {
    const [markdown, setMarkdown] = createSignal("# Summary\n\nThe answer");
    render(() => <Markdown markdown={markdown()} streaming />);
    const selection = document.getSelection();
    selection?.selectAllChildren(screen.getByRole("heading", { name: "Summary" }));
    for (const suffix of [" is", " is here.", " is here.\n\n- Done"]) {
      setMarkdown(`# Summary\n\nThe answer${suffix}`);
      expect(selection?.toString()).toBe("Summary");
    }
  });

  it("completes unfinished syntax only while streaming", () => {
    const [streaming, setStreaming] = createSignal(true);
    const { container } = render(() => <Markdown markdown="Partly **bold" streaming={streaming()} />);
    expect(container.querySelector("strong")).toHaveTextContent("bold");
    setStreaming(false);
    expect(container.querySelector("strong")).toBeNull();
    expect(container).toHaveTextContent("Partly **bold");
  });
});
