---
"timeline": patch
---

Every MCP tool now has a title for clients to show, and tells them whether it reaches outside Timeline: only `semantic_search` does, sending its query to the embeddings endpoint (`openWorldHint`). `save_memory_note` and `delete_memory_note` say they can overwrite or delete a note and that repeating a call changes nothing more, so a client can ask before running them.
