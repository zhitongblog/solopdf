// Apple Translation shim for SoloPDF (macOS 15+ / iOS 18+, on-device).
//
// Swift because the Translation framework has no Objective-C surface. The
// entry points are plain C (@_cdecl) so Rust calls them exactly like the
// Vision OCR shim next door:
//
//   solopdf_translate(text, target, fallback) -> malloc'd UTF-8 JSON
//     ok:    {"text":"…","source":"en","target":"zh-Hans"}
//     error: {"error":"…","code":"notInstalled|unsupported|unavailable|same|empty|failed",
//             "source":"en","target":"zh-Hans"}
//   solopdf_translate_prepare(source, target) -> JSON {"ok":"1"} or an error
//     asks the system to download the language pack (its own consent sheet)
//   solopdf_translate_available() -> 2 headless API, 1 hosted only, 0 none
//   solopdf_translate_free(p)
//
// Two ways to reach a TranslationSession:
//  - macOS 26 / iOS 26: TranslationSession(installedSource:target:) works
//    outside SwiftUI, fully headless. It cannot download a language pack —
//    that case is reported as `notInstalled`.
//  - macOS 15 / iOS 18 (and every download prompt): a session only exists
//    inside SwiftUI's `.translationTask`, so we host a tiny view in a small
//    panel (macOS) or an overlay sheet (iOS) for the duration of the call.
//
// Language detection is NLLanguageRecognizer. `fallback` is the target to use
// when the text is already in `target` (reading a Chinese book with a Chinese
// UI means you want English, not a no-op).
//
// Everything that touches Translation, SwiftUI or Swift Concurrency sits
// behind `#available`, and the frameworks are weak-linked: the binary still
// launches on the older systems Tauri supports, where this reports
// `unavailable` and the configured provider (if any) takes over.

import Foundation
import NaturalLanguage
// Older SDKs ship a Translation module without TranslationSession (macOS 14
// SDK) or without the headless init (macOS 15 SDK), so gate on the compiler
// that comes with each SDK: Swift 6.0 ↔ Xcode 16, Swift 6.2 ↔ Xcode 26. A
// build on an older Xcode compiles the stubs and reports "unavailable".
#if canImport(Translation) && compiler(>=6.0)
@preconcurrency import Translation
import SwiftUI
#endif
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#endif

private func jsonCString(_ obj: [String: String]) -> UnsafeMutablePointer<CChar>? {
  let data = (try? JSONSerialization.data(withJSONObject: obj))
    ?? Data("{\"error\":\"json encode failed\",\"code\":\"failed\"}".utf8)
  return strdup(String(decoding: data, as: UTF8.self))
}

/// "zh-Hans-CN" → "zh", "pt-BR" → "pt": the part that decides whether two
/// tags are the same language for the "already in target" rule
private func baseCode(_ tag: String) -> String {
  String(tag.split(separator: "-").first ?? Substring(tag)).lowercased()
}

/// dominant language as a BCP-47-ish tag ("en", "zh-Hans", "ja"), or nil
private func detect(_ text: String) -> String? {
  let r = NLLanguageRecognizer()
  // Priors: a two-word selection ("Portable document format") is otherwise
  // a coin toss between English and French. The weights only matter when the
  // text itself is ambiguous; a real French sentence still wins.
  r.languageHints = [
    .english: 0.5, .simplifiedChinese: 0.12, .traditionalChinese: 0.08, .japanese: 0.08,
    .korean: 0.04, .french: 0.04, .german: 0.04, .spanish: 0.04, .russian: 0.03, .italian: 0.03,
  ]
  r.processString(text)
  guard let lang = r.dominantLanguage, lang != .undetermined else { return nil }
  return lang.rawValue
}

/// test hook: route through the SwiftUI-hosted session even on macOS 26, so
/// the macOS 15 path can be exercised on a current machine
private var forceHosted: Bool {
  ProcessInfo.processInfo.environment["SOLOPDF_TRANSLATE_HOSTED"] == "1"
}

@_cdecl("solopdf_translate_available")
public func solopdf_translate_available() -> Int32 {
  #if canImport(Translation) && compiler(>=6.0)
  #if compiler(>=6.2)
  if #available(macOS 26.0, iOS 26.0, *) { return forceHosted ? 1 : 2 }
  #endif
  if #available(macOS 15.0, iOS 18.0, *) { return 1 }
  #endif
  return 0
}

@_cdecl("solopdf_translate_free")
public func solopdf_translate_free(_ p: UnsafeMutablePointer<CChar>?) {
  free(p)
}

/// Result slot shared between the waiting C caller and the async work.
private final class Box: @unchecked Sendable {
  var out: [String: String] = [:]
  let sem = DispatchSemaphore(value: 0)
  func finish(_ o: [String: String]) {
    out = o
    sem.signal()
  }
}

/// Block the C caller until `box` is filled. The caller is normally a worker
/// thread (Tauri's blocking pool). The CLI calls from the main thread, and the
/// framework — and our hosted panel — need the main queue and event loop to
/// keep turning, so there we pump events instead of sleeping.
private func wait(_ box: Box) {
  guard Thread.isMainThread else {
    box.sem.wait()
    return
  }
  while box.sem.wait(timeout: .now()) == .timedOut {
    #if os(macOS)
    // NSApp stays nil in a headless CLI until the hosted panel creates it —
    // only then are there window events to deliver
    if let app = NSApp {
      if let e = app.nextEvent(
        matching: .any, until: Date(timeIntervalSinceNow: 0.05), inMode: .default, dequeue: true)
      {
        app.sendEvent(e)
      }
    } else {
      RunLoop.main.run(mode: .default, before: Date(timeIntervalSinceNow: 0.05))
    }
    #else
    RunLoop.main.run(mode: .default, before: Date(timeIntervalSinceNow: 0.05))
    #endif
  }
}

@_cdecl("solopdf_translate")
public func solopdf_translate(
  _ textPtr: UnsafePointer<CChar>?,
  _ targetPtr: UnsafePointer<CChar>?,
  _ fallbackPtr: UnsafePointer<CChar>?
) -> UnsafeMutablePointer<CChar>? {
  let text = textPtr.map { String(cString: $0) } ?? ""
  var target = targetPtr.map { String(cString: $0) } ?? ""
  let fallback = fallbackPtr.map { String(cString: $0) } ?? ""
  let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
  if trimmed.isEmpty { return jsonCString(["error": "nothing to translate", "code": "empty"]) }
  if target.isEmpty { target = fallback.isEmpty ? "en" : fallback }

  guard let source = detect(trimmed) else {
    return jsonCString(["error": "could not identify the language", "code": "unsupported", "target": target])
  }
  if baseCode(source) == baseCode(target) {
    if !fallback.isEmpty && baseCode(fallback) != baseCode(source) {
      target = fallback
    } else {
      return jsonCString(["error": "already in the target language", "code": "same", "source": source, "target": target])
    }
  }

  #if canImport(Translation) && compiler(>=6.0)
  if #available(macOS 15.0, iOS 18.0, *) {
    let box = Box()
    let src = source, tgt = target
    Task.detached {
      box.finish(await translateAny(trimmed, source: src, target: tgt))
    }
    wait(box)
    return jsonCString(box.out)
  }
  #endif
  return jsonCString(["error": "on-device translation needs macOS 15 / iOS 18", "code": "unavailable", "source": source, "target": target])
}

@_cdecl("solopdf_translate_prepare")
public func solopdf_translate_prepare(
  _ sourcePtr: UnsafePointer<CChar>?,
  _ targetPtr: UnsafePointer<CChar>?
) -> UnsafeMutablePointer<CChar>? {
  let source = sourcePtr.map { String(cString: $0) } ?? ""
  let target = targetPtr.map { String(cString: $0) } ?? ""
  if source.isEmpty || target.isEmpty {
    return jsonCString(["error": "source and target are required", "code": "failed"])
  }
  #if canImport(Translation) && compiler(>=6.0)
  if #available(macOS 15.0, iOS 18.0, *) {
    let box = Box()
    Task.detached {
      box.finish(await hosted(source: source, target: target, text: nil))
    }
    wait(box)
    return jsonCString(box.out)
  }
  #endif
  return jsonCString(["error": "on-device translation needs macOS 15 / iOS 18", "code": "unavailable"])
}

#if canImport(Translation) && compiler(>=6.0)

@available(macOS 15.0, iOS 18.0, *)
private func translateAny(_ text: String, source: String, target: String) async -> [String: String] {
  let src = Locale.Language(identifier: source)
  let tgt = Locale.Language(identifier: target)
  var base = ["source": source, "target": target]
  switch await LanguageAvailability().status(from: src, to: tgt) {
  case .unsupported:
    base["error"] = "this language pair is not supported"
    base["code"] = "unsupported"
    return base
  case .supported:
    // supported, but the language pack is not on this device
    base["error"] = "language not downloaded"
    base["code"] = "notInstalled"
    return base
  case .installed:
    break
  @unknown default:
    break
  }
  #if compiler(>=6.2)
  if #available(macOS 26.0, iOS 26.0, *), !forceHosted {
    do {
      let session = TranslationSession(installedSource: src, target: tgt)
      let res = try await session.translate(text)
      base["text"] = res.targetText
      return base
    } catch {
      return describe(error, into: base)
    }
  }
  #endif
  return await hosted(source: source, target: target, text: text)
}

/// TranslationError.notInstalled only exists in the macOS 26 / iOS 26 SDK
@available(macOS 15.0, iOS 18.0, *)
private func isNotInstalled(_ error: Error) -> Bool {
  #if compiler(>=6.2)
  if #available(macOS 26.0, iOS 26.0, *) { return TranslationError.notInstalled ~= error }
  #endif
  return false
}

@available(macOS 15.0, iOS 18.0, *)
private func describe(_ error: Error, into base: [String: String]) -> [String: String] {
  var out = base
  if isNotInstalled(error) {
    out["code"] = "notInstalled"
    out["error"] = "language not downloaded"
  } else if TranslationError.unsupportedLanguagePairing ~= error
    || TranslationError.unsupportedSourceLanguage ~= error
    || TranslationError.unsupportedTargetLanguage ~= error
  {
    out["code"] = "unsupported"
    out["error"] = error.localizedDescription
  } else if error is CancellationError {
    out["code"] = "cancelled"
    out["error"] = "cancelled"
  } else {
    out["code"] = "failed"
    out["error"] = error.localizedDescription
  }
  return out
}

/// The SwiftUI side: a view whose only job is to own a `.translationTask`.
/// With `text` it translates; without it, it asks for the language download
/// (prepareTranslation shows the system's own consent sheet).
@available(macOS 15.0, iOS 18.0, *)
private struct HostView: View {
  let config: TranslationSession.Configuration
  let text: String?
  let label: String
  /// the caller's own tags, echoed back unchanged ("zh-Hans", not "zh")
  let base: [String: String]
  let done: ([String: String]) -> Void

  var body: some View {
    VStack(spacing: 10) {
      ProgressView().controlSize(.small)
      Text(label).font(.callout).foregroundStyle(.secondary)
    }
    .padding(20)
    .frame(minWidth: 280, minHeight: 90)
    .translationTask(config) { session in
      do {
        if let text {
          let res = try await session.translate(text)
          var out = base
          out["text"] = res.targetText
          done(out)
        } else {
          try await session.prepareTranslation()
          var out = base
          out["ok"] = "1"
          done(out)
        }
      } catch {
        done(describe(error, into: base))
      }
    }
  }
}

/// Show HostView for one request and wait for its result. macOS: a small
/// floating panel (the download sheet attaches to it). iOS: an overlay over
/// the key window's top view controller.
@available(macOS 15.0, iOS 18.0, *)
private func hosted(source: String, target: String, text: String?) async -> [String: String] {
  let config = TranslationSession.Configuration(
    source: Locale.Language(identifier: source), target: Locale.Language(identifier: target))
  let label = text == nil ? "Translation languages" : "Translating…"
  let base = ["source": source, "target": target]
  return await withCheckedContinuation { (cont: CheckedContinuation<[String: String], Never>) in
    DispatchQueue.main.async {
      var finished = false
      #if os(macOS)
      let app = NSApplication.shared
      // a CLI process has no running app; give it one so the panel can show
      if app.activationPolicy() == .prohibited { app.setActivationPolicy(.regular) }
      if !app.isRunning { app.finishLaunching() }
      let panel = NSPanel(
        contentRect: NSRect(x: 0, y: 0, width: 320, height: 110),
        styleMask: [.titled, .closable, .utilityWindow], backing: .buffered, defer: false)
      panel.title = "SoloPDF"
      panel.isReleasedWhenClosed = false
      panel.level = .floating
      let finish: ([String: String]) -> Void = { out in
        if finished { return }
        finished = true
        panel.orderOut(nil)
        cont.resume(returning: out)
      }
      panel.contentView = NSHostingView(rootView: HostView(config: config, text: text, label: label, base: base, done: finish))
      panel.center()
      app.activate(ignoringOtherApps: true)
      panel.makeKeyAndOrderFront(nil)
      panel.orderFrontRegardless()
      // closing the panel by hand is a cancel, not a hang
      NotificationCenter.default.addObserver(
        forName: NSWindow.willCloseNotification, object: panel, queue: .main
      ) { _ in finish(["error": "cancelled", "code": "cancelled"]) }
      #else
      var presented: UIViewController?
      let finish: ([String: String]) -> Void = { out in
        if finished { return }
        finished = true
        presented?.dismiss(animated: true)
        cont.resume(returning: out)
      }
      let vc = UIHostingController(rootView: HostView(config: config, text: text, label: label, base: base, done: finish))
      vc.modalPresentationStyle = .formSheet
      vc.sheetPresentationController?.detents = [.medium()]
      var root = UIApplication.shared.connectedScenes
        .compactMap { ($0 as? UIWindowScene)?.windows.first(where: { $0.isKeyWindow }) }
        .first?.rootViewController
      while let p = root?.presentedViewController { root = p }
      guard let host = root else {
        finish(["error": "no window to present from", "code": "failed"])
        return
      }
      presented = vc
      host.present(vc, animated: true)
      #endif
    }
  }
}

#endif

/// macOS: open System Settings → Language & Region, where Translation
/// Languages can be downloaded or removed. 1 = opened.
@_cdecl("solopdf_translate_open_settings")
public func solopdf_translate_open_settings() -> Int32 {
  #if os(macOS)
  guard let url = URL(string: "x-apple.systempreferences:com.apple.Localization-Settings.extension") else { return 0 }
  return NSWorkspace.shared.open(url) ? 1 : 0
  #else
  return 0
  #endif
}
