import { useIsRouting, useMatch } from "@solidjs/router";
import { createEffect, createRenderEffect, on, onCleanup } from "solid-js";
import { DOCUMENT_SCROLL_ROUTES } from "./routes";

/**
 * Lets the shell grow and the window scroll on DOCUMENT_SCROLL_ROUTES while
 * `appShown`, by setting `data-document-scroll` on <html> (see app.css).
 */
export function useDocumentScroll(appShown: () => boolean) {
  const matches = DOCUMENT_SCROLL_ROUTES.map((path) => useMatch(() => path));
  // A render effect, so the shell switches in the same commit as the page and
  // before the router restores a Back or Forward offset.
  createRenderEffect(() => {
    document.documentElement.toggleAttribute("data-document-scroll", appShown() && matches.some((match) => match()));
  });
  onCleanup(() => document.documentElement.removeAttribute("data-document-scroll"));

  // The router's scroll restoration records an entry's offset only from scroll
  // events, and Back to an entry it has no offset for keeps the current one. A
  // scroll event as each entry settles, after any restore, records pages that
  // are left without being scrolled.
  const isRouting = useIsRouting();
  createEffect(on(isRouting, (routing) => {
    if (!routing) window.dispatchEvent(new Event("scroll"));
  }));
}
