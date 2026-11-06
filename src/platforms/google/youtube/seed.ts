import type { SeedSource } from "../../../seed/context";
import {
  activityHour,
  atLocalHour,
  escapeHtml,
  GOOGLE_ACCOUNT,
  myActivityCell,
  myActivityPage,
  pickCommunityPost,
  pickVideo,
  recencyFactor,
  type YouTubeChannel,
  type YouTubeVideo,
  YOUTUBE_SEARCHES,
} from "../seed-data/google-data";

/** Evenings and weekends; a little at lunch. */
const WATCH_HOURS = [0.6, 0.3, 0.05, 0, 0, 0, 0.1, 0.5, 0.4, 0.2, 0.2, 0.3, 1.2, 0.6, 0.3, 0.3, 0.4, 0.7, 1.4, 2.2, 2.6, 2.6, 2, 1.2];

function channelUrl(channel: YouTubeChannel): string {
  return `https://www.youtube.com/channel/${channel.id}`;
}

function videoLinks(video: YouTubeVideo): string {
  return (
    `<a href="https://www.youtube.com/watch?v=${video.id}">${escapeHtml(video.title)}</a>` +
    `<br><a href="${channelUrl(video.channel)}">${escapeHtml(video.channel.name)}</a>`
  );
}

/**
 * Takeout "YouTube and YouTube Music": history/watch-history.html and
 * history/search-history.html (My Activity format) plus
 * subscriptions/subscriptions.csv, run through the CLI importer.
 */
export const googleYoutubeSeed: SeedSource = {
  name: "google-youtube",
  produces: {
    youtube: ["youtube:watch", "youtube:search", "youtube:like", "youtube:subscribe", "youtube:view", "youtube:subscription"],
  },
  async seed(ctx) {
    const rng = ctx.rng("google-youtube");
    const watch: { at: Date; html: string }[] = [];
    const search: { at: Date; html: string }[] = [];
    const subscribed = new Set<YouTubeChannel>();
    const watchesByChannel = new Map<YouTubeChannel, number>();

    for (const day of ctx.days) {
      const count = rng.poisson(2.25 * recencyFactor(ctx, day) * (day.isWeekend ? 1.5 : 0.85));
      for (let i = 0; i < count; i++) {
        const at = atLocalHour(ctx, day.date, activityHour(rng, day, WATCH_HOURS));
        // Searches usually lead straight into a watch.
        if (rng.chance(0.1)) {
          const query = rng.pick(YOUTUBE_SEARCHES);
          const searchedAt = new Date(at.getTime() - rng.int(15, 90) * 1000);
          search.push({
            at: searchedAt,
            html: myActivityCell(
              "YouTube",
              "Searched for",
              `<a href="https://www.youtube.com/results?search_query=${encodeURIComponent(query)}">${escapeHtml(query)}</a>`,
              searchedAt,
            ),
          });
        }
        const video = pickVideo(rng);
        watch.push({ at, html: myActivityCell("YouTube", "Watched", videoLinks(video), at) });

        const seen = (watchesByChannel.get(video.channel) ?? 0) + 1;
        watchesByChannel.set(video.channel, seen);
        const later = (minutes: number) => new Date(at.getTime() + minutes * 60_000 + rng.int(0, 59) * 1000);
        if (rng.chance(0.06)) {
          const likedAt = later(rng.int(3, 20));
          watch.push({ at: likedAt, html: myActivityCell("YouTube", "Liked", videoLinks(video), likedAt) });
        }
        if (!subscribed.has(video.channel) && seen >= 3 && rng.chance(0.35)) {
          subscribed.add(video.channel);
          const subAt = later(rng.int(5, 25));
          watch.push({
            at: subAt,
            html: myActivityCell(
              "YouTube",
              "Subscribed to",
              `<a href="${channelUrl(video.channel)}">${escapeHtml(video.channel.name)}</a>`,
              subAt,
            ),
          });
        }
        if (rng.chance(0.035)) {
          const post = pickCommunityPost(rng);
          const viewedAt = later(rng.int(1, 30));
          watch.push({
            at: viewedAt,
            html: myActivityCell(
              "YouTube",
              "Viewed",
              `<a href="https://www.youtube.com/post/${post.postId}">${escapeHtml(post.text)}</a>` +
                `<br><a href="${channelUrl(post.channel)}">${escapeHtml(post.channel.name)}</a>`,
              viewedAt,
            ),
          });
        }
      }
    }

    const byNewest = (a: { at: Date }, b: { at: Date }) => b.at.getTime() - a.at.getTime();
    watch.sort(byNewest);
    search.sort(byNewest);
    ctx.writeStaged("google-youtube", "history/watch-history.html", myActivityPage(watch.map((c) => c.html)));
    ctx.writeStaged("google-youtube", "history/search-history.html", myActivityPage(search.map((c) => c.html)));
    const csv = [
      "Channel Id,Channel Url,Channel Title",
      ...[...subscribed].map((c) => `${c.id},http://www.youtube.com/channel/${c.id},${c.name}`),
      "",
    ].join("\n");
    ctx.writeStaged("google-youtube", "subscriptions/subscriptions.csv", csv);

    await ctx.runParserCli("platforms/google/youtube/parser.ts", [ctx.stage("google-youtube"), GOOGLE_ACCOUNT]);
  },
};
