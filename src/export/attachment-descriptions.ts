import type { QueryExecutor } from "../db/pool";
import type { TimelineEvent } from "../db/schema";

export interface RenderAttachmentDescription {
  contentHash: string;
  description: string | null;
}

export type AttachmentDescriptionsByEvent = Map<number, RenderAttachmentDescription[]>;

export interface AttachmentDescriptionSelect {
  sql: string;
  params: string[];
}

export function latestAttachmentDescriptionSelect(
  select: string,
  preferredModels?: readonly string[],
): AttachmentDescriptionSelect {
  if (preferredModels && preferredModels.length > 0) {
    const cases = preferredModels.map((_, index) => `WHEN ? THEN ${index}`).join(" ");
    return {
      sql: `(
  SELECT ${select}
  FROM attachment_descriptions ad
  WHERE ad.content_hash = a.content_hash
  ORDER BY CASE ad.model ${cases} ELSE ${preferredModels.length} END, ad.created_at DESC, ad.model DESC
  LIMIT 1
)`,
      params: [...preferredModels],
    };
  }
  return {
    sql: `(
  SELECT ${select}
  FROM attachment_descriptions ad
  WHERE ad.content_hash = a.content_hash
  ORDER BY ad.created_at DESC, ad.model DESC
  LIMIT 1
)`,
    params: [],
  };
}

interface AttachmentDescriptionRow {
  event_id: number;
  content_hash: string;
  description: string | null;
}

export async function loadAttachmentDescriptionsForEvents(
  db: QueryExecutor,
  events: TimelineEvent[],
  preferredModels?: readonly string[],
): Promise<AttachmentDescriptionsByEvent> {
  const eventIds = Array.from(new Set(events.map((event) => event.id)));
  if (eventIds.length === 0) return new Map();

  const placeholders = eventIds.map(() => "?").join(", ");
  const descriptionSelect = latestAttachmentDescriptionSelect("ad.description", preferredModels);
  const rows = await db.query<AttachmentDescriptionRow>(`
    SELECT
      a.event_id,
      a.content_hash,
      ${descriptionSelect.sql} AS description
    -- Without planner statistics, three or more event ids make SQLite prefer
    -- the low-selectivity status index and scan every stored attachment.
    FROM attachments a INDEXED BY idx_attachments_event
    WHERE a.event_id IN (${placeholders})
      AND a.status = 'stored'
      AND a.mime_type LIKE 'image/%'
      AND a.content_hash IS NOT NULL
    ORDER BY a.event_id, a.id
  `, ...descriptionSelect.params, ...eventIds);

  const byEvent: AttachmentDescriptionsByEvent = new Map();
  for (const row of rows) {
    let entries = byEvent.get(row.event_id);
    if (!entries) {
      entries = [];
      byEvent.set(row.event_id, entries);
    }
    entries.push({
      contentHash: row.content_hash,
      description: row.description,
    });
  }
  return byEvent;
}
