#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
REPO_ROOT="$(cd ../.. && pwd)"
source "$PWD/sparkle.sh"
work="$(mktemp -d "${TMPDIR:-/tmp}/timeline-updater-smoke.XXXXXX")"
trap 'rm -rf "$work"' EXIT
app="$work/Timeline.app"
output="$work/updates"
mkdir -p "$output"
ditto "${1:-Timeline.app}" "$app"
cp Info.plist "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Set :CFBundleVersion 999999' "$app/Contents/Info.plist"

# Fresh synthetic keys exercise the real signing tools without the login keychain.
bun -e '
  const { generateKeyPairSync } = await import("node:crypto");
  const keys = generateKeyPairSync("ed25519");
  const seed = keys.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  await Bun.write(process.argv[1], seed.toString("base64"));
  await Bun.write(process.argv[2], pub.toString("base64"));
' "$work/private-key" "$work/public-key"
chmod 600 "$work/private-key"
TIMELINE_UPDATE_FEED_URL=https://example.com/appcast.xml \
  TIMELINE_UPDATE_PUBLIC_KEY="$(cat "$work/public-key")" \
  bun run update-config.ts "$app/Contents/Info.plist"
codesign --force --sign - "$app"
codesign --verify --deep --strict "$app"
ditto -c -k --keepParent "$app" "$output/Timeline-test.zip"
SPARKLE_ED_PRIVATE_KEY="$(cat "$work/private-key")" \
  TIMELINE_UPDATE_APP_BUNDLE="$app" TIMELINE_UPDATE_OUTPUT="$output" \
  GH_REPO=example/timeline RELEASE_TAG=v0.10.0 ./generate-appcast.sh
grep -q '999999' "$output/appcast.xml"
grep -q 'https://github.com/example/timeline/releases/download/v0.10.0/Timeline-test.zip' "$output/appcast.xml"
signature="$(bun -e '
  const xml = await Bun.file(process.argv[1]).text();
  const signature = /<enclosure\b[^>]*sparkle:edSignature="([^"]+)"/.exec(xml)?.[1];
  if (!signature) throw new Error("No archive signature in the update feed");
  process.stdout.write(signature);
' "$output/appcast.xml")"
cat "$work/private-key" | "$SPARKLE_ROOT/bin/sign_update" --ed-key-file - --verify "$output/Timeline-test.zip" "$signature"
printf 'tampered archive\n' > "$work/tampered.zip"
if cat "$work/private-key" | "$SPARKLE_ROOT/bin/sign_update" --ed-key-file - --verify "$work/tampered.zip" "$signature"; then
  echo 'Signature verification accepted a tampered archive.' >&2
  exit 1
fi
echo 'OK: configured updater feed, signed archive, and rejected tampering.'
