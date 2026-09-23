use std::path::{Path, PathBuf};
use std::process::Command;

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
        build_translate_shim(&target);
    }
    tauri_build::build()
}

/// Apple Translation shim — Swift (the framework has no ObjC API), compiled
/// to a static library with swiftc and linked like the ObjC shims.
///
/// Deployment target stays at the app's floor; everything newer is behind
/// `#available` in the Swift source, and Translation / SwiftUI / the Swift
/// concurrency runtime are weak-linked so the app still launches on systems
/// that lack them (it just reports "unavailable" there).
fn build_translate_shim(target: &str) {
    let src = "vision_shim/translate_shim.swift";
    println!("cargo:rerun-if-changed={src}");
    println!("cargo:rerun-if-env-changed=MACOSX_DEPLOYMENT_TARGET");
    println!("cargo:rerun-if-env-changed=IPHONEOS_DEPLOYMENT_TARGET");
    let ios = target.contains("ios");
    let sim = target.ends_with("-sim") || target.starts_with("x86_64-apple-ios");
    let arch = if target.starts_with("x86_64") { "x86_64" } else { "arm64" };
    let (sdk, triple, platform_dir) = if ios {
        let v = std::env::var("IPHONEOS_DEPLOYMENT_TARGET").unwrap_or_else(|_| "15.0".into());
        let suffix = if sim { "-simulator" } else { "" };
        (
            if sim { "iphonesimulator" } else { "iphoneos" },
            format!("{arch}-apple-ios{v}{suffix}"),
            if sim { "iphonesimulator" } else { "iphoneos" },
        )
    } else {
        // Tauri 2's floor; swiftc needs 10.15 for Concurrency back-deployment
        let v = std::env::var("MACOSX_DEPLOYMENT_TARGET").unwrap_or_else(|_| "10.15".into());
        let v = if version_lt(&v, "10.15") { "10.15".to_string() } else { v };
        ("macosx", format!("{arch}-apple-macos{v}"), "macosx")
    };

    let sdk_path = xcrun(&["--sdk", sdk, "--show-sdk-path"]);
    let swiftc = xcrun(&["--sdk", sdk, "-f", "swiftc"]);
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let lib = out.join("libsolopdf_translate.a");
    let status = Command::new(&swiftc)
        .args(["-emit-library", "-static", "-parse-as-library", "-wmo", "-O"])
        .args(["-swift-version", "5", "-module-name", "SoloPDFTranslate"])
        .args(["-target", &triple, "-sdk", &sdk_path])
        // the frameworks we need weak are linked explicitly below instead
        .args(["-Xfrontend", "-disable-autolink-framework", "-Xfrontend", "Translation"])
        .args(["-Xfrontend", "-disable-autolink-framework", "-Xfrontend", "_Translation_SwiftUI"])
        .args(["-Xfrontend", "-disable-autolink-framework", "-Xfrontend", "SwiftUI"])
        .args(["-Xfrontend", "-disable-autolink-library", "-Xfrontend", "swift_Concurrency"])
        .arg("-o")
        .arg(&lib)
        .arg(src)
        .env_remove("SDKROOT") // cargo's SDKROOT may point at the host SDK
        .status()
        .expect("swiftc not found — Xcode command line tools are required");
    assert!(status.success(), "swiftc failed to build {src}");

    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=static=solopdf_translate");
    println!("cargo:rustc-link-lib=framework=NaturalLanguage");
    // Swift runtime: the OS copy (.tbd in the SDK) + the toolchain's static
    // back-deployment shims the Swift objects reference
    let toolchain_lib = Path::new(&swiftc)
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.join("lib/swift").join(platform_dir))
        .unwrap();
    println!("cargo:rustc-link-search=native={}", toolchain_lib.display());
    println!("cargo:rustc-link-search=native={}/usr/lib/swift", sdk_path);
    // `#available` lowers to __isPlatformVersionAtLeast, which lives in
    // compiler-rt — and rustc links with -nodefaultlibs (see the ObjC shim
    // notes). Pull in clang's builtins archive for this platform.
    // iOS is different: the crate is a staticlib (libapp.a) that Xcode's clang
    // links, and clang adds compiler-rt by itself. Bundling the archive into
    // the staticlib also fails outright — rustc can't read the archive format
    // newer Xcodes ship ("Unsupported archive identifier").
    if !ios {
        let rt = PathBuf::from(xcrun(&["--sdk", sdk, "clang", "-print-resource-dir"])).join("lib/darwin");
        if rt.join("libclang_rt.osx.a").exists() {
            println!("cargo:rustc-link-search=native={}", rt.display());
            println!("cargo:rustc-link-lib=static=clang_rt.osx");
        }
    }
    // Weak, so systems without them (iOS 15–17, macOS 14) still launch and the
    // shim reports "unavailable". On iOS these reach the cdylib that cargo also
    // links (the libapp.a that Xcode links gets its frameworks from
    // gen/apple/project.yml, which scripts/build-ios.sh patches)
    println!("cargo:rustc-link-arg=-Wl,-weak_framework,Translation");
    println!("cargo:rustc-link-arg=-Wl,-weak_framework,_Translation_SwiftUI");
    println!("cargo:rustc-link-arg=-Wl,-weak_framework,SwiftUI");
    println!("cargo:rustc-link-arg=-Wl,-weak-lswift_Concurrency");
    if !ios {
        // back-deployable Swift libs are referenced as @rpath/libswift_*.dylib;
        // the OS copy lives in /usr/lib/swift (what swiftc/Xcode add by default)
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    }
}

fn xcrun(args: &[&str]) -> String {
    let out = Command::new("xcrun")
        .args(args)
        .env_remove("SDKROOT")
        .output()
        .expect("xcrun not found");
    assert!(out.status.success(), "xcrun {args:?} failed");
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn version_lt(a: &str, b: &str) -> bool {
    let p = |s: &str| s.split('.').map(|x| x.parse::<u32>().unwrap_or(0)).collect::<Vec<_>>();
    p(a) < p(b)
}
