import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router";
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiscordServerDetail } from "../lib/api";
import DiscordServerView from "./DiscordServerView";

vi.mock("../lib/echarts-theme", () => ({
  useChartTheme: () => ({ option: (option: unknown) => option }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DiscordServerView", () => {
  it("identifies threads in channel link names", async () => {
    const detail: DiscordServerDetail = {
      guildId: "guild-1",
      name: "Example server",
      iconUrl: null,
      channelCount: 2,
      messageCount: 2,
      firstMessage: null,
      lastMessage: null,
      categories: [
        {
          name: "General",
          messageCount: 2,
          channels: [
            {
              conversationId: "channel-1",
              name: "announcements",
              title: "announcements",
              lastEventId: 1,
              isThread: false,
              messageCount: 1,
              lastMessage: null,
            },
            {
              conversationId: "thread-1",
              name: "release discussion",
              title: "release discussion",
              lastEventId: 2,
              isThread: true,
              messageCount: 1,
              lastMessage: null,
            },
          ],
        },
      ],
      participants: [],
      activityByMonth: [],
      emojiCount: 0,
      emojiUploaders: [],
    };
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json(detail)));
    const history = createMemoryHistory();
    history.set({ value: "/server/discord/guild-1", replace: true });

    const view = render(() => (
      <MemoryRouter history={history}>
        <Route path="/server/:source/:id" component={DiscordServerView} />
      </MemoryRouter>
    ));

    expect(
      await view.findByRole("link", { name: /Thread\s*release discussion/ }),
    ).toBeInTheDocument();
    expect(view.getByRole("link", { name: /^announcements/ })).toBeInTheDocument();
  });
});
