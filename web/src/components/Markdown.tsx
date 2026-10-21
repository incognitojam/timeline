import type { Element, Root, RootContent, Text } from "hast";
import { find, html } from "property-information";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { createComputed, createRenderEffect, For, type JSX, Match, Switch } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { Dynamic } from "solid-js/web";
import { unified } from "unified";

// Raw HTML is discarded by remark-rehype; only parser-generated elements reach the renderer.
const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype).freeze();

interface MarkdownProps {
  markdown: string;
  class?: string;
}

const ALLOWED_PROTOCOLS = /^(https?|mailto|tel):/i;
const SAFE_HREF_PATTERN = /^(#|\/(?!\/))/;

/** Sanitize link URIs — only allow http(s), mailto, tel, root-relative (/), and hash (#) URLs. */
export function sanitizeLinkUri(href: string): string {
  if (!href) return "";
  if (SAFE_HREF_PATTERN.test(href)) return href;
  if (ALLOWED_PROTOCOLS.test(href)) return href;
  return "";
}

function elementProperties(node: Element) {
  const attributes: Record<string, string | number | boolean | JSX.CSSProperties> = {};
  for (const [name, value] of Object.entries(node.properties)) {
    if (value === null || value === undefined) continue;
    const info = find(html, name);
    attributes[info.attribute] = Array.isArray(value)
      ? value.join(info.commaSeparated ? ", " : " ")
      : value;
  }

  if (node.tagName === "a") {
    attributes.href = sanitizeLinkUri(String(node.properties.href ?? ""));
    attributes.target = "_blank";
    attributes.rel = "noopener noreferrer";
  }
  if ((node.tagName === "td" || node.tagName === "th") && typeof node.properties.align === "string") {
    attributes.style = { "text-align": node.properties.align as JSX.CSSProperties["text-align"] };
    delete attributes.align;
  }
  return attributes;
}

function MarkdownElement(props: { node: Element }): JSX.Element {
  return (
    <Dynamic component={props.node.tagName as keyof JSX.IntrinsicElements} {...elementProperties(props.node)}>
      <MarkdownChildren nodes={props.node.children} />
    </Dynamic>
  );
}

function MarkdownText(props: { node: Text }): JSX.Element {
  // A stable Text node prevents array updates from moving siblings and losing focus.
  const text = document.createTextNode("");
  createRenderEffect(() => {
    text.data = props.node.value;
  });
  return text;
}

function MarkdownChildren(props: { nodes: RootContent[] }): JSX.Element {
  return (
    <For each={props.nodes}>
      {(node) => (
        <Switch>
          <Match when={node.type === "element" && node}>
            {(element) => <MarkdownElement node={element()} />}
          </Match>
          <Match when={node.type === "text" && node}>
            {(text) => <MarkdownText node={text()} />}
          </Match>
        </Switch>
      )}
    </For>
  );
}

export function Markdown(props: MarkdownProps): JSX.Element {
  const [tree, setTree] = createStore<Root>({ type: "root", children: [] });
  createComputed(() => {
    const next = processor.runSync(processor.parse(props.markdown));
    // Parser nodes have no stable keys. Merge by position to retain DOM during streaming.
    setTree(reconcile(next, { key: null, merge: true }));
  });

  return (
    <div class={props.class}>
      <MarkdownChildren nodes={tree.children} />
    </div>
  );
}
