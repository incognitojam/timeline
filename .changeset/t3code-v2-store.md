---
"timeline": minor
---

T3 Code sync now reads current T3 Code and styal databases (`statev2.sqlite`): threads import with per-turn provider and model, tool calls, proposed plans, reasoning, image attachments, and subagent threads linked to their parent. Scheduled syncs read only what changed since the previous run, with a full read once a day to catch rows that landed late, and an unrecognised database schema fails the sync instead of importing part of it.
