#!/bin/bash
set -Eeuo pipefail
trap 'printf "DMG packaging failed at %s:%s (exit %s)\n" "${BASH_SOURCE[0]}" "$LINENO" "$?" >&2' ERR
cd "$(dirname "$0")"

: "${APPLE_SIGNING_CERTIFICATE_BASE64:?Set the Developer ID Application p12 secret}"
: "${APPLE_SIGNING_CERTIFICATE_PASSWORD:?Set the p12 password secret}"
: "${APPLE_NOTARY_KEY_BASE64:?Set the App Store Connect API private key secret}"
: "${APPLE_NOTARY_KEY_ID:?Set the notarization API key ID}"
: "${APPLE_NOTARY_ISSUER_ID:?Set the notarization API issuer ID}"
: "${RUNNER_TEMP:?Run packaging on a CI runner}"

APP="$PWD/Timeline.app"
ROOT="$(cd ../.. && pwd)"
OUTPUT="$ROOT/dist/macos"
WORK="$(mktemp -d "$RUNNER_TEMP/timeline-signing.XXXXXX")"
KEYCHAIN="$WORK/signing.keychain-db"
cleanup() {
  security delete-keychain "$KEYCHAIN" >/dev/null 2>&1 || true
  hdiutil detach "$WORK/mount" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
umask 077
printf '%s' "$APPLE_SIGNING_CERTIFICATE_BASE64" | base64 --decode > "$WORK/certificate.p12"
printf '%s' "$APPLE_NOTARY_KEY_BASE64" | base64 --decode > "$WORK/notary.p8"
keychain_unlock="$(openssl rand -hex 32)"
security create-keychain -p "$keychain_unlock" "$KEYCHAIN"
security set-keychain-settings -lut 21600 "$KEYCHAIN"
security unlock-keychain -p "$keychain_unlock" "$KEYCHAIN"
security import "$WORK/certificate.p12" -k "$KEYCHAIN" -P "$APPLE_SIGNING_CERTIFICATE_PASSWORD" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -k "$keychain_unlock" "$KEYCHAIN" >/dev/null
# codesign also consults the search list when resolving the certificate chain.
security list-keychains -d user -s "$KEYCHAIN"
identity="$(security find-identity -v -p codesigning "$KEYCHAIN" | awk '/Developer ID Application:/ {print $2}')"
if [[ ! "$identity" =~ ^[A-Fa-f0-9]{40}$ ]]; then
  echo "Expected exactly one valid Developer ID Application identity in the certificate secret." >&2
  exit 1
fi

mkdir -p "$OUTPUT"
# Sign nested code before sealing the app. Bun's official runtime entitlements
# must survive re-signing (JIT and native addon loading).
while IFS= read -r -d '' binary; do
  if ! file -b "$binary" | grep -q 'Mach-O'; then continue; fi
  if [ "$binary" = "$APP/Contents/MacOS/Timeline" ]; then continue; fi
  options=(--force --options runtime --timestamp --keychain "$KEYCHAIN" --sign "$identity")
  if [ "$binary" = "$APP/Contents/Resources/timeline-service/bin/bun" ]; then
    options+=(--preserve-metadata=entitlements)
  fi
  case "$binary" in
    "$APP/Contents/Frameworks/Sparkle.framework/"*) options+=(--preserve-metadata=entitlements) ;;
  esac
  codesign "${options[@]}" "$binary"
done < <(find "$APP" -type f -print0)
# Seal Sparkle's helper bundles after their Mach-O files, then the framework.
while IFS= read -r -d '' bundle; do
  codesign --force --options runtime --timestamp --preserve-metadata=entitlements --keychain "$KEYCHAIN" --sign "$identity" "$bundle"
done < <(find "$APP/Contents/Frameworks" -depth -type d \( -name '*.app' -o -name '*.xpc' -o -name '*.framework' \) -print0)
codesign --force --options runtime --timestamp --keychain "$KEYCHAIN" --sign "$identity" "$APP"
codesign --verify --deep --strict "$APP"

# Exercise the signed runtime before sending it to Apple.
./smoke.sh

notarize() {
  local artifact="$1"
  local name="$2"
  if ! xcrun notarytool submit "$artifact" \
    --key "$WORK/notary.p8" --key-id "$APPLE_NOTARY_KEY_ID" --issuer "$APPLE_NOTARY_ISSUER_ID" \
    --wait --timeout 30m --output-format json > "$WORK/$name.json"; then
    cat "$WORK/$name.json" >&2
    echo "Notarization submission failed for $name." >&2
    exit 1
  fi
  local status
  status="$(bun -e 'console.log((await Bun.file(process.argv[1]).json()).status)' "$WORK/$name.json")"
  if [ "$status" != Accepted ]; then
    echo "Apple did not accept $name (status: $status)." >&2
    submission="$(bun -e 'console.log((await Bun.file(process.argv[1]).json()).id)' "$WORK/$name.json")"
    xcrun notarytool log "$submission" --key "$WORK/notary.p8" --key-id "$APPLE_NOTARY_KEY_ID" --issuer "$APPLE_NOTARY_ISSUER_ID" >&2
    exit 1
  fi
}

ditto -c -k --keepParent "$APP" "$WORK/Timeline.zip"
notarize "$WORK/Timeline.zip" app
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
spctl --assess --type execute --verbose "$APP"

version="$(bun run "$ROOT/scripts/print-product-version.ts")"
DMG="$OUTPUT/Timeline-$version-macos-$(uname -m).dmg"
python3 -m venv "$WORK/dmgbuild"
"$WORK/dmgbuild/bin/pip" install --quiet --require-hashes --only-binary :all: -r dmg/requirements.txt
"$WORK/dmgbuild/bin/dmgbuild" -s dmg/settings.py \
  -D app="$APP" -D background="$PWD/dmg/background.png" \
  Timeline "$DMG"
# dmgbuild ignores copy failures, so check the app that actually shipped.
mkdir "$WORK/mount"
hdiutil attach -readonly -nobrowse -mountpoint "$WORK/mount" "$DMG" >/dev/null
codesign --verify --deep --strict "$WORK/mount/Timeline.app"
xcrun stapler validate "$WORK/mount/Timeline.app"
hdiutil detach "$WORK/mount" >/dev/null
codesign --force --timestamp --keychain "$KEYCHAIN" --sign "$identity" "$DMG"
notarize "$DMG" dmg
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"
codesign --verify --strict "$DMG"
spctl --assess --type open --context context:primary-signature --verbose "$DMG"
(cd "$OUTPUT" && shasum -a 256 "$(basename "$DMG")" > "$(basename "$DMG").sha256")
echo "Notarized DMG ready: $DMG"
