---
name: database-cleanup-safety
description: Checks destructive SQL, migrations, and backfill scripts for dry-run, backup, idempotence, and verification safeguards.
severity-default: critical
tools: [Bash, Read, Grep]
---

Use this check only when the review target adds or changes SQL, migrations, backfills, cleanup scripts, data-rewrite scripts, or production database runbooks. If the diff does not mutate persisted data, return no findings.

Look for:

- Unbounded destructive operations: `DELETE`, `UPDATE`, `INSERT OR REPLACE`, schema rewrites, or file deletes without narrow predicates tied to source, account, import batch, timestamps, IDs, or another reviewed constraint.
- Missing dry-run path: no `SELECT`/count/sample preview, `--dry-run` mode, or equivalent way to inspect affected rows before mutation.
- Missing transaction/backup assumptions: destructive work does not run in a transaction where appropriate, does not state backup/snapshot expectations, or cannot be safely retried.
- Non-idempotent cleanup: running the script twice would corrupt data, double-apply transformations, or produce misleading results.
- Missing before/after verification: no checks for affected row counts, invariants, sample rows, FTS consistency, service health, or source-specific totals.
- Production safety gaps: hard-coded production paths, credentials, or hostnames; no explicit operator confirmation for irreversible production changes; or behavior that silently falls back to a different database.
- Mixed concerns: behavioral parser changes and destructive cleanup are bundled without a clear reason they must land together.

Report the smallest safe fix: add a dry-run, narrow the predicate, wrap in a transaction, add verification, split the change, or escalate for human approval. Treat real irreversible production-risk findings as blockers.
