import { createDomRenderer, createHtmlRenderer, type HtmlOptions } from "@pierre/words/html";
import { createRenderEffect, type JSX, onCleanup } from "solid-js";

interface MarkdownProps {
  markdown: string;
  class?: string;
  /** Text is still arriving: complete unfinished syntax and patch only the open block. */
  streaming?: boolean;
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

// Words' DOM renderer never emits raw HTML from the source. Every link and
// image address must also pass sanitizeLinkUri. A rejected image keeps a
// marker address so `finish` can show its alt text in its place; a rejected
// link loses its href and `finish` unwraps it to plain text.
const REJECTED_IMAGE = "#md-rejected-image";
const baseOptions: HtmlOptions = {
  controls: false,
  lineNumbers: false,
  urlTransform: (url, key) => sanitizeLinkUri(url) || (key === "src" ? REJECTED_IMAGE : null),
};

const REJECTED_IMAGE_TAG = new RegExp(`<img data-markdown="img" src="${REJECTED_IMAGE}"(?: alt="([^"]*)")?[^>]*>`, "g");

/** Drop each link Words left without an href, keeping its content, including nested links. */
function unwrapRejectedLinks(html: string): string {
  const dropped: boolean[] = [];
  return html.replace(/<a\b[^>]*>|<\/a>/g, (tag) => {
    if (tag === "</a>") return dropped.pop() ? "" : tag;
    const drop = tag.startsWith('<a data-markdown="a"') && !tag.includes(' href="');
    dropped.push(drop);
    return drop ? "" : tag;
  });
}

/**
 * Final touches on the HTML Words formats, applied before it reaches the DOM so
 * that Words patches it like its own output. A `components` hook could do some
 * of this, but any hook turns off Words' line-by-line patching of a code block
 * that is still streaming. Alt text arrives escaped; `<` is escaped again in
 * case that ever changes.
 */
const finish = (html: string) =>
  unwrapRejectedLinks(html.replace(REJECTED_IMAGE_TAG, (_, alt = "") => alt.replace(/</g, "&lt;")))
    .replace(/<a data-markdown="a"(?= href="(?!#))/g, '<a data-markdown="a" target="_blank" rel="noopener noreferrer"')
    .replace(/(data-footnote-backref-idx="[^"]*-(\d+)"[^>]*>↩)<\/a>/g, "$1<sup>$2</sup></a>")
    .replace(/(<section data-markdown="section" class="footnotes" data-footnotes>)/g, '$1<h2 class="sr-only">Footnotes</h2>');

// The `formatter` argument of createDomRenderer: Words' own formatter, with
// `finish` applied to each piece of HTML the DOM renderer reads.
function finishingFormatter(options: HtmlOptions) {
  const formatter = createHtmlRenderer(options);
  return {
    configure: formatter.configure,
    dispose: formatter.dispose,
    render(source: string, incomplete: boolean, active?: boolean) {
      const update = formatter.render(source, incomplete, active);
      return {
        revision: update.revision,
        reset: update.reset,
        code: update.code,
        get stable() {
          return finish(update.stable);
        },
        get addition() {
          return finish(update.addition);
        },
        get pending() {
          return finish(update.pending);
        },
      };
    },
  };
}

let instances = 0;

export function Markdown(props: MarkdownProps): JSX.Element {
  const root = (<div class={props.class} />) as HTMLDivElement;
  // Footnote ids must not collide between messages on the same page.
  const instanceOptions = { ...baseOptions, idPrefix: `md${++instances}-` };
  const renderer = createDomRenderer(root, instanceOptions, finishingFormatter(instanceOptions));
  createRenderEffect(() => {
    const streaming = props.streaming === true;
    renderer.update(props.markdown, streaming, streaming);
  });
  onCleanup(() => renderer.disconnect());
  return root;
}
