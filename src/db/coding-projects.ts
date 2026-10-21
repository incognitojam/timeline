import type { QueryExecutor } from "./pool";
import { conversationTypeClause } from "./conversations";

export interface CodingProject {
  name: string;
  primaryLanguage: string | null;
  totalDuration: number;
  sessionCount: number;
  conversationCount: number;
  messageCount: number;
  aiSources: string[];
  firstActivity: string | null;
  lastActivity: string | null;
}

export interface ListCodingProjectsOptions {
  search?: string;
  limit?: number;
}

export interface CodingProjectConversation {
  source: string;
  sourceAccount: string | null;
  conversationId: string | null;
  title: string;
  messageCount: number;
  firstMessage: string | null;
  lastMessage: string | null;
  lastEventId: number;
}

export interface ListCodingProjectConversationsOptions {
  limit?: number;
  offset?: number;
}

// Per-source filter fragments. `?` is bound to the project name; some sources
// bind it more than once. Each fragment is wrapped in parens so it can be
// combined with the shared `conversationTypeClause()` and grouping logic.
//
// Matching strategy notes:
//   * conductor: exact `repo_name` from raw_data.
//   * t3code: exact `project_title` from raw_data (T3 Code names projects
//     after the workspace root's basename).
//   * claude-code: title prefix — `raw_data.cwd` is per-message and changes
//     when the user cd's mid-session, but the title's project name is derived
//     from the launch directory (`~/.claude/projects/<dir>`) and is stable.
//     Same pattern as WakaTime ("Project (Language)" -> "Project (slug)").
//   * amp / opencode / codex: workspace_roots[0] / project_path / cwd is
//     session-level and stable. Conductor-aware so sessions under
//     ~/conductor/workspaces/<repo>/<workspace-vN> roll up to <repo>.
interface ProjectFilter {
  source: string;
  hasConversationId: boolean;
  clause: string;
  paramCount: number;
}

const PROJECT_FILTERS: ProjectFilter[] = [
  {
    source: "conductor",
    hasConversationId: true,
    clause: "json_extract(raw_data, '$.repo_name') = ?",
    paramCount: 1,
  },
  {
    source: "t3code",
    hasConversationId: true,
    clause: "json_extract(raw_data, '$.project_title') = ?",
    paramCount: 1,
  },
  {
    source: "claude-code",
    hasConversationId: true,
    clause: "(title = ? OR title LIKE ? || ' (%')",
    paramCount: 2,
  },
  {
    source: "amp",
    hasConversationId: false,
    clause: `(
      json_extract(raw_data, '$.workspace_roots[0]') LIKE '%/conductor/workspaces/' || ? || '/%'
      OR (
        json_extract(raw_data, '$.workspace_roots[0]') LIKE '%/' || ?
        AND json_extract(raw_data, '$.workspace_roots[0]') NOT LIKE '%/conductor/workspaces/%'
      )
    )`,
    paramCount: 2,
  },
  {
    source: "opencode",
    hasConversationId: true,
    clause: `(
      json_extract(raw_data, '$.project_path') LIKE '%/conductor/workspaces/' || ? || '/%'
      OR (
        json_extract(raw_data, '$.project_path') LIKE '%/' || ?
        AND json_extract(raw_data, '$.project_path') NOT LIKE '%/conductor/workspaces/%'
      )
    )`,
    paramCount: 2,
  },
  {
    source: "codex",
    hasConversationId: true,
    clause: `(
      json_extract(raw_data, '$.cwd') LIKE '%/conductor/workspaces/' || ? || '/%'
      OR (
        json_extract(raw_data, '$.cwd') LIKE '%/' || ?
        AND json_extract(raw_data, '$.cwd') NOT LIKE '%/conductor/workspaces/%'
      )
    )`,
    paramCount: 2,
  },
];

/**
 * List AI coding conversations associated with a coding project. Groups
 * messages by stable `conversation_id` when the source provides one (conductor,
 * claude-code, opencode); falls back to `(source, source_account, title)` for
 * amp which doesn't set `conversation_id`. The displayed title is the most
 * recent one, matching `listConversations()` semantics.
 */
export async function getCodingProjectConversations(
  db: QueryExecutor,
  projectName: string,
  options: ListCodingProjectConversationsOptions = {}
): Promise<{ conversations: CodingProjectConversation[]; total: number }> {
  const { limit = 50, offset = 0 } = options;

  // Build the per-source subqueries. Each yields rows with the same shape so
  // we can UNION ALL them and apply ordering/pagination at the end.
  const subqueries: string[] = [];
  const params: (string | number)[] = [];

  for (const filter of PROJECT_FILTERS) {
    const projectParams = Array(filter.paramCount).fill(projectName);

    if (filter.hasConversationId) {
      // Group by conversation_id, then fall back to title for rows without one.
      subqueries.push(`
        SELECT
          source,
          source_account,
          conversation_id,
          NULL AS group_title,
          COUNT(*) AS message_count,
          MIN(timestamp) AS first_message,
          MAX(timestamp) AS last_message,
          MAX(id) AS last_event_id
        FROM events
        WHERE source = ?
          AND conversation_id IS NOT NULL
          AND ${conversationTypeClause()}
          AND title IS NOT NULL
          AND ${filter.clause}
        GROUP BY source, source_account, conversation_id
      `);
      params.push(filter.source, ...projectParams);

      subqueries.push(`
        SELECT
          source,
          source_account,
          NULL AS conversation_id,
          title AS group_title,
          COUNT(*) AS message_count,
          MIN(timestamp) AS first_message,
          MAX(timestamp) AS last_message,
          MAX(id) AS last_event_id
        FROM events
        WHERE source = ?
          AND conversation_id IS NULL
          AND ${conversationTypeClause()}
          AND title IS NOT NULL
          AND ${filter.clause}
        GROUP BY source, source_account, title
      `);
      params.push(filter.source, ...projectParams);
    } else {
      // amp: title-only grouping.
      subqueries.push(`
        SELECT
          source,
          source_account,
          NULL AS conversation_id,
          title AS group_title,
          COUNT(*) AS message_count,
          MIN(timestamp) AS first_message,
          MAX(timestamp) AS last_message,
          MAX(id) AS last_event_id
        FROM events
        WHERE source = ?
          AND ${conversationTypeClause()}
          AND title IS NOT NULL
          AND ${filter.clause}
        GROUP BY source, source_account, title
      `);
      params.push(filter.source, ...projectParams);
    }
  }

  const groupedSql = subqueries.join(" UNION ALL ");

  const [countResult, rows] = await Promise.all([
    db.get<{ total: number }>(`SELECT COUNT(*) as total FROM (${groupedSql})`, ...params),
    db.query<{
      source: string;
      source_account: string | null;
      conversation_id: string | null;
      group_title: string | null;
      message_count: number;
      first_message: string | null;
      last_message: string | null;
      last_event_id: number;
    }>(
      `WITH grouped AS (
        ${groupedSql}
        ORDER BY last_message DESC LIMIT ? OFFSET ?
      )
      SELECT
        g.source,
        g.source_account,
        g.conversation_id,
        CASE WHEN g.conversation_id IS NOT NULL THEN
          (SELECT e.title FROM events e
           WHERE e.source = g.source
             AND e.source_account IS g.source_account
             AND e.conversation_id = g.conversation_id
             AND ${conversationTypeClause("e.")}
             AND e.title IS NOT NULL
           ORDER BY e.timestamp DESC, e.id DESC LIMIT 1)
        ELSE g.group_title
        END AS group_title,
        g.message_count,
        g.first_message,
        g.last_message,
        g.last_event_id
      FROM grouped g
      ORDER BY g.last_message DESC`,
      ...params,
      limit,
      offset,
    ),
  ]);

  const conversations: CodingProjectConversation[] = rows.map((r) => ({
    source: r.source,
    sourceAccount: r.source_account,
    conversationId: r.conversation_id,
    title: r.group_title ?? "",
    messageCount: r.message_count,
    firstMessage: r.first_message,
    lastMessage: r.last_message,
    lastEventId: r.last_event_id,
  }));

  return { conversations, total: countResult?.total ?? 0 };
}

// Extract a project name from amp's workspace_roots[0] or opencode's project_path.
// Mirrors the SQL match logic in PROJECT_FILTERS so listing and lookup agree:
//   * `.../conductor/workspaces/<name>/...` -> `<name>` (Conductor workspace)
//   * else the trailing path segment (basename)
export function projectNameFromWorkspacePath(path: string | null): string | null {
  if (!path) return null;
  const conductorMatch = path.match(/\/conductor\/workspaces\/([^/]+)/);
  if (conductorMatch) return conductorMatch[1];
  const segments = path.split("/").filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : null;
}

interface AiAggregate {
  conversationCount: number;
  messageCount: number;
  firstActivity: string | null;
  lastActivity: string | null;
  sources: Set<string>;
}

function mergeAi(
  map: Map<string, AiAggregate>,
  name: string,
  source: string,
  row: { conversation_count: number; message_count: number; first_message: string | null; last_message: string | null },
) {
  let agg = map.get(name);
  if (!agg) {
    agg = {
      conversationCount: 0,
      messageCount: 0,
      firstActivity: null,
      lastActivity: null,
      sources: new Set<string>(),
    };
    map.set(name, agg);
  }
  agg.conversationCount += row.conversation_count;
  agg.messageCount += row.message_count;
  agg.sources.add(source);
  if (row.first_message && (!agg.firstActivity || row.first_message < agg.firstActivity)) {
    agg.firstActivity = row.first_message;
  }
  if (row.last_message && (!agg.lastActivity || row.last_message > agg.lastActivity)) {
    agg.lastActivity = row.last_message;
  }
}

/**
 * List all coding projects across WakaTime sessions and AI conversations
 * (conductor, t3code, claude-code, amp, opencode, codex). Projects that exist in only one
 * data source — typical for repos that pre-date WakaTime tracking, or that
 * are touched exclusively via AI assistants — still appear in the list.
 *
 * Sorted by last activity (descending) so recently-active projects surface
 * first regardless of which data source provided the activity.
 */
export async function getCodingProjects(
  db: QueryExecutor,
  options: ListCodingProjectsOptions = {},
): Promise<{ projects: CodingProject[] }> {
  const { search, limit = 200 } = options;

  // WakaTime sessions, grouped by extracted project name from title.
  const wakaRows = await db.query<{
    name: string;
    primaryLanguage: string | null;
    totalDuration: number;
    sessionCount: number;
    firstActivity: string | null;
    lastActivity: string | null;
  }>(`
    WITH wakatime_sessions AS (
      SELECT
        id,
        duration_ms,
        timestamp,
        raw_data,
        CASE
          WHEN INSTR(title, ' (') > 0 THEN SUBSTR(title, 1, INSTR(title, ' (') - 1)
          ELSE title
        END as project_name
      FROM events
      WHERE source = 'wakatime' AND type = 'code:session' AND title IS NOT NULL
    )
    SELECT
      project_name as name,
      (
        -- Rank languages by proportional duration (heartbeats / total
        -- heartbeats * session duration). Matches the byLanguage aggregation
        -- so a project's primary language equals its top byLanguage entry.
        SELECT l.key
        FROM wakatime_sessions w2, json_each(json_extract(w2.raw_data, '$.languages')) l
        WHERE w2.project_name = wakatime_sessions.project_name
        GROUP BY l.key
        ORDER BY SUM(
          CAST(l.value AS REAL)
          / (SELECT SUM(CAST(value AS REAL)) FROM json_each(json_extract(w2.raw_data, '$.languages')))
          * COALESCE(w2.duration_ms, 0)
        ) DESC
        LIMIT 1
      ) as primaryLanguage,
      COALESCE(SUM(duration_ms), 0) as totalDuration,
      COUNT(*) as sessionCount,
      MIN(timestamp) as firstActivity,
      MAX(timestamp) as lastActivity
    FROM wakatime_sessions
    GROUP BY project_name
    HAVING project_name IS NOT NULL AND project_name != ''
  `);

  const ai = new Map<string, AiAggregate>();

  // Conductor / t3code: project name comes directly from a raw_data field.
  for (const { source, nameExpr } of [
    { source: "conductor", nameExpr: "$.repo_name" },
    { source: "t3code", nameExpr: "$.project_title" },
  ] as const) {
    const rows = await db.query<{
      name: string;
      conversation_count: number;
      message_count: number;
      first_message: string | null;
      last_message: string | null;
    }>(`
      SELECT
        json_extract(raw_data, '${nameExpr}') as name,
        COUNT(DISTINCT COALESCE(conversation_id, IFNULL(source_account, '') || '|' || title)) as conversation_count,
        COUNT(*) as message_count,
        MIN(timestamp) as first_message,
        MAX(timestamp) as last_message
      FROM events
      WHERE source = '${source}'
        AND ${conversationTypeClause()}
        AND title IS NOT NULL
        AND json_extract(raw_data, '${nameExpr}') IS NOT NULL
      GROUP BY name
    `);
    for (const row of rows) {
      if (row.name) mergeAi(ai, row.name, source, row);
    }
  }

  // Claude-code: title prefix (same "Project (Language)" convention as WakaTime).
  const claudeCodeRows = await db.query<{
    name: string;
    conversation_count: number;
    message_count: number;
    first_message: string | null;
    last_message: string | null;
  }>(`
    SELECT
      CASE
        WHEN INSTR(title, ' (') > 0 THEN SUBSTR(title, 1, INSTR(title, ' (') - 1)
        ELSE title
      END as name,
      COUNT(DISTINCT COALESCE(conversation_id, IFNULL(source_account, '') || '|' || title)) as conversation_count,
      COUNT(*) as message_count,
      MIN(timestamp) as first_message,
      MAX(timestamp) as last_message
    FROM events
    WHERE source = 'claude-code'
      AND ${conversationTypeClause()}
      AND title IS NOT NULL
    GROUP BY name
  `);
  for (const row of claudeCodeRows) {
    if (row.name) mergeAi(ai, row.name, "claude-code", row);
  }

  // Amp / opencode / codex: aggregate by raw path, then resolve to project
  // name in JS to mirror the path-matching done by PROJECT_FILTERS.
  for (const { source, pathExpr } of [
    { source: "amp", pathExpr: "$.workspace_roots[0]" },
    { source: "opencode", pathExpr: "$.project_path" },
    { source: "codex", pathExpr: "$.cwd" },
  ] as const) {
    const rows = await db.query<{
      path: string | null;
      conversation_count: number;
      message_count: number;
      first_message: string | null;
      last_message: string | null;
    }>(`
      SELECT
        json_extract(raw_data, '${pathExpr}') as path,
        COUNT(DISTINCT COALESCE(conversation_id, IFNULL(source_account, '') || '|' || title)) as conversation_count,
        COUNT(*) as message_count,
        MIN(timestamp) as first_message,
        MAX(timestamp) as last_message
      FROM events
      WHERE source = ?
        AND ${conversationTypeClause()}
        AND title IS NOT NULL
        AND json_extract(raw_data, '${pathExpr}') IS NOT NULL
      GROUP BY path
    `, source);
    for (const row of rows) {
      const name = projectNameFromWorkspacePath(row.path);
      if (name) mergeAi(ai, name, source, row);
    }
  }

  // Merge WakaTime projects with AI aggregates, keyed by project name.
  const merged = new Map<string, CodingProject>();
  for (const row of wakaRows) {
    merged.set(row.name, {
      name: row.name,
      primaryLanguage: row.primaryLanguage,
      totalDuration: row.totalDuration,
      sessionCount: row.sessionCount,
      conversationCount: 0,
      messageCount: 0,
      aiSources: [],
      firstActivity: row.firstActivity,
      lastActivity: row.lastActivity,
    });
  }
  for (const [name, agg] of ai) {
    const existing = merged.get(name);
    const aiSources = Array.from(agg.sources).sort();
    if (existing) {
      existing.conversationCount = agg.conversationCount;
      existing.messageCount = agg.messageCount;
      existing.aiSources = aiSources;
      if (agg.firstActivity && (!existing.firstActivity || agg.firstActivity < existing.firstActivity)) {
        existing.firstActivity = agg.firstActivity;
      }
      if (agg.lastActivity && (!existing.lastActivity || agg.lastActivity > existing.lastActivity)) {
        existing.lastActivity = agg.lastActivity;
      }
    } else {
      merged.set(name, {
        name,
        primaryLanguage: null,
        totalDuration: 0,
        sessionCount: 0,
        conversationCount: agg.conversationCount,
        messageCount: agg.messageCount,
        aiSources,
        firstActivity: agg.firstActivity,
        lastActivity: agg.lastActivity,
      });
    }
  }

  let projects = Array.from(merged.values());

  if (search) {
    const q = search.toLowerCase();
    projects = projects.filter(
      (p) => p.name.toLowerCase().includes(q) || (p.primaryLanguage?.toLowerCase().includes(q) ?? false),
    );
  }

  // Sort by most recent activity (combined across WakaTime + AI), descending.
  projects.sort((a, b) => {
    if (a.lastActivity && b.lastActivity) return b.lastActivity.localeCompare(a.lastActivity);
    if (a.lastActivity) return -1;
    if (b.lastActivity) return 1;
    return a.name.localeCompare(b.name);
  });

  if (projects.length > limit) projects = projects.slice(0, limit);

  return { projects };
}
