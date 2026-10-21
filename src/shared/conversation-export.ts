export type ConversationRangeExportTimestampStyle = "date-headers" | "full-timestamps";

const CONVERSATION_RANGE_EXPORT_TIMESTAMP_STYLES = [
  "date-headers",
  "full-timestamps",
] as const;

function isConversationRangeExportTimestampStyle(
  value: unknown,
): value is ConversationRangeExportTimestampStyle {
  return CONVERSATION_RANGE_EXPORT_TIMESTAMP_STYLES.includes(value as ConversationRangeExportTimestampStyle);
}

export interface ConversationRangeExportFormat {
  timestampStyle: ConversationRangeExportTimestampStyle;
  includeReactions: boolean;
  compactAuthors: boolean;
  anonymiseNames: boolean;
  timeZone?: string;
}

export const DEFAULT_CONVERSATION_RANGE_EXPORT_FORMAT = {
  timestampStyle: "date-headers",
  includeReactions: true,
  compactAuthors: true,
  anonymiseNames: false,
} satisfies ConversationRangeExportFormat;

export function normalizeConversationRangeExportFormat(
  format: Partial<ConversationRangeExportFormat> | undefined,
): ConversationRangeExportFormat {
  const timeZone = normalizeConversationRangeExportTimeZone(format?.timeZone);
  return {
    timestampStyle: format?.timestampStyle ?? DEFAULT_CONVERSATION_RANGE_EXPORT_FORMAT.timestampStyle,
    includeReactions: format?.includeReactions ?? DEFAULT_CONVERSATION_RANGE_EXPORT_FORMAT.includeReactions,
    compactAuthors: format?.compactAuthors ?? DEFAULT_CONVERSATION_RANGE_EXPORT_FORMAT.compactAuthors,
    anonymiseNames: format?.anonymiseNames ?? DEFAULT_CONVERSATION_RANGE_EXPORT_FORMAT.anonymiseNames,
    ...(timeZone ? { timeZone } : {}),
  };
}

function normalizeConversationRangeExportTimeZone(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const timeZone = value.trim();
  if (!timeZone) {
    throw new Error("format.timeZone must be a non-empty IANA time zone");
  }
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone;
  } catch {
    throw new Error("format.timeZone must be a valid IANA time zone");
  }
}

export function parseConversationRangeExportFormat(value: unknown): ConversationRangeExportFormat {
  if (value === undefined) {
    return { ...DEFAULT_CONVERSATION_RANGE_EXPORT_FORMAT };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("format must be an object");
  }

  const parsed: Partial<ConversationRangeExportFormat> = {};
  const record = value as Record<string, unknown>;
  for (const [key, option] of Object.entries(record)) {
    if (key === "timestampStyle") {
      if (!isConversationRangeExportTimestampStyle(option)) {
        throw new Error(`format.timestampStyle must be one of: ${CONVERSATION_RANGE_EXPORT_TIMESTAMP_STYLES.join(", ")}`);
      }
      parsed.timestampStyle = option;
      continue;
    }
    if (key === "includeReactions") {
      if (typeof option !== "boolean") {
        throw new Error("format.includeReactions must be a boolean");
      }
      parsed.includeReactions = option;
      continue;
    }
    if (key === "compactAuthors") {
      if (typeof option !== "boolean") {
        throw new Error("format.compactAuthors must be a boolean");
      }
      parsed.compactAuthors = option;
      continue;
    }
    if (key === "anonymiseNames") {
      if (typeof option !== "boolean") {
        throw new Error("format.anonymiseNames must be a boolean");
      }
      parsed.anonymiseNames = option;
      continue;
    }
    if (key === "timeZone") {
      if (typeof option !== "string") {
        throw new Error("format.timeZone must be a string");
      }
      parsed.timeZone = option;
      continue;
    }
    throw new Error(`Unsupported format option: ${key}`);
  }

  return normalizeConversationRangeExportFormat(parsed);
}
