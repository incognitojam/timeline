import type { Database } from "../../db/sqlite";
import { LARGE_TABLES } from "./policy";
import { identifier, tokens } from "./sql";

export interface Finding { table: string; kind: "table-scan" | "index-scan" | "virtual-scan" | "automatic-index" | "unresolved-scan"; detail: string }
export interface Plan { details: string[]; findings: Finding[] }

export function explain(db: Database, sql: string): Plan {
  // Unbound parameters are NULL. This checks the generic prepared plan, not
  // value-sensitive LIKE recompilation or LIMIT-dependent execution counts.
  const details = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map(row => row.detail);
  const known = new Set((db.query("SELECT name FROM sqlite_schema WHERE type IN ('table','view')").all() as { name: string }[]).map(row => row.name));
  known.add("sqlite_master");
  known.add("sqlite_schema");
  const intermediate = new Set(details.flatMap(line => /^(?:MATERIALIZE|CO-ROUTINE) (.+)$/.exec(line)?.slice(1) ?? []));
  const aliases = new Map<string, Set<string>>();
  const parts = tokens(sql);
  for (let i = 0; i < parts.length; i++) {
    if (!/^(FROM|JOIN|UPDATE|INTO)$/i.test(parts[i] ?? "")) continue;
    const table = identifier(parts[i + 1] ?? "");
    if (!known.has(table) && !intermediate.has(table)) continue;
    const alias = identifier(parts[i + (parts[i + 2]?.toUpperCase() === "AS" ? 3 : 2)] ?? "");
    if (!aliases.has(alias)) aliases.set(alias, new Set());
    aliases.get(alias)?.add(table);
  }
  const findings: Finding[] = [];
  for (const detail of details) {
    const index = /USING (?:COVERING )?INDEX ([\w]+)/.exec(detail)?.[1];
    const match = /^(SCAN|SEARCH) (\S+)/.exec(detail);
    if (!match) continue;
    const name = identifier(match[2] ?? "");
    const tables = new Set(aliases.get(name) ?? [name]);
    if (known.has(name)) tables.add(name);
    if (/AUTOMATIC/.test(detail)) {
      for (const table of tables) findings.push({ table, kind: "automatic-index", detail });
      continue;
    }
    if (match[1] === "SEARCH" && /\bUSING\b/.test(detail)) continue;
    if (/^SCAN \d+ CONSTANT ROWS$/.test(detail)) continue;
    if (name === "constant" || name.startsWith("(subquery-") || (intermediate.has(name) && !known.has(name))) continue;
    // FTS5 labels constrained MATCH/rowid lookups SCAN too. Other virtual
    // tables (e.g. json_each) are not persistent growing application tables.
    if (/VIRTUAL TABLE/.test(detail)) {
      for (const table of tables) {
        if (!LARGE_TABLES.has(table)) continue;
        if (/VIRTUAL TABLE INDEX \d+:[^ ]*(?:M\d|=)/.test(detail)) continue;
        findings.push({ table, kind: "virtual-scan", detail });
      }
      continue;
    }
    for (const table of tables) {
      if (intermediate.has(table) && !known.has(table)) continue;
      if (LARGE_TABLES.has(table)) findings.push({ table, kind: index ? "index-scan" : "table-scan", detail });
      else if (!known.has(table)) findings.push({ table, kind: "unresolved-scan", detail });
    }
  }
  return { details, findings };
}
