#!/usr/bin/env bun
import { loadConfig } from "../config";
import { getDb, initDb } from "../db/schema";
import { initProviders, resolveLanguageModel } from "../llm";
import {
  type AttachmentDescriptionCandidate,
  describeAttachments,
} from "../media/describe-attachments";
import { getMediaStore } from "../media/storage";
import { isAttachmentDescriptionImageDimension, MAX_ATTACHMENT_DESCRIPTION_IMAGE_DIMENSION } from "../shared/attachments";

export {
  generateAttachmentDescription,
  selectAttachmentsToDescribe,
} from "../media/describe-attachments";

export const HELP = `
Usage: bun run src/scripts/describe-attachments.ts --model <ref> [options]

Options:
  --model <ref>                Required model reference from the configured LLM providers
  --limit <n>                  Describe at most n distinct image hashes
  --source <source>            Restrict to attachment rows from one source
  --reasoning-effort <value>   Pass reasoning effort to OpenAI-compatible models (none|low|medium|high)
  --max-image-dimension <px>   Longest image side sent to the model (1–${MAX_ATTACHMENT_DESCRIPTION_IMAGE_DIMENSION}; default: ${MAX_ATTACHMENT_DESCRIPTION_IMAGE_DIMENSION})
  --newest                     Process newest attachments first (default: oldest first)
  --dry-run                    List candidates without calling the model or writing rows
  -h, --help                   Show this help
`;

export interface DescribeAttachmentsOptions {
  model: string;
  limit?: number;
  source?: string;
  reasoningEffort?: string;
  maxImageDimension?: number;
  newest?: boolean;
  dryRun?: boolean;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer, got ${value}`);
  }
  return parsed;
}

export function parseArgs(args: string[]): DescribeAttachmentsOptions {
  const options: Partial<DescribeAttachmentsOptions> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help") {
      console.log(HELP.trim());
      process.exit(0);
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--newest") {
      options.newest = true;
      continue;
    }
    const [flag, inlineValue] = arg.split(/=(.*)/s);
    const readValue = () => {
      if (inlineValue !== undefined) return inlineValue;
      const value = args[++i];
      if (!value) throw new Error(`${flag} requires a value`);
      return value;
    };
    switch (flag) {
      case "--model":
        options.model = readValue();
        break;
      case "--limit":
        options.limit = parsePositiveInteger(readValue(), flag);
        break;
      case "--source":
        options.source = readValue();
        break;
      case "--reasoning-effort": {
        const value = readValue();
        if (!value) throw new Error(`${flag} requires a value`);
        options.reasoningEffort = value;
        break;
      }
      case "--max-image-dimension": {
        const value = readValue();
        if (!value) throw new Error(`${flag} requires a value`);
        const dimension = Number(value);
        if (!isAttachmentDescriptionImageDimension(dimension)) {
          throw new Error(`${flag} must be an integer between 1 and ${MAX_ATTACHMENT_DESCRIPTION_IMAGE_DIMENSION}`);
        }
        options.maxImageDimension = dimension;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.model) throw new Error("--model is required");
  return options as DescribeAttachmentsOptions;
}

function displayName(candidate: AttachmentDescriptionCandidate): string {
  return candidate.filename || candidate.storage_path || "(unnamed)";
}

if (import.meta.main) {
  const db = getDb();
  initDb(db);
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.dryRun) {
      const { selectAttachmentsToDescribe } = await import("../media/describe-attachments");
      const candidates = selectAttachmentsToDescribe(db, options);
      for (const candidate of candidates) {
        console.log(`${candidate.content_hash.slice(0, 12)} ${candidate.source} ${displayName(candidate)}`);
      }
      console.log(`summary: described=0 skipped=${candidates.length} failed=0`);
    } else {
      const config = await loadConfig();
      await initProviders(config.llm);
      const stats = await describeAttachments({
        db,
        mediaStore: await getMediaStore(),
        languageModel: resolveLanguageModel(options.model),
        modelRef: options.model,
        selection: options,
        reasoningEffort: options.reasoningEffort,
        maxImageDimension: options.maxImageDimension,
      });
      console.log(
        `summary: described=${stats.described} skipped=${stats.skipped} failed=${stats.failed}` +
          (stats.stoppedReason ? ` stopped=${stats.stoppedReason}` : ""),
      );
      if (stats.failed > 0) process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}
