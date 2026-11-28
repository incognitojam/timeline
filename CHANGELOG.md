# Timeline

## 0.22.0

### Minor Changes

- 09e30d5: Import Claude conversation category ZIPs individually or from a multipart export folder, with bounded writes and read-only preview counts. Preserve the operator's account identity and require confirmation before importing under a new account when Claude history already exists.
- 89423a3: Import Claude memory files and project memories with stable identities. Retain the legacy conversation memory without duplicating it and archive prior raw data when memory content changes.
- cd95726: Import Claude projects with their instructions and full documents. Link memories and infer conversation project tags only from unambiguous exact memory-path segments matching exported projects.
- bcab1f8: Import Jellyfin video playback history from an activity-log export. Timeline preserves the original evidence and labels start-to-stop durations as estimated elapsed time.
- 817e868: Call recordings now import Cube ACR `.amr` files from an inbox folder, such as Cube's Google Drive backup pulled by rclone. The audio is kept in Timeline's media store with a browser-playable copy made on macOS, and a recording without a number waits in the inbox until exactly one call in Timeline overlaps it. The call-transcribe `calls` sync source is gone.
- 6cd4c78: Discord DMs and group DMs have a Refresh button in the conversation header. It fetches just that conversation's new messages, up to 500 a click, and shows how many arrived. It waits behind a sync that is already running ("Queued"), and a second click joins the refresh already on its way. It appears only on conversations the full Discord sync has already collected.
- 5433e11: Add an optional Discord DM pass, turned on in Sync settings, that brings new DMs and group DMs in every 2 minutes (editable) without waiting behind other syncs. A pass with nothing new is one request and shows as one "No changes" row an hour in the sync history; after an error or a rate limit it waits longer before trying again. Scheduled runs of other sources that find nothing to do now fold into one row an hour the same way. A full Discord sync that cannot list your DMs now fails at that point, before syncing servers, instead of quietly treating every DM as hidden.
- 93ce902: The Refresh button also appears on channels and threads in Discord servers synced in full, fetching just that channel's new messages. Channels in servers synced sparsely, and excluded channels, have no Refresh button.
- 329bf65: Import movie and episode sessions from selected Jellyfin users with Playback Reporting.
- c721c38: `get_updates` can keep an agent's place under a name it chooses: pass `checkpoint: "<name>"` and each catch-up starts where that name last finished, so an agent no longer has to carry `id:<n>` between chats. A checkpoint unused for 90 days is cleaned up. A reply that starts from a checkpoint says where the catch-up that moved it began, so a reply lost in transit can be asked for again. Continuing a long catch-up now takes the single `cursor` the reply prints, replacing `until` and `skip`.
- 79fb21d: `get_updates` now opens with a one-line index of every conversation with new messages, then shows direct messages and conversations you took part in before channels you only read. Calendar events, call recordings, Trakt shows and place visits get one line each instead of a count, events from an old export arriving late are summed per source with their date range instead of being listed, and a conversation titled by a phone number shows the contact's name beside it.
- e8fd3c7: Refresh a Google Messages conversation from its header when it maps to one phone thread on the paired account. Refresh includes reactions from the usual one-hour overlap and waits for a running sync. If the thread has never finished syncing, Refresh reads its available history.
- 43a4c1f: Agents can now ask about a contact you have hidden. Hiding someone still keeps them out of what an agent is shown without asking, such as catch-ups, searches and the contact list, which now says how many hidden contacts it left out. But an agent that names them, by name, id or identifier, or opens one of their messages by id, gets their profile, messages and conversation like anyone else's, and `get_contact_info` says they are hidden.
- 22dab4b: Agents can read, update and delete a memory note about a hidden contact when they ask for it by name, and `get_contact_info` lists it. Such notes are still left out of the memory index an agent reads first, which now says how many it left out. The Memory page, the Claude import preview and the contact delete dialog no longer say that these notes are kept from agents. The delete dialog's warning that deleting would let agents read a hidden contact's notes is gone, and an import is no longer refused because a contact was hidden or shown after the preview.
- bf7a83f: A conversation an agent opens by id now shows everyone's messages, a hidden contact's included, instead of reading as though they had never spoken. Catch-ups and broad searches still leave a hidden contact's own messages out. Where a visible message mentions a hidden contact, quotes them, forwards their message or shows their poll vote, agents now see it with their name, as the web app shows it, instead of "someone".
- 70ffcce: Code blocks in Markdown are syntax-highlighted, in colours that follow the light or dark theme, with the language shown above the code. This covers coding-agent and AI chat messages, day summaries, journal reflections, release notes and Discord embeds. The highlighter downloads only when a page first shows a code block.
- 88cf431: MCP tokens can be managed with `timeline-service mcp-token create --label <label> [--read-only] [--tailnet-only]`, `list` and `revoke <id or label>`, without editing the env file or restarting. A read-only token's sessions are not offered the tools that change anything, and a tailnet-only token is refused over public access. Revoking a token stops it on its next request, including in sessions it already opened. `list` and the MCP sessions page show which token was used and by which client. Tokens in `MCP_TOKENS` keep working with full access.
- b3274c0: The MCP page lists `get_updates` checkpoints: each name, when the events it has caught up to were added, when it was last used and when it is cleaned up if unused. Deleting one there makes the next call with that name start afresh, 7 days back; no Timeline data is removed.
- 3965d63: MCP `query_events`, `get_context` and `semantic_search` list events in a more compact form, like a conversation export: a `## <day>` line, a `[source/type]` line (or `[source] <conversation>` for messages) for each run of events that share it, then one `HH:MM #<id> …` line per event, in UTC. Times no longer show seconds, offset timestamps are converted to UTC, Spotify listens no longer repeat the track name, texts and calls show their direction (`sms:sent`, `call:missed`), and previews stay on one line. Results are 25–40% smaller for day and contact queries.
- f3a7c50: The MCP `get_context` tool takes `same_conversation: true` with an `event_id` to show only the events around it in that event's own chat, channel or DM, instead of everything else that happened at the same time.
- 52dbd5b: The MCP `query_events` tool takes `exclude_source`, as `get_context` does. A keyword search with no `source`, `contact` or `exclude_source` now leaves out AI-assistant sessions and screen recall, the sources the web search already leaves out by default, and its first line names them; pass `exclude_source: ""` to search them too.
- 311161c: Add a `get_updates` MCP tool for catching an agent up in one call: messages added since its last check, grouped by conversation, one line a day of sleep, resting heart rate, HRV and other health records for the last two weeks on a broad check, and a count per source of other new events. Each conversation is headed with the id to pass back, and the last page ends with the checkpoint to pass next time, which also picks up old messages imported late.
- 64406a8: The MCP `query_events` and `semantic_search` tools take `group_by_conversation: true` to return one line per conversation (or per source and type for events outside one) instead of the events: its hit count, the dates of its first and last hit, and an event id to pass to `export_conversation`. A keyword search now shows every conversation it touches, rather than only those among the newest 50 hits. Calls without the option return what they did before.
- 812f56e: Contacts marked hidden are now left out of Timeline's MCP tools, as they are on the web app's timeline pages. `list_contacts` no longer lists them. Keyword search, date browsing, `get_context`, `semantic_search` (with any conversation window that holds one of their messages) and conversation grouping leave out the events filed under a hidden contact: a DM with them disappears, and a group chat keeps everyone else's messages. Memory notes linked to a hidden contact are left out of `list_memory` and the connect-time memory index. `run_sql` still reads every row, and `search_mcp_tool_calls` replays earlier results.
- c718556: The MCP `query_events` and `get_context` tools now start their results with a line saying how many events are shown, which end of the matches they are (oldest or newest first), and, when more match, the `cursor` to pass for the next page. For a contact, it also gives the total number of matching events (counted up to 10,000), replacing the old "Events found" line, which only counted the page.
- 4ddd8e4: The MCP `get_schema` tool without a source now explains how to write correct SQL for `run_sql`: `conversation_id`, both full-text tables, how `people` maps to contacts through `identities`, which types are messages, the UTC timestamp conventions, Spotify `artist:` tags, worked queries including who sent each message, and each source's event count and latest date instead of every type's count. With a source it also lists that source's types. The note on `#<id>` event ids moved from four tool descriptions into the server instructions.
- a1cc36f: The MCP sessions page lists MCP tokens with their flags, creation time, last use and last client, creates one (with the read-only and tailnet-only options) and shows it once with a copy button, and revokes one after a confirmation. Tokens from `MCP_TOKENS` are shown only as a count.
- 6f11dab: Timeline's MCP server offers 13 tools instead of 17, and its tool list is 23% smaller (17,494 to 13,450 characters measured, with the rest of this release's MCP changes). `get_summary` is gone: `query_events` with `group_by_conversation`, `get_schema` and `run_sql` cover what it showed. `list_mcp_sessions` and `get_mcp_session` are now part of `search_mcp_tool_calls`: pass `sessions: true` to list sessions, or `session_id: "current"` (or a session id) for one session's details and calls; an unknown id is an error. `remember_contact_fact` is gone: save a fact about a person with `save_memory_note` and its `contact` parameter. `get_contact_info` lists the memory notes linked to a contact, and still shows the facts saved on the contact before, which are kept as they were.
- bb866e6: On the Memory page and a project's page, notes linked to a contact you have hidden now sit in a collapsed "Hidden notes" group at the end instead of among your other notes, as hidden contacts are kept out of sight elsewhere. The note counts on project rows leave them out. People's notes no longer say "hidden contact" beside the contact's name. The page of a note about a hidden contact says once that the contact is hidden in Contacts. The Claude import preview says which notes will be listed under Hidden notes.
- 6d958a6: Import from Claude on the Memory page now says which file to upload and where to get it, and accepts `claude-memory-<date>.zip` from claude.ai's **Settings → Your Claude → Memory → Export memory** as well as `memories-000.zip` from the full data export. Any other file gets a message naming the two accepted files.
- 37dea61: Import the memory claude.ai has built up from its data export's `memories-000.zip`, from **Import from Claude** on the Memory page. A preview shows the notes it would add per kind and project, the ones already in memory and the files it cannot import; Import then adds the new notes in one go, never changing an existing note. A note's details can now be up to 16,000 characters.
- 5a92a50: Import from Claude now previews memory in plain words: each place the notes go, by project title, with counts such as "9 people" or "3 topics" that open to the note titles. Every person note shows which contact it will link to and why, or why it will not, and you can pick a different contact or choose not to link before importing. A note matched to a hidden contact says so; hidden contacts appear in the contact search once you tick "Show hidden contacts when choosing".
- 69a6ad8: A person's memory note now shows the contact it is linked to, or "Not linked to a contact", and you can choose a different contact or remove the link from the note's page. The page says when the contact is hidden, and asks before it saves a change. Restoring an earlier version of a note keeps its current contact. On the Memory page, people's notes that are not linked to a contact are marked "Not linked".
- 7bcbe97: Add a Memory page for the notes agents save over MCP: browse them by kind and project, edit or delete a note, view and restore its previous versions, and restore recently deleted notes. Each project has a "Use account memory" switch; turned off, `list_memory` for that project lists only its own notes.
- 0013254: The Excluded page shows each played playlist's cover beside its name, with a placeholder when none is cached. The Spotify sync now keeps a playlist's cover when it looks up the playlist's name, so covers appear for playlists it first sees after this release; playlists it had already named show the placeholder unless the playlist follower sync tracks them.
- 0e2df54: The Music page's Excluded page lists the playlists the live sync recorded plays from, with their play counts and when each was last played, so any of them can be left out of the top lists without first finding one of its plays.
- 12c1532: Leave a track, album, artist or playlist out of the Music page's top tracks and top artists, and optionally leave out private-session plays. The Music page links to a new Excluded page that lists them, with a way to include each again. Excluded plays still count in the Plays total and stay everywhere else in Timeline; a playlist can only be excluded from plays the live sync recorded it for.
- 76a2c46: Pilot conversation windows for semantic search: choose one source under Conversation windows on the embeddings Sync page, or run `bun run embeddings index --windows <source>`, to also embed its conversations as windows of consecutive messages. `semantic_search` and `bun run embeddings search` then list the nearest conversations, with a time span and an `#id` for `export_conversation`, after the single-event hits, which are unchanged. Embedding runs now log documents and bytes per second, and the semantic-search eval can score events, windows or both, and how many expected conversations reach the top results.
- d202270: Remote Access now serves Timeline to your tailnet only, with Tailscale Serve, and never to the public internet. After updating, a node that was set up with Funnel switches to tailnet only on its own, without logging in again. Hosted clients such as Claude.ai custom connectors can no longer reach the service. The menu shows "Remote Access: tailnet only" and offers **Copy URL**.
- 164f5b3: Remote Access can make Timeline's MCP endpoint reachable from the internet for 5 minutes, 1 hour or 1 day, with **Make Public on the Internet** in the menu bar app; other public requests are refused. While it is public, the menu says so and shows when it ends; **Stop Public Access** ends it early. It also ends when you turn Remote Access off, when you quit Timeline, when the Mac restarts, and at launch or wake once the time has passed.
- f7d66f0: Give every connected AI agent one shared memory through Timeline's MCP server. Agents list, read, save and delete notes about you, people, topics and projects, and each connection starts with your `you` notes and the memory index in the server's instructions.
- 70d76bc: Tailnet users can upload files to named inbox sources with a revocable, login-pinned token instead of the service password.
- c7cafd3: A top track's "Exclude from top lists" menu on the Music page now offers the playlist its plays in the selected range came from, as recent plays already do. It offers the most played playlist, and a second one when it accounts for at least a fifth of the track's plays.
- 70bacb3: The menu bar app's **Settings** submenu now shows and changes whether Timeline checks for updates automatically and whether it downloads and installs them automatically. Automatic installation could previously be turned on only in the window that appears when an update is found.

### Patch Changes

- b5d1f89: If preparing `app-state.db` fails when a process first opens it, for example because another writer held the lock too long during an upgrade, the next attempt opens a fresh connection and prepares it again, instead of running against a half-prepared database until the service restarts.
- 7eb9c4f: When attachment descriptions can't find a usable model, the error on the Sync page now names the provider each model resolved to, for example "the provider lmstudio for google/gemma-4-e4b is unavailable" or "sol/google/gemma-4-e4b is not listed by provider sol", so a model saved without its provider prefix is easy to spot.
- 00c3996: Deleting a contact that has memory notes linked to it now asks whether to keep those notes, unlinked, or delete them too, where they stay restorable under Recently deleted on the Memory page. Either way no note is left pointing at the deleted contact, and a restored note comes back unlinked.
- a990982: Choosing a contact on the People page shows their name and avatar straight away, with placeholders where their details and recent events will go, instead of keeping the previous contact on screen until the new one loads. The avatar and name glide from the list into the contact header in browsers that support view transitions (unless reduced motion is on), the tab title names the contact, hovering a contact starts loading them, and returning to the page scrolls the list to the selected contact. A contact whose photo loads now shows it in the header even when the previous contact's photo failed to load.
- 361e017: Opening a conversation from Messages, AI chats, coding sessions or a contact's conversations shows its title and tab title straight away instead of the source name, with placeholder messages where the transcript will land. From the Messages, AI chats and coding sessions lists, the source badge and title glide from the row into the conversation header in browsers that support view transitions (unless reduced motion is on), hovering a row starts loading the conversation, and going back scrolls the list to the conversation you opened.
- d6b3d6a: Opening a conversation stays on the newest message as the page settles and attachments load.
- 18ca4c4: Copying selected conversation messages now wraps the transcript in a Markdown code fence, so it stays separate from your own text when pasted into a chat with an AI assistant.
- a4e030c: Download smaller macOS edge updates from recent edge builds and the latest stable build.
- dd0909c: The Discord DM pass now checks every full page of 100 messages, not only a DM's first, before storing it, so a page that skips ahead of the stored messages fails the pass instead of losing the messages in between. This costs one extra request for each full page.
- 9af9cbc: Edge builds check for updates every hour instead of once a day, so a Mac following the edge feed more often gets a small patch instead of the full download. Stable builds still check daily.
- 8cd0172: Offer a smaller macOS download when updating from the previous stable release.
- 8976658: Rebuilding the people index (`verify-event-people --force-rebuild`) is much faster for large group chats and reuses the old index's space instead of growing the database file. The verifier now names the database, event count and SQLite version and library it uses, refuses a SQLite older than 3.38 and a rebuild of a missing or empty database, and exits 2 for a rebuild that rolled back and 3 for one that committed but did not verify. The macOS host guide has a runbook for the rebuild and a rehearsal script that runs it on a copy first.
- 1d8306c: Editing an event that lists the same person more than once, such as a note with a contact added twice, no longer fails with a database constraint error.
- cb26b39: `verify-event-people --force-rebuild` now stops before changing the people index when its check finds drift, and says when a rebuild has committed before checking it; `--rebuild` still rebuilds to repair drift. The macOS host guide's rebuild runbook verifies once instead of twice, holding the service for about 31 minutes, gives the times and space measured on a 3.4-million-event database, and raises the free-space floor to 10 GB, which the rehearsal checks against the same figures.
- aad7593: Inbox uploads become visible to importers only after the complete file has been written.
- f2ad75d: `get_updates` with the `conversation_id` of a conversation that has no title now says there is nothing new, instead of reporting the id as unknown, when nothing was added to it since the checkpoint.
- d03be23: Timeline now ships with Bun 1.4.5 and SQLite 3.54.1.
- 752b1c3: In a group conversation, a message now counts for the person who sent it rather than for every member: contact and identity event counts, a contact's conversations, events with a person, and hiding a contact follow the sender. Hiding a contact no longer hides other people's messages in groups they belong to. Messages indexed before this release keep counting every member until the people index is rebuilt.
- fdd73b8: Day summaries and journal reflections no longer flash raw Markdown such as `**` or an unclosed link while they are still being written. Markdown images whose address is not a web or Timeline address, such as `data:` or `javascript:`, are no longer shown, matching the rule links already followed.
- 8bbd5db: The MCP page has a **Connect a client** section that walks through adding Timeline to claude.ai: turning on public access, which token to create, and the `/mcp` URL to paste with a copy button. It says whether public access is on, and until when, as the menu bar app records it, and warns when it is off.
- 56547d8: Creating an MCP token now opens a dialog: a label, the **Read-only** and **Tailnet only** options with what each is for, and then the new token with the steps to connect it, the URL and the `Bearer` header value ready to copy. A tailnet-only token gets the steps for a client on the tailnet or the Mac instead of claude.ai's. The page keeps a folded **Connect a client** entry with the same steps for later, and closing the dialog clears the token from the page.
- c028d20: The MCP endpoint answers a request without credentials with a `WWW-Authenticate: Bearer` challenge, and such requests no longer count toward the lockout for wrong tokens over public access, so a hosted client's credential-less checks cannot lock its address out. Over public access, OAuth discovery requests under `/.well-known/` get `404 Not Found` instead of `403`. Each refused MCP request is logged to `service.log` (path kind, status, whether an `Authorization` header was sent, a shortened User-Agent), at most 60 lines a minute, never the token or the full source address.
- 693f109: The Memory page lists projects as rows you open, each with its own page (`/memory/project/<key>`) holding its notes and its account-memory setting. A project's note leads back through a Memory › project breadcrumb, and deleting it returns to the project. Going back to Memory or a project, by Back or by a link, returns to where you had scrolled, and a note opened from the list shows its title, tab title and content at once while it loads.
- bd1b968: The Memory pages now scroll the whole browser window instead of a box inside the page. Back and Forward return each one to where you left it, and so does a page's own back link ("‹ Memory", or a note's project) when you came from that page. On a phone, the browser's own scrolling now applies there, such as the address bar collapsing as you scroll.
- c2b8b87: The menu bar app's status lines, such as "Service: not responding" and "Remote Access: tailnet only", are dimmed again so they stand apart from the actions, and clicking one no longer does anything. Right after the app starts or restarts the service, the menu shows "Service: starting…" without the warning icon; it changes to "Service: not responding" if the service has not answered after a minute.
- 41fa9f9: The menu bar app's action items show their icons on macOS 27.
- fd72207: The Music exclusions page's back link now matches the playlist and Memory pages: "‹ Music" on its own line above the heading.
- e3ab62e: A Music playlist page's header keeps the cover beside the title, as in the Music list, with the back link and Open in Spotify on their own line above it, so the cover and title no longer swap places as they glide between the list and the page. A long playlist name, cut short in the list, wraps in full on its page, and a title that wraps differently on the two pages keeps one shape for the glide and changes shape only as it lands.
- 1d00ac4: Opening a tracked playlist from the Music page shows its name and cover straight away instead of waiting for its history, and the cover glides from the list into the playlist header and back again in browsers that support view transitions (unless reduced motion is on). The tab title now names the playlist.
- a810966: The playlist cover's move between the Music page and a playlist is slower and easier to follow, and the cover no longer fades while it moves. The playlist name now moves with it, from its row into the playlist heading. A playlist row that is partly hidden under the bottom navigation bar or a list's edge is scrolled into view first, instead of the cover jumping out on top of them.
- 746d8e2: The menu bar app now checks from the internet side that public access really answers. After Funnel comes on, Remote Access reads "public until …, checking…" until a request through Tailscale's public address gets an answer, then "public until …". If it never answers within 15 minutes, the menu says it is not confirmed reachable, why, and offers Check Again.
- bed9be4: Public access in the menu bar app now survives an app update. Funnel goes off while the update installs; the reopened app shows "Public access resumes after the update" with Stop Public Access, then "making public…" and "public until" with the same end time. It resumes only within 5 minutes of the update's quit, before the end time, and if neither the Mac nor `tailscaled` restarted in between. Quitting Timeline yourself still ends it, and after a crash or force-quit Timeline now starts tailnet only instead of resuming an unexpired share.
- e3635ed: Sync history now shows repeated scheduled deferrals with the same reason as one row, such as "Deferred 43 times, 16:02 to 16:58", instead of one row per check. A row covers at most one clock hour.
- 0a33a10: A Discord DM check that finds nothing new now reads "No changes" instead of "Deferred" on the source page, in /status and in the service log, and counts as a successful run; only runs that were really put off still count as deferred.
- 64bfaf1: If a text recognition worker is still running after Timeline sends it KILL, Timeline stops waiting for it and tries a fresh worker on the next capture. If a second worker gets stuck too, captures are skipped until one of them exits.
- aac3c97: Screen recall keeps capturing after Apple's text recognition hangs. Recognition now runs in a separate OCR worker process that Timeline ends and replaces when a recognition takes longer than two minutes or the worker exits, so the next capture works without restarting Timeline.
- fd5e182: Recall now records a dedicated video player's window without its image while the player is playing, even when it plays in a window rather than fullscreen. The record keeps its app, window title and time, and windowed playback is marked `video_playback` (fullscreen playback is still marked `fullscreen_video`). While a player is playing in one window, its other windows are recorded without images too. The players are Infuse, IINA, VLC, QuickTime Player, Apple TV, mpv, Plex, Plex HTPC, Movist and Movist Pro. Paused players, browsers and other apps are captured as before.
- 357e80e: The conversation Refresh button's icon now spins the way its arrows point.
- 50df86a: After you choose a **Make Public on the Internet** duration, the Timeline menu shows "Remote Access: making public…" until Funnel turns on or fails, and does not offer the choice again meanwhile. If it fails, an alert now says why, with the same text and **Enable Funnel in Tailscale…** button as the menu.
- 3b9c843: When **Make Public on the Internet** fails, the Timeline menu now says why instead of silently staying tailnet only. If the device lacks the `funnel` node attribute, it says Funnel is not allowed for this device, tells you to allow it in your tailnet's access controls, and offers **Enable Funnel in Tailscale…** when Tailscale provides a link. The menu's copy item is now **Copy URL** in both modes.
- 1c0f6da: The Spotify sync now fills in covers for playlists it had already named before it started storing covers. It looks up at most 10 per run and each playlist only once, including playlists that have no cover or that Spotify will not return. Their names are left as they are.
- 2cf4831: The Sync page lists sync sources that have no saved settings under **Not set up**, so an opt-in source such as Discord DMs can be found and turned on there. Turning one on moves it to the main list.
- 5b682f0: The menu bar app's menu is shorter. While public, Remote Access reads "Remote Access: public until 18:15" with **Stop Public Access** and **Copy URL** at the top, and the menu bar icon becomes a globe until public access ends, even while the service is not responding. The address, **Make Public on the Internet** and **Turn Off Remote Access** move into a **Remote Access** submenu once the node is running. **Launch at Login**, **Restart Service**, **Check for Updates…** and the service version move into a **Settings** submenu; while the service is not responding, its status and **Restart Service** still show at the top. "Recall: recording" no longer repeats the ticked **Record Screen**. Action items have icons.
- d2dff82: Scheduled rclone inbox pulls now download only files matching the source’s configured patterns.
- ad8050f: Restrict public Tailscale Funnel access to MCP and rate-limit public token use and authentication failures.
- e7ce2ae: The web app and the `/status` page are served with a Content-Security-Policy that runs scripts only from Timeline itself, so script markup that reached a page through imported or generated text, such as a `javascript:` link in a sync error, could not run. The map popup's "View in timeline" button keeps its hover highlight under the policy.

## 0.21.0

### Minor Changes

- 65e2e4c: Recall no longer stores screenshots or OCR text of fullscreen video. While VLC, Infuse, a browser, or another player shows video fullscreen, the window is still recorded with its app, title, and position, without an image.

### Patch Changes

- e31e1f7: When the local media cache exceeds its limit, evict the oldest R2-backed media down to 90% of that limit to leave room for new media. More old media may remain offsite until opened and restored on demand.
- 0d97309: Codex sync skips unchanged rollout files while tracking parent rollouts, and commits new events and attachments in short batches. Use the parser’s --full flag to reread all files.
- 045d51f: Claude Code sync skips unchanged session and subagent logs, leaves unchanged title suppression untouched, and commits new events and attachments in short batches. Use the parser’s --full flag to reread all files.
- 0db77c9: Stop waiting after the final failed Discord request attempt, and use a maintained attachment-recovery index instead of scanning recent message JSON on every sync.
- 81dd9b2: Avoid scanning Discord message history on every sync when looking for polls needing voter capture. The first start builds the pending-poll index once.
- 636d43d: Show refused Discord poll voters as unavailable instead of recording an empty vote list. Stop retrying permanent refusals and rotate transient failures so older polls can still be captured.
- 107479b: Skype imports now decode numeric character entities, so emoji and other characters written as `&#128578;` appear as the character in message text and names. Events already imported are unchanged.
- 9731901: Skip the full media eviction inventory when a fresh filesystem size check shows the cache is below its limit, so idle maintenance releases other sync jobs sooner.
  
  Scheduled runs record an estimated cache size when skipping inventory; exact cache and evictable totals are recorded only on full runs. They run the full inventory at least on the first scheduled run after six hours to catch filesystem accounting differences.
- 7ed40aa: Google Health syncs now keep each event's id and leave unchanged events alone, so links to Google Health events stay valid and syncs with nothing new finish quickly. The sync status reports added and updated events separately.

## 0.20.0

### Minor Changes

- 4fd5d1a: The status page and the Sync view now warn when a source has gone quiet: its newest event is older than the source normally goes without new events. Each source's newest event time is listed on `/status`, `/status.md`, and its sync card.

### Patch Changes

- a51bc40: Retired sources with no registered sync or current importer event types now show “Not checked: source retired” instead of quiet warnings. Historical events and stored sync settings are preserved.
- 0933480: Show actionable Monzo sync failures instead of the Bun version banner, and fail promptly when a background sync needs login or app approval. Retry temporary API failures without misreporting them as expired credentials.

## 0.19.0

### Minor Changes

- b72902c: Enable native macOS updates in every build, with automatic checks and a prompt before installation.

## 0.18.0

### Minor Changes

- bd2a3e8: Play a call recording's audio from its card on the timeline, read on demand from call-transcribe's folder. Recordings with only an AMR original say that no playable copy exists yet.
- 8917ee5: Keyword search leaves out events containing a word written with a leading `-`, such as `running -club`, or a quoted phrase such as `-"running late"`. A search made only of excluded words lists every other event that matches the filters.
- 2760ad1: Link each call recording to the call it recorded, from the phone call log or any other source with calls, so the day view shows the call and its recording as one card. Links appear as soon as either side is imported.
- 5abc64b: Import call recordings and their transcripts from call-transcribe's `calls` command. Each recording appears on the timeline as a call with its transcript, which is searchable and included in day summaries.
- 1cecafa: Keyword search matches whole words and their other endings, so `POI` no longer finds "point" while `run` still finds "runs" and "running". End a word with `*` to match words starting with it, or quote words to match them exactly as written. The search page explains this syntax and offers a `*` search when a partly typed word finds nothing. The first service start after updating builds a new search index, which takes about a minute on a large timeline.

### Patch Changes

- b7fc35f: Publish releases only after the signed macOS DMG, checksum, and configured update feed are attached, keeping the previous stable release available while packaging runs or is retried.

## 0.17.5

### Patch Changes

- a559da5: Ship the matching Google Messages sidecar with Timeline.app, so app updates no longer require a separate sidecar installation. Existing pairing state and explicit binary overrides are preserved.
- 8af9918: Number source-built macOS apps like releases so they are only offered updates with a higher build number.

## 0.17.4

### Patch Changes

- e7342ad: Make agent-log, Claude export, WakaTime export, Monzo, and shared import CLIs show help without opening storage and reject unknown flags instead of importing. Existing import paths, account defaults, and supported flags are unchanged.
- 578e150: Avoid downloading Google Messages attachments again when a verified full-size copy is already stored. Missing or corrupt files are fetched and repaired, and thumbnails remain eligible for full-size upgrades.
  
  When upgrading, rebuild and reinstall `timeline-gmessages` from `tools/timeline-gmessages` alongside Timeline. Older sidecar binaries do not support the new sync protocol.

## 0.17.3

### Patch Changes

- a1a9468: Stop the image description job failing every run while the machine serving its model is offline. When the provider answers but no longer lists the model, scheduled runs are now skipped with a reason on the sync page and resume when the model is listed again. A manual run still fails, and says the model is not listed instead of claiming it is not vision-capable.
- edf2ae2: Image descriptions no longer stall while another sync or import is running. The description job keeps describing images and writes the finished descriptions together as soon as the other job finishes.

## 0.17.2

### Patch Changes

- bf1493b: Fix the macOS menu bar last-capture time showing “in 0 sec” and keep the elapsed age current between captures, including while the menu is open.
- 05684be: Stop the Discord sync from taking 12–17 minutes once a day. The daily search for new active threads is now spread across the day's syncs, a few channels at a time, so every sync stays close to its usual length and every channel is still searched at least once a day. An interrupted sync no longer restarts the search from scratch.

## 0.17.1

### Patch Changes

- 951e73d: `bun run embeddings search` now rejects unrecognized flags instead of searching for them as text; put query text that starts with a dash after `--`. Invalid `embeddings` flags now print the error with the command's usage instead of a raw JSON error, `--version` prints `embeddings v<version>`, and a `SIGTERM` during `embeddings index` exits with 130 instead of 0.
- b39fd62: Conversation views now show the sender and timestamp again when someone sends a message five minutes or more after the previous one, instead of only when the sender changes.
- 805cced: Google Takeout zips no longer stop the background worker, and Search, Location History and Google Fit now import from them.

## 0.17.0

### Minor Changes

- 9a44849: Import Claude Code and Codex sessions from another machine with the new **Remote agents** sync source. Timeline generates its own SSH key from the source's settings page, shows the `authorized_keys` line to install on the remote machine alongside the read-only `tools/timeline-export` wrapper, and asks you to confirm the host key fingerprint on **Test connection**. Imported sessions use the account you set (for example `alice@laptop`), so they stay separate from the Timeline host's own. A remote machine that is asleep or offline is recorded as a deferred run until its last successful pull is older than the configured limit (24 hours by default), after which the run fails.
- 2fb8a34: A T3 Code or styal thread is now the single listed conversation for the agent sessions it drove: the matching Claude Code, Codex and OpenCode transcripts stay stored and searchable but no longer appear as separate conversations or as worktree-named projects on the Coding page. T3's throwaway title-generation Claude sessions are no longer imported, and ones already imported are hidden the same way.
- 2fb8a34: T3 Code sync now reads current T3 Code and styal databases (`statev2.sqlite`): threads import with per-turn provider and model, tool calls, proposed plans, reasoning, image attachments, and subagent threads linked to their parent. Scheduled syncs read only what changed since the previous run, with a full read once a day to catch rows that landed late, and an unrecognised database schema fails the sync instead of importing part of it.

### Patch Changes

- 75f9dc7: Events from the retired Steam Friends and Google Location Sharing sources now show readable names instead of raw ids, and Google Location Sharing uses the location icon.
- 9a44849: Deferred sync runs now say why they were deferred, such as a blocked Wi-Fi network: `/status.md` shows the reason next to the run, and the run history in the web app shows it when you hover over **Deferred**.
- 2b269dd: T3 Code sync no longer holds the database write lock for a whole run. It compares rows without the lock, so a sync with nothing new takes no write lock, and writes what changed in short transactions, so other sources and writers keep working during a long rename, archive or first import. A run that fails partway is finished by the next one.

## 0.16.1

### Patch Changes

- ea896b3: Google Messages now syncs every 30 minutes by default instead of every hour, so new texts appear sooner. An interval you've set for the source still applies, and the sync dashboard shows the new default. Each sync asks your phone for data, so set a longer interval if you notice extra battery drain.
- fe225fd: Spotify Friends picks up new listens again, and friends who had dropped out of the old feed return. It now reads Spotify's listening-activity feed, so a listen stays one event when a friend pauses or seeks.

## 0.16.0

### Minor Changes

- 3deb425: Google Messages conversations now show reactions, with a count and who reacted, as other messaging sources do. Reactions added or removed shortly after a message arrives are picked up by later syncs. Custom reactions appear as an icon because their images exist only on the phone. Rebuild and reinstall `timeline-gmessages` to see who reacted; it can be installed before or after this release.

### Patch Changes

- 1b9144a: Discord messages built with Components V2 now appear in conversations as cards with their text, thumbnails, galleries, files and separators, instead of as empty messages. Buttons and menus are shown but can't be clicked, and images whose Discord links have expired show a placeholder. Newly synced messages are searchable by their card text. Conversations, exports and assistant tools show card text on existing messages too. Existing messages become searchable after the next render sweep.

## 0.15.1

### Patch Changes

- 0c825c5: The Coding page's project list loads again on large databases. It now comes from the maintained conversation tables and takes under a second instead of running past the server's 30-second limit.
- 648cffb: Google Messages syncs time out far less often and usually finish much faster: the sidecar asks the phone for smaller pages, retries a page the phone did not answer, and normally stops listing conversations once it reaches ones older than the last clean run. Rebuild and reinstall `timeline-gmessages` before upgrading Timeline, because this release passes the sidecar a new flag.

## 0.15.0

### Minor Changes

- be64e43: Chat assistant conversations (claude.ai and ChatGPT) move out of Messages to a new AI chats page in the navigation, with search, a source filter, and pagination. Old Messages links filtered to a chat assistant redirect there.
- a1f8817: Messages no longer lists coding agent sessions (Claude Code, Codex, Amp, OpenCode, Conductor, T3 Code). They move to a searchable list on the Coding page that you can filter by source, by project, or to sessions with no project, and each project page links to its filtered list. Old Messages links filtered to a coding agent redirect there.

## 0.14.0

### Minor Changes

- c4c57c1: OpenCode imports now read OpenCode's `opencode.db` database, so sessions from OpenCode 1.2 onward, including OpenCode 2, appear in Timeline alongside those from the older JSON `storage/` folder, each message once. Point the OpenCode source at OpenCode's data directory (usually `~/.local/share/opencode`); a `storage/` folder or an `opencode.db` file on its own still works. Reasoning and failed tool calls now appear in imported OpenCode turns.

### Patch Changes

- 25a8b7b: Re-importing, renaming or archiving a long conversation no longer stalls syncs for minutes. Updates that leave a conversation's title, timing and membership unchanged, such as raw-data refreshes, skip the conversation list entirely, and renaming or deleting every message of a conversation now takes time proportional to its size instead of its size squared.
- 7c47e80: Skype, Google Keep, and Minecraft imports now write each export in a single transaction, so large imports are much faster.
- 4be9f8b: Screen recording no longer reports an outage after a single failed capture. Timeline now waits for three failed captures in a row before showing an error or posting the "Timeline stopped recording your screen" notification, and it removes that notification once capturing works again.
- 9bc35c9: The desktop navigation rail now keeps Attachments, MCP sessions, and Evaluations behind a More menu, so every Explore destination stays visible on shorter windows, including when sign-in is enabled.

## 0.13.1

### Patch Changes

- 463b3da: The Settings page's update check now queries GitHub releases without credentials. Previously it sent the GitHub sync token, so an expired token made the check fail with "GitHub denied the release check" even though the releases are public.

## 0.13.0

### Minor Changes

- cf04388: Keep steps, activity, active zone minutes, and weight updating from Google Health after the Fitbit Web API shuts down. On dates Google Health covers, the health dashboard and day panel use its values; earlier Fitbit records are kept. Google Health step counts combine the watch with phone step counting, so they can be higher than Fitbit's on days the watch was not worn all day. VO2 max is not available from Google Health.

### Patch Changes

- 0e7aede: The service now prepares its database before syncing starts. Previously, when a derived table such as conversation summaries needed rebuilding (a fresh install, a restored backup, or a copied database), a sync could collide with the rebuild, so the service failed with "database is locked" and kept restarting. Startup logs how long database preparation took.
- cf04388: Remove the Fitbit Web API sync source. Google Health now supplies the same displayed metrics except VO2 max, which is no longer collected. Existing Fitbit history and Google Takeout imports remain available.
- cf04388: Provide a reusable macOS embedding-server LaunchAgent template that avoids slow model wake-ups causing background indexing to time out.
- cf04388: Speed up release validation by running test suites and browser shards in parallel while requiring every check to pass before publishing.
- cf04388: Remove the Google Location Sharing and Steam Friends sync sources, along with the Steam activity panel on contact pages. Existing events from both sources stay in the database and appear on the timeline as individual events. Saved settings for either source are ignored with a startup warning.

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
