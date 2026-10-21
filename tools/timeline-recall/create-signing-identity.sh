#!/bin/bash
# Create a stable, self-signed code-signing identity for the timeline-recall binary.
#
# Why this exists: macOS attributes the Screen Recording (TCC) grant to the
# binary's code signature. An ad-hoc signature (what `swiftc` emits by default)
# is keyed by the cdhash, which changes on every recompile — so each rebuild
# looks like a brand-new program and the Screen Recording grant is lost, forcing
# a re-grant. Signing with a *stable* identity anchors the grant to the
# certificate instead: TCC keys on the designated requirement (identifier + cert
# leaf), which is constant across rebuilds even though the cdhash is not. A local
# self-signed cert is sufficient — the grant is per-machine anyway.
#
# Idempotent and one-time per machine: re-running when the identity already
# exists is a no-op. After this, ./build.sh signs the binary with it.
set -euo pipefail

IDENTITY="Timeline Recall Signing"

if security find-identity -p codesigning | grep -qF "$IDENTITY"; then
  echo "Code-signing identity '$IDENTITY' already present — nothing to do."
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/cfg" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $IDENTITY
[ext]
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
basicConstraints = critical, CA:false
EOF

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$WORK/key.pem" -out "$WORK/cert.pem" -config "$WORK/cfg"

# Import the key+cert via a transient PKCS#12. OpenSSL 3.x needs -legacy to emit
# a bundle macOS can read (its modern MAC/PBE defaults fail `security import`);
# LibreSSL / OpenSSL 1.1 lack the flag and already default to compatible
# algorithms, so detect support rather than assuming it.
HELP="$(openssl pkcs12 -help 2>&1 || true)"
LEGACY=""
case "$HELP" in *-legacy*) LEGACY="-legacy" ;; esac

openssl pkcs12 -export $LEGACY -name "$IDENTITY" \
  -inkey "$WORK/key.pem" -in "$WORK/cert.pem" \
  -out "$WORK/id.p12" -passout pass:timeline-recall

# Import into the default (login) keychain. -A lets codesign use the key during
# automated builds without an access prompt — acceptable for a local,
# self-signed signing key on a personal machine.
security import "$WORK/id.p12" -P timeline-recall -A

if security find-identity -p codesigning | grep -qF "$IDENTITY"; then
  echo "Created code-signing identity '$IDENTITY'."
  echo "Run ./build.sh; the first signed binary needs Screen Recording granted once,"
  echo "after which rebuilds keep the grant."
else
  echo "error: identity import reported success but '$IDENTITY' is not listed." >&2
  exit 1
fi
