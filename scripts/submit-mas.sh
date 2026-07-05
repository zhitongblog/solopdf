#!/usr/bin/env bash
# Upload a MAS .pkg to App Store Connect using the ASC API key
# (AuthKey_H85Q4NJPVD.p8 in ~/.appstoreconnect/private_keys — same key
# FreeID Photo CI uses; no Apple ID password needed).
#
# Usage: ./scripts/submit-mas.sh [dist-mas/SoloPDF_X.Y.Z_B.pkg]
set -euo pipefail
cd "$(dirname "$0")/.."

ASC_KEY_ID="${ASC_KEY_ID:-H85Q4NJPVD}"
ASC_ISSUER="${ASC_ISSUER:-21dd1b35-fb04-42f1-8ec0-d847838fa7b6}"

PKG="${1:-$(ls -t dist-mas/*.pkg 2>/dev/null | head -1)}"
[ -n "$PKG" ] && [ -f "$PKG" ] || { echo "ERROR: no .pkg found; run scripts/build-mas.sh" >&2; exit 1; }

echo "==> Validating $PKG"
xcrun altool --validate-app -f "$PKG" -t osx \
  --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER"

echo "==> Uploading $PKG"
xcrun altool --upload-app -f "$PKG" -t osx \
  --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER"
echo "==> Uploaded. Check App Store Connect -> TestFlight/Builds."
