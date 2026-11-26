---
"timeline": patch
---

Screen recall keeps capturing after Apple's text recognition hangs. Recognition now runs in a separate OCR worker process that Timeline ends and replaces when a recognition takes longer than two minutes or the worker exits, so the next capture works without restarting Timeline.
