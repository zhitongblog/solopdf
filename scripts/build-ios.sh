#!/usr/bin/env bash
# iOS App Store build for SoloPDF (pattern: SoloMD build-ios.sh, minus libgit2 flags).
# Key inherited fixes:
#   - Manual signing w/ Apple Distribution + named profile (Xcode-managed → conflicts)
#   - LSSupportsOpeningDocumentsInPlace/UISupportsDocumentBrowser = false:
#     open-in-place hands Rust a security-scoped URL std::fs can't read
#     (SoloMD #139 device bug) — false makes iOS copy into our sandbox.
#   - must run via `tauri ios build` (it hosts a JSON-RPC server xcode-script calls)
# Output: app/src-tauri/gen/apple/build/arm64/SoloPDF.ipa
set -euo pipefail
cd "$(dirname "$0")/.."

IOS_SIGNING_PROFILE_NAME="${IOS_SIGNING_PROFILE_NAME:-SoloPDF iOS}"
PROJECT_YML=app/src-tauri/gen/apple/project.yml
EXPORT_PLIST=app/src-tauri/gen/apple/ExportOptions.plist
PROFILE_SRC=app/src-tauri/SoloPDF-iOS.mobileprovision

[ -f "$PROJECT_YML" ] || { echo "ERROR: run \`pnpm tauri ios init\` first" >&2; exit 1; }
[ -f "$PROFILE_SRC" ] || { echo "ERROR: $PROFILE_SRC missing (scripts/asc/setup-appstore.mjs creates it)" >&2; exit 1; }

echo "==> Installing provisioning profile"
UUID=$(security cms -D -i "$PROFILE_SRC" 2>/dev/null | plutil -extract UUID raw -o - -- -)
mkdir -p ~/Library/MobileDevice/"Provisioning Profiles"
cp "$PROFILE_SRC" ~/Library/MobileDevice/"Provisioning Profiles/$UUID.mobileprovision"
echo "    UUID: $UUID"

echo "==> Patching project.yml (manual signing, xcodegen settings.base)"
python3 - "$PROJECT_YML" "$IOS_SIGNING_PROFILE_NAME" << 'PY'
import sys
p, profile = sys.argv[1], sys.argv[2]
s = open(p).read()
if 'PROVISIONING_PROFILE_SPECIFIER' not in s:
    marker = "  solopdf_iOS:\n    type: application\n    platform: iOS"
    inject = marker + f"""\n    settings:\n      base:\n        DEVELOPMENT_TEAM: 6NQM3XP5RF\n        CODE_SIGN_STYLE: Manual\n        CODE_SIGN_IDENTITY: \"Apple Distribution\"\n        PROVISIONING_PROFILE_SPECIFIER: \"{profile}\""""
    assert marker in s, 'target marker not found'
    s = s.replace(marker, inject, 1)
    open(p, 'w').write(s)
print('signing config ok')
PY
for key in LSSupportsOpeningDocumentsInPlace UISupportsDocumentBrowser; do
  if grep -q "$key:" "$PROJECT_YML"; then
    /usr/bin/sed -i.bak "s|^\\( *\\)$key: .*\$|\\1$key: false|" "$PROJECT_YML" && rm -f "$PROJECT_YML.bak"
  fi
done

echo "==> Writing ExportOptions.plist"
cat > "$EXPORT_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>app-store-connect</string>
    <key>teamID</key>
    <string>6NQM3XP5RF</string>
    <key>signingStyle</key>
    <string>manual</string>
    <key>signingCertificate</key>
    <string>Apple Distribution</string>
    <key>provisioningProfiles</key>
    <dict>
        <key>app.solopdf</key>
        <string>${IOS_SIGNING_PROFILE_NAME}</string>
    </dict>
    <key>uploadSymbols</key>
    <true/>
</dict>
</plist>
EOF

echo "==> Building signed .ipa (this takes a while)"
cd app
unset APPLE_SIGNING_IDENTITY
pnpm tauri ios build --export-method app-store-connect
IPA=$(ls src-tauri/gen/apple/build/arm64/*.ipa 2>/dev/null | head -1)
[ -n "$IPA" ] || { echo "ERROR: no ipa produced" >&2; exit 1; }
echo "==> Done: app/$IPA"
