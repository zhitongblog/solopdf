#!/usr/bin/env bash
#
# Mac App Store build for SoloPDF (pattern: SoloMD's battle-tested build-mas.sh,
# simplified — no sidecar binaries).
#
#   - Signs with "Apple Distribution", embeds entitlements.mas.plist
#     (sandbox + JIT; NO hardened runtime — MAS rejects the combination)
#   - Embeds SoloPDF.provisionprofile + PrivacyInfo.xcprivacy
#   - Strips quarantine xattrs (Apple validator error 91109 otherwise)
#   - productbuild → signed .pkg (3rd Party Mac Developer Installer)
#
# Usage: MAS_VERSION=1.0.0 MAS_BUILD_NUMBER=1.0.0 ./scripts/build-mas.sh
set -euo pipefail
cd "$(dirname "$0")/.."

MAS_SIGNING_IDENTITY="${MAS_SIGNING_IDENTITY:-Apple Distribution: xiangdong li (6NQM3XP5RF)}"
MAS_INSTALLER_IDENTITY="${MAS_INSTALLER_IDENTITY:-3rd Party Mac Developer Installer: xiangdong li (6NQM3XP5RF)}"
MAS_PROVISIONING_PROFILE="${MAS_PROVISIONING_PROFILE:-app/src-tauri/SoloPDF.provisionprofile}"
MAS_VERSION="${MAS_VERSION:-1.0.0}"
MAS_BUILD_NUMBER="${MAS_BUILD_NUMBER:-1.0.0}"
ENTITLEMENTS="app/src-tauri/entitlements.mas.plist"

[ -f "$MAS_PROVISIONING_PROFILE" ] || { echo "ERROR: profile missing: $MAS_PROVISIONING_PROFILE" >&2; exit 1; }
[ -f "$ENTITLEMENTS" ] || { echo "ERROR: $ENTITLEMENTS missing" >&2; exit 1; }

echo "==> SoloPDF MAS build  v$MAS_VERSION ($MAS_BUILD_NUMBER)"
cd app
pnpm install --frozen-lockfile
unset APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID
pnpm tauri build --target universal-apple-darwin --bundles app
APP="src-tauri/target/universal-apple-darwin/release/bundle/macos/SoloPDF.app"
[ -d "$APP" ] || { echo "ERROR: .app not found" >&2; exit 1; }
cd ..

PLIST="app/$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $MAS_VERSION" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $MAS_BUILD_NUMBER" "$PLIST"

echo "==> Embedding provisioning profile + privacy manifest"
cp "$MAS_PROVISIONING_PROFILE" "app/$APP/Contents/embedded.provisionprofile"
cp app/src-tauri/PrivacyInfo.xcprivacy "app/$APP/Contents/Resources/PrivacyInfo.xcprivacy"

echo "==> Stripping xattrs + existing signatures"
xattr -cr "app/$APP"
find "app/$APP" -type f \( -perm -u+x -o -name "*.dylib" -o -name "*.framework" \) -print0 |
  while IFS= read -r -d '' f; do codesign --remove-signature "$f" 2>/dev/null || true; done
codesign --remove-signature "app/$APP" 2>/dev/null || true

if [ -d "app/$APP/Contents/Frameworks" ]; then
  find "app/$APP/Contents/Frameworks" -type d -name "*.framework" -print0 |
    while IFS= read -r -d '' fw; do
      codesign --force --deep --sign "$MAS_SIGNING_IDENTITY" "$fw"
    done
fi

# MAS: strip CLI helper binaries (solopdf-ocr) — a bare nested executable
# without its own bundle + provisioning profile fails validation
# (errors 90049/90885). The CLI still ships in the dmg / Windows / Linux
# bundles; MAS users lose nothing app-side (OCR lives in the lib).
find "app/$APP/Contents/MacOS" -type f ! -name SoloPDF -delete
ls "app/$APP/Contents/MacOS"

echo "==> Signing .app (sandbox entitlements, no hardened runtime)"
codesign --force --sign "$MAS_SIGNING_IDENTITY" \
  --entitlements "$ENTITLEMENTS" \
  --identifier app.solopdf \
  "app/$APP"
codesign --verify --strict --deep --verbose=2 "app/$APP"

echo "==> Building signed .pkg"
mkdir -p dist-mas
PKG="dist-mas/SoloPDF_${MAS_VERSION}_${MAS_BUILD_NUMBER}.pkg"
rm -f "$PKG"
productbuild --component "app/$APP" /Applications --sign "$MAS_INSTALLER_IDENTITY" "$PKG"
pkgutil --check-signature "$PKG"
echo "==> Done: $PKG"
