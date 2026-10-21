import { CONVERSATION_EVENT_TYPE_PATTERNS } from "../shared/grouping";

type ConversationEventTypePattern = typeof CONVERSATION_EVENT_TYPE_PATTERNS[number];

function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function conversationTypePatternClause(col: string, pattern: ConversationEventTypePattern): string {
  if (pattern.op === "contains") {
    return `${col} LIKE ${quoteSqlString(`%${pattern.value}%`)}`;
  }
  return `${col} LIKE ${quoteSqlString(`${pattern.value}%`)}`;
}

// SQL fragment matching event types that belong in a conversation thread.
export function conversationTypeClause(alias = ""): string {
  const col = `${alias}type`;
  return `(${CONVERSATION_EVENT_TYPE_PATTERNS.map((pattern) => conversationTypePatternClause(col, pattern)).join(" OR ")})`;
}

export function conversationEventEligibilityClause(alias = ""): string {
  return `${conversationTypeClause(alias)} AND ${alias}title IS NOT NULL`;
}
