# Recorded query plans

The backend test preload records successful application calls to SQLite's
`prepare`, `query`, `run` and `exec`. It also records SQL submitted through
`DbPool.query` (the worker's `all` operation), `get` and `run` on the main thread,
so the API's pooled reads are covered even though the preload does not run in
Bun workers. Pool paths are classified using a separate readonly connection when
the pool is created. No production module imports the recorder; bindings are not
saved. Direct test fixture SQL is excluded, except where a test supplies SQL to
an application wrapper such as `wrapDatabase`.

On close or at the end of the run, native connection schemas identify Timeline
and app-state, including in-memory fixtures. Mixed-schema fixtures and connections
matching neither schema are excluded. A recorder schema-read
failure cannot prevent the original `close()` call; it is reported by the final
check instead of being thrown into application code.

The preload's final `afterAll` sends the deduplicated recording to a fresh process
so suite mocks and old-schema fixtures cannot change the check's schemas. Replay
only prepares EXPLAIN QUERY PLAN; it never executes recorded SQL. DDL, PRAGMA,
transaction control and EXPLAIN statements are skipped. Batches are split outside
strings, comments and trigger bodies.

`./test.sh` enables full-inventory checks only in CI. Those checks reject stale
allowances, including findings that disappeared, and recordings below
`MIN_FULL_SUITE_STATEMENTS` in `audit.ts`. Local and single-file runs check new
findings without demanding the full inventory: optional tests and SQLite plans
can differ between machines. The preload removes the full-run flag from child
environments so nested test runs do not audit an incomplete suite.

`policy.ts` is the single large/small table policy. It rejects newly added schema
tables without a classification, names that no longer exist, and overlaps between
the two sets. Table scans and full index walks both require review. `SEARCH`
without `USING` also counts as a table scan (for example an unindexed `MAX`).
`LIMIT` can stop a scan early, so this is a conservative plan check, not a claim
that every execution visits every row. Automatic indexes require review even on
intermediate results; temporary sort B-trees alone do not fail the check.

Aliases are resolved against SQL table references, conservatively when reused.
Materialized/CTE result scans are ignored, but underlying scans are checked.
Unresolved ordinary scans fail rather than disappear. Constrained FTS5 MATCH and
rowid virtual lookups are accepted; unbounded FTS scans fail. JSON virtual tables
are not persistent growing tables. Embeddings/sqlite-vec and external source
schemas are outside this two-schema policy.

Fix a new finding by adding an index or rewriting the query. If the scan is
intended, add an entry to `allowlist.json`'s `accepted` array with a real reason;
the failure prints its database and a ready-to-paste entry. Matching uses the
**database, normalized SQL, table and finding kind** (`table:kind`), not SQLite's
exact wording, chosen index name, or covering-index label. Replay exceptions match
the SQL and exact error. A new kind or table still fails for an allowed statement.

The separate `underReview` array holds scans awaiting review. Its size cannot
exceed `MAX_UNDER_REVIEW` in `audit.ts`; new scans must be fixed or explicitly
accepted with a substantive reason. Never regenerate it to silence failures.
CI requires removing obsolete entries and findings from either section.

Coverage remains execution-based. Other worker isolates, ordinary subprocesses,
trigger bodies, arbitrary MCP `run_sql` input, and untested branches are invisible.
The pool interception covers SQL submitted through the public pool methods, not
SQL constructed inside a worker. Bound parameters are left NULL; value-sensitive
LIKE replanning, cardinality, actual rows visited and runtime costs are not assessed.
Keep targeted tests for index selection, join order, trigger probes, partial indexes,
bound-value behavior and avoiding sorts.
