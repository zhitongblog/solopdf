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

echo "==> Patching project.yml (merge signing into existing settings.base)"
python3 - "$PROJECT_YML" "$IOS_SIGNING_PROFILE_NAME" << 'PY'
import sys
p, profile = sys.argv[1], sys.argv[2]
s = open(p).read()
if 'PROVISIONING_PROFILE_SPECIFIER' not in s:
    anchor = "    settings:\n      base:\n        ENABLE_BITCODE: false"
    assert anchor in s, 'settings anchor not found'
    inject = f'    settings:\n      base:\n        DEVELOPMENT_TEAM: 6NQM3XP5RF\n        CODE_SIGN_STYLE: Manual\n        CODE_SIGN_IDENTITY: "Apple Distribution"\n        PROVISIONING_PROFILE_SPECIFIER: "{profile}"\n        ENABLE_BITCODE: false'
    s = s.replace(anchor, inject, 1)
    open(p, 'w').write(s)
print('signing config ok')
PY
echo "==> Linking the translation shim's frameworks (libapp.a is linked by Xcode)"
# Translation / SwiftUI (+ _Translation_SwiftUI, home of .translationTask) are
# weak so iOS 15–17 still launch (the shim reports
# "unavailable" there); NaturalLanguage exists on every supported iOS.
python3 - "$PROJECT_YML" << 'PY'
import sys
p = sys.argv[1]
s = open(p).read()
anchor = "      - sdk: Vision.framework\n"
assert anchor in s, 'Vision.framework dependency anchor not found'
add = ""
for fw, weak in (("NaturalLanguage", False), ("Translation", True), ("_Translation_SwiftUI", True), ("SwiftUI", True)):
    if f"sdk: {fw}.framework" not in s:
        add += f"      - sdk: {fw}.framework\n" + ("        weak: true\n" if weak else "")
if add:
    s = s.replace(anchor, anchor + add, 1)
    open(p, 'w').write(s)
print('translation frameworks ok')
PY

echo "==> Regenerating xcodeproj (tauri ios build does NOT re-run xcodegen)"
(cd app/src-tauri/gen/apple && xcodegen generate >/dev/null)
grep -q PROVISIONING_PROFILE_SPECIFIER app/src-tauri/gen/apple/solopdf.xcodeproj/project.pbxproj || { echo "ERROR: signing not in pbxproj" >&2; exit 1; }

for key in LSSupportsOpeningDocumentsInPlace UISupportsDocumentBrowser; do
  if grep -q "$key:" "$PROJECT_YML"; then
    /usr/bin/sed -i.bak "s|^\\( *\\)$key: .*\$|\\1$key: false|" "$PROJECT_YML" && rm -f "$PROJECT_YML.bak"
  fi
done

# export compliance: no networking/custom crypto — without this ASC blocks
# review submission (usesNonExemptEncryption null)
IOS_PLIST=app/src-tauri/gen/apple/solopdf_iOS/Info.plist
/usr/libexec/PlistBuddy -c "Add :ITSAppUsesNonExemptEncryption bool false" "$IOS_PLIST" 2>/dev/null ||
  /usr/libexec/PlistBuddy -c "Set :ITSAppUsesNonExemptEncryption false" "$IOS_PLIST"

# UIScene lifecycle: iOS 27 traps at launch (EXC_BREAKPOINT in
# _UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption) for apps built
# with the iOS 27 SDK that don't adopt it — App Review 2.1(a) on 0.7.0. The
# manifest puts tao (vendor/tao, 0.37 iOS backend) in scene mode; one scene only.
# It goes into project.yml, not Info.plist: the xcodegen run below rewrites
# Info.plist and would drop a PlistBuddy-added dict.
python3 - "$PROJECT_YML" << 'PY'
import sys
p = sys.argv[1]
s = open(p).read()
if 'UIApplicationSceneManifest' not in s:
    anchor = "        LSRequiresIPhoneOS: true\n"
    assert anchor in s, 'info.properties anchor not found'
    s = s.replace(anchor, anchor + "        UIApplicationSceneManifest:\n          UIApplicationSupportsMultipleScenes: false\n", 1)
    open(p, 'w').write(s)
print('scene manifest ok')
PY

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

echo "==> Clearing stale Externals debug variants (SoloMD pitfall #3)"
rm -rf app/src-tauri/gen/apple/Externals/*/debug
# Externals must NOT be a source folder — the linker finds libapp.a via
# LIBRARY_SEARCH_PATHS; as a source it copies debug+release variants and
# xcodebuild fails with "Multiple commands produce libapp.a" (SoloMD fix)
/usr/bin/sed -i.bak '/^      - path: Externals$/d' "$PROJECT_YML" && rm -f "$PROJECT_YML.bak"
(cd app/src-tauri/gen/apple && xcodegen generate >/dev/null)

# xcodegen does NOT overwrite existing Info.plist keys — force the build
# number directly (ASC rejects duplicate CFBundleVersion uploads)
IOS_BUILD_NUMBER="${IOS_BUILD_NUMBER:-}"
if [ -n "$IOS_BUILD_NUMBER" ]; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $IOS_BUILD_NUMBER" app/src-tauri/gen/apple/solopdf_iOS/Info.plist
  echo "    CFBundleVersion -> $IOS_BUILD_NUMBER"
fi

echo "==> Building signed .ipa (this takes a while)"
cd app
unset APPLE_SIGNING_IDENTITY
pnpm tauri ios build --export-method app-store-connect
IPA=$(ls src-tauri/gen/apple/build/arm64/*.ipa 2>/dev/null | head -1)
[ -n "$IPA" ] || { echo "ERROR: no ipa produced" >&2; exit 1; }
# without the scene manifest the app crashes on launch on iOS 27 (2.1(a) rejection of 0.7.0)
unzip -p "$IPA" 'Payload/*.app/Info.plist' | plutil -extract UIApplicationSceneManifest xml1 -o - - >/dev/null 2>&1 ||
  { echo "ERROR: $IPA has no UIApplicationSceneManifest — iOS 27 would kill it at launch" >&2; exit 1; }
echo "==> Done: app/$IPA"
