# Mac screen recall

Timeline.app periodically captures on-screen application windows, runs Apple Vision OCR locally, and feeds the results into Timeline as searchable `screen:capture` events. **Recording runs only while Timeline.app is open. Quitting the app stops recording.** The Timeline service continues running independently.

## Setup

1. Install the WebP encoder with `brew install webp`.
2. Install and open Timeline.app using [macOS host setup](macos-host.md), or the signed DMG. Source builds require Xcode command-line tools; DMG users do not need a separate Swift build.
3. Choose **Record Screen** or **Allow Timeline to Record Screen…** from the menu bar app. Approve the macOS permission request and enable **Timeline** in **System Settings → Privacy & Security → Screen & System Audio Recording**. The menu opens that settings pane when permission is missing. Quit and reopen Timeline after granting access if macOS requests it.
4. Enable the `recall` source in the web app's **Sync** page, with its path set to `~/.local/share/timeline/recall`.
5. Enable **Launch at Login** in Timeline's menu if recording should resume after you sign in. macOS may require approval in **General → Login Items**.

Screen Recording permission belongs to Timeline.app. You do not need to locate or grant access to a hidden executable. Keep the same signing identity across source builds to preserve the app's identity: `tools/timeline-recall/create-signing-identity.sh` creates the stable local identity used by the app build. Ad-hoc builds may require renewed permission; signed releases use Developer ID.

## Upgrading from the separate capture executable

The first installed-app launch unregisters the old app-owned `dev.incognitojam.timeline-recall` job and stops any remaining job with that label before enabling in-app recording. A hand-installed plist in `~/Library/LaunchAgents` is renamed with a `.migrated-<UUID>` suffix. Migration failures appear in the menu and prevent the app from starting a second capture loop.

Your pause flag, exclusion file, pending captures, and imported history remain in place. The old `~/.local/share/timeline-recall/timeline-recall` executable is no longer used by the app. If **Timeline** already has Screen Recording access, no new grant is needed. Otherwise, use the menu permission action after upgrading. A grant listed only for the standalone executable does not suffice; that old permission entry can be removed once the new app is recording.

The bundle retains an inert Recall LaunchAgent plist so macOS can unregister its previous identity. It has no capture schedule. There is no longer a Recall agent to kickstart; reopen Timeline to restart capture.

To roll back, quit Timeline and restore the previous app bundle using [macOS host rollback](macos-host.md#updating). That version can register its bundled Recall agent again and still uses the old capture executable and its permission. Do not run both versions at once.

## Recording controls

- **Record Screen** pauses or resumes recording. The existing `~/.local/share/timeline/recall.pause` flag is also honored, including changes made outside the app.
- Capture skips sleeping displays, a locked session, and excluded apps. A tick does not overlap the previous tick. OCR and WebP encoding run off the menu's UI thread.
- The menu shows the latest successful capture time and reports permission, migration, or capture errors.
- When recording stops because of a capture error, lost Screen Recording permission, or a capture that never finishes, Timeline posts one notification until a capture succeeds again. Allow notifications when macOS asks. A stuck capture also writes a stack sample to `~/.local/share/timeline-recall/stuck-<time>.txt` and names that file in the capture log; quit and reopen Timeline to recover.
- Exclude an app by adding its name or bundle identifier to `~/.config/timeline/recall-exclude.txt`, one per line. Blank lines and `#` comments are accepted. An excluded frontmost app skips the whole tick; excluded background windows are also omitted. Changes apply on the next tick.

```bash
# Pause capture; remove the flag to resume while the app is open.
touch ~/.local/share/timeline/recall.pause
rm ~/.local/share/timeline/recall.pause

# Read recent capture diagnostics.
cat ~/.local/share/timeline-recall/capture.log

# Exclude apps.
echo '1Password' >> ~/.config/timeline/recall-exclude.txt
echo 'Tor Browser' >> ~/.config/timeline/recall-exclude.txt
```

## Data flow and storage

The app captures each eligible window with ScreenCaptureKit, recognizes its text with Vision, and compresses the image with `cwebp`. Complete image/JSON pairs are published to `~/.local/share/timeline/recall/<date>/<HHMMSS>-NN.{webp,json}`. The sidecar preserves app identity, window title, OCR text, capture time, geometry, display, and stacking information. The service imports these pairs into the existing recall event and media format, then deletes the input pairs. Content-addressed storage deduplicates identical images.

Unfinished captures are staged outside the import tree and removed when the tick finishes. Staging files left by a quit or crash are cleaned up on the next capture attempt. Unimported image/JSON files older than 90 days are pruned as a storage backstop. Imported images remain in the content-addressed media root.

## Troubleshooting

- **Permission required:** use the menu action and enable **Timeline** in Screen & System Audio Recording. Restart the app after changing the grant if capture still fails.
- **Quit & Reopen leaves Timeline closed:** this was observed after revoking and restoring permission during recording. Open Timeline from Applications again; manual reopening restored capture. The cause of the failed system restart is still unconfirmed.
- **WebP encoder missing:** run `brew install webp`, then enable Record Screen again. Standard Apple Silicon and Intel Homebrew locations are supported.
- **Migration failed:** inspect the menu error before attempting to start the old agent manually. The app blocks new capture until it confirms that the old job is stopped.
- **No new captures:** confirm Timeline is open, Record Screen is enabled, a display is awake, and the frontmost app is not excluded. Check the capture log and the web Sync page.

## Diagnostic CLI

`tools/timeline-recall/build.sh` still builds a standalone diagnostic executable using the same Swift capture engine. It requires its own Screen Recording approval and is not part of normal setup. The historical `capture.sh` remains available for older installations; the current app neither bundles nor invokes it.
