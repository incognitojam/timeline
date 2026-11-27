---
"timeline": minor
---

Add an optional Discord DM pass, turned on in Sync settings, that brings new DMs and group DMs in every 2 minutes (editable) without waiting behind other syncs. A pass with nothing new is one request and shows as one deferred row an hour in the sync history; after an error or a rate limit it waits longer before trying again. Scheduled runs of other sources that find nothing to do now fold into one row an hour the same way. A full Discord sync that cannot list your DMs now fails at that point, before syncing servers, instead of quietly treating every DM as hidden.
