---
"timeline": patch
---

Google Messages syncs time out far less often and usually finish much faster: the sidecar asks the phone for smaller pages, retries a page the phone did not answer, and normally stops listing conversations once it reaches ones older than the last clean run. Rebuild and reinstall `timeline-gmessages` before upgrading Timeline, because this release passes the sidecar a new flag.
