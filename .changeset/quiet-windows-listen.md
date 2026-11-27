---
"timeline": minor
---

Pilot conversation windows for semantic search: choose one source under Conversation windows on the embeddings Sync page, or run `bun run embeddings index --windows <source>`, to also embed its conversations as windows of consecutive messages. `semantic_search` and `bun run embeddings search` then list the nearest conversations, with a time span and an `#id` for `export_conversation`, after the single-event hits, which are unchanged. Embedding runs now log documents and bytes per second, and the semantic-search eval can score events, windows or both, and how many expected conversations reach the top results.
