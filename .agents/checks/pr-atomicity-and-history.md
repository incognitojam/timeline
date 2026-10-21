---
name: pr-atomicity-and-history
description: Checks diffs and PR metadata for atomic scope, no dead code, single source of truth, and repository git hygiene rules.
severity-default: medium
tools: [Bash, Read, Grep]
---

Review the change for repository hygiene that linters will not catch. If PR metadata is available, inspect it with `gh pr view --json title,body,baseRefName,headRefName,url` when useful. If metadata is unavailable, review only the diff.

Look for:

- Non-atomic changes: unrelated behavior, formatting, renames, dependency bumps, generated files, or documentation rewrites bundled into one diff without a necessary shared reason.
- Dead code or scaffolding: new helpers, config, APIs, schemas, components, or tests with no caller, no exercised path, or no feature flag.
- Duplicated source of truth: constants, config values, types, schema facts, or business rules defined in multiple places instead of imported or derived.
- Comments/docs that restate or contradict code, types, or schema instead of adding non-obvious context.
- Commit/PR title/body issues when visible: missing `<scope>: <description>` style, overlong/vague titles, or closing keywords (`Closes #N`) on partial work.
- Dependency changes without a checkable reason, compatibility review, or usage in the same logical change.
- Broad rewrites caused by formatting or mechanical churn that make behavioral review harder.

Report only issues that materially affect reviewability, correctness, maintainability, or repository history. Do not block on style preferences already enforced by formatters/linters unless the diff hides behavior or violates a documented rule.
