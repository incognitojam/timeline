---
"timeline": minor
---

Keyword search matches whole words and their other endings, so `POI` no longer finds "point" while `run` still finds "runs" and "running". End a word with `*` to match words starting with it, or quote words to match them exactly as written. The search page explains this syntax and offers a `*` search when a partly typed word finds nothing. The first service start after updating builds a new search index, which takes about a minute on a large timeline.
