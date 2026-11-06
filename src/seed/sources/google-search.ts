import type { SeedSource } from "../context";
import {
  activityHour,
  atLocalHour,
  escapeHtml,
  GOOGLE_ACCOUNT,
  myActivityCell,
  myActivityPage,
  pickSearch,
  recencyFactor,
} from "./google-data";

/**
 * Takeout "My Activity/Search/My Activity.html": "Searched for" entries plus
 * "Visited" entries for clicked results. The importer stores both as
 * google-search/search (it has no separate visit type).
 */
export const googleSearchSeed: SeedSource = {
  name: "google-search",
  produces: { "google-search": ["search"] },
  async seed(ctx) {
    const rng = ctx.rng("google-search");
    const cells: { at: Date; html: string }[] = [];

    for (const day of ctx.days) {
      const count = rng.poisson(4.1 * recencyFactor(ctx, day) * (day.isWeekend ? 1.1 : 1));
      for (let i = 0; i < count; i++) {
        const hour = activityHour(rng, day);
        const at = atLocalHour(ctx, day.date, hour);
        const pick = pickSearch(rng, day, hour);
        const query = escapeHtml(pick.query);
        cells.push({
          at,
          html: myActivityCell(
            "Search",
            "Searched for",
            `<a href="https://www.google.com/search?q=${encodeURIComponent(pick.query)}">${query}</a>`,
            at,
          ),
        });
        if (pick.result) {
          const visitedAt = new Date(at.getTime() + rng.int(4, 50) * 1000);
          cells.push({
            at: visitedAt,
            html: myActivityCell(
              "Search",
              "Visited",
              `<a href="${escapeHtml(pick.result.url)}">${escapeHtml(pick.result.title)}</a>`,
              visitedAt,
            ),
          });
        }
        // Refining a query a minute later is common.
        if (rng.chance(0.12)) {
          const refinedAt = new Date(at.getTime() + rng.int(20, 180) * 1000);
          const refined = `${pick.query} ${rng.pick(["reddit", day.date.slice(0, 4), "example", "vs", "near me", "explained", "alternative"])}`;
          cells.push({
            at: refinedAt,
            html: myActivityCell(
              "Search",
              "Searched for",
              `<a href="https://www.google.com/search?q=${encodeURIComponent(refined)}">${escapeHtml(refined)}</a>`,
              refinedAt,
            ),
          });
        }
      }
    }

    // Takeout lists newest first.
    cells.sort((a, b) => b.at.getTime() - a.at.getTime());
    const path = ctx.writeStaged(
      "google-search",
      "Takeout/My Activity/Search/My Activity.html",
      myActivityPage(cells.map((c) => c.html)),
    );
    await ctx.runParserCli("parsers/google-search.ts", [path, GOOGLE_ACCOUNT]);
  },
};
