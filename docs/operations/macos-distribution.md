# macOS distribution

Merging the Changesets version PR remains the release approval. After a draft release is created at the tested tag, CI checks that its tag resolves to the release commit, builds a native Apple Silicon app, signs its Mach-O executables and libraries with Developer ID, submits it to Apple, staples the app ticket, creates and signs a DMG, notarizes and staples the DMG, and attaches the DMG plus a SHA-256 checksum to the draft. Once those assets and the appcast have been uploaded, CI publishes the release. Stable tags become latest unless a newer stable version is already published; prereleases remain prereleases.

The package targets Apple Silicon Macs running macOS 14 and later. This is a direct-download distribution, not an App Store submission. See [Apple's Developer ID guidance](https://developer.apple.com/developer-id/) and [notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow).

## Signing setup

An Apple Developer Program membership and a **Developer ID Application** certificate with its private key are required. Export the certificate and private key together as a password-protected `.p12`. Development, Mac App Distribution, and self-signed certificates do not qualify.

Create a GitHub Actions environment named `release` under **Settings → Environments**. Restrict its deployment branches to `main` and leave required reviewers unset to keep merging the version PR as the only approval. Both automatic packaging and manual retries run from `main`, then check out the requested release tag. The packaging job declares this environment directly, which supplies the Apple credentials.

Set these secrets on the `release` environment. Keep the values out of issues, PRs, logs, and the checkout:

| Secret | Value |
| --- | --- |
| `APPLE_SIGNING_CERTIFICATE_BASE64` | Base64-encoded Developer ID Application `.p12`, containing exactly one signing identity |
| `APPLE_SIGNING_CERTIFICATE_PASSWORD` | Password protecting that `.p12` |
| `APPLE_NOTARY_KEY_BASE64` | Base64-encoded App Store Connect team API private key (`.p8`) authorized for notarization |
| `APPLE_NOTARY_KEY_ID` | That API key's key ID |
| `APPLE_NOTARY_ISSUER_ID` | That API key's issuer ID |
| `VITE_MAPTILER_API_KEY` | MapTiler browser API key embedded in the packaged web UI |

The web build requires the MapTiler key before compilation and fails if it is missing. Vite embeds this browser key in the shipped JavaScript; changing the installed service's environment cannot update it. Local builds read `web/.env`. PR builds and browser tests use explicit synthetic keys and do not verify access to live map tiles. Trusted CI builds the service and app on `main` without the `release` environment, so it reads a repository secret with the same name.

The packaging script imports the certificate into a temporary, unlocked keychain scoped to the signing command. It removes the keychain and decoded key files on exit. Signing requires a valid Developer ID identity; missing credentials or rejected notarization fail the build. Bun retains the entitlements from its pinned official runtime when re-signed, including the permissions needed for JIT and native addons.

The DMG window layout lives in `tools/timeline-app/dmg/`: `settings.py` positions the icons for [dmgbuild](https://dmgbuild.readthedocs.io/), which packaging installs from hash-pinned `requirements.txt`, and `render-background.ts` renders the committed background images. Rerun it after changing the layout.

PR CI builds and smoke-tests an ad-hoc-signed app on a hosted Mac without signing secrets. Release packaging smoke-tests again after Developer ID signing. The workflow does not install the app or register background agents on the runner. Test installation and Login Item registration on a real Mac before treating a first release as verified.

## Installing

For a first installation, drag the app to `/Applications`, then configure the service using [macOS host setup](../user/macos-host.md). While the service is down, the menu bar shows why it can't start, such as a missing `AUTH_PASSWORD` and the env file to add it to. Existing `~/Applications/Timeline.app` users should replace that copy instead of creating a second installation. The menu warns when both Applications folders contain a copy. Follow the maintenance hold procedure in the host guide before manually replacing a running installation.

The app supports both Applications locations. Bundled LaunchAgents use `BundleProgram` and a small native launcher that resolves scripts relative to the running bundle and opens logs in the current user's home directory. The signed bundle contains no build-user LaunchAgent paths and requires no plist edits after signing.

The DMG includes the service, web UI, Bun, the Google Messages sidecar, and native service libraries. Existing source setup, config and authentication requirements still apply. Recall capture runs inside the app and requires Screen Recording permission for Timeline plus the external `cwebp` encoder; see [Recall setup](../user/recall-setup.md). Tailscale remains an optional external installation. Neither external tool is silently downloaded by the DMG.

## Native updates

Every build includes [Sparkle](https://sparkle-project.org/documentation/) updates. The feed URL and public verification key live in `tools/timeline-app/Info.plist`. Install the app in `~/Applications` or `/Applications` to enable **Check for Updates…**. Copies opened from a build directory leave updates disabled so they cannot stop the installed service. Automatic checks are enabled; installation asks for confirmation by default. Existing user preferences still apply. Source builds can be replaced by a later release; a branch whose commit count exceeds the next release will not be offered that release.

Set `SPARKLE_ED_PRIVATE_KEY` in the `release` Actions environment to the exported Sparkle signing seed matching the committed public key. Keep a secure backup outside the repository: existing installations trust this key. Packaging requires the secret, checks it against the app's key, signs the notarized DMG in `appcast.xml`, and always uploads the feed alongside the download assets. The signing-check artifact also includes the appcast. Missing or mismatched keys fail packaging.

The release stays a draft until the appcast and download assets are attached. During packaging, the latest-release URL continues serving the previous published stable release.

Before replacement, the app pauses service-agent reconciliation, creates an owned maintenance hold, and waits for the service to stop. Failed preparation refuses termination. The relaunched bundle removes only its own hold and lets the service recover; manual maintenance holds and capture preferences are preserved. Capture stops with the old app and resumes according to those preferences when the new app launches. See [Updating](../user/macos-host.md#updating) for install-on-quit behavior and recovery.

Verify actual replacement in a separate canary macOS GUI account before merging updater changes. Use a separate service port, synthetic data, and disable scheduler, inbox, recall, and Remote Access. Build/sign the test apps on the development account and stage them for the canary; launching and SMAppService registration must happen in the canary's GUI session, not over SSH. The smoke scripts validate packaging and signatures without installing the app. After the enabling change merges, run the signing check to verify the real secret against the committed key, then exercise a release-to-release update in the canary before moving the host. Releases without enabled updates require one manual installation first.

## Failed packaging and retries

To test signing or packaging changes without a version bump, run **macOS signing check → Run workflow** on `main`. It builds the selected run's commit using the same build and packaging scripts as a release, including signing, smoke tests, and notarization. The DMG and checksum are saved as a workflow artifact for seven days; no tag or GitHub release is created. Merge the changes you want to test into `main` first so the workflow can use the `release` environment.

A release remains a draft until packaging and every upload succeed. Readers of latest release, including Settings and the configured Sparkle feed, continue seeing the previous stable release during a failure. Packaging fails if the release tag differs from the expected commit, credentials are missing, signing or smoke checks fail, Apple rejects the submission, or an upload fails. It never installs an unsigned fallback DMG.

For a packaging failure, rerun the failed jobs. The macOS DMG workflow also supports **Run workflow** on `main`, with the existing draft release tag and its full expected commit SHA, to retry after correcting credentials or external failures. Both paths require exactly one release for the tag, find its draft using authenticated `gh release` commands, and publish it when packaging completes. Check for an existing draft before creating one during recovery; duplicate releases for a tag stop the workflow before building, uploading, or publishing. Do not publish the draft manually before its assets are ready. After a workflow-only fix lands on `main`, use **Run workflow** to package the existing tag with the updated workflow; rerunning the original run retains its old workflow. A defect in the tagged build scripts needs a new release containing the fix.

Retries replace same-named assets on the draft so a rebuilt DMG, checksum, and appcast remain consistent after a partial upload or failed publish. Uploads are not atomic: another failure still leaves the release as a draft for retry. An already published release is rejected before building or uploading, including a rerun after publication succeeded but its response was lost; inspect the release state before retrying. Never turn a published release back into a draft to replace its assets; ship a new version. Recovering an older stable draft after a newer stable version has shipped publishes it without changing latest, so Settings and the update feed keep the newer version. Failure to list releases stops publication rather than assuming there is no newer version.

The draft-first sequence supports GitHub release immutability: all assets are attached before publication locks the release. Enabling immutability is a separate repository setting; retries only modify unpublished drafts.

## Google Messages sidecar

Local builds, PR and trusted macOS CI, DMG packaging and the signing-check workflow use the exact Go compiler in `mise.toml`. `build.sh` fails before compilation if Go is missing or differs from that pin. The service artifact builder compiles `tools/timeline-gmessages` for the app's native architecture with CGO disabled, trimmed paths and pinned, vendored dependencies. The resulting executable lives in `Contents/Resources/timeline-service/bin/timeline-gmessages` beside Bun.

The local app build signs it with the hardened runtime. `package-dmg.sh`'s nested Mach-O pass re-signs it with Developer ID and the hardened runtime before app sealing and notarization. It needs no entitlements: it has no JIT, dynamic native addons, app sandbox or protected macOS resource access; ordinary outbound networking and files in the user's state directory require none. `smoke.sh` verifies its signature and runtime flag, executes session-free `--help`, checks the media-contract flag and source archive, and checks the service's default-path resolver against the bundle. No pairing or message dump is part of this check.

The sidecar is AGPL v3 or later. Its license, notice and corresponding-source archive ship under `Contents/Resources/timeline-service/Resources/licenses/timeline-gmessages/`. The archive contains the source actually compiled, vendored dependencies with their notices, and rebuild instructions; the notice also links to `tools/timeline-gmessages` at the release tag (or commit for development builds). This ships source alongside the executable even if the repository link is unavailable. Timeline's separate MIT components retain their license. This describes the distribution measures, not legal advice.
