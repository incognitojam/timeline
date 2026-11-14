# Vendored reference sources

## Effect

`effect/` is an unmodified source snapshot from [Effect-TS/effect, tag `effect@4.1.2`](https://github.com/Effect-TS/effect/releases/tag/effect%404.1.2), commit `506eef143bcc1750ce58920aac1e45da7265d103`. It matches the `effect` and `@effect/platform-bun` releases resolved by the root `bun.lock`.

The snapshot includes the release's `LLMS.md`, `ai-docs/`, source, and tests. Bun platform implementations live in `packages/platform/bun/`. The installed package's export map and shipped documentation remain authoritative for application imports; upstream publication rewrites the source export targets to `dist/` and copies JSDoc onto overloads.

[The public fixture manifest](../src/scripts/public-release-fixtures.json) records SHA-256 hashes for upstream's public TLS and ZIP test fixtures and the `Config.ts` documentation's placeholder API key. The public release safety checker accepts these exact files at these exact paths; changed contents and other paths still undergo the usual checks. Review and refresh these hashes against the release archive when updating the snapshot.

When updating Effect dependencies, refresh this snapshot from the matching release in `Effect-TS/effect` and update the tag and commit above. Download the release archive into an ignored `.scratch/` directory, extract it there, and replace the entire `repos/effect/` tree, including dotfiles, so removed upstream files cannot remain as stale references. Preserve the upstream contents without local patches or installed dependencies.

Before accepting a refresh, compare `packages/effect/package.json`'s version and `publishConfig.exports` with the installed package's version and `exports`. Run the release's CLI example against the installed package, adapting only its platform runtime to `@effect/platform-bun` when testing with Bun. Use the installed release's examples to check both import paths and API names before adapting documentation from effect-smol's main branch.
