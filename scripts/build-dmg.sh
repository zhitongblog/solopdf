#!/usr/bin/env bash
#
# Direct-distribution macOS dmg — universal (arm64 + x86_64).
#
# Until v0.6 this was built by hand on an Apple Silicon machine, so the dmg was
# arm64-only and Intel Macs had nothing to download. It is a script now, and it
# is universal.
#
# With signing credentials in the environment it signs (Tauri), notarizes and
# staples the .app, then notarizes and staples the dmg wrapper too — without
# that second pass Gatekeeper still phones home on first open. Without the
# credentials it produces a plain unsigned dmg, which is all CI needs.
#
#   APPLE_SIGNING_IDENTITY="Developer ID Application: xiangdong li (6NQM3XP5RF)"
#   APPLE_API_KEY=H85Q4NJPVD
#   APPLE_API_ISSUER=21dd1b35-fb04-42f1-8ec0-d847838fa7b6
#   APPLE_API_KEY_PATH=~/.appstoreconnect/private_keys/AuthKey_H85Q4NJPVD.p8
#
# The UntermNotary keychain profile's app-specific password is dead (401) —
# always authenticate with the ASC API key.
#
# Usage: ./scripts/build-dmg.sh
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=lib/mac-universal-helpers.sh
source scripts/lib/mac-universal-helpers.sh

pnpm install --frozen-lockfile
pnpm --filter @solopdf/core build

cd app
mac_lipo_helpers

# macOS signs inside-out: a nested Mach-O in Contents/MacOS must carry its own
# signature before the enclosing .app can be signed. `lipo -create` output has
# no signature, so without this tauri's app signing dies with
#   "code object is not signed at all. In subcomponent: .../solopdf-ocr"
# The MAS path never hit this because it deletes the helpers before signing
# (bare nested executables fail MAS validation 90049/90885); the dmg keeps them
# — they are the shipped CLI drivers the README documents.
# --options runtime (hardened runtime) is required for notarization to pass.
if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
  echo "==> Signing helper binaries"
  for b in solopdf-ocr solopdf-doc; do
    codesign --force --timestamp --options runtime \
      --sign "$APPLE_SIGNING_IDENTITY" \
      "src-tauri/target/universal-apple-darwin/release/$b"
    codesign --verify --strict --verbose=1 \
      "src-tauri/target/universal-apple-darwin/release/$b"
  done
fi

pnpm tauri build --target universal-apple-darwin --bundles dmg
cd ..

UNIVERSAL=app/src-tauri/target/universal-apple-darwin/release
# Pick the dmg for THIS version by name, not `ls | head -1`: the bundle dir
# keeps previous releases, and alphabetical order hands you the oldest one —
# which would get notarized and reported as success while the build you just
# made sits unused. Same class of trap as the stale helper in a628eb8.
VERSION=$(python3 -c "import json;print(json.load(open('app/src-tauri/tauri.conf.json'))['version'])")
DMG="$UNIVERSAL/bundle/dmg/SoloPDF_${VERSION}_universal.dmg"
[ -f "$DMG" ] || { echo "ERROR: expected $DMG, got: $(ls "$UNIVERSAL"/bundle/dmg/*.dmg 2>/dev/null || echo none)" >&2; exit 1; }

# Check the lipo'd main binary, NOT bundle/macos/SoloPDF.app — `--bundles dmg`
# does not leave a .app behind, and on a machine where a previous `--bundles
# app` run did, checking it would pass on a months-old binary. Same class of
# trap as the stale universal helper in a628eb8.
echo "==> main binary archs:"
lipo -archs "$UNIVERSAL/SoloPDF"

if [ -n "${APPLE_API_KEY:-}" ]; then
  echo "==> Notarizing the dmg wrapper"
  xcrun notarytool submit "$DMG" \
    --key "${APPLE_API_KEY_PATH/#\~/$HOME}" \
    --key-id "$APPLE_API_KEY" \
    --issuer "$APPLE_API_ISSUER" \
    --wait
  xcrun stapler staple "$DMG"
  xcrun stapler validate "$DMG"
else
  echo "==> APPLE_API_KEY unset — unsigned, un-notarized dmg (build check only)"
fi

echo "==> Done: $DMG"
