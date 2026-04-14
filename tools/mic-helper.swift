#!/usr/bin/env swift
// mic-helper — macOS microphone authorization & recording via AVFoundation
// Packaged as .app bundle so macOS shows the permission dialog.
//
// Usage:
//   mic-helper check              → exit 0 if authorized, 1 if not
//   mic-helper authorize           → trigger permission dialog, wait for result
//   mic-helper record <secs> <out> → record 16kHz mono PCM WAV

import AVFoundation
import Foundation
import AppKit  // Needed for NSApplication run loop (permission dialogs require it)

// MARK: - Permission

func checkPermission() -> Bool {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: return true
    default: return false
    }
}

/// Request mic permission using NSApplication run loop so macOS can show the dialog.
func requestPermissionWithRunLoop() -> Bool {
    if checkPermission() { return true }

    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)  // No dock icon, but CAN show system dialogs

    var granted = false
    var done = false

    AVCaptureDevice.requestAccess(for: .audio) { ok in
        granted = ok
        done = true
        // Stop the run loop from the callback
        DispatchQueue.main.async {
            app.stop(nil)
            // Post a dummy event to unblock run()
            let event = NSEvent.otherEvent(
                with: .applicationDefined,
                location: .zero,
                modifierFlags: [],
                timestamp: 0,
                windowNumber: 0,
                context: nil,
                subtype: 0,
                data1: 0,
                data2: 0
            )
            if let event = event {
                app.postEvent(event, atStart: true)
            }
        }
    }

    // Timeout: stop after 30 seconds even if user doesn't respond
    DispatchQueue.global().asyncAfter(deadline: .now() + 30) {
        if !done {
            done = true
            DispatchQueue.main.async {
                app.stop(nil)
                let event = NSEvent.otherEvent(
                    with: .applicationDefined,
                    location: .zero,
                    modifierFlags: [],
                    timestamp: 0,
                    windowNumber: 0,
                    context: nil,
                    subtype: 0,
                    data1: 0,
                    data2: 0
                )
                if let event = event {
                    app.postEvent(event, atStart: true)
                }
            }
        }
    }

    app.run()  // Blocks until app.stop() — allows system dialogs to appear
    return granted
}

// MARK: - WAV Recording

class Recorder: NSObject {
    private var engine: AVAudioEngine?
    private var outputFile: AVAudioFile?
    private var timer: DispatchSourceTimer?

    func record(seconds: Double, outputPath: String) -> Bool {
        let engine = AVAudioEngine()
        self.engine = engine

        let input = engine.inputNode
        let hwFormat = input.outputFormat(forBus: 0)

        // Target: 16kHz, mono, 16-bit signed int
        guard let targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: 16000,
            channels: 1,
            interleaved: true
        ) else {
            fputs("Error: cannot create target format\n", stderr)
            return false
        }

        guard let converter = AVAudioConverter(from: hwFormat, to: targetFormat) else {
            fputs("Error: cannot create audio converter\n", stderr)
            return false
        }

        let url = URL(fileURLWithPath: outputPath)
        do {
            outputFile = try AVAudioFile(
                forWriting: url,
                settings: targetFormat.settings,
                commonFormat: .pcmFormatInt16,
                interleaved: true
            )
        } catch {
            fputs("Error: cannot create output file: \(error)\n", stderr)
            return false
        }

        let sem = DispatchSemaphore(value: 0)

        input.installTap(onBus: 0, bufferSize: 4096, format: hwFormat) { [weak self] buffer, _ in
            guard let self = self, let file = self.outputFile else { return }

            let frameCount = AVAudioFrameCount(
                targetFormat.sampleRate / hwFormat.sampleRate * Double(buffer.frameLength)
            )
            guard frameCount > 0,
                  let convertedBuffer = AVAudioPCMBuffer(
                      pcmFormat: targetFormat, frameCapacity: frameCount
                  )
            else { return }

            var error: NSError?
            converter.convert(to: convertedBuffer, error: &error) { _, status in
                status.pointee = .haveData
                return buffer
            }

            if error == nil && convertedBuffer.frameLength > 0 {
                do { try file.write(from: convertedBuffer) } catch {}
            }
        }

        do {
            try engine.start()
        } catch {
            fputs("Error: cannot start engine: \(error)\n", stderr)
            return false
        }

        let timer = DispatchSource.makeTimerSource()
        timer.schedule(deadline: .now() + seconds)
        timer.setEventHandler {
            engine.stop()
            input.removeTap(onBus: 0)
            self.outputFile = nil
            sem.signal()
        }
        timer.resume()
        self.timer = timer

        sem.wait()
        return true
    }
}

// MARK: - Main

let args = CommandLine.arguments.dropFirst()
guard let command = args.first else {
    fputs("Usage: mic-helper <check|authorize|record> [args...]\n", stderr)
    exit(2)
}

// Helper: write exit code to file (for wrapper script communication via `open`)
func writeExitFile(_ code: Int32) {
    let args = Array(CommandLine.arguments.dropFirst())
    if let idx = args.firstIndex(of: "--exit-file"), idx + 1 < args.count {
        let path = args[idx + 1]
        try? "\(code)".write(toFile: path, atomically: true, encoding: .utf8)
    }
}

switch command {
case "check":
    let ok = checkPermission()
    writeExitFile(ok ? 0 : 1)
    exit(ok ? 0 : 1)

case "authorize":
    let ok = requestPermissionWithRunLoop()
    print(ok ? "authorized" : "denied")
    exit(ok ? 0 : 1)

case "record":
    let argList = Array(args)
    guard argList.count >= 3,
          let seconds = Double(argList[1])
    else {
        fputs("Usage: mic-helper record <seconds> <output.wav>\n", stderr)
        exit(2)
    }
    let outPath = argList[2]

    if !checkPermission() {
        let ok = requestPermissionWithRunLoop()
        if !ok {
            fputs("Microphone permission denied\n", stderr)
            exit(1)
        }
    }

    let recorder = Recorder()
    let ok = recorder.record(seconds: seconds, outputPath: outPath)
    exit(ok ? 0 : 1)

default:
    fputs("Unknown command: \(command)\n", stderr)
    exit(2)
}
