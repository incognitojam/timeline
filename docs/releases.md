# Releases

Timeline uses Changesets to record release intent independently of its scoped commit titles. Every pull request must add either a release note with `bun changeset` or an empty decision with `bun changeset --empty`.

Choose `patch` for compatible fixes and performance improvements, `minor` for compatible features, and `major` for incompatible changes. Changelog summaries should describe the effect for somebody using Timeline rather than the implementation.

The Release workflow runs on every push to `main` and does one of three things, decided by Changesets:

- **Pending changesets**: it creates or updates a release pull request, which applies them to propose the next product version, update `CHANGELOG.md`, and synchronize the macOS bundle version. Its title includes the proposed version so you can identify the release before opening it. Review that PR to see the release notes before publishing.
- **No changesets and the current version is untagged**, which is the push that merges the version PR: it runs static, backend, and frontend checks alongside sharded browser tests, including the full chart sweeps and Linux visual snapshots. Once every check passes, `bun changeset git-tag` names the `v<version>` tag. The workflow creates that tag at the tested commit and publishes a GitHub release from it with the matching changelog entry. If the tag cannot be created at that commit, the run fails before any release is published.
- **Otherwise**: nothing.

**Merging the version PR is the release approval.** No separate approval, dispatch, or manual tagging is needed. The workflow needs **Actions → General → Allow GitHub Actions to create and approve pull requests** enabled, and existing branch review/check requirements still apply. It never pushes commits directly to `main`.

Timeline remains a private package. `privatePackages.tag` lets Changesets tag it, and the publish step runs the tag-only command instead of npm publishing. Changesets owns tag naming; the workflow creates the tag and the release itself, so a release can only be published at the commit that was tested.

If the publish run fails before the tag is pushed, rerun the Release run for the version PR's merge push; a rerun uses that same commit. If the tag was pushed but the GitHub release was not created, create the release from that tag in GitHub's Releases UI with the matching `CHANGELOG.md` entry, since reruns skip existing tags. If tests fail for a reason a rerun cannot fix, land the fix with a changeset and merge the next version PR; the skipped version keeps its changelog entry but never gets a tag. Never move a published tag.

The root `package.json` is the source of truth for the product version. `tools/timeline-app/Info.plist` is a checked mirror maintained by `bun run version:sync`; `bun run version:check` rejects drift. The web package is private and has no independent version.

`CFBundleVersion` is a separate numeric build identifier. Local builds use the committed value from `Info.plist`. Packaging CI derives `TIMELINE_BUILD_NUMBER` from the tagged commit’s reachable commit count with `scripts/print-build-number.sh`, so retries use the same number and subsequent releases on `main` advance it.

After Changesets publishes a release, the macOS DMG workflow builds the tagged source on an Apple Silicon runner, signs and notarizes it, then attaches the DMG and checksum. See [macOS distribution](macos-distribution.md) for the required signing secrets and failure recovery. The source release can exist while packaging is still running or has failed.

## Release information in Settings

Settings displays the latest stable GitHub release and its notes. Packaged installations compare their product version with that release; source builds show release information without claiming to be current. A macOS download link appears after the DMG is uploaded. Checking in the browser does not install an update on the host.

The service makes the GitHub request and shares checks across browsers for one minute. Private repositories use `GITHUB_TOKEN` from the service environment, or the token already configured in `~/.config/timeline/github.json`. The token needs permission to read repository releases and never reaches the browser. Set `TIMELINE_RELEASE_REPOSITORY` to `owner/name` to use a different release repository. Public repositories can be checked without credentials. Permission, network, and metadata failures appear as failed checks rather than an “up to date” result.
