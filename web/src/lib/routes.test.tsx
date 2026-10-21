import { Route, MemoryRouter, createMemoryHistory, useParams } from "@solidjs/router";
import { render } from "@solidjs/testing-library";
import { describe, expect, test } from "vitest";
import {
  buildConversationUrl,
  buildHealthUrl,
  buildTimelineUrl,
  MOBILE_MORE_ITEMS,
  MOBILE_NAV_ITEMS,
  navigationItemForPath,
  PRIMARY_NAV_ITEMS,
  ROUTES,
  safeDecode,
  UTILITY_NAV_ITEMS,
} from "./routes";

function ConversationParamProbe() {
  const params = useParams();
  return <div data-testid="conversation-id">{safeDecode(params.conversationId ?? "")}</div>;
}

describe("buildConversationUrl", () => {
  test("round-trips slash-bearing conversation ids through the router", () => {
    const conversationId = "inbox/alice_123456";
    const history = createMemoryHistory();
    history.set({
      value: buildConversationUrl("instagram", conversationId, 42),
      replace: true,
    });

    const { getByTestId } = render(() => (
      <MemoryRouter history={history}>
        <Route path={ROUTES.CONVERSATION} component={ConversationParamProbe} />
      </MemoryRouter>
    ));

    expect(getByTestId("conversation-id").textContent).toBe(conversationId);
  });
});

describe("buildTimelineUrl", () => {
  test("uses the root route as the timeline route", () => {
    expect(buildTimelineUrl()).toBe("/");
    expect(buildTimelineUrl({ date: "2026-07-07" })).toBe("/?date=2026-07-07");
    expect(buildTimelineUrl({ date: "2026-07-07", eventId: 42 })).toBe("/?date=2026-07-07#event-42");
  });
});

describe("buildHealthUrl", () => {
  test("preserves canonical health window state", () => {
    expect(buildHealthUrl({
      section: "activity",
      view: "month",
      mode: "recent",
      anchor: "2026-08-12",
    })).toBe("/health?section=activity&view=month&mode=recent&anchor=2026-08-12");
  });
});

describe("navigation hierarchy", () => {
  test("keeps Material navigation destination counts within their intended ranges", () => {
    expect(PRIMARY_NAV_ITEMS).toHaveLength(6);
    expect(MOBILE_NAV_ITEMS).toHaveLength(4);
    expect(MOBILE_MORE_ITEMS).toHaveLength(8);
    expect(UTILITY_NAV_ITEMS).toHaveLength(6);
  });

  test.each([
    ["/", "Timeline"],
    ["/event/42", "Timeline"],
    ["/contacts?id=1", "People"],
    ["/conversations", "Messages"],
    ["/conversation/discord/study-group", "Messages"],
    ["/servers", "Messages"],
    ["/server/discord/123", "Messages"],
    ["/search", "Search"],
    ["/health", "Health"],
    ["/coding", "Coding"],
    ["/coding/project/timeline", "Coding"],
    ["/music", "Music"],
    ["/music/playlist/focus", "Music"],
    ["/sync", "Sync"],
    ["/sync/discord", "Sync"],
    ["/settings", "Settings"],
    ["/attachments", "Attachments"],
    ["/mcp-sessions", "MCP sessions"],
    ["/mcp-sessions/session-1", "MCP sessions"],
    ["/eval", "Evaluations"],
  ])("maps %s to %s", (url, label) => {
    expect(navigationItemForPath(new URL(url, "https://example.com").pathname)?.label).toBe(label);
  });
});
