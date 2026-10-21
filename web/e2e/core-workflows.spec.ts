import { expect, test, type Page, type Route } from "@playwright/test";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import type { TimelineEvent } from "../src/lib/types";

const TEST_DATE = "2025-01-15";

test.use({ launchOptions: { args: ["--enable-unsafe-swiftshader"] } });

const summaryModel = {
  id: "example-summary",
  name: "Example Summary",
  provider: "Example",
  price: "Free",
  contextLength: 32_768,
};
const summaryMetadata = `\0${JSON.stringify({
  tokenCount: 120,
  eventCount: 0,
  model: summaryModel.id,
  cached: true,
  metadata: null,
})}`;

const summaryTest = test.extend<{ summaryResponse: ServerResponse }>({
  summaryResponse: async ({ page }, use) => {
    const browserErrors: string[] = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    // route.fulfill buffers the whole body; a local server lets the browser read
    // real HTTP chunks, with each write controlled by the test's DOM assertions.
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP test server");
      const responseReady = new Promise<ServerResponse>((resolve) => {
        server.once("request", (_request, response) => {
          response.writeHead(200, {
            "Content-Type": "text/plain; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
          });
          response.flushHeaders();
          resolve(response);
        });
      });
      const unexpectedRequests = await installApiMock(page, async (route, url) => {
        if (await fulfillTimelineReads(route, url, [])) return true;
        if (url.pathname === "/api/summary/models") {
          await route.fulfill({ json: { models: [summaryModel] } });
          return true;
        }
        if (url.pathname === `/api/day/${TEST_DATE}/summary`) {
          expect(url.searchParams.get("model")).toBe(summaryModel.id);
          await route.continue({ url: `http://127.0.0.1:${address.port}/summary` });
          return true;
        }
        return false;
      });

      await page.clock.setFixedTime(new Date(`${TEST_DATE}T12:00:00.000Z`));
      await page.goto(`/?date=${TEST_DATE}&summary=true`);
      await expect(page.getByText("Generating summary...")).toBeVisible();
      await use(await responseReady);
      expect(unexpectedRequests).toEqual([]);
      expect(browserErrors).toEqual([]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  },
});

type ApiHandler = (route: Route, url: URL) => Promise<boolean>;

const authStatus = {
  authenticated: true,
  authEnabled: false,
};

const stats = {
  total_events: 120,
  sources: [
    { source: "discord", type: "message:group", count: 120 },
    { source: "google-calendar", type: "event", count: 1 },
    { source: "manual", type: "note", count: 1 },
  ],
  date_range: { earliest: TEST_DATE, latest: TEST_DATE },
};

async function installApiMock(page: Page, handler: ApiHandler): Promise<string[]> {
  const unexpectedRequests: string[] = [];

  // Modified link clicks open tabs that need the same synthetic API as the main page.
  await page.context().route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (request.method() === "GET" && url.pathname === "/api/auth/status") {
      await route.fulfill({ json: authStatus });
      return;
    }
    if (request.method() === "GET" && url.pathname === "/api/stats") {
      await route.fulfill({ json: stats });
      return;
    }
    if (await handler(route, url)) return;

    const requestLabel = `${request.method()} ${url.pathname}${url.search}`;
    unexpectedRequests.push(requestLabel);
    await route.fulfill({
      status: 500,
      json: { error: `Unexpected browser-test request: ${requestLabel}` },
    });
  });

  return unexpectedRequests;
}

function timelineEvent(overrides: Partial<TimelineEvent> & {
  id: number;
  source: string;
  type: string;
  timestamp: string;
  title: string;
}): TimelineEvent {
  return {
    source_id: `event-${overrides.id}`,
    source_account: "example",
    end_timestamp: null,
    duration_ms: null,
    content: null,
    latitude: null,
    longitude: null,
    location_name: null,
    people: null,
    tags: null,
    raw_data: "{}",
    imported_at: overrides.timestamp,
    import_batch: "playwright-core-workflows",
    conversation_id: null,
    ...overrides,
  };
}

function dayResponse(events: TimelineEvent[]) {
  const bySource = new Map<string, number>();
  const byType = new Map<string, number>();
  for (const event of events) {
    bySource.set(event.source, (bySource.get(event.source) ?? 0) + 1);
    byType.set(event.type, (byType.get(event.type) ?? 0) + 1);
  }

  return {
    date: TEST_DATE,
    centerTimestamp: `${TEST_DATE}T12:00:00.000Z`,
    events,
    attachments: {},
    summary: {
      totalEvents: events.length,
      bySource: Array.from(bySource, ([source, count]) => ({ source, count })),
      byType: Array.from(byType, ([type, count]) => ({ type, count })),
      timeRange: {
        earliest: events[0]?.timestamp ?? null,
        latest: events.at(-1)?.timestamp ?? null,
      },
    },
  };
}

async function fulfillTimelineReads(route: Route, url: URL, events: TimelineEvent[]): Promise<boolean> {
  if (route.request().method() !== "GET") return false;

  if (url.pathname === "/api/day") {
    await route.fulfill({ json: dayResponse(events) });
    return true;
  }
  if (url.pathname === `/api/day/${TEST_DATE}/health`) {
    await route.fulfill({
      json: { healthMetrics: {}, outOfRangeCount: 0, totalMetricCount: 0 },
    });
    return true;
  }
  if (url.pathname === "/api/timeline/date-index") {
    await route.fulfill({
      json: {
        dates: events.length > 0
          ? [{ date: TEST_DATE, eventCount: events.length }]
          : [],
      },
    });
    return true;
  }
  if (url.pathname === "/api/contacts") {
    await route.fulfill({ json: { contacts: [] } });
    return true;
  }

  return false;
}

test.describe("packaged map", () => {
  test("loads its worker and displays a location marker", async ({ page }) => {
    const browserErrors: string[] = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    await page.addInitScript(() => {
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          this.addEventListener("message", () => {
            document.documentElement.dataset.workerResponded = "true";
          });
        }
      };
    });
    await page.route("https://api.maptiler.com/**", (route) => route.fulfill({
      json: {
        version: 8,
        sources: {
          fixture: {
            type: "geojson",
            data: {
              type: "FeatureCollection",
              features: [{
                type: "Feature",
                properties: {},
                geometry: { type: "Point", coordinates: [0, 0] },
              }],
            },
          },
        },
        layers: [{ id: "fixture", type: "circle", source: "fixture" }],
      },
    }));
    const unexpectedRequests = await installApiMock(page, async (route, url) => {
      if (await fulfillTimelineReads(route, url, [])) return true;
      if (url.pathname === `/api/map/day/${TEST_DATE}`) {
        await route.fulfill({ json: {
          events: [{
            id: 9_001,
            latitude: 0,
            longitude: 0,
            location_name: "Example location",
            title: "Example visit",
            type: "location:visit",
            source: "google-location",
            timestamp: `${TEST_DATE}T12:00:00.000Z`,
          }],
          count: 1,
        } });
        return true;
      }
      return false;
    });

    await page.goto(`/?date=${TEST_DATE}&map=true`);
    await expect(page.locator("html")).toHaveAttribute("data-worker-responded", "true");
    await expect(page.locator(".maplibregl-marker")).toHaveCount(1);
    await page.getByTitle("Close map", { exact: true }).click();
    await expect(page.locator(".maplibregl-canvas")).toHaveCount(0);
    expect(browserErrors).toEqual([]);
    expect(unexpectedRequests).toEqual([]);
  });
});

summaryTest("streaming Markdown preserves link focus and code scrolling", async ({ page, summaryResponse }) => {
  summaryResponse.write([
    "## Example day",
    "",
    "[Example reference](https://example.com/reference)",
    "",
    "```text",
    "A deliberately long line of example code. ".repeat(20),
    "```",
    "",
    "The answer",
  ].join("\n"));

  const markdown = page.locator(".prose");
  const link = markdown.getByRole("link", { name: "Example reference" });
  const code = markdown.locator("pre");
  const regenerate = page.getByRole("button", { name: "Regenerate", exact: true });
  await expect(markdown.getByText("The answer", { exact: true })).toBeVisible();
  await expect(regenerate).toBeDisabled();
  await expect.poll(() => code.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeGreaterThan(80);
  await code.evaluate((element) => { element.scrollLeft = 80; });
  await link.focus();
  await expect(link).toBeFocused();
  const originalLink = await link.elementHandle();
  const originalCode = await code.elementHandle();
  if (!originalLink || !originalCode) throw new Error("Expected rendered Markdown elements");

  for (const [chunk, text] of [
    [" is", "The answer is"],
    [" **arriving", "The answer is **arriving"],
    [" now**.\n\n- Done", "The answer is arriving now."],
  ]) {
    summaryResponse.write(chunk);
    await expect(markdown.getByText(text, { exact: true })).toBeVisible();
    await expect(regenerate).toBeDisabled();
    await expect(link).toBeFocused();
    expect(await link.evaluate((element, original) => element === original, originalLink)).toBe(true);
    expect(await code.evaluate((element, original) => element === original, originalCode)).toBe(true);
    await expect(code).toHaveJSProperty("scrollLeft", 80);
  }

  summaryResponse.end(summaryMetadata);
  await expect(regenerate).toBeEnabled();
  await expect(markdown.locator("strong")).toHaveText("arriving now");
  await expect(markdown.getByRole("listitem")).toHaveText("Done");
  await expect(link).toBeFocused();
  await expect(code).toHaveJSProperty("scrollLeft", 80);
});

summaryTest.describe("Markdown layout at 390px", () => {
  summaryTest.use({ viewport: { width: 390, height: 844 } });

  summaryTest("aligns tables and contains wide code", async ({ page, summaryResponse }) => {
    summaryResponse.end([
      "## Example day",
      "",
      "| Left | Centre | Right |",
      "| :--- | :---: | ---: |",
      "| Alpha | Beta | Gamma |",
      "",
      "```text",
      "A deliberately long line of example code. ".repeat(20),
      "```",
      summaryMetadata,
    ].join("\n"));

    const markdown = page.locator(".prose");
    await markdown.getByRole("heading", { name: "Example day" }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: "Regenerate", exact: true })).toBeEnabled();

    const table = markdown.getByRole("table");
    await expect(table).toBeInViewport();
    for (const [index, alignment] of ["left", "center", "right"].entries()) {
      await expect(table.getByRole("columnheader").nth(index)).toHaveCSS("text-align", alignment);
      await expect(table.getByRole("cell").nth(index)).toHaveCSS("text-align", alignment);
    }

    const code = markdown.locator("pre");
    await expect(code).toHaveCSS("overflow-x", "auto");
    await expect.poll(() => code.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeGreaterThan(80);
    const contentWidth = await markdown.evaluate((element) => element.clientWidth);
    for (const block of [table, code]) {
      expect(await block.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThanOrEqual(contentWidth + 1);
    }
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
      .toBeLessThanOrEqual(0);

    await code.evaluate((element) => { element.scrollLeft = 80; });
    await expect(code).toHaveJSProperty("scrollLeft", 80);
  });
});

test("creates, edits, and deletes a Timeline note", async ({ page }) => {
  let events: TimelineEvent[] = [];
  const requests: Array<{ method: string; body?: Record<string, unknown> }> = [];
  const eventId = 7_001;

  const unexpectedRequests = await installApiMock(page, async (route, url) => {
    const request = route.request();
    if (await fulfillTimelineReads(route, url, events)) return true;

    if (request.method() === "POST" && url.pathname === "/api/events/manual") {
      const body = request.postDataJSON() as {
        timestamp: string;
        title: string;
        content?: string;
        people?: number[];
      };
      requests.push({ method: request.method(), body });
      const event = timelineEvent({
        id: eventId,
        source: "manual",
        source_id: "manual-playwright-note",
        source_account: "user",
        type: "note",
        timestamp: body.timestamp,
        title: body.title,
        content: body.content ?? null,
        people: body.people?.length
          ? JSON.stringify(body.people.map((contactId) => `contact:${contactId}`))
          : null,
        raw_data: JSON.stringify({ origin: { type: "user", created_via: "web-ui" } }),
      });
      events = [event];
      await route.fulfill({ status: 201, json: { event } });
      return true;
    }

    if (request.method() === "PATCH" && url.pathname === `/api/events/${eventId}`) {
      const body = request.postDataJSON() as Partial<{
        timestamp: string;
        title: string;
        content: string | null;
        people: number[] | null;
      }>;
      requests.push({ method: request.method(), body });
      const current = events[0];
      if (!current) throw new Error("Expected the note to exist before editing it");
      const event: TimelineEvent = {
        ...current,
        timestamp: body.timestamp ?? current.timestamp,
        title: body.title ?? current.title,
        content: body.content === undefined ? current.content : body.content,
        people: body.people === undefined
          ? current.people
          : body.people?.length
            ? JSON.stringify(body.people.map((contactId) => `contact:${contactId}`))
            : null,
      };
      events = [event];
      await route.fulfill({ json: { event } });
      return true;
    }

    if (request.method() === "DELETE" && url.pathname === `/api/events/${eventId}`) {
      requests.push({ method: request.method() });
      events = [];
      await route.fulfill({ status: 204, body: "" });
      return true;
    }

    return false;
  });

  await page.clock.setFixedTime(new Date("2025-01-15T12:00:00.000Z"));
  await page.goto(`/?date=${TEST_DATE}`);
  await expect(page.getByText("No events for this day")).toBeVisible();

  await page.getByRole("button", { name: "Add event" }).click();
  await page.getByRole("menuitem", { name: /Note/ }).click();

  const addDialog = page.getByRole("dialog").filter({ hasText: "Add Note" });
  await addDialog.locator('input[type="date"]').fill(TEST_DATE);
  await addDialog.locator('input[type="time"]').fill("10:30");
  await addDialog.getByPlaceholder("Daily reflection").fill("Planning notes");
  await addDialog.getByPlaceholder("Write your thoughts...").fill("Outline the next project milestone.");
  await addDialog.getByRole("button", { name: "Create" }).click();

  const event = page.locator(`#event-${eventId}`);
  await expect(event.getByText("Planning notes")).toBeVisible();
  await expect(event.getByText("Outline the next project milestone.")).toBeVisible();

  await event.hover();
  await event.getByTitle("Edit event").click();
  const editDialog = page.getByRole("dialog").filter({ hasText: "Edit Note" });
  await editDialog.getByPlaceholder("Daily reflection").fill("Revised planning notes");
  await editDialog.getByPlaceholder("Write your thoughts...").fill("Confirm the next project milestone.");
  await editDialog.getByRole("button", { name: "Update" }).click();

  await expect(event.getByText("Revised planning notes")).toBeVisible();
  await expect(event.getByText("Confirm the next project milestone.")).toBeVisible();

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toBe('Delete "Revised planning notes"?');
    await dialog.accept();
  });
  await event.hover();
  await event.getByTitle("Delete event").click();

  await expect(event).toHaveCount(0);
  await expect(page.getByText("No events for this day")).toBeVisible();
  expect(requests).toEqual([
    {
      method: "POST",
      body: expect.objectContaining({
        timestamp: "2025-01-15T10:30:00.000Z",
        title: "Planning notes",
        content: "Outline the next project milestone.",
      }),
    },
    {
      method: "PATCH",
      body: expect.objectContaining({
        title: "Revised planning notes",
        content: "Confirm the next project milestone.",
      }),
    },
    { method: "DELETE" },
  ]);
  expect(unexpectedRequests).toEqual([]);
});

// The headless shell can leave modified-click tabs without a committed document.
const searchTest = test.extend({ channel: "chromium" });

searchTest("searches from the form and opens the highlighted Timeline result", async ({ page }) => {
  const browserErrors: string[] = [];
  page.context().on("weberror", (error) => browserErrors.push(error.error().message));
  const result = timelineEvent({
    id: 7_101,
    source: "google-calendar",
    type: "event",
    timestamp: "2025-01-15T09:30:00.000Z",
    title: "Library planning session",
    content: "Review the project outline in the quiet room.",
  });
  const searchQueries: string[] = [];

  const unexpectedRequests = await installApiMock(page, async (route, url) => {
    if (await fulfillTimelineReads(route, url, [result])) return true;

    if (route.request().method() === "GET" && url.pathname === "/api/recent") {
      await route.fulfill({ json: { events: [], count: 0, nextCursor: null } });
      return true;
    }
    if (route.request().method() === "GET" && url.pathname === `/api/events/${result.id}`) {
      await route.fulfill({ json: { event: result } });
      return true;
    }

    if (route.request().method() === "GET" && url.pathname === "/api/search") {
      const query = url.searchParams.get("q") ?? "";
      searchQueries.push(query);
      await route.fulfill({
        json: {
          events: query === "library" ? [result] : [],
          count: query === "library" ? 1 : 0,
          nextCursor: null,
        },
      });
      return true;
    }

    return false;
  });

  await page.clock.setFixedTime(new Date("2025-01-15T12:00:00.000Z"));
  await page.goto("/search");

  const searchInput = page.getByRole("combobox", { name: "Search timeline" });
  await searchInput.fill("library");
  await page.getByRole("button", { name: "Search", exact: true }).click();

  await expect(page).toHaveURL(/\/search\?q=library$/);
  const titleLink = page.getByRole("link", { name: "Library planning session", exact: true });
  const dayLink = page.getByRole("link", { name: "this day", exact: true });
  await expect(titleLink).toHaveAttribute("href", `/event/${result.id}`);
  await expect(dayLink).toHaveAttribute("href", `/?date=${TEST_DATE}#event-${result.id}`);

  for (const link of [titleLink, dayLink]) {
    for (const options of [{ button: "middle" as const }, { modifiers: ["ControlOrMeta" as const] }]) {
      const popupPromise = page.context().waitForEvent("page");
      await link.click(options);
      const popup = await popupPromise;
      await expect(popup).toHaveURL(`/?date=${TEST_DATE}#event-${result.id}`);
      const popupEvent = popup.locator(`#event-${result.id}`);
      await expect(popupEvent.getByText("Library planning session")).toBeVisible();
      await expect(popupEvent.locator(".ring-2")).toHaveCount(1);
      await popup.close();
      await expect(page).toHaveURL(/\/search\?q=library$/);
    }
  }
  await dayLink.click();

  await expect(page).toHaveURL(`/?date=${TEST_DATE}#event-${result.id}`);
  const highlightedEvent = page.locator(`#event-${result.id}`);
  await expect(highlightedEvent.getByText("Library planning session")).toBeVisible();
  await expect(highlightedEvent.locator(".ring-2")).toHaveCount(1);
  await page.goBack();
  await expect(titleLink).toBeVisible();
  await titleLink.click();
  await expect(page).toHaveURL(`/?date=${TEST_DATE}#event-${result.id}`);
  await expect(highlightedEvent.locator(".ring-2")).toHaveCount(1);
  expect(browserErrors).toEqual([]);
  expect(searchQueries).toContain("library");
  expect(unexpectedRequests).toEqual([]);
});

function conversationMessage(index: number): TimelineEvent {
  const id = 8_000 + index;
  const timestamp = new Date(Date.UTC(2025, 0, 15, 8, index - 1)).toISOString();
  const author = index % 2 === 0 ? "bob" : "alice";
  return timelineEvent({
    id,
    source: "discord",
    source_id: `message-${id}`,
    type: "message:group",
    timestamp,
    title: "Study Group",
    content: `Message ${index}: synthetic browser-test conversation content.`,
    people: JSON.stringify([`discord:${author}`]),
    conversation_id: "study-group",
  });
}

test("scrolls a long conversation, jumps to latest, and downloads an export", async ({ page }) => {
  const messages = Array.from({ length: 120 }, (_, index) => conversationMessage(index + 1));
  const oldest = messages[0];
  const newest = messages.at(-1);
  if (!oldest || !newest) throw new Error("Expected generated conversation messages");

  const exportRequests: Record<string, unknown>[] = [];
  const unexpectedRequests = await installApiMock(page, async (route, url) => {
    const request = route.request();

    if (request.method() === "GET" && url.pathname === "/api/conversations") {
      await route.fulfill({
        json: {
          conversations: [{
            source: "discord",
            sourceAccount: "example",
            conversationId: "study-group",
            title: "Study Group",
            messageCount: messages.length,
            firstMessage: oldest.timestamp,
            lastMessage: newest.timestamp,
          }],
          total: 1,
        },
      });
      return true;
    }
    if (request.method() === "GET" && url.pathname === "/api/conversations/sources") {
      await route.fulfill({ json: { sources: ["discord"] } });
      return true;
    }
    if (request.method() === "GET" && url.pathname === "/api/conversation") {
      const cursor = url.searchParams.get("cursor");
      const pageEvents = cursor === "older-page"
        ? messages.slice(0, 20).reverse()
        : messages.slice(20).reverse();
      await route.fulfill({
        json: {
          title: "Study Group",
          events: pageEvents,
          attachments: {},
          nextCursor: cursor === "older-page" ? null : "older-page",
          participants: {
            "discord:alice": { name: "Alice", contactId: null, avatarUrl: null },
            "discord:bob": { name: "Bob", contactId: null, avatarUrl: null },
          },
          server: { source: "discord", id: "example-server", name: "Example University" },
        },
      });
      return true;
    }
    if (request.method() === "GET" && url.pathname === "/api/conversation/stats") {
      await route.fulfill({
        json: {
          totalMessages: messages.length,
          firstMessage: oldest.timestamp,
          lastMessage: newest.timestamp,
          firstEventId: oldest.id,
          lastEventId: newest.id,
          participants: [
            { identifier: "discord:alice", name: "Alice", contactId: null, count: 60 },
            { identifier: "discord:bob", name: "Bob", contactId: null, count: 60 },
          ],
          attachmentCount: 0,
          activityByMonth: [{ month: "2025-01", count: messages.length }],
          titles: [],
          tokenUsage: null,
        },
      });
      return true;
    }
    if (request.method() === "POST" && url.pathname === "/api/conversation/export-range") {
      exportRequests.push(request.postDataJSON() as Record<string, unknown>);
      await route.fulfill({
        json: {
          text: "Alice: First message\nBob: Latest message",
          eventCount: messages.length,
          tokenCount: 12,
          range: {
            startEventId: oldest.id,
            endEventId: newest.id,
            requestedStartEventId: oldest.id,
            requestedEndEventId: newest.id,
            source: "discord",
            sourceAccount: "example",
            conversationId: "study-group",
            title: "Study Group",
            startTimestamp: oldest.timestamp,
            endTimestamp: newest.timestamp,
          },
        },
      });
      return true;
    }

    return false;
  });

  await page.clock.setFixedTime(new Date("2025-01-15T12:00:00.000Z"));
  await page.goto("/conversations");
  await page.getByRole("link", { name: /Study Group/ }).click();

  await expect(page).toHaveURL("/conversation/discord/study-group");
  await expect(page.locator(`#event-${newest.id}`)).toBeVisible();
  const viewport = page.locator("main div.overflow-auto").filter({
    has: page.locator(`#event-${newest.id}`),
  }).first();
  await expect.poll(() => viewport.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);

  await viewport.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  const jumpToLatest = page.getByRole("button", { name: "Jump to latest messages" });
  await expect(jumpToLatest).toBeVisible();
  await jumpToLatest.click();
  await expect.poll(() => viewport.evaluate(
    (element) => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop),
  )).toBeLessThanOrEqual(2);

  await page.getByRole("button", { name: "Select messages to export" }).click();
  await page.getByRole("button", { name: "Select all" }).click();

  const preview = page.getByRole("dialog", { name: "Export preview" });
  await expect(preview.getByText("120 messages · 2 lines · 12 tokens")).toBeVisible();
  await expect(preview.getByRole("textbox")).toHaveValue(
    "Alice: First message\nBob: Latest message",
  );

  const downloadPromise = page.waitForEvent("download");
  await preview.getByRole("button", { name: "Download" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("discord-study-group-2025-01-15.txt");

  expect(exportRequests).toEqual([
    expect.objectContaining({
      startEventId: oldest.id,
      endEventId: newest.id,
      format: expect.objectContaining({ timeZone: "Europe/London" }),
    }),
  ]);
  expect(unexpectedRequests).toEqual([]);
});

test("renders the journal pane with source context and a Markdown reflection", async ({ page }) => {
  const journalModel = {
    id: "example-journal",
    name: "Example Journal",
    provider: "Example",
    price: "Free",
    contextLength: 32_768,
  };
  const journalState = {
    date: TEST_DATE,
    questions: [
      {
        question: "What helped you settle into the day?",
        category: "activity",
        group_ids: ["morning-walk"],
        answered: true,
        answer: "A quiet walk by the river gave me space to plan the morning.",
        event_id: 8_001,
      },
      {
        question: "What progress felt most satisfying?",
        category: "work",
        group_ids: ["project-session"],
        answered: true,
        answer: "Turning the project notes into a clear outline made the next step feel manageable.",
        event_id: 8_002,
      },
    ],
    contextGroups: {
      "morning-walk": {
        id: "morning-walk",
        source: "google-fit",
        label: "Morning walk",
        summary: "A relaxed walk along the riverside path.",
        eventCount: 1,
        timeRange: {
          start: `${TEST_DATE}T07:35:00.000Z`,
          end: `${TEST_DATE}T08:10:00.000Z`,
        },
      },
      "project-session": {
        id: "project-session",
        source: "wakatime",
        label: "Project planning",
        summary: "Focused writing and planning session.",
        eventCount: 1,
        timeRange: {
          start: `${TEST_DATE}T10:00:00.000Z`,
          end: `${TEST_DATE}T11:20:00.000Z`,
        },
      },
    },
    reflection: {
      content: [
        "Today had a reassuring rhythm: **movement first, focused work later**.",
        "",
        "- The riverside walk created some breathing room.",
        "- The project outline turned ideas into a practical next step.",
      ].join("\n"),
      event_id: 8_003,
    },
    cached: true,
  };

  const unexpectedRequests = await installApiMock(page, async (route, url) => {
    if (await fulfillTimelineReads(route, url, [])) return true;
    if (route.request().method() === "GET" && url.pathname === "/api/summary/models") {
      await route.fulfill({ json: { models: [journalModel] } });
      return true;
    }
    if (route.request().method() === "GET" && url.pathname === `/api/journal/${TEST_DATE}`) {
      expect(url.searchParams.get("model")).toBe(journalModel.id);
      await route.fulfill({ json: journalState });
      return true;
    }
    return false;
  });

  await page.clock.setFixedTime(new Date(`${TEST_DATE}T12:00:00.000Z`));
  await page.goto(`/?date=${TEST_DATE}&journal=true`);

  const journal = page
    .getByRole("heading", { name: "Journal", exact: true })
    .locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' h-full ')][1]");
  await expect(journal.getByText("What helped you settle into the day?")).toBeVisible();
  await journal.getByTitle("Show source context").first().click();
  await expect(journal.getByText("A relaxed walk along the riverside path.")).toBeVisible();

  const reflection = journal.locator(".prose");
  await expect(reflection.locator("strong")).toHaveText("movement first, focused work later");
  await expect(reflection.getByRole("listitem")).toHaveCount(2);
  expect(unexpectedRequests).toEqual([]);

  await expect(journal).toHaveScreenshot("journal-pane.png");
});
