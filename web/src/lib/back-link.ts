/**
 * Click handler for an in-page link back to a parent page ("‹ Memory"). When
 * the previous history entry is the link's target, it goes back to it, so the
 * page returns where it was left; otherwise the link navigates as usual. The
 * Navigation API reports that entry, reloads included; without it the link
 * always navigates.
 */
export function backToPrevious(event: MouseEvent & { currentTarget: HTMLAnchorElement }) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const navigation = window.navigation;
  const index = navigation?.currentEntry?.index;
  if (!navigation || index === undefined || index < 1) return;
  const previousUrl = navigation.entries()[index - 1]?.url;
  if (!previousUrl) return;
  const previous = new URL(previousUrl);
  const target = new URL(event.currentTarget.href);
  if (previous.origin !== target.origin || previous.pathname + previous.search !== target.pathname + target.search) return;
  // Runs before the router's document listener, which skips prevented clicks.
  event.preventDefault();
  window.history.back();
}
