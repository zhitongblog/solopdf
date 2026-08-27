#!/usr/bin/env bash
# Android build for SoloPDF.
#
# `tauri android init` writes app/src-tauri/gen/android, which is gitignored
# (same as gen/apple) — so every manifest change lives HERE and is re-applied
# on each build rather than committed into generated code.
#
# What this script adds to the generated manifest:
#   - VIEW intent filters so "open with" works for our document types, by
#     MIME type AND by file extension (content:// URIs from Drive and friends
#     often arrive as application/octet-stream)
#   - the solopdf:// deep-link scheme, so SoloMD's jump-back links work
#
# Usage:
#   scripts/build-android.sh              # debug APK (installable, unsigned)
#   scripts/build-android.sh release      # release APK + AAB (needs a keystore)
#
# Release signing needs a keystore YOU own; see the block at the bottom.
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-debug}"
export ANDROID_HOME="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
export NDK_HOME="${NDK_HOME:-$(ls -d "$ANDROID_HOME"/ndk/* 2>/dev/null | tail -1)}"
export JAVA_HOME="${JAVA_HOME:-$(/usr/libexec/java_home -v 17 2>/dev/null || echo "")}"

[ -d "$ANDROID_HOME" ] || { echo "ERROR: ANDROID_HOME not found ($ANDROID_HOME)" >&2; exit 1; }
[ -d "$NDK_HOME" ] || { echo "ERROR: NDK not found — sdkmanager 'ndk;26.1.10909125'" >&2; exit 1; }
echo "==> SDK $ANDROID_HOME"
echo "==> NDK $NDK_HOME"

GEN=app/src-tauri/gen/android
if [ ! -d "$GEN" ]; then
  echo "==> Generating the Android project"
  (cd app && pnpm tauri android init)
fi

MANIFEST="$GEN/app/src/main/AndroidManifest.xml"
[ -f "$MANIFEST" ] || { echo "ERROR: $MANIFEST missing" >&2; exit 1; }

echo "==> Patching AndroidManifest.xml (open-with + deep link)"
python3 - "$MANIFEST" << 'PY'
import sys

path = sys.argv[1]
xml = open(path, encoding='utf-8').read()
if 'solopdf-intent-filters' in xml:
    print('    already patched')
    raise SystemExit

MIMES = [
    'application/pdf',
    'application/epub+zip',
    'text/plain',
    'application/x-mobipocket-ebook',
    'application/vnd.amazon.ebook',
    'application/vnd.comicbook+zip',
    'application/vnd.comicbook-rar',
    'image/vnd.djvu',
]
# Providers frequently report octet-stream for anything they don't know, so
# a second filter matches on the file name instead. pathPattern needs the
# doubled backslash escape and does NOT support alternation.
EXTS = ['pdf', 'epub', 'txt', 'mobi', 'azw3', 'cbz', 'cbr', 'djvu', 'djv']

lines = ['            <!-- solopdf-intent-filters -->']
lines.append('            <intent-filter>')
lines.append('                <action android:name="android.intent.action.VIEW" />')
lines.append('                <category android:name="android.intent.category.DEFAULT" />')
lines.append('                <category android:name="android.intent.category.BROWSABLE" />')
for m in MIMES:
    lines.append(f'                <data android:mimeType="{m}" />')
lines.append('            </intent-filter>')

for ext in EXTS:
    lines.append('            <intent-filter>')
    lines.append('                <action android:name="android.intent.action.VIEW" />')
    lines.append('                <category android:name="android.intent.category.DEFAULT" />')
    lines.append('                <category android:name="android.intent.category.BROWSABLE" />')
    lines.append('                <data android:scheme="content" />')
    lines.append('                <data android:scheme="file" />')
    lines.append('                <data android:mimeType="*/*" />')
    lines.append(f'                <data android:pathPattern=".*\\\\.{ext}" />')
    lines.append('            </intent-filter>')

# solopdf:// — SoloMD's "jump back to the source" links
lines.append('            <intent-filter>')
lines.append('                <action android:name="android.intent.action.VIEW" />')
lines.append('                <category android:name="android.intent.category.DEFAULT" />')
lines.append('                <category android:name="android.intent.category.BROWSABLE" />')
lines.append('                <data android:scheme="solopdf" />')
lines.append('            </intent-filter>')

anchor = '            </intent-filter>\n'
at = xml.index(anchor) + len(anchor)
xml = xml[:at] + '\n'.join(lines) + '\n' + xml[at:]
open(path, 'w', encoding='utf-8').write(xml)
print(f'    added {len(EXTS) + 2} intent filters')
PY

cd app
if [ "$MODE" = "release" ]; then
  if [ -z "${ANDROID_KEY_PATH:-}" ]; then
    cat >&2 <<'EOF'
ERROR: release builds need a signing keystore, which only you can create:

  keytool -genkey -v -keystore ~/solopdf-release.jks \
    -keyalg RSA -keysize 2048 -validity 10000 -alias solopdf

then export before re-running:
  ANDROID_KEY_PATH=~/solopdf-release.jks
  ANDROID_KEY_ALIAS=solopdf
  ANDROID_KEY_PASSWORD=…
  ANDROID_STORE_PASSWORD=…

Play Console upload also needs a developer account (one-off fee) — that
part is not automatable from here.
EOF
    exit 1
  fi
  cat > src-tauri/gen/android/keystore.properties <<EOF
storeFile=$ANDROID_KEY_PATH
storePassword=$ANDROID_STORE_PASSWORD
keyAlias=$ANDROID_KEY_ALIAS
password=$ANDROID_KEY_PASSWORD
EOF
  echo "==> Building release APK + AAB"
  pnpm tauri android build --apk --aab
else
  echo "==> Building debug APK"
  pnpm tauri android build --debug --apk
fi

echo "==> Artifacts"
find src-tauri/gen/android/app/build/outputs -name "*.apk" -o -name "*.aab" | sed 's/^/    /'
