---
"timeline": patch
---

`bun run embeddings search` now rejects unrecognized flags instead of searching for them as text; put query text that starts with a dash after `--`. Invalid `embeddings` flags now print the error with the command's usage instead of a raw JSON error, `--version` prints `embeddings v<version>`, and a `SIGTERM` during `embeddings index` exits with 130 instead of 0.
