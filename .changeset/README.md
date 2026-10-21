# Changesets

Every pull request records whether it affects a Timeline release. Run `bun changeset` for a release-worthy change or `bun changeset --empty` for tests, documentation, refactors, and other changes that should not appear in the changelog.

Use `patch` for compatible fixes and performance improvements, `minor` for compatible features, and `major` for incompatible changes. Write summaries for people using Timeline rather than as implementation notes.
