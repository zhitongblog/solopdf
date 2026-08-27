fn main() {
    // Vision OCR shim — Apple platforms only. cc respects the cross target
    // (aarch64-apple-ios etc) via the TARGET env cargo sets.
    let target = std::env::var("TARGET").unwrap_or_default();
    if target.contains("apple") {
        cc::Build::new()
            .file("vision_shim/ocr_shim.m")
            .file("vision_shim/dict_shim.m")
            .flag("-fobjc-arc")
            .compile("solopdf_vision_shim");
        println!("cargo:rerun-if-changed=vision_shim/ocr_shim.m");
        println!("cargo:rerun-if-changed=vision_shim/dict_shim.m");
        println!("cargo:rustc-link-lib=framework=Vision");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rustc-link-lib=framework=ImageIO");
        println!("cargo:rustc-link-lib=framework=CoreGraphics");
        println!("cargo:rustc-link-lib=framework=CoreImage");
        // the system dictionary panel lives in UIKit on iOS, AppKit on macOS
        if target.contains("ios") {
            println!("cargo:rustc-link-lib=framework=UIKit");
        } else {
            println!("cargo:rustc-link-lib=framework=AppKit");
        }
    }
    tauri_build::build()
}
