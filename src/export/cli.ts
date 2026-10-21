#!/usr/bin/env bun
import { getAppStateDbPath, getTimelineDbPath } from "../db/paths";
import { wrapDatabase } from "../db/pool";
import { openReadonlyDbAtPath, openReadonlyTimelineDb } from "../db/readonly";
import { getConfiguredAttachmentDescriptionModels } from "../sync/sources/attachment-descriptions";
import {
  type ExportRenderOptions,
  exportContact,
  exportConversation,
  exportRange,
} from "./export";

function configuredAttachmentDescriptionModels(): readonly string[] | undefined {
  try {
    const appStateDb = openReadonlyDbAtPath(getAppStateDbPath(getTimelineDbPath()));
    try {
      return getConfiguredAttachmentDescriptionModels(appStateDb);
    } finally {
      appStateDb.close();
    }
  } catch {
    return undefined;
  }
}

const HELP = `
Usage: bun run src/export/cli.ts <command> [options]

Commands:
  contact <name>           Export interactions with a contact
  range <start> <end>      Export events in a date range
  conversation <conversationId>
                          Export a specific conversation

Options:
  --source <source>        Filter by source (discord, phone, facebook, etc.)
  --count-only             Only show token count, no text output
  --limit <n>              Limit number of events (default: no limit for export)
  --all                    Include all messages from large groups (default: filter to participation)
  --group-size <n>         Threshold for "large group" filtering (default: 5)
  --context-hours <h>      Hours of context around participation (default: 4)
  --context-messages <n>   Messages of context around participation (default: 25)
  --no-compact-authors     Repeat the author on every message
  --no-summaries           Disable summary metadata in group headers
  --full-timestamps        Always show full date+time (disable compact timestamps)
  -h, --help               Show this help

Examples:
  bun run src/export/cli.ts contact "Alice Example" --count-only
  bun run src/export/cli.ts contact "Alice Example" --all
  bun run src/export/cli.ts range 2024-01-01 2024-01-31
  bun run src/export/cli.ts conversation 9100000000000000000 --source discord
`;

function parseArgs(args: string[]) {
  const result: {
    command?: string;
    args: string[];
    source?: string;
    countOnly: boolean;
    limit?: number;
    all: boolean;
    groupSize: number;
    contextHours: number;
    contextMessages: number;
    compactAuthors: boolean;
    noSummaries: boolean;
    fullTimestamps: boolean;
    help: boolean;
  } = {
    args: [],
    countOnly: false,
    all: false,
    groupSize: 5,
    contextHours: 4,
    contextMessages: 25,
    compactAuthors: true,
    noSummaries: false,
    fullTimestamps: false,
    help: false,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help") {
      result.help = true;
      i++;
    } else if (arg === "--source" && args[i + 1]) {
      result.source = args[i + 1];
      i += 2;
    } else if (arg === "--count-only") {
      result.countOnly = true;
      i++;
    } else if (arg === "--all") {
      result.all = true;
      i++;
    } else if (arg === "--limit" && args[i + 1]) {
      result.limit = parseInt(args[i + 1], 10);
      i += 2;
    } else if (arg === "--group-size" && args[i + 1]) {
      result.groupSize = parseInt(args[i + 1], 10);
      i += 2;
    } else if (arg === "--context-hours" && args[i + 1]) {
      result.contextHours = parseFloat(args[i + 1]);
      i += 2;
    } else if (arg === "--context-messages" && args[i + 1]) {
      result.contextMessages = parseInt(args[i + 1], 10);
      i += 2;
    } else if (arg === "--no-compact-authors") {
      result.compactAuthors = false;
      i++;
    } else if (arg === "--no-summaries") {
      result.noSummaries = true;
      i++;
    } else if (arg === "--full-timestamps") {
      result.fullTimestamps = true;
      i++;
    } else if (!result.command) {
      result.command = arg;
      i++;
    } else {
      result.args.push(arg);
      i++;
    }
  }

  return result;
}

function printContactResult(result: Awaited<ReturnType<typeof exportContact>>, countOnly: boolean) {
  if (result.kind === "not-found") {
    console.error(`No contact found matching "${result.name}"`);
    process.exit(1);
  }
  if (result.kind === "ambiguous") {
    console.error(`Multiple contacts match "${result.name}":`);
    for (const contact of result.candidates) {
      console.error(`  - ${contact.display_name} (id: ${contact.id})`);
    }
    console.error("Please be more specific.");
    process.exit(1);
  }

  console.error(`Contact: ${result.contact.display_name}`);
  console.error(
    `  ${result.aliases.length} aliases across ${result.aliasSources.length > 0 ? result.aliasSources.join(", ") : "all sources"}`,
  );
  if (result.filtered) {
    console.error(
      `Total events: ${result.events.length.toLocaleString()} (filtered from ${result.totalBeforeFilter.toLocaleString()})`,
    );
  } else {
    console.error(`Total events: ${result.events.length.toLocaleString()}`);
  }
  if (result.events.length === 0) {
    console.error("No events found.");
    return;
  }

  console.error("\nBreakdown by source:");
  for (const breakdown of result.tokenBreakdown) {
    console.error(
      `  ${breakdown.source}: ${breakdown.eventCount.toLocaleString()} events, ${breakdown.tokenCount.toLocaleString()} tokens`,
    );
  }
  if (result.tokenCount === null) throw new Error("Missing contact export token count");
  console.error(`Total: ${result.tokenCount.toLocaleString()} tokens (cl100k_base)`);

  if (!countOnly) {
    if (result.text === null) throw new Error("Missing contact export text");
    console.log(result.text);
  }
}

function printRenderedResult(
  result: Awaited<ReturnType<typeof exportRange>> | Awaited<ReturnType<typeof exportConversation>>,
  countOnly: boolean,
) {
  console.error(`Total events: ${result.events.length.toLocaleString()}`);
  if (result.events.length === 0) {
    console.error("No events found.");
    return;
  }

  if (result.tokenCount === null) throw new Error("Missing export token count");
  console.error(`Token count: ${result.tokenCount.toLocaleString()} (cl100k_base)`);

  if (!countOnly) {
    if (result.text === null) throw new Error("Missing export text");
    console.log(result.text);
  }
}

function getRenderOptions(
  args: ReturnType<typeof parseArgs>,
  preferredDescriptionModels: readonly string[] | undefined,
): ExportRenderOptions {
  return {
    source: args.source,
    limit: args.limit,
    compactAuthors: args.compactAuthors,
    noSummaries: args.noSummaries,
    fullTimestamps: args.fullTimestamps,
    preferredDescriptionModels,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.command) {
    console.log(HELP);
    process.exit(args.help ? 0 : 1);
  }

  const db = openReadonlyTimelineDb();
  const readDb = wrapDatabase(db);
  const preferredDescriptionModels = configuredAttachmentDescriptionModels();
  const renderOptions = getRenderOptions(args, preferredDescriptionModels);

  switch (args.command) {
    case "contact": {
      if (args.args.length < 1) {
        console.error("Usage: export contact <name> [names...]");
        process.exit(1);
      }
      const result = await exportContact(readDb, { names: args.args }, {
        ...renderOptions,
        all: args.all,
        groupSize: args.groupSize,
        contextHours: args.contextHours,
        contextMessages: args.contextMessages,
      });
      printContactResult(result, args.countOnly);
      break;
    }

    case "range": {
      if (args.args.length < 2) {
        console.error("Usage: export range <start-date> <end-date>");
        process.exit(1);
      }
      console.error(`Date range: ${args.args[0]} to ${args.args[1]}`);
      const result = await exportRange(readDb, { startDate: args.args[0], endDate: args.args[1] }, renderOptions);
      printRenderedResult(result, args.countOnly);
      break;
    }

    case "conversation": {
      if (args.args.length < 1) {
        console.error("Usage: export conversation <conversationId>");
        process.exit(1);
      }
      console.error(`Conversation: ${args.args[0]}`);
      const result = await exportConversation(readDb, { conversationId: args.args[0] }, renderOptions);
      printRenderedResult(result, args.countOnly);
      break;
    }

    default:
      console.error(`Unknown command: ${args.command}`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
