#!/usr/bin/env bash
# Upload the iOS .ipa to App Store Connect via ASC API key.
set -euo pipefail
cd "$(dirname "$0")/.."
ASC_KEY_ID="${ASC_KEY_ID:-H85Q4NJPVD}"
ASC_ISSUER="${ASC_ISSUER:-21dd1b35-fb04-42f1-8ec0-d847838fa7b6}"
IPA="${1:-$(ls app/src-tauri/gen/apple/build/arm64/*.ipa 2>/dev/null | head -1)}"
[ -n "$IPA" ] && [ -f "$IPA" ] || { echo "ERROR: no ipa; run scripts/build-ios.sh" >&2; exit 1; }
echo "==> Validating $IPA"
xcrun altool --validate-app -f "$IPA" -t ios --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER"
echo "==> Uploading $IPA"
xcrun altool --upload-app -f "$IPA" -t ios --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER"
echo "==> Uploaded — TestFlight will show it after processing."
