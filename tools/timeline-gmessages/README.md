# timeline-gmessages

The Google Messages sidecar for Timeline's `google-messages` sync source. It
wraps Beeper's [`libgm`](https://pkg.go.dev/go.mau.fi/mautrix-gmessages/pkg/libgm)
(the reverse-engineered Google Messages for Web protocol) and is kept as a
separate Go binary: libgm is AGPL and has no TypeScript port. Timeline runs
`dump` as a one-shot subprocess each sync and imports the JSONL it prints
(`src/platforms/google-messages`); this binary owns the Google session.

It never sends messages or changes anything on the account. The phone must be
online — everything is proxied through the Messages app on it.

Sync setup for Timeline is in [docs/user/source-setup.md](../../docs/user/source-setup.md);
the rest of this file covers building, pairing, and the CLI.

## Build

Timeline.app builds, signs and ships this sidecar alongside its Bun runtime. App users do not need Go or a separate installation. Pair with the bundled executable as described in [Google Messages setup](../../docs/user/source-setup.md#google-messages-setup).

For standalone development or Linux, build from the same revision as the service:

```bash
mise install go
cd tools/timeline-gmessages
mise exec -- go build -mod=readonly -trimpath -o timeline-gmessages .
mkdir -p ~/.local/share/timeline-gmessages
cp timeline-gmessages ~/.local/share/timeline-gmessages/
cd ~/.local/share/timeline-gmessages
```

The standalone default is `~/.local/share/timeline-gmessages/timeline-gmessages`. Rebuild and copy it when upgrading the service. An explicit **Sidecar binary** setting overrides both packaged and standalone defaults. The state directory is independent of the executable location.

`mise.toml` pins the build compiler; `go.mod` declares the module's minimum Go version and pins libgm and other dependencies, verified by `go.sum`. App builds require the pinned compiler, disable automatic toolchain downloads and CGO, and target the same native architecture as the app. This directory is a standalone Go module, separate from Bun/TypeScript.

## License and corresponding source

This sidecar is distributed under [GNU AGPL v3 or later](LICENSE). The separate Timeline app and service remain MIT licensed. App bundles include `Resources/timeline-service/Resources/licenses/timeline-gmessages/` with the license, a notice linking to this directory at the release tag (or commit for development builds), and `source.tar.gz`. That archive contains the actual build inputs, vendored dependency sources and their license notices, and `BUILDING.txt` for offline dependency builds with the documented Go compiler. The archive does not contain sessions, cookies or message data.

## 1. Extract account cookies

In a **private/incognito window** (so the cookies don't rotate out from under
you), sign in at
<https://accounts.google.com/AccountChooser?continue=https://messages.google.com/web/config>.
Once the page has loaded, open DevTools → Network, reload, right-click the
top `config` request → **Copy as cURL**, and paste the whole thing into
`cookies.txt` in the state directory (`~/.local/share/timeline-gmessages` by default). The tool extracts the Cookie header itself.

It also accepts a raw `Cookie:` header line, a bare `SID=...; HSID=...`
string, or a JSON object of cookie name→value. Required cookies: `SID`,
`HSID`, `SSID`, `OSID`, `APISID`, `SAPISID` (plus `__Secure-1PSIDTS` when
present). `OSID` lives on `messages.google.com`, the rest on `.google.com` —
the Copy-as-cURL route captures all of them in one go.

> Chrome with Device Bound Session Credentials (DBSC) won't yield usable
> cookies — use Firefox, or disable DBSC via chrome://flags. DBSC is the main
> long-term risk to this whole approach.

`cookies.txt`, `session.json`, and `media/` are gitignored — they are secrets.

## 2. Pair

```bash
cd ~/.local/share/timeline-gmessages
~/Applications/Timeline.app/Contents/Resources/timeline-service/bin/timeline-gmessages pair
```

Adjust to `/Applications` if installed there. For standalone installations, use `./timeline-gmessages pair`. The remaining CLI examples assume a standalone binary in the state directory; app users should substitute the bundled executable's absolute path.

It prints an emoji; confirm the matching one on your phone
(Messages → Settings → Device pairing). On success it writes `session.json`.
Delete `session.json` to re-pair.

## 3. Dump

```bash
# Everything, to a file:
./timeline-gmessages dump > dump.jsonl

# Quick probe: ~50 messages per conversation, inbox only:
./timeline-gmessages dump -folder inbox -max-messages 50 > sample.jsonl

# Include media (downloads + decrypts attachments into ./media):
./timeline-gmessages dump -media ./media > dump.jsonl

# Incremental: only messages at/after a Unix-ms timestamp, skipping idle conversations
./timeline-gmessages dump -since 1780000000000 > delta.jsonl
```

Output is one JSON object per line, tagged by `kind`:

- `contact` — participant id, name, number
- `conversation` — id, name, folder (`INBOX`, `ARCHIVE`, `SPAM_BLOCKED`), group flag,
  type (SMS/RCS), participants
  (`participant_id`, `number`, `name`, `is_me`)
- `message` — id, conversation id, ms timestamp, direction (`incoming`,
  `outgoing`, `system` for tombstone banners such as "Texting with …
  (SMS/MMS)", or `unknown`), protocol status name, message type
  (`sms`/`mms`/`rcs`), sender participant id/number/name, text, subject,
  reply-to, reactions, media. The phone reports a message's current reactions
  each time the message is fetched. Each entry in `reactions` is `emoji`, `type`
  (the protocol's `EmojiType` name), and `participant_ids` (keys into the
  conversation's participants, including invisible ones):
  `{"emoji":"❤️","type":"RED_HEART","participant_ids":["586"]}`. An `EMOTIFY`
  reaction carries a UUID as its `emoji`; its image exists only on the phone.
  Binaries built before this format emit `reactions` as bare strings, one per
  entry, with custom reactions as the same UUID. Timeline accepts both.

- `conversation_done` — every page of that conversation was fetched (the
  consumer may advance its cursor); `conversation_error` — it could not be
  fully paged even after retries (the cursor must not advance)

Conversation records always precede their messages, and each conversation
ends with `conversation_done` or `conversation_error`. `-cursors` takes a JSON
object of per-conversation `since` values (`-` reads it from stdin), which is
how Timeline resumes. `-list-until` stops listing a folder after a page entirely
older than a Unix-ms timestamp, relying on the phone listing the most recently
active conversations first; Timeline passes it between its daily full listings
so a typical sync only asks the phone for the first page of each folder. This
is the contract consumed by
`src/platforms/google-messages/parser.ts`. Inspect it:

```bash
jq -r 'select(.kind=="message") | .message_type' dump.jsonl | sort | uniq -c
jq 'select(.kind=="message") | .timestamp_ms' dump.jsonl | sort -n | head -1  # oldest message
```

## 4. Watch (session longevity)

```bash
./timeline-gmessages watch
```

Holds the session open, logging incoming message events and a heartbeat every
5 minutes. Leave it running to see how long a session stays alive.

## Media

The sync source runs `dump` with `-media` pointing at a per-run staging
directory in the state dir and moves each file into Timeline's media storage
as it imports the message. It also passes `-existing-media` with a per-run JSON
manifest of full-size stored copies, keyed by message ID then media ID. Each
candidate has an absolute `path`, byte `size`, and `sha256`. The sidecar checks
that file's size and hash before emitting `status: "cached"` without a staging
path; missing or corrupt copies are downloaded again. Thumbnail copies do not
qualify, so a later run can still fetch the full attachment. App updates keep this contract matched; standalone users must rebuild the sidecar
alongside the sync source.

Google keeps a smaller copy of every attachment beside the full-size one, under
its own media ID and decryption key. Some messages arrive with only the
thumbnail's key, in which case that copy is downloaded and the record's status
says `thumbnail` rather than `stored`; `size` is then the bytes on disk while
`width` and `height` still describe the original. A part with no key for either
copy is reported as `unavailable`.
