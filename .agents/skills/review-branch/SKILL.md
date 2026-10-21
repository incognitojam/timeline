---
name: review-branch
description: Delegate a complete read-only review of the current branch or a specified diff target to this repository's reviewer subagent. Use when the user invokes $review-branch or asks for a full code review using the repository review checks.
---

# Review Branch

Spawn the project `reviewer` subagent with fresh context. Pass only:

- the current worktree path;
- the requested diff target, defaulting to `origin/main...HEAD`;
- acceptance criteria and scope notes stated by the user.

Tell it to review the code, apply the repository review guidance and checks, return findings only, and make no edits. Wait for it to finish and relay its findings packet without performing another review.
