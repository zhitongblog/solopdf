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
pnpm tauri build --target universal-apple-darwin --bundles dmg
cd ..

BUNDLE=app/src-tauri/target/universal-apple-darwin/release/bundle
APP="$BUNDLE/macos/SoloPDF.app"
DMG=$(ls "$BUNDLE"/dmg/*.dmg | head -1)

echo "==> main binary archs:"
lipo -archs "$APP/Contents/MacOS/SoloPDF"

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
