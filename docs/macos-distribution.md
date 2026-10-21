# macOS distribution

Merging the Changesets version PR remains the release approval. After the source release is published, CI checks that its tag resolves to the release commit, builds a native Apple Silicon app, signs its Mach-O executables and libraries with Developer ID, submits it to Apple, staples the app ticket, creates and signs a DMG, notarizes and staples the DMG, and attaches the DMG plus a SHA-256 checksum to the existing GitHub release.

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

For a first installation, drag the app to `/Applications`, then configure the service using [macOS host setup](macos-host.md). While the service is down, the menu bar shows why it can't start, such as a missing `AUTH_PASSWORD` and the env file to add it to. Existing `~/Applications/Timeline.app` users should replace that copy instead of creating a second installation. The menu warns when both Applications folders contain a copy. Follow the maintenance hold procedure in the host guide before manually replacing a running installation.

The app supports both Applications locations. Bundled LaunchAgents use `BundleProgram` and a small native launcher that resolves scripts relative to the running bundle and opens logs in the current user's home directory. The signed bundle contains no build-user LaunchAgent paths and requires no plist edits after signing.

The DMG includes the service, web UI, Bun, and native service libraries. Existing source setup, config and authentication requirements still apply. Recall capture runs inside the app and requires Screen Recording permission for Timeline plus the external `cwebp` encoder; see [Recall setup](recall-setup.md). Tailscale remains an optional external installation. Neither external tool is silently downloaded by the DMG.

## Native updates

The menu offers **View Downloads on GitHub** in builds without an update feed. This supports the current private repository: sign in to GitHub in the browser to download a release. No GitHub credentials are embedded in the app.

Public distribution can opt into [Sparkle](https://sparkle-project.org/documentation/) updates. In the `release` Actions environment, set `TIMELINE_UPDATE_FEED_URL` and `TIMELINE_UPDATE_PUBLIC_KEY` as variables, and `SPARKLE_ED_PRIVATE_KEY` as a secret. Use `generate_keys` from the pinned Sparkle distribution to generate a key, then export it with `generate_keys -x <private-key-file>`; store the exported base64 seed as the secret, never in the repository. The build embeds only the public key. Keep a secure backup: existing installations trust this key.

For GitHub-hosted updates, use `https://github.com/<owner>/<repo>/releases/latest/download/appcast.xml` as the feed URL. Configured release builds check for updates automatically, ask before installation, and add **Check for Updates** to the menu. Missing or invalid halves of the feed/key configuration fail the build. Packaging verifies the signing key matches the app, generates `appcast.xml` from the notarized DMG, and attaches the feed after the download assets. Publishing a feed requires the release repository to be public; leave these settings unset while it remains private.

Before replacement, the app pauses service-agent reconciliation, creates an owned maintenance hold, and waits for the service to stop. Failed preparation refuses app termination. The relaunched bundle removes only its own hold and lets the service recover; manual maintenance holds and capture preferences are preserved. Capture stops with the old app and resumes according to those preferences when the new app launches.

Before enabling distribution, use the macOS signing-check workflow to verify signing/notarization with the framework included, then exercise an older-to-newer install on a Mac. Confirm the service reports the new version, recording resumes when enabled, and a manual maintenance hold prevents installation. Existing releases without Sparkle need one manual installation of an update-enabled build first.

## Failed packaging and retries

To test signing or packaging changes without a version bump, run **macOS signing check → Run workflow** on `main`. It builds the selected run's commit using the same build and packaging scripts as a release, including signing, smoke tests, and notarization. The DMG and checksum are saved as a workflow artifact for seven days; no tag or GitHub release is created. Merge the changes you want to test into `main` first so the workflow can use the `release` environment.

A GitHub source release may appear before its DMGs. Packaging fails if the release tag differs from the expected commit, credentials are missing, signing or smoke checks fail, Apple rejects the submission, or an upload fails. It never installs an unsigned fallback DMG.

For a packaging failure, rerun the failed jobs. The macOS DMG workflow also supports **Run workflow** on `main`, with the existing release tag and its full expected commit SHA, to retry after correcting credentials or external failures. After a workflow-only fix lands on `main`, use **Run workflow** to package the existing tag with the updated workflow; rerunning the original run retains its old workflow. A defect in the tagged build scripts needs a new release containing the fix. Retries do not overwrite existing release assets; replacing an already uploaded DMG is a separate maintainer decision.

The current Changesets action publishes the source release before assets are attached. Repository release immutability must therefore remain disabled for this flow; enabling immutable releases requires switching to a draft-release publication sequence first.
