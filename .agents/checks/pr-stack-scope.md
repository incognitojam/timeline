---
name: pr-stack-scope
description: Checks a PR in a stack for correct scope, dependency context, and base-branch metadata.
severity-default: high
tools: [Bash, Read, Grep]
---

Use this check only when the review target appears to be one PR in a stack of dependent PRs. Evidence can include a branch/PR base other than the default branch, PR text mentioning a stack or prior PRs, linked prior PRs, or review instructions that name the PR's position in a sequence. If the change appears standalone, return no findings.

Look for:

- Scope mismatch: the diff implements work explicitly reserved for a later PR, or omits functionality required by this PR's stated acceptance criteria.
- Future-PR scaffolding: new interfaces, helpers, config, schema, or UI are introduced only for a later PR and have no usable path in this one.
- Wrong review base: the PR targets or is reviewed against the wrong base branch for its position in the stack. If available, inspect `gh pr view --json baseRefName,headRefName,title,body,url` and `git branch --show-current`.
- Missing stack metadata: PR title/body does not identify the prior PR/base dependency or the PR's position in the stack in reviewer-friendly terms.
- Wrong issue semantics: when the stack is tracked by a GitHub issue, PR metadata uses `Closes #N` on a PR that is not the final one (intermediate PRs should use `Refs #N` or `Part of #N`).

Report only actionable findings. Include evidence from the diff, PR metadata, branch metadata, or stated plan. If stack context is unavailable but materially needed, report `uncertain` rather than inventing requirements.
