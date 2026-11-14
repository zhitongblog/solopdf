#!/usr/bin/env bash
# Android build for SoloPDF.
#
# `tauri android init` writes app/src-tauri/gen/android, which is gitignored
# (same as gen/apple) — so every manifest/gradle/Kotlin patch lives HERE and is
# re-applied on each build rather than committed into generated code.
#
# What this script adds to the generated Android project:
#   - 16 KB ELF page alignment (-Wl,-z,max-page-size=16384) required by Google Play for Android 15+
#   - com.android.vending.BILLING permission + com.android.billingclient:billing:7.1.1
#   - MainActivity.kt Google Play Billing bridge for the 3-tier voluntary Tip Jar
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

if [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
fi

MODE="${1:-debug}"
export ANDROID_HOME="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
export NDK_HOME="${NDK_HOME:-${ANDROID_NDK_HOME:-$(ls -d "$ANDROID_HOME"/ndk/* 2>/dev/null | tail -1)}}"
if [ -z "${JAVA_HOME:-}" ] && [ -x /usr/libexec/java_home ]; then
  JAVA_HOME="$(/usr/libexec/java_home -v 17 2>/dev/null || true)"
  [ -n "$JAVA_HOME" ] && export JAVA_HOME || unset JAVA_HOME
fi

[ -d "$ANDROID_HOME" ] || { echo "ERROR: ANDROID_HOME not found ($ANDROID_HOME)" >&2; exit 1; }
[ -d "$NDK_HOME" ] || { echo "ERROR: NDK not found — sdkmanager 'ndk;26.1.10909125'" >&2; exit 1; }
echo "==> SDK $ANDROID_HOME"
echo "==> NDK $NDK_HOME"

# Android 15+ uses 16 KB memory pages; Google Play Console refuses releases whose
# native .so libraries are still 4 KB aligned (0x1000 instead of 0x4000).
ANDROID_PAGE_FLAGS="-C link-arg=-Wl,-z,max-page-size=16384"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS="$ANDROID_PAGE_FLAGS"
export CARGO_TARGET_ARMV7_LINUX_ANDROIDEABI_RUSTFLAGS="$ANDROID_PAGE_FLAGS"
export CARGO_TARGET_I686_LINUX_ANDROID_RUSTFLAGS="$ANDROID_PAGE_FLAGS"
export CARGO_TARGET_X86_64_LINUX_ANDROID_RUSTFLAGS="$ANDROID_PAGE_FLAGS"

GEN=app/src-tauri/gen/android
if [ ! -d "$GEN" ]; then
  echo "==> Generating the Android project"
  (cd app && pnpm tauri android init)
fi

MANIFEST="$GEN/app/src/main/AndroidManifest.xml"
[ -f "$MANIFEST" ] || { echo "ERROR: $MANIFEST missing" >&2; exit 1; }

echo "==> Patching AndroidManifest.xml (BILLING + open-with + deep link)"
python3 - "$MANIFEST" << 'PY'
import sys

path = sys.argv[1]
xml = open(path, encoding='utf-8').read()
changed = False

if 'com.android.vending.BILLING' not in xml:
    xml = xml.replace(
        '<uses-permission android:name="android.permission.INTERNET" />',
        '<uses-permission android:name="android.permission.INTERNET" />\n    <uses-permission android:name="com.android.vending.BILLING" />',
        1,
    )
    changed = True

if 'solopdf-intent-filters' not in xml:
    MIMES = [
        'application/pdf',
        'application/epub+zip',
        'text/plain',
        'application/x-mobipocket-ebook',
        'application/vnd.amazon.ebook',
        'application/vnd.comicbook+zip',
        'application/vnd.comicbook-rar',
        'image/vnd.djvu',
        'application/x-fictionbook+xml',
        'application/x-fictionbook',
        'application/x-zip-compressed-fb2',
        'image/tiff',
    ]
    EXTS = ['pdf', 'epub', 'txt', 'mobi', 'azw3', 'cbz', 'cbr', 'djvu', 'djv', 'fb2', 'fbz', 'tif', 'tiff']

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

    lines.append('            <intent-filter>')
    lines.append('                <action android:name="android.intent.action.VIEW" />')
    lines.append('                <category android:name="android.intent.category.DEFAULT" />')
    lines.append('                <category android:name="android.intent.category.BROWSABLE" />')
    lines.append('                <data android:scheme="solopdf" />')
    lines.append('            </intent-filter>')

    anchor = '            </intent-filter>\n'
    at = xml.index(anchor) + len(anchor)
    xml = xml[:at] + '\n'.join(lines) + '\n' + xml[at:]
    changed = True

if changed:
    open(path, 'w', encoding='utf-8').write(xml)
    print('    patched AndroidManifest.xml')
else:
    print('    already patched')
PY

echo "==> Patching app/build.gradle.kts (Play Billing dependency)"
python3 - "$GEN/app/build.gradle.kts" << 'PYGRADLE'
import sys, pathlib
p = pathlib.Path(sys.argv[1])
s = p.read_text()
if "com.android.billingclient:billing" not in s:
    s = s.replace(
        'dependencies {',
        'dependencies {\n    implementation("com.android.billingclient:billing:7.1.1")',
        1,
    )
    p.write_text(s)
    print("    added com.android.billingclient:billing:7.1.1")
else:
    print("    Play Billing dependency already present")
PYGRADLE

echo "==> Patching MainActivity.kt (Google Play Billing Tip Jar bridge)"
cat > "$GEN/app/src/main/java/app/solopdf/MainActivity.kt" << 'KOTLIN'
package app.solopdf

import android.content.Context
import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import com.android.billingclient.api.AcknowledgePurchaseParams
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.ConsumeParams
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.PurchasesUpdatedListener
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicReference

class MainActivity : TauriActivity() {
  companion object {
    private const val IAP_PREFS = "solopdf_iap"
    private const val IAP_PREFS_KEY = "purchased_ids"

    @JvmStatic
    private var instance: MainActivity? = null

    private var billingClient: BillingClient? = null
    private val productCache = ConcurrentHashMap<String, ProductDetails>()
    private val iapProductsPoll = AtomicReference<String>("")
    private val iapPurchasePoll = AtomicReference<String>("")
    private val iapRestorePoll = AtomicReference<String>("")

    private val purchasesListener = PurchasesUpdatedListener { result, purchases ->
      when (result.responseCode) {
        BillingClient.BillingResponseCode.OK -> {
          if (!purchases.isNullOrEmpty()) {
            for (p in purchases) {
              handlePlayPurchase(p)
            }
          } else {
            iapPurchasePoll.set(JSONObject().put("status", "cancelled").toString())
          }
        }
        BillingClient.BillingResponseCode.USER_CANCELED -> {
          iapPurchasePoll.set(JSONObject().put("status", "cancelled").toString())
        }
        else -> {
          iapPurchasePoll.set(
            JSONObject()
              .put("error", result.debugMessage.ifEmpty { "Google Play Billing error (${result.responseCode})" })
              .toString()
          )
        }
      }
    }

    private fun handlePlayPurchase(purchase: Purchase) {
      if (purchase.purchaseState != Purchase.PurchaseState.PURCHASED) return
      for (pid in purchase.products) {
        recordPurchasedId(pid)
      }
      val client = billingClient
      if (client != null && client.isReady) {
        val consumeParams = ConsumeParams.newBuilder()
          .setPurchaseToken(purchase.purchaseToken)
          .build()
        client.consumeAsync(consumeParams) { _, _ -> }
        if (!purchase.isAcknowledged) {
          val ackParams = AcknowledgePurchaseParams.newBuilder()
            .setPurchaseToken(purchase.purchaseToken)
            .build()
          client.acknowledgePurchase(ackParams) { _ -> }
        }
      }
      iapPurchasePoll.set(JSONObject().put("status", "purchased").toString())
    }

    private fun withBilling(onReady: (BillingClient) -> Unit, onFail: (String) -> Unit) {
      val act = instance
      if (act == null) {
        onFail("Activity unavailable")
        return
      }
      val existing = billingClient
      if (existing != null && existing.isReady) {
        onReady(existing)
        return
      }
      val client = BillingClient.newBuilder(act.applicationContext)
        .setListener(purchasesListener)
        .enablePendingPurchases(
          PendingPurchasesParams.newBuilder().enableOneTimeProducts().build()
        )
        .build()
      billingClient = client
      client.startConnection(object : BillingClientStateListener {
        override fun onBillingSetupFinished(result: BillingResult) {
          if (result.responseCode == BillingClient.BillingResponseCode.OK) {
            onReady(client)
          } else {
            onFail(result.debugMessage.ifEmpty { "Play Billing unavailable (${result.responseCode})" })
          }
        }
        override fun onBillingServiceDisconnected() {}
      })
    }

    private fun recordPurchasedId(productId: String) {
      val act = instance ?: return
      val prefs = act.getSharedPreferences(IAP_PREFS, Context.MODE_PRIVATE)
      val set = prefs.getStringSet(IAP_PREFS_KEY, emptySet())?.toMutableSet() ?: mutableSetOf()
      set.add(productId)
      prefs.edit().putStringSet(IAP_PREFS_KEY, set).apply()
    }

    @JvmStatic
    fun iapGetPurchased(): String {
      val act = instance ?: return "[]"
      val prefs = act.getSharedPreferences(IAP_PREFS, Context.MODE_PRIVATE)
      val set = prefs.getStringSet(IAP_PREFS_KEY, emptySet()) ?: emptySet()
      val arr = JSONArray()
      set.forEach { arr.put(it) }
      return arr.toString()
    }

    @JvmStatic
    fun iapStartFetchProducts(idsJson: String): String {
      iapProductsPoll.set("")
      val ids = try {
        val ja = JSONArray(idsJson)
        (0 until ja.length()).map { ja.getString(it) }
      } catch (_: Exception) {
        listOf("app.solopdf.tip.coffee", "app.solopdf.tip.meal", "app.solopdf.tip.feast")
      }
      withBilling(
        onReady = { client ->
          val productList = ids.map { id ->
            QueryProductDetailsParams.Product.newBuilder()
              .setProductId(id)
              .setProductType(BillingClient.ProductType.INAPP)
              .build()
          }
          val params = QueryProductDetailsParams.newBuilder()
            .setProductList(productList)
            .build()
          client.queryProductDetailsAsync(params) { _, productDetailsList ->
            val out = JSONArray()
            for (d in productDetailsList) {
              productCache[d.productId] = d
              val price = d.oneTimePurchaseOfferDetails?.formattedPrice ?: ""
              out.put(
                JSONObject().apply {
                  put("productId", d.productId)
                  put("title", d.name)
                  put("description", d.description)
                  put("formattedPrice", price)
                }
              )
            }
            iapProductsPoll.set(out.toString())
          }
        },
        onFail = { _ -> iapProductsPoll.set("[]") }
      )
      return "ok"
    }

    @JvmStatic
    fun iapPollProducts(): String = iapProductsPoll.getAndSet("")

    @JvmStatic
    fun iapStartPurchase(productId: String): String {
      iapPurchasePoll.set("")
      val act = instance ?: return "no_activity"
      withBilling(
        onReady = { client ->
          val launchWith = { details: ProductDetails ->
            act.runOnUiThread {
              val productParams = BillingFlowParams.ProductDetailsParams.newBuilder()
                .setProductDetails(details)
                .build()
              val flowParams = BillingFlowParams.newBuilder()
                .setProductDetailsParamsList(listOf(productParams))
                .build()
              val res = client.launchBillingFlow(act, flowParams)
              if (res.responseCode != BillingClient.BillingResponseCode.OK) {
                iapPurchasePoll.set(
                  JSONObject()
                    .put("error", res.debugMessage.ifEmpty { "Failed to launch billing flow" })
                    .toString()
                )
              }
            }
          }
          val cached = productCache[productId]
          if (cached != null) {
            launchWith(cached)
          } else {
            val qParams = QueryProductDetailsParams.newBuilder()
              .setProductList(
                listOf(
                  QueryProductDetailsParams.Product.newBuilder()
                    .setProductId(productId)
                    .setProductType(BillingClient.ProductType.INAPP)
                    .build()
                )
              )
              .build()
            client.queryProductDetailsAsync(qParams) { _, productDetailsList ->
              val found = productDetailsList.firstOrNull()
              if (found != null) {
                productCache[found.productId] = found
                launchWith(found)
              } else {
                iapPurchasePoll.set(
                  JSONObject()
                    .put("error", "Product '$productId' not found in Google Play Console.")
                    .toString()
                )
              }
            }
          }
        },
        onFail = { msg ->
          iapPurchasePoll.set(JSONObject().put("error", msg).toString())
        }
      )
      return "ok"
    }

    @JvmStatic
    fun iapPollPurchase(): String = iapPurchasePoll.getAndSet("")

    @JvmStatic
    fun iapStartRestore(): String {
      iapRestorePoll.set("")
      withBilling(
        onReady = { client ->
          val params = QueryPurchasesParams.newBuilder()
            .setProductType(BillingClient.ProductType.INAPP)
            .build()
          client.queryPurchasesAsync(params) { _, purchases ->
            for (p in purchases) {
              if (p.purchaseState == Purchase.PurchaseState.PURCHASED) {
                for (pid in p.products) {
                  recordPurchasedId(pid)
                }
              }
            }
            iapRestorePoll.set(iapGetPurchased())
          }
        },
        onFail = { _ -> iapRestorePoll.set(iapGetPurchased()) }
      )
      return "ok"
    }

    @JvmStatic
    fun iapPollRestore(): String = iapRestorePoll.getAndSet("")
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    instance = this
  }

  override fun onDestroy() {
    if (instance === this) {
      instance = null
    }
    super.onDestroy()
  }
}
KOTLIN

cd app
if [ "$MODE" = "release" ]; then
  ANDROID_KEY_PATH="${ANDROID_KEY_PATH:-${ANDROID_KEYSTORE_PATH:-}}"
  ANDROID_STORE_PASSWORD="${ANDROID_STORE_PASSWORD:-${ANDROID_KEYSTORE_PASS:-}}"
  ANDROID_KEY_PASSWORD="${ANDROID_KEY_PASSWORD:-${ANDROID_KEY_PASS:-$ANDROID_STORE_PASSWORD}}"
  ANDROID_KEY_ALIAS="${ANDROID_KEY_ALIAS:-solopdf}"

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
EOF
    exit 1
  fi
  cat > src-tauri/gen/android/keystore.properties <<EOF
storeFile=$ANDROID_KEY_PATH
storePassword=$ANDROID_STORE_PASSWORD
keyAlias=$ANDROID_KEY_ALIAS
password=$ANDROID_KEY_PASSWORD
EOF

  python3 - "src-tauri/gen/android/app/build.gradle.kts" <<'GRADLE'
import sys, pathlib
p = pathlib.Path(sys.argv[1])
s = p.read_text()
if "signingConfigs" in s:
    print("    signingConfig already present"); raise SystemExit
anchor = "android {"
assert anchor in s, "android block not found in build.gradle.kts"
block = """android {
    val keystorePropertiesFile = rootProject.file("keystore.properties")
    val keystoreProperties = Properties().apply {
        if (keystorePropertiesFile.exists()) {
            keystorePropertiesFile.inputStream().use { load(it) }
        }
    }
    signingConfigs {
        create("release") {
            if (keystorePropertiesFile.exists()) {
                storeFile = file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("password")
            }
        }
    }"""
s = s.replace(anchor, block, 1)
rel = 'getByName("release") {'
assert rel in s, "release buildType not found"
s = s.replace(rel, rel + '\n            signingConfig = signingConfigs.getByName("release")', 1)
p.write_text(s)
print("    signingConfig injected")
GRADLE

  echo "==> Building release APK + AAB"
  VITE_APP_STORE_BUILD=true SOLOPDF_APP_STORE_BUILD=1 pnpm tauri android build --apk --aab
else
  echo "==> Building debug APK"
  pnpm tauri android build --debug --apk
fi

echo "==> Artifacts"
find src-tauri/gen/android/app/build/outputs \( -name "*.apk" -o -name "*.aab" \) | sed 's/^/    /'

if [ "$MODE" = "release" ]; then
  APK=$(find src-tauri/gen/android/app/build/outputs -name "*.apk" | head -1)
  case "$APK" in
    *unsigned*) echo "ERROR: release APK is unsigned: $APK" >&2; exit 1 ;;
  esac
  APKSIGNER=$(find "${ANDROID_HOME:-$ANDROID_SDK_ROOT}/build-tools" -name apksigner 2>/dev/null | sort -r | head -1)
  if [ -n "$APKSIGNER" ]; then
    echo "==> Verifying APK signature"
    "$APKSIGNER" verify --print-certs "$APK" || { echo "ERROR: signature verification failed" >&2; exit 1; }
  else
    echo "WARNING: apksigner not found; signature not verified" >&2
  fi

  VERSION=$(python3 -c 'import json; print(json.load(open("src-tauri/tauri.conf.json"))["version"])')
  STAGE_DIR="../dist-android"
  mkdir -p "$STAGE_DIR"
  AAB=$(find src-tauri/gen/android/app/build/outputs -name "*.aab" | head -1)
  [ -n "$AAB" ] && cp "$AAB" "$STAGE_DIR/SoloPDF_${VERSION}.aab"
  [ -n "$APK" ] && cp "$APK" "$STAGE_DIR/SoloPDF_${VERSION}_universal.apk"
  echo "==> Staged Play Console & sideload artifacts in dist-android/:"
  ls -lh "$STAGE_DIR"/SoloPDF_"${VERSION}"* 2>/dev/null || true
fi
