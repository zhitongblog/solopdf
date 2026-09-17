# Sourced by build-dmg.sh and build-mas.sh. Call from the `app/` directory.
#
# `tauri build --target universal-apple-darwin` lipos ONLY the main binary;
# the extra [[bin]] targets are left in their per-arch directories and
# bundling then dies with "solopdf-doc does not exist". Build the helpers for
# both arches and lipo them into the universal dir before invoking tauri.
#
# (This bit the MAS build in v0.6 — see a628eb8. It lives here so the dmg and
# MAS paths cannot drift apart again.)
mac_lipo_helpers() {
  local helpers=(solopdf-ocr solopdf-doc) arch b
  for arch in aarch64-apple-darwin x86_64-apple-darwin; do
    cargo build --release --manifest-path src-tauri/Cargo.toml --target "$arch" \
      "${helpers[@]/#/--bin=}"
  done
  mkdir -p src-tauri/target/universal-apple-darwin/release
  for b in "${helpers[@]}"; do
    lipo -create -output "src-tauri/target/universal-apple-darwin/release/$b" \
      "src-tauri/target/aarch64-apple-darwin/release/$b" \
      "src-tauri/target/x86_64-apple-darwin/release/$b"
    lipo -archs "src-tauri/target/universal-apple-darwin/release/$b"
  done
}
