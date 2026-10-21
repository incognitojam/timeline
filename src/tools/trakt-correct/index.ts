import { detectOutliers, type Outlier, getShowEpisodes, checkSequence } from "./detect";
import { interpolateTimestamp, type InterpolationResult } from "./interpolate";
import { applyCorrection, deleteFromTrakt } from "./correct";
import { ensureAuthenticated } from "../../parsers/trakt-api";
import * as readline from "readline";

interface OutlierGroup {
  showSlug: string;
  showName: string;
  timestamp: string;
  outliers: Outlier[];
  priorViewings: Map<string, { timestamp: string; season: number; episode: number }[]>;
  hasPriorViewings: boolean;
}

function formatDate(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleString("en-GB", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatEpisode(season: number, episode: number): string {
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

function formatEpisodeList(episodes: { season: number; episode: number }[]): string {
  if (episodes.length === 0) return "";
  if (episodes.length === 1) {
    return formatEpisode(episodes[0].season, episodes[0].episode);
  }

  // Check if all same season and contiguous
  const firstSeason = episodes[0].season;
  const allSameSeason = episodes.every((e) => e.season === firstSeason);

  if (allSameSeason) {
    const epNums = episodes.map((e) => e.episode).sort((a, b) => a - b);
    const isContiguous = epNums.every((n, i) => i === 0 || n === epNums[i - 1] + 1);

    if (isContiguous) {
      // "S03E01-E10 (10 episodes)"
      return `S${String(firstSeason).padStart(2, "0")}E${String(epNums[0]).padStart(2, "0")}-E${String(epNums[epNums.length - 1]).padStart(2, "0")} (${episodes.length} episodes)`;
    } else {
      // Non-contiguous: "S01E01, E03 (2 episodes)"
      const epList = epNums.map((n) => `E${String(n).padStart(2, "0")}`).join(", ");
      return `S${String(firstSeason).padStart(2, "0")} ${epList} (${episodes.length} episodes)`;
    }
  } else {
    // Multiple seasons - list individually
    const epList = episodes.map((e) => formatEpisode(e.season, e.episode)).join(", ");
    return `${epList} (${episodes.length} episodes)`;
  }
}

/**
 * Group outliers by show and timestamp, and look up prior viewings for context.
 */
function groupOutliers(outliers: Outlier[]): OutlierGroup[] {
  // Group by show + timestamp (rounded to minute for clustering)
  const groups = new Map<string, Outlier[]>();

  for (const outlier of outliers) {
    // Round timestamp to minute for grouping
    const timestampMinute = outlier.timestamp.substring(0, 16); // "2026-01-06T00:22"
    const key = `${outlier.show_slug}|${timestampMinute}`;

    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push(outlier);
  }

  // For each group, look up prior viewings
  const result: OutlierGroup[] = [];

  for (const [key, groupOutliers] of groups) {
    const [showSlug] = key.split("|");
    const showName = groupOutliers[0].title.split(" - ")[0];

    // Get all episodes for this show to find prior viewings
    const allEpisodes = getShowEpisodes(showSlug);

    // Find prior viewings for each outlier episode
    const priorViewings = new Map<string, { timestamp: string; season: number; episode: number }[]>();
    let hasPriorViewings = false;

    for (const outlier of groupOutliers) {
      const epKey = formatEpisode(outlier.season, outlier.episode);
      const priors = allEpisodes.filter(
        (e) =>
          e.season === outlier.season &&
          e.episode === outlier.episode &&
          e.timestamp !== outlier.timestamp // Different timestamp = prior viewing
      );

      if (priors.length > 0) {
        hasPriorViewings = true;
        priorViewings.set(
          epKey,
          priors.map((p) => ({
            timestamp: p.timestamp,
            season: p.season,
            episode: p.episode,
          }))
        );
      }
    }

    // Sort outliers by season/episode
    groupOutliers.sort((a, b) => {
      if (a.season !== b.season) return a.season - b.season;
      return a.episode - b.episode;
    });

    result.push({
      showSlug,
      showName,
      timestamp: groupOutliers[0].timestamp,
      outliers: groupOutliers,
      priorViewings,
      hasPriorViewings,
    });
  }

  // Sort groups by timestamp (most recent first)
  result.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return result;
}

async function promptUser(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

function parseSinceArg(args: string[]): Date | undefined {
  const sinceIdx = args.indexOf("--since");
  if (sinceIdx === -1 || sinceIdx + 1 >= args.length) return undefined;

  const sinceValue = args[sinceIdx + 1];

  // Handle relative time like "1d", "7d", "24h"
  const relativeMatch = sinceValue.match(/^(\d+)([dh])$/);
  if (relativeMatch) {
    const amount = parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2];
    const now = new Date();
    if (unit === "d") {
      now.setDate(now.getDate() - amount);
    } else if (unit === "h") {
      now.setHours(now.getHours() - amount);
    }
    return now;
  }

  // Handle ISO date
  const date = new Date(sinceValue);
  if (!isNaN(date.getTime())) {
    return date;
  }

  console.log(`Invalid --since value: ${sinceValue}. Use "1d", "7d", "24h", or ISO date.`);
  return undefined;
}

async function runDetect(sinceDate?: Date) {
  if (sinceDate) {
    console.log(`Detecting outliers since ${formatDate(sinceDate.toISOString())}...\n`);
  } else {
    console.log("Detecting all outliers in Trakt watch history...\n");
    console.log("Tip: Use --since 1d or --since 7d to limit to recent entries\n");
  }

  const outliers = detectOutliers(sinceDate);

  if (outliers.length === 0) {
    console.log("No outliers detected! Your watch history looks consistent.");
    return;
  }

  // Group outliers by type
  const outOfOrder = outliers.filter((o) => o.reason === "out_of_order");
  const bulkMarked = outliers.filter((o) => o.reason === "bulk_marked");

  console.log(`Found ${outliers.length} episode outliers\n`);

  if (outOfOrder.length > 0) {
    console.log("=".repeat(60));
    console.log("OUT OF ORDER EPISODES");
    console.log("=".repeat(60));
    for (const outlier of outOfOrder) {
      console.log(`\n${outlier.title}`);
      console.log(`  Watched: ${formatDate(outlier.timestamp)}`);
      if (outlier.conflicting_episode) {
        const ce = outlier.conflicting_episode;
        console.log(
          `  Problem: ${formatEpisode(ce.season, ce.episode)} was watched earlier (${formatDate(ce.timestamp)})`
        );
      }
    }
    console.log();
  }

  if (bulkMarked.length > 0) {
    console.log("=".repeat(60));
    console.log("BULK MARKED (different shows within 5 minutes)");
    console.log("=".repeat(60));
    for (const outlier of bulkMarked) {
      console.log(`\n${outlier.title}`);
      console.log(`  Watched: ${formatDate(outlier.timestamp)}`);
      if (outlier.nearby_episodes) {
        console.log(`  Nearby: ${outlier.nearby_episodes.map((e) => e.title.split(" - ")[0]).join(", ")}`);
      }
    }
    console.log();
  }

  console.log(`\nRun 'bun run src/tools/trakt-correct/index.ts fix' to correct timestamps.`);
}

async function runFix(sinceDate?: Date) {
  if (sinceDate) {
    console.log(`Detecting outliers since ${formatDate(sinceDate.toISOString())}...\n`);
  } else {
    console.log("Detecting outliers...\n");
  }

  // Ensure we're authenticated before starting
  await ensureAuthenticated();

  const outliers = detectOutliers(sinceDate);

  if (outliers.length === 0) {
    console.log("No outliers detected! Nothing to fix.");
    return;
  }

  // Group outliers by show and look up prior viewings
  const groups = groupOutliers(outliers);

  console.log(`Found ${outliers.length} outlier episodes in ${groups.length} group(s).\n`);

  let deleted = 0;
  let interpolated = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];

    console.log("=".repeat(60));
    console.log(`[${i + 1}/${groups.length}] ${group.showName}`);
    console.log("=".repeat(60));

    // Show episodes - check if contiguous
    const episodes = group.outliers.map((o) => ({ season: o.season, episode: o.episode }));
    const episodeStr = formatEpisodeList(episodes);
    console.log(`  Episodes: ${episodeStr}`);
    console.log(`  Marked:   ${formatDate(group.timestamp)}`);

    // Check sequence for the current (outlier) entries
    const outlierSequence = checkSequence(
      group.showSlug,
      group.outliers[0].season,
      group.outliers[0].episode,
      group.timestamp
    );

    // Show prior viewings if any
    if (group.hasPriorViewings) {
      console.log(`\n  PRIOR VIEWINGS FOUND:`);

      // Show a sample of prior viewings with sequence info
      let shown = 0;
      let anyPriorInSequence = false;
      for (const [epKey, priors] of group.priorViewings) {
        if (shown >= 5) {
          console.log(`    ... and ${group.priorViewings.size - 5} more`);
          break;
        }
        const mostRecent = priors.sort(
          (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        )[0];

        // Check if the prior viewing is in sequence
        const priorSeq = checkSequence(
          group.showSlug,
          mostRecent.season,
          mostRecent.episode,
          mostRecent.timestamp
        );
        if (priorSeq.isInSequence) anyPriorInSequence = true;

        const seqIndicator = priorSeq.isInSequence ? "✓" : "✗";
        console.log(`    ${epKey}: ${formatDate(mostRecent.timestamp)} ${seqIndicator} ${priorSeq.reason}`);
        shown++;
      }

      // Show recommendation based on sequence analysis
      console.log();
      if (anyPriorInSequence && !outlierSequence.isInSequence) {
        console.log(`  → Prior viewing appears legitimate, current entry is likely duplicate`);
      } else if (!anyPriorInSequence && outlierSequence.isInSequence) {
        console.log(`  → Current entry appears legitimate, prior viewing may be the duplicate`);
      }

      console.log();
      const answer = await promptUser(
        "[d]elete these entries / [i]nterpolate anyway / [s]kip: "
      );

      if (answer === "d" || answer === "delete") {
        console.log("\nDeleting duplicate entries...");
        const results = await deleteFromTrakt(group.outliers);
        const successCount = results.filter((r) => r.success).length;
        const failCount = results.filter((r) => !r.success).length;
        console.log(`  Deleted: ${successCount}, Failed: ${failCount}\n`);
        deleted += successCount;
        failed += failCount;
      } else if (answer === "i" || answer === "interpolate") {
        // Fall through to interpolation
        await processInterpolation(group, (d, i, f) => {
          interpolated += i;
          failed += f;
          skipped += d; // d here is actually skipped in interpolation
        });
      } else {
        skipped += group.outliers.length;
        console.log();
      }
    } else {
      // No prior viewings - show sequence info and interpolation preview
      console.log(`\n  No prior viewings found.`);

      // Show sequence info for the outlier
      const seqIndicator = outlierSequence.isInSequence ? "✓" : "✗";
      console.log(`  Sequence: ${seqIndicator} ${outlierSequence.reason}`);

      if (outlierSequence.isInSequence) {
        console.log(`\n  → This entry appears to be in correct viewing sequence`);
        console.log(`    Consider if this is actually a legitimate viewing, not bulk-marked`);
      }

      // Show interpolation preview
      console.log(`\n  INTERPOLATION PREVIEW:`);
      const previews = await getInterpolationPreviews(group.outliers);
      let canInterpolate = 0;
      let cannotInterpolate = 0;

      for (const preview of previews) {
        const ep = formatEpisode(preview.outlier.season, preview.outlier.episode);
        if (preview.suggestedTimestamp) {
          console.log(`    ${ep}: ${formatDate(preview.outlier.timestamp)} → ${formatDate(preview.suggestedTimestamp)}`);
          if (preview.priorEpisode && preview.followingEpisode) {
            console.log(`         (between ${formatEpisode(preview.priorEpisode.season, preview.priorEpisode.episode)} and ${formatEpisode(preview.followingEpisode.season, preview.followingEpisode.episode)})`);
          }
          canInterpolate++;
        } else {
          console.log(`    ${ep}: Cannot interpolate - ${preview.reason}`);
          cannotInterpolate++;
        }
      }

      if (cannotInterpolate > 0 && canInterpolate === 0) {
        console.log(`\n  → None of these episodes can be interpolated`);
      } else if (cannotInterpolate > 0) {
        console.log(`\n  → ${canInterpolate} can be interpolated, ${cannotInterpolate} cannot`);
      }

      console.log();
      const answer = await promptUser("[i]nterpolate / [s]kip: ");

      if (answer === "i" || answer === "interpolate") {
        await processInterpolation(group, (d, i, f) => {
          interpolated += i;
          failed += f;
          skipped += d;
        });
      } else {
        skipped += group.outliers.length;
        console.log();
      }
    }
  }

  console.log("=".repeat(60));
  console.log("SUMMARY");
  console.log("=".repeat(60));
  console.log(`  Deleted:      ${deleted}`);
  console.log(`  Interpolated: ${interpolated}`);
  console.log(`  Skipped:      ${skipped}`);
  console.log(`  Failed:       ${failed}`);
}

async function getInterpolationPreviews(outliers: Outlier[]): Promise<InterpolationResult[]> {
  const results: InterpolationResult[] = [];
  for (const outlier of outliers) {
    const result = await interpolateTimestamp(outlier);
    results.push(result);
  }
  return results;
}

async function processInterpolation(
  group: OutlierGroup,
  updateCounts: (skipped: number, interpolated: number, failed: number) => void
): Promise<void> {
  console.log("\nAnalyzing and interpolating...\n");

  let interpolated = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (const outlier of group.outliers) {
    const result = await interpolateTimestamp(outlier);

    if (result.suggestedTimestamp) {
      console.log(
        `  ${formatEpisode(outlier.season, outlier.episode)}: ${formatDate(result.suggestedTimestamp)}`
      );

      const correctionResult = await applyCorrection(result);
      if (correctionResult.success) {
        interpolated++;
      } else {
        console.log(`    FAILED: ${correctionResult.error}`);
        failedCount++;
      }
    } else {
      console.log(
        `  ${formatEpisode(outlier.season, outlier.episode)}: Cannot interpolate - ${result.reason}`
      );
      skippedCount++;
    }
  }

  console.log(
    `\n  Done: ${interpolated} interpolated, ${skippedCount} skipped, ${failedCount} failed\n`
  );
  updateCounts(skippedCount, interpolated, failedCount);
}

// CLI
if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args[0];
  const sinceDate = parseSinceArg(args);

  if (command === "detect") {
    await runDetect(sinceDate);
  } else if (command === "fix") {
    await runFix(sinceDate);
  } else {
    console.log(`Trakt Watch History Correction Tool

Usage:
  bun run src/tools/trakt-correct/index.ts detect [--since <time>]   Find outliers
  bun run src/tools/trakt-correct/index.ts fix [--since <time>]      Interactive correction

Options:
  --since <time>   Only show outliers from this time forward
                   Examples: --since 1d, --since 7d, --since 24h, --since 2024-01-15

Detects episodes that appear to have been bulk-marked or watched out of order,
and suggests corrected timestamps based on surrounding episode watch history.
`);
  }
}
