---
"timeline": patch
---

The web app and the `/status` page are served with a Content-Security-Policy that runs scripts only from Timeline itself, so script markup that reached a page through imported or generated text, such as a `javascript:` link in a sync error, could not run. The map popup's "View in timeline" button keeps its hover highlight under the policy.
