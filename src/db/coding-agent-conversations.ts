import { CHAT_ASSISTANT_SOURCES, CODING_AGENT_SOURCES } from "../shared/grouping";

// raw_data field naming each source's coding project (or a workspace path the
// project is derived from). claude-code derives it from the title instead.
const PROJECT_FIELDS: Partial<Record<(typeof CODING_AGENT_SOURCES)[number], string>> = {
  conductor: "$.repo_name",
  t3code: "$.project_title",
  amp: "$.workspace_roots[0]",
  opencode: "$.project_path",
  codex: "$.cwd",
};

const WORKSPACE_PATH_SOURCES = ["amp", "opencode", "codex"] as const;

const CONDUCTOR_WORKSPACES = "/conductor/workspaces/";

function sqlList(values: readonly string[]): string {
  return values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", ");
}

export const CODING_AGENT_SOURCES_SQL = sqlList(CODING_AGENT_SOURCES);
export const CHAT_ASSISTANT_SOURCES_SQL = sqlList(CHAT_ASSISTANT_SOURCES);

/**
 * SQL expression for the coding project a coding-agent event belongs to,
 * evaluated against the events row `ref` (e.g. `NEW`). Matches the per-source
 * rules in coding-projects.ts:
 *   - claude-code: title prefix before " (" ("<project> (<slug>)")
 *   - conductor / t3code: the raw_data field as-is
 *   - amp / opencode / codex: workspace path, rolling Conductor workspaces
 *     (`.../conductor/workspaces/<repo>/<workspace>`) up to `<repo>`,
 *     otherwise the path's basename
 * Yields NULL when the event carries no project.
 */
export function codingAgentProjectSql(ref: string): string {
  const fieldCases = Object.entries(PROJECT_FIELDS)
    .map(([source, path]) => `WHEN '${source}' THEN '${path}'`)
    .join(" ");
  const marker = `'${CONDUCTOR_WORKSPACES}'`;
  return `(
    SELECT NULLIF(CASE
      WHEN ${ref}.source = 'claude-code' THEN
        CASE WHEN INSTR(${ref}.title, ' (') > 0
          THEN SUBSTR(${ref}.title, 1, INSTR(${ref}.title, ' (') - 1)
          ELSE ${ref}.title
        END
      WHEN ${ref}.source IN (${sqlList(WORKSPACE_PATH_SOURCES)}) THEN
        CASE WHEN conductor_at > 0
          THEN SUBSTR(conductor_rest, 1, INSTR(conductor_rest || '/', '/') - 1)
          ELSE SUBSTR(trimmed, LENGTH(RTRIM(trimmed, REPLACE(trimmed, '/', ''))) + 1)
        END
      ELSE value
    END, '')
    FROM (
      SELECT
        value,
        RTRIM(value, '/') AS trimmed,
        INSTR(value, ${marker}) AS conductor_at,
        SUBSTR(value, INSTR(value, ${marker}) + ${CONDUCTOR_WORKSPACES.length}) AS conductor_rest
      FROM (
        SELECT CASE WHEN typeof(extracted) = 'text' THEN extracted END AS value
        FROM (
          SELECT CASE WHEN ${ref}.source IN (${sqlList(Object.keys(PROJECT_FIELDS))}) THEN
            CASE WHEN json_valid(${ref}.raw_data)
              THEN json_extract(${ref}.raw_data, CASE ${ref}.source ${fieldCases} END)
            END
          END AS extracted
        )
      )
    )
  )`;
}
