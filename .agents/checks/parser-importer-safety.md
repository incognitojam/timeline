---
name: parser-importer-safety
description: Checks parser, importer, and sync changes for idempotence, source ID stability, and data preservation risks.
severity-default: high
tools: [Bash, Read, Grep]
---

Use this check only when the review target changes parsers, sync sources, import scripts, event normalization, source IDs, timestamps, raw data handling, or database writes for imported events. If the diff does not affect ingestion/import behavior, return no findings.

Look for:

- Source identity regressions: `source_id`, `source`, or `source_account` changes that can collide, become unstable across re-runs, or collapse multiple raw records into one event.
- Idempotence gaps: re-running the importer/sync would duplicate rows, leave stale rows, or fail to update previously imported events correctly.
- Stale-row risk: changing source ID generation without a cleanup/backfill plan, dry-run query, or explicit decision that old rows can remain.
- Silent timestamp defaults: invented timestamps or fallback values that mask missing source data. Derive timestamps from raw evidence where possible; otherwise preserve nulls or fail loudly at the boundary when the value is required.
- Raw boundary validation: values read from exports, APIs, `raw_data`, or optional metadata are narrowed from `unknown` or validated before string/date/number-specific parsing; malformed optional fields should not crash imports unless the field is required by the source contract.
- Raw data loss: dropping original source fields from `raw_data` without an explicit storage reason and test coverage, especially fields needed for future reprocessing.
- Normalized content/schema drift: new event types, content block shapes, tags, or normalized metadata emitted by a parser are handled by downstream formatters, exporters, renderers, and search/context surfaces, or are explicitly rejected with tests.
- Multi-account regressions: changes that ignore or conflate `source_account`, account config, or import batches.
- Incremental sync regressions: cursor/state changes that can skip history, repeat work indefinitely, or make backfills impossible.
- Test gaps for risky cases: missing coverage for duplicate/missing IDs, repeated imports, multiple accounts, absent or malformed timestamps, raw export schema drift, or newly emitted normalized content shapes.

Report concrete data-safety or correctness risks with file/line evidence and the expected failure mode. Do not require broad migrations or full backfills when the current change is explicitly read-only or scoped to future re-sync behavior; mark those as backlog or uncertain instead.
