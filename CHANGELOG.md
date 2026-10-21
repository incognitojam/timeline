# Timeline

## 0.12.0

### Minor Changes

- 82e1c0f: Blocked Wi-Fi networks are now one list under Settings → Network instead of a separate list on each sync source. Sources choose whether to avoid them with the new **Skip on blocked Wi-Fi networks** setting. Existing per-source lists are combined into the shared list on upgrade, and the sources that had a list have the setting turned on.

### Patch Changes

- 4564cd7: The macOS DMG now opens to a Timeline-branded window with the app and an Applications shortcut laid out for drag-to-install.
- 29e0785: Fix the packaged macOS service starting without authentication. It now refuses to start, and installation fails its configuration check, until `AUTH_PASSWORD` is set. Previously the packaged service served the API without a password when none was set.
- eff4777: Hide the repeated participant name on conversation cards when it matches the conversation title.
- 11cf719: The menu bar now explains why the service can't start, for example a missing `AUTH_PASSWORD` and the env file to add it to, and warns when Timeline is installed in both Applications folders. The DMG drops its Install.txt in favour of this in-app guidance and a reminder that Timeline lives in the menu bar.

## 0.11.0

### Minor Changes

- c17352a: The `embeddings` sync source can now embed photos as well as text. With its new `index_images` setting on, it embeds the photos of searchable sources from the image itself, fetching any that the local media cache lacks from remote media storage without adding them to the cache. It needs llama-server started with `--mmproj`. Photo vectors are stored apart from event vectors, so semantic search over events is unchanged until photo search is added.
- cab7f06: Timeline's menu opens GitHub downloads for manual updates. Distribution builds can enable automatic update checks and confirmed installation from a signed update feed, stopping the bundled service during replacement and recovering it after relaunch.
- 722cb72: Settings shows the latest GitHub release, its release notes, and a macOS download link, with clear update and release-check failure states.

### Patch Changes

- 491d114: Keep the menu bar's service status concise by showing the release version, with full version, build, and commit details available in web Settings.
- 5957b8e: The `embeddings` sync source now reports how many events are left past its cursor after each run, so its Sync page charts catch-up progress, falling to zero once it has caught up.
- 66058fb: Semantic search memory-maps the vector index instead of copying it through SQLite's page cache, making each search about 13% faster and cheaper in energy.
- 178a68d: The Timeline service now runs at normal priority instead of as a macOS background process, so the web app and API are no longer confined to the efficiency cores and throttled disk I/O. Syncs and imports still run at background priority on their own thread.
- a12c08a: Semantic search no longer holds up other requests while it runs: the service scans the vector index on a dedicated worker thread, with a connection kept open between searches.

## 0.10.0

### Minor Changes

- 40d3793: Semantic search can now stay current on its own. A new `embeddings` sync source embeds the events added since its last run, within a time budget (default one minute), and resumes where it stopped after the embeddings server has been unavailable. Its `require_ac_power` setting skips scheduled runs while the Mac is on battery or in Low Power Mode. `bun run embeddings index` now also caps each request at 64,000 bytes of documents, so runs of long events no longer time out.
- 224b9c4: `bun run embeddings index` keeps several embeddings requests in flight at once, set with `--concurrency` (default 8), which makes indexing roughly 2.5 times faster against a llama-server with 8 slots. Every embeddings request now times out after `[embeddings] timeout_seconds` (default 60). A timed-out request stops the run instead of leaving it waiting forever, and running `index` again resumes where it stopped.
- daf108f: Configure semantic search under `[embeddings]` in `config.toml`: point `base_url` at any OpenAI-compatible server, on this machine or another, and set `document_prefix` and `query_prefix` for models that expect task prompts, such as EmbeddingGemma. The `TIMELINE_EMBEDDING_ENDPOINT`, `TIMELINE_EMBEDDING_MODEL`, `TIMELINE_EMBEDDING_DIMENSIONS`, `TIMELINE_EMBEDDING_PROFILE`, `TIMELINE_EMBEDDING_PROVIDER` and `TIMELINE_EMBEDDING_API_KEY_ENV` environment variables are no longer read; move their values into `[embeddings]` before upgrading, or semantic search reports that it is not configured.
- c4af1d2: Sync resting heart rate, HRV, SpO2, breathing rate and skin temperature from Google Health, so the day health panel and health dashboard keep updating after the Fitbit Web API shuts down. On days both sources cover, Google Health values are used.
- a86a41a: Run screen recall inside Timeline.app and request Screen Recording permission for Timeline from its menu, removing the need to locate a separate capture executable. Quitting Timeline now stops recording; enable Launch at Login to resume after signing in. Existing installations retire the previous Recall background agent and use Timeline's Screen Recording permission.

### Patch Changes

- 1764de6: Bundle the map worker so maps can load tiles in production builds of the web UI and macOS app.
- 29c9d70: Fix contact searches showing empty or incomplete results when source, type, or chat filters exclude recent events. Keep pagination consistent for events with identical timestamps.
- ed9d8d0: Shorten very long events before embedding them, so semantic indexing no longer stops at an event too long for the model's input window.
- 4f58ef5: Prevent the signed macOS app from repeatedly restarting its background agents when macOS reports a bundle-relative executable.
- cb632dc: Discord server pages list a contact once in Top participants and emoji uploaders, combining all of their linked Discord accounts.
- 9dcbca3: Keep the latest description backlog bar at the chart edge.
- bbde97b: Exclude recall capture events from daily activity totals and make activity bars readable when one day is unusually busy.
- 611ece8: Screen recording no longer stops for good when macOS text recognition stops responding. A window whose text recognition takes longer than two minutes now skips that capture, reports an error in the menu and capture log, and later captures keep running.
- 3159bec: Timeline now posts a macOS notification when screen recording stops because of a capture error, lost Screen Recording permission, or a capture that stops responding, instead of only changing the menu bar icon. A capture that stays stuck for five minutes is reported in the menu and capture log with a stack sample to help diagnose it.
- c3c8894: Make search result titles and “this day” links support opening in a new tab.
- b3428ce: Label Discord forwards as quoted previews in conversation exports, truncating long text like replies while retaining media markers and saved photo descriptions. Show when forwarded content is unavailable.
- 6165f26: Include the MapTiler configuration in signed macOS builds so the web UI loads, and reject builds with a missing map key before packaging.

## 0.9.1

### Patch Changes

- eb67a5b: Fix access to signing credentials during automated releases and publish macOS DMGs for Apple Silicon only.

## 0.9.0

### Minor Changes

- 52a6d4f: Sync SMS, MMS and RCS text messages live from Google Messages as a new `google-messages` source, via a paired `timeline-gmessages` sidecar. Media attachments are not imported yet.
- 11e8f09: Discord messages now render inline `<t:…>` timestamps as readable dates instead of raw markup. Conversations show them in your locale and timezone the way Discord does — including relative styles like "2 months ago", with the full date on hover — while exports, MCP results and timeline snippets get an absolute date and time.
- 764d136: Source markers now use consistent monochrome brand and interface icons instead of emoji, with matching sizing across timeline cards, filters, sync views, and map popups.
- e7b375f: Google Messages sync now imports MMS and RCS attachments (photos, GIFs, audio and files) into media storage alongside their messages. Parts the phone reports without a decryption key are recorded as unrecoverable, and media-only messages show an attachment marker in exports.
- fbdf80e: The timeline sidebar's date list now labels each month, keeping the label in view while you scroll through it.
- 804a806: Build Developer ID-signed, notarized macOS DMGs in release CI and attach them with checksums to GitHub releases. Apps use portable background-agent paths and can be installed in either Applications folder.
- 8a7e0cc: Timeline sleep nights from Google Health render as a dedicated card: time asleep, efficiency and time in bed at a glance, with the stage breakdown as coloured totals instead of a "Deep: 99m, Light: 253m" text line.
- a16bcbe: The attachments gallery now charts description queue depth and daily file outcomes across 30-day, 90-day, and all-history views, with exact eligible-file coverage tracked for new runs.

### Patch Changes

- 6503849: File attachments, message badges, health statuses, and other interface controls now use consistent monochrome icons instead of emoji.
- e4eb094: The sidebar activity list now brings the selected day into view when its month finishes loading, so opening a link to an old date or picking a distant year in the calendar scrolls the list there instead of leaving it where it was. Days with no events of their own centre on the nearest earlier day.
- d5b2962: Event cards offer "Show more" only when the preview text is actually cut off, instead of on any content longer than 100 characters.
- 13dae65: Remove the weekly activity pattern from contact details.
- fc391be: Opening a day far in the past no longer makes the sidebar activity list scroll itself forward to the present, loading every month in between.
- 0c473fc: The selected day in the sidebar activity list is no longer marked with an arrow. Its background and outline already say which day is selected, and dropping the arrow stops selection nudging the event counts across.
- 331b8ac: Preserve interrupted jobs and queued follow-ups during graceful restarts, retries, and expired-lease recovery.
- 292e4ce: Start loading the main interface font earlier to reduce the time spent displaying fallback text on a first visit.
- 0c473fc: The selected day in the sidebar activity list now fades its outline in step with its background, instead of the outline snapping into place ahead of it.
- 138f34c: Allow smaller image inputs for attachment descriptions to avoid vision model failures. Set the maximum image dimension in sync settings, API requests, or the CLI; stored originals and the default limit are unchanged.
- bf64f49: Timeline date navigation and calendar activity indicators now load the complete activity index once, eliminating incremental pauses while scrolling through history.
- 27e5062: Google Messages sync now falls back to the thumbnail copy when the phone unlocks only that one, instead of recording the attachment as unrecoverable. Stored dimensions and size describe the copy on disk, while the original's dimensions stay in the event's raw data. Re-syncing a conversation upgrades parts that were previously recorded as unrecoverable.
- 4188339: Show pointer cursors for clickable period controls and section tabs on the health dashboard while retaining the unavailable cursor for disabled controls.
- 7b8480e: Hidden contacts no longer appear in the music friends listening row.
- e29c440: Hiding a contact now removes their events from the timeline, search, recent activity, and the conversations list.
- 8cceca2: Hiding a contact no longer removes the group chats and Discord channels they took part in from the conversations list. Discord server pages stop listing hidden contacts among top participants and emoji uploaders. Deleting a contact now returns its linked identities to the unlinked list instead of losing them.
- c79d490: Use the interface font for chart labels and tooltips and map controls and popups, keeping chart text correctly spaced when the font finishes loading.
- 49d3a01: Use bundled Inter for interface text so typography is consistent across operating systems.
- 146c07a: Keep streamed Markdown content mounted while it updates, preserve spacing between adjacent formatted lines, and honor table column alignment.
- 3e80bd0: Google Messages sync now follows the phone's conversation-list cursor, so conversations beyond the first page (~250) are synced instead of silently skipped.
- 159bbbb: Update chart colors when switching between light and dark themes without reloading the page or resetting current data, legend selections, or zoom.
- b4b84d9: Require authentication for the service status pages at `/status` and `/status.md`, and prevent their responses from being cached.
- b4b5c8e: Timeline now shows proper source names such as Google Messages, Spotify Friends, and Claude Code throughout the interface instead of internal source IDs.
- fc31b19: Charts now respect reduced-motion preferences while preserving zoom and selection when the preference changes.
- 883cd7b: SMS Backup & Restore imports no longer abort the whole file when a message has no address; such rows are counted and skipped.
- af267a1: Use consistent date labels across health charts, with weekdays in Week view and month and year boundary markers. The dashboard keeps its original centered width, and charts fit their margins to the axis labels. Chart cards wrap to fit the available space, and dates stay on a single baseline. Narrow screens use spaced date ticks while retaining every data point and its tooltip. Charts wait for their initial layout and font before drawing, and resize their axes and canvas together to prevent flicker and temporary overlaps. Labels and sizing stay with the displayed data until a new Week, Month, or Year view is ready.
- f3541f6: Show queued and running sync states clearly on source cards and link recent activity sources to their detail pages.
- 3227905: Timeline events no longer repeat your own name as the sender. Your listens, watches and other personal activity drop the sender line entirely, and your own messages read `<You>` instead of your contact name.
- 41334a5: Load Discord server pages faster on large timelines.
- dd05ca6: Refreshing the current timeline window no longer makes dates near overlapping query boundaries briefly show partial activity totals.
- 50efb17: Google Messages sync also fetches the spam & blocked folder; each event records its conversation folder in `raw_data.folder`.
- d0ce115: Remove the redundant Activity subheading above the timeline sidebar date list.
- 283bab2: Tag each version and publish a GitHub release with its changelog notes when the version PR merges. Releases provide source archives only.
- 9c34796: Health charts now show the new year beneath January when a rolling year view crosses a calendar boundary.
- 9a3067b: Allow ordinary sync and import jobs to progress while attachment descriptions wait for inference, while coordinating local database and media work.

## 0.8.2

### Patch Changes

- 694af40: Restore the Timeline product name across the app, status page, documentation, and package metadata.

## 0.8.1

Changelog tracking starts with this release. Earlier changes remain available in the Git history.
