// notabene-speech — macOS's own speech recognition, for lecture transcripts
// (plan §10.3, the `apple-speech` engine).
//
// `SpeechAnalyzer` and `SpeechTranscriber` are Swift-only, `async`, and new in
// macOS 26, so there is no Objective-C surface for `objc2` to bind. This is a
// small command-line helper instead, run by `src-tauri/src/asr/apple.rs` the
// way `tts/system.rs` runs `say(1)`: one process per window, JSON on stdout,
// a nonzero exit and `{"error", "message"}` on stderr when it fails. That also
// keeps the decoder that reads untrusted audio out of the app's own process.
//
// Nothing here reaches a network NotaBene chose. The recognition model is
// Apple's, installed per language by `AssetInventory` when the student asks
// for it (`install`), and never as a side effect of `transcribe`.
//
// Built by `src-tauri/build.rs` with a macOS 13 deployment target so it can
// always start and *say* it is unsupported; everything real sits behind
// `#available(macOS 26, *)`.

import AVFoundation
import CoreMedia
import Foundation
import Speech

struct Failure: Error {
  let code: String
  let message: String
}

func emit(_ value: Any) {
  guard let data = try? JSONSerialization.data(withJSONObject: value),
    let line = String(data: data, encoding: .utf8)
  else { return }
  print(line)
  fflush(stdout)
}

func fail(_ failure: Failure) -> Never {
  if let data = try? JSONSerialization.data(withJSONObject: [
    "error": failure.code, "message": failure.message,
  ]), let line = String(data: data, encoding: .utf8) {
    FileHandle.standardError.write((line + "\n").data(using: .utf8)!)
  }
  exit(1)
}

/// `--flag value` pairs; a flag may repeat (`--locale`, `--context`).
func options(_ arguments: ArraySlice<String>) -> [String: [String]] {
  var result: [String: [String]] = [:]
  var iterator = arguments.makeIterator()
  while let flag = iterator.next() {
    guard flag.hasPrefix("--"), let value = iterator.next() else {
      fail(Failure(code: "usage", message: "unexpected argument \(flag)"))
    }
    result[String(flag.dropFirst(2)), default: []].append(value)
  }
  return result
}

@available(macOS 26, *)
func transcriber(_ locale: Locale) -> SpeechTranscriber {
  SpeechTranscriber(
    locale: locale,
    transcriptionOptions: [],
    reportingOptions: [],
    attributeOptions: [.audioTimeRange, .transcriptionConfidence])
}

/// `installed` needs care: `AssetInventory.status` can answer `supported` for
/// a language whose model is already on the Mac (installed for dictation, not
/// reserved by us), and transcription then works. `installedLocales` is the
/// second opinion.
@available(macOS 26, *)
func languageStatus(_ identifier: String) async -> String {
  guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: identifier))
  else { return "unsupported" }
  let installed = await SpeechTranscriber.installedLocales
  if installed.contains(where: { $0.identifier(.bcp47) == locale.identifier(.bcp47) }) {
    return "installed"
  }
  switch await AssetInventory.status(forModules: [transcriber(locale)]) {
  case .installed: return "installed"
  case .downloading: return "downloading"
  case .supported: return "supported"
  default: return "unsupported"
  }
}

@available(macOS 26, *)
func resolve(_ identifier: String) async throws -> Locale {
  guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: identifier))
  else { throw Failure(code: "language_unsupported", message: identifier) }
  if await languageStatus(identifier) != "installed" {
    throw Failure(code: "language_not_installed", message: identifier)
  }
  return locale
}

struct Transcript {
  var segments: [[String: Any]] = []
  var confidences: [Double] = []

  var meanConfidence: Double {
    confidences.isEmpty ? 0 : confidences.reduce(0, +) / Double(confidences.count)
  }
}

@available(macOS 26, *)
func transcribe(file: URL, locale: Locale, context: [String]) async throws -> Transcript {
  let audio: AVAudioFile
  do {
    audio = try AVAudioFile(forReading: file)
  } catch {
    throw Failure(code: "audio_unreadable", message: error.localizedDescription)
  }
  let module = transcriber(locale)
  let analyzer = SpeechAnalyzer(modules: [module])
  if !context.isEmpty {
    // The course's accepted terms: how its own jargon is spelled.
    let analysis = AnalysisContext()
    analysis.contextualStrings[.general] = context
    try await analyzer.setContext(analysis)
  }
  let collector = Task { () throws -> Transcript in
    var transcript = Transcript()
    for try await result in module.results where result.isFinal {
      var words: [[String: Any]] = []
      for run in result.text.runs {
        let text = String(result.text[run.range].characters)
          .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, let range = run.audioTimeRange else { continue }
        var word: [String: Any] = [
          "text": text, "start": range.start.seconds, "end": range.end.seconds,
        ]
        if let confidence = run.transcriptionConfidence {
          word["confidence"] = confidence
          transcript.confidences.append(confidence)
        } else {
          word["confidence"] = NSNull()
        }
        words.append(word)
      }
      let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
      if text.isEmpty { continue }
      transcript.segments.append([
        "start": result.range.start.seconds,
        "end": result.range.end.seconds,
        "text": text,
        "words": words,
      ])
    }
    return transcript
  }
  if let end = try await analyzer.analyzeSequence(from: audio) {
    try await analyzer.finalizeAndFinish(through: end)
  } else {
    await analyzer.cancelAndFinishNow()
  }
  return try await collector.value
}

@available(macOS 26, *)
func run(_ command: String, _ flags: [String: [String]]) async throws {
  switch command {
  case "status":
    var languages: [[String: Any]] = []
    for identifier in flags["locale"] ?? [] {
      languages.append(["locale": identifier, "status": await languageStatus(identifier)])
    }
    emit(["available": SpeechTranscriber.isAvailable, "languages": languages])

  case "install":
    guard let identifier = flags["locale"]?.first,
      let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: identifier))
    else { throw Failure(code: "language_unsupported", message: flags["locale"]?.first ?? "") }
    if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber(locale)]) {
      let observation = request.progress.observe(\.fractionCompleted) { progress, _ in
        emit(["progress": progress.fractionCompleted])
      }
      try await request.downloadAndInstall()
      observation.invalidate()
    }
    emit(["done": true])

  case "detect":
    // Which of the candidate languages this audio is in. Listening in the
    // wrong language still produces words — with a mean confidence around
    // 0.4 against 0.95 in the right one — so the probe is simply both.
    guard let path = flags["file"]?.first else {
      throw Failure(code: "usage", message: "detect needs --file")
    }
    var best: (String, Double)? = nil
    var scores: [String: Double] = [:]
    for identifier in flags["locale"] ?? [] {
      guard let locale = try? await resolve(identifier) else { continue }
      let transcript = try await transcribe(
        file: URL(fileURLWithPath: path), locale: locale, context: [])
      scores[identifier] = transcript.meanConfidence
      if transcript.meanConfidence > (best?.1 ?? -1) {
        best = (identifier, transcript.meanConfidence)
      }
    }
    guard let chosen = best else {
      throw Failure(code: "language_not_installed", message: "no candidate language is installed")
    }
    emit(["language": chosen.0, "scores": scores])

  case "transcribe":
    guard let path = flags["file"]?.first, let identifier = flags["locale"]?.first else {
      throw Failure(code: "usage", message: "transcribe needs --file and --locale")
    }
    let locale = try await resolve(identifier)
    let transcript = try await transcribe(
      file: URL(fileURLWithPath: path), locale: locale, context: flags["context"] ?? [])
    emit(["language": identifier, "segments": transcript.segments])

  default:
    throw Failure(code: "usage", message: "unknown command \(command)")
  }
}

let arguments = CommandLine.arguments.dropFirst()
guard let command = arguments.first else {
  fail(Failure(code: "usage", message: "notabene-speech status|install|detect|transcribe"))
}
let flags = options(arguments.dropFirst())

if #available(macOS 26, *) {
  let semaphore = DispatchSemaphore(value: 0)
  Task {
    do {
      try await run(command, flags)
    } catch let failure as Failure {
      fail(failure)
    } catch {
      fail(Failure(code: "failed", message: error.localizedDescription))
    }
    semaphore.signal()
  }
  semaphore.wait()
} else {
  if command == "status" {
    emit(["available": false, "languages": [] as [Any], "reason": "unsupported_os"])
  } else {
    fail(Failure(code: "unsupported_os", message: "macOS 26 or later is required"))
  }
}
