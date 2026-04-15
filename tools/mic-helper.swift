#!/usr/bin/env swift
// mic-helper — macOS microphone authorization & recording via AVFoundation
// Packaged as .app bundle so macOS shows the permission dialog.
//
// Usage:
//   mic-helper check              → exit 0 if authorized, 1 if not
//   mic-helper authorize           → trigger permission dialog, wait for result
//   mic-helper record <secs> <out> → record 16kHz mono PCM WAV
//   mic-helper stream-record <sock> [secs] → stream 16kHz mono PCM16 to Unix socket
//   mic-helper hud <sock>          → show floating ASR HUD (status + partial text)

import AVFoundation
import Foundation
import AppKit  // Needed for NSApplication run loop (permission dialogs require it)
import Darwin

let hudPidFilePath = "/tmp/echocoding-hud.pid"

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

func envBool(_ key: String, defaultValue: Bool) -> Bool {
    guard let raw = ProcessInfo.processInfo.environment[key]?.trimmingCharacters(in: .whitespacesAndNewlines),
          !raw.isEmpty
    else { return defaultValue }
    switch raw.lowercased() {
    case "1", "true", "yes", "on":
        return true
    case "0", "false", "no", "off":
        return false
    default:
        return defaultValue
    }
}

func shouldEnableVoiceProcessing() -> Bool {
    // VoiceProcessingIO can trigger system ducking in some routes.
    // Keep disabled by default so HUD/ASK TTS playback volume stays stable.
    return envBool("ECHOCODING_MIC_VOICE_PROCESSING", defaultValue: false)
}

@available(macOS 14.0, *)
func resolveVoiceProcessingDuckingLevel() -> AVAudioVoiceProcessingOtherAudioDuckingConfiguration.Level {
    let raw = ProcessInfo.processInfo.environment["ECHOCODING_MIC_VP_DUCKING_LEVEL"]?
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .lowercased() ?? "min"

    let levelRawValue: Int
    switch raw {
    case "default":
        levelRawValue = 0
    case "mid":
        levelRawValue = 20
    case "max":
        levelRawValue = 30
    default:
        levelRawValue = 10
    }

    return AVAudioVoiceProcessingOtherAudioDuckingConfiguration.Level(rawValue: levelRawValue)
        ?? AVAudioVoiceProcessingOtherAudioDuckingConfiguration.Level(rawValue: 10)!
}

func configureVoiceProcessing(_ input: AVAudioInputNode, enabled: Bool, context: String) {
    guard #available(macOS 10.15, *), enabled else {
        debugLog("\(context): voice processing disabled")
        return
    }

    do {
        try input.setVoiceProcessingEnabled(true)
        debugLog("\(context): voice processing enabled")

        // AGC can make perceived loudness unstable in noisy environments.
        input.isVoiceProcessingAGCEnabled = !envBool("ECHOCODING_MIC_VP_DISABLE_AGC", defaultValue: true)
        debugLog("\(context): voice processing AGC=\(input.isVoiceProcessingAGCEnabled)")

        if #available(macOS 14.0, *) {
            var config = input.voiceProcessingOtherAudioDuckingConfiguration
            config.enableAdvancedDucking = false
            config.duckingLevel = resolveVoiceProcessingDuckingLevel()
            input.voiceProcessingOtherAudioDuckingConfiguration = config
            debugLog("\(context): ducking advanced=\(config.enableAdvancedDucking) levelRaw=\(config.duckingLevel.rawValue)")
        }
    } catch {
        debugLog("\(context): voice processing unavailable \(error)")
    }
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
        configureVoiceProcessing(input, enabled: shouldEnableVoiceProcessing(), context: "record")

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

// MARK: - Streaming PCM Recording

func connectUnixSocket(_ socketPath: String) -> Int32 {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    if fd < 0 { return -1 }

    var addr = sockaddr_un()
    addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    addr.sun_family = sa_family_t(AF_UNIX)

    let pathBytes = Array(socketPath.utf8CString)
    let copied = withUnsafeMutableBytes(of: &addr.sun_path) { raw -> Bool in
        guard pathBytes.count < raw.count else { return false }
        memset(raw.baseAddress, 0, raw.count)
        _ = pathBytes.withUnsafeBytes { src in
            memcpy(raw.baseAddress, src.baseAddress, pathBytes.count)
        }
        return true
    }
    if !copied {
        Darwin.close(fd)
        return -1
    }

    let addrLen = socklen_t(MemoryLayout<sockaddr_un>.size)
    let result = withUnsafePointer(to: &addr) { ptr in
        ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
            connect(fd, sockPtr, addrLen)
        }
    }
    if result != 0 {
        Darwin.close(fd)
        return -1
    }

    return fd
}

func writeAll(fd: Int32, data: UnsafeRawPointer, count: Int) -> Bool {
    var offset = 0
    while offset < count {
        let n = Darwin.write(fd, data.advanced(by: offset), count - offset)
        if n <= 0 { return false }
        offset += n
    }
    return true
}

class StreamRecorder: NSObject {
    private var engine: AVAudioEngine?
    private var timer: DispatchSourceTimer?
    private var socketFd: Int32 = -1

    func stream(seconds: Double, socketPath: String, forceVoiceProcessing: Bool?) -> Bool {
        let fd = connectUnixSocket(socketPath)
        if fd < 0 {
            fputs("Error: cannot connect socket \(socketPath)\n", stderr)
            return false
        }
        socketFd = fd

        let engine = AVAudioEngine()
        self.engine = engine

        let input = engine.inputNode
        let hwFormat = input.outputFormat(forBus: 0)
        let voiceProcessingEnabled = forceVoiceProcessing ?? shouldEnableVoiceProcessing()
        configureVoiceProcessing(input, enabled: voiceProcessingEnabled, context: "stream-record")

        guard let targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: 16000,
            channels: 1,
            interleaved: true
        ) else {
            fputs("Error: cannot create target format\n", stderr)
            Darwin.close(fd)
            socketFd = -1
            return false
        }

        guard let converter = AVAudioConverter(from: hwFormat, to: targetFormat) else {
            fputs("Error: cannot create audio converter\n", stderr)
            Darwin.close(fd)
            socketFd = -1
            return false
        }

        let sem = DispatchSemaphore(value: 0)
        var finished = false
        var writeFailed = false

        let finish: () -> Void = {
            if finished { return }
            finished = true
            engine.stop()
            input.removeTap(onBus: 0)
            if self.socketFd >= 0 {
                Darwin.close(self.socketFd)
                self.socketFd = -1
            }
            self.timer?.cancel()
            self.timer = nil
            sem.signal()
        }

        input.installTap(onBus: 0, bufferSize: 1024, format: hwFormat) { buffer, _ in
            if finished { return }

            let frameCount = AVAudioFrameCount(
                targetFormat.sampleRate / hwFormat.sampleRate * Double(buffer.frameLength)
            )
            guard frameCount > 0,
                  let convertedBuffer = AVAudioPCMBuffer(
                      pcmFormat: targetFormat, frameCapacity: frameCount
                  )
            else { return }

            var convError: NSError?
            converter.convert(to: convertedBuffer, error: &convError) { _, status in
                status.pointee = .haveData
                return buffer
            }
            if convError != nil || convertedBuffer.frameLength == 0 { return }

            guard let channels = convertedBuffer.int16ChannelData else { return }
            let bytesPerFrame = Int(targetFormat.streamDescription.pointee.mBytesPerFrame)
            let byteCount = Int(convertedBuffer.frameLength) * bytesPerFrame
            if byteCount <= 0 { return }

            let ok = writeAll(fd: fd, data: UnsafeRawPointer(channels.pointee), count: byteCount)
            if !ok {
                writeFailed = true
                DispatchQueue.main.async { finish() }
            }
        }

        do {
            try engine.start()
        } catch {
            fputs("Error: cannot start engine: \(error)\n", stderr)
            finish()
            return false
        }

        let timer = DispatchSource.makeTimerSource()
        timer.schedule(deadline: .now() + seconds)
        timer.setEventHandler { finish() }
        timer.resume()
        self.timer = timer

        sem.wait()
        return !writeFailed
    }
}

// MARK: - Floating HUD

final class HudOverlayController: NSObject {
    private let statusDotIntervalMs: Int = 350
    private let cursorBlinkIntervalMs: Int = 500
    private let minHudOpenMs: Int = 700
    private let postTerminalHoldMs: Int = 1600
    private let eofCloseGraceMs: Int = 260
    private let hardIdleCloseMs: Int = 65_000
    private let userLinePrefix = "YOU: "
    private let socketFd: Int32
    private var fdClosed = false
    private var window: NSPanel?
    private var statusLabel: NSTextField?
    private var conversationView: NSTextView?
    private var draftLineLabel: NSTextField?
    private var conversationLines: [String] = []
    private var currentUserDraft: String?
    private var userDraftActive = true
    private var userCursorVisible = true
    private var readSource: DispatchSourceRead?
    private var statusAnimationTimer: DispatchSourceTimer?
    private var cursorBlinkTimer: DispatchSourceTimer?
    private var idleWatchdogTimer: DispatchSourceTimer?
    private var closeWorkItem: DispatchWorkItem?
    private var readBuffer = Data()
    private var baseStatus = "Listening"
    private var isAnimating = false
    private var dotCount = 0
    private var closeRequested = false
    private var minVisibleUntil: Date?
    private var scheduledCloseAt: Date?
    private var sawTerminalMessage = false
    private var lastInboundAt = Date()
    private let maxConversationTurns = 2

    init(socketFd: Int32) {
        self.socketFd = socketFd
    }

    func start() {
        minVisibleUntil = Date().addingTimeInterval(Double(minHudOpenMs) / 1000.0)
        lastInboundAt = Date()
        setupWindow()
        startReadLoop()
        startStatusAnimationTimer()
        startCursorBlinkTimer()
        startIdleWatchdogTimer()
        updateStatusUI()
        ensureUserDraftVisible(force: true)
        renderConversation()
    }

    func shutdown() {
        readSource?.cancel()
        readSource = nil
        statusAnimationTimer?.cancel()
        statusAnimationTimer = nil
        cursorBlinkTimer?.cancel()
        cursorBlinkTimer = nil
        idleWatchdogTimer?.cancel()
        idleWatchdogTimer = nil
        closeWorkItem?.cancel()
        closeWorkItem = nil
        closeFdIfNeeded()
    }

    private func closeFdIfNeeded() {
        guard !fdClosed else { return }
        fdClosed = true
        Darwin.close(socketFd)
    }

    private func setupWindow() {
        let width: CGFloat = 500
        let height: CGFloat = 210
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1280, height: 800)
        let x = screen.midX - (width / 2)
        let y = screen.maxY - height - 10
        let frame = NSRect(x: x, y: y, width: width, height: height)

        let panel = NSPanel(
            contentRect: frame,
            styleMask: [.titled, .nonactivatingPanel, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isMovableByWindowBackground = true
        panel.backgroundColor = NSColor(calibratedWhite: 0.07, alpha: 0.94)
        panel.isOpaque = false
        panel.hasShadow = true
        panel.standardWindowButton(.closeButton)?.isHidden = true
        panel.standardWindowButton(.miniaturizeButton)?.isHidden = true
        panel.standardWindowButton(.zoomButton)?.isHidden = true

        let content = NSView(frame: NSRect(x: 0, y: 0, width: width, height: height))
        panel.contentView = content

        let titleLabel = NSTextField(labelWithString: "EchoCoding Ask")
        titleLabel.font = NSFont.systemFont(ofSize: 15, weight: .semibold)
        titleLabel.textColor = NSColor(calibratedWhite: 0.87, alpha: 1.0)
        titleLabel.frame = NSRect(x: 18, y: height - 38, width: width - 36, height: 18)
        content.addSubview(titleLabel)

        let status = NSTextField(labelWithString: "Listening")
        status.font = NSFont.monospacedSystemFont(ofSize: 16, weight: .medium)
        status.textColor = NSColor(calibratedRed: 0.57, green: 0.85, blue: 1.0, alpha: 1.0)
        status.frame = NSRect(x: 18, y: height - 62, width: width - 36, height: 18)
        content.addSubview(status)
        self.statusLabel = status

        let timelineHeader = NSTextField(labelWithString: "Recent (2 turns)")
        timelineHeader.font = NSFont.systemFont(ofSize: 13, weight: .semibold)
        timelineHeader.textColor = NSColor(calibratedWhite: 0.72, alpha: 1.0)
        timelineHeader.frame = NSRect(x: 18, y: height - 84, width: width - 36, height: 14)
        content.addSubview(timelineHeader)

        let draftFrame = NSRect(x: 18, y: 12, width: width - 36, height: 24)
        let draftLabel = NSTextField(labelWithString: "\(userLinePrefix)|")
        draftLabel.font = NSFont.monospacedSystemFont(ofSize: 15, weight: .regular)
        draftLabel.textColor = NSColor(calibratedWhite: 0.98, alpha: 1.0)
        draftLabel.frame = draftFrame
        draftLabel.lineBreakMode = .byTruncatingTail
        content.addSubview(draftLabel)
        self.draftLineLabel = draftLabel

        let scrollFrame = NSRect(x: 18, y: 40, width: width - 36, height: height - 130)
        let scrollView = NSScrollView(frame: scrollFrame)
        scrollView.borderType = .noBorder
        scrollView.hasVerticalScroller = false
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.drawsBackground = false

        let textView = NSTextView(frame: NSRect(origin: .zero, size: scrollFrame.size))
        textView.isEditable = false
        textView.isSelectable = false
        textView.drawsBackground = false
        textView.font = NSFont.monospacedSystemFont(ofSize: 15, weight: .regular)
        textView.textColor = NSColor(calibratedWhite: 0.9, alpha: 1.0)
        textView.string = ""
        textView.textContainerInset = NSSize(width: 4, height: 6)
        textView.textContainer?.lineBreakMode = .byWordWrapping
        textView.textContainer?.widthTracksTextView = true
        textView.minSize = NSSize(width: 0, height: scrollFrame.height)
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        scrollView.documentView = textView
        content.addSubview(scrollView)
        self.conversationView = textView
        self.conversationLines = []

        panel.orderFrontRegardless()
        NSApp.activate(ignoringOtherApps: false)
        self.window = panel
    }

    private func startReadLoop() {
        let source = DispatchSource.makeReadSource(fileDescriptor: socketFd, queue: DispatchQueue.global(qos: .userInitiated))
        source.setEventHandler { [weak self] in
            guard let self = self else { return }
            var buf = [UInt8](repeating: 0, count: 4096)
            let n = Darwin.read(self.socketFd, &buf, buf.count)
            if n <= 0 {
                if self.closeRequested { return }
                self.readSource?.cancel()
                self.readSource = nil
                // EOF can race with queued UI updates (final/partial).
                // Give the main queue a brief grace period before closing.
                self.processTailBufferIfNeeded()
                DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(180)) {
                    self.requestClose(extraHoldMs: self.eofCloseGraceMs)
                }
                return
            }
            self.readBuffer.append(buf, count: n)
            self.processBufferedLines()
        }
        source.setCancelHandler { [weak self] in
            self?.closeFdIfNeeded()
        }
        readSource = source
        source.resume()
    }

    private func processBufferedLines() {
        while let idx = readBuffer.firstIndex(of: 0x0A) { // '\n'
            let lineData = readBuffer.prefix(upTo: idx)
            readBuffer.removeSubrange(...idx)
            guard !lineData.isEmpty else { continue }
            guard let json = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any] else {
                continue
            }
            DispatchQueue.main.async { self.handleHudMessage(json) }
        }
    }

    private func processTailBufferIfNeeded() {
        guard !readBuffer.isEmpty else { return }
        let lineData = readBuffer
        readBuffer.removeAll(keepingCapacity: false)
        guard let json = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any] else {
            return
        }
        DispatchQueue.main.async { self.handleHudMessage(json) }
    }

    private func trimConversationIfNeeded() {
        let maxConversationLines = maxConversationTurns * 2
        if conversationLines.count <= maxConversationLines { return }
        conversationLines = Array(conversationLines.suffix(maxConversationLines))
    }

    private func appendConversationLine(_ line: String) {
        let text = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        conversationLines.append(text)
        trimConversationIfNeeded()
        renderConversation()
    }

    private func ensureUserDraftVisible(force: Bool = false) {
        if !force && sawTerminalMessage { return }
        if currentUserDraft == nil {
            currentUserDraft = ""
        }
        userDraftActive = true
        userCursorVisible = true
    }

    private func extendVisibility(ms: Int) {
        let until = Date().addingTimeInterval(Double(max(0, ms)) / 1000.0)
        if let existing = minVisibleUntil {
            minVisibleUntil = max(existing, until)
        } else {
            minVisibleUntil = until
        }
    }

    private func scheduleClose(at date: Date) {
        let now = Date()
        if let scheduled = scheduledCloseAt, scheduled >= date {
            let remainMs = Int((scheduled.timeIntervalSince(now) * 1000.0).rounded())
            debugLog("hud: skip close reschedule remainMs=\(remainMs)")
            return
        }
        scheduledCloseAt = date

        closeWorkItem?.cancel()
        closeWorkItem = nil

        let delay = max(0.0, date.timeIntervalSinceNow)
        debugLog("hud: schedule close delayMs=\(Int((delay * 1000.0).rounded()))")
        let workItem = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            self.closeWorkItem?.cancel()
            self.closeWorkItem = nil
            self.scheduledCloseAt = nil
            debugLog("hud: close work item fired")
            self.terminateApp()
        }
        closeWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: workItem)
    }

    private func renderConversation() {
        guard let view = conversationView else { return }
        let baseFont = NSFont.monospacedSystemFont(ofSize: 15, weight: .regular)
        let baseAttrs: [NSAttributedString.Key: Any] = [
            .font: baseFont,
            .foregroundColor: NSColor(calibratedWhite: 0.9, alpha: 1.0),
        ]
        let focusedAttrs: [NSAttributedString.Key: Any] = [
            .font: baseFont,
            .foregroundColor: NSColor(calibratedRed: 0.97, green: 0.99, blue: 1.0, alpha: 1.0),
        ]
        let cursorAttrs: [NSAttributedString.Key: Any] = [
            .font: baseFont,
            .foregroundColor: NSColor(calibratedRed: 0.72, green: 0.9, blue: 1.0, alpha: 1.0),
        ]

        let composed = NSMutableAttributedString()

        func appendLine(_ line: NSAttributedString) {
            if composed.length > 0 {
                composed.append(NSAttributedString(string: "\n", attributes: baseAttrs))
            }
            composed.append(line)
        }

        for line in conversationLines {
            appendLine(NSAttributedString(string: line, attributes: baseAttrs))
        }

        if composed.length == 0 {
            composed.append(NSAttributedString(string: "AI: Waiting for voice...", attributes: baseAttrs))
        }

        view.textStorage?.setAttributedString(composed)
        let endRange = NSRange(location: max(0, composed.length - 1), length: min(1, composed.length))
        view.scrollRangeToVisible(endRange)

        if let label = draftLineLabel {
            if userDraftActive {
                let draft = currentUserDraft?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let line = NSMutableAttributedString(string: "\(userLinePrefix)\(draft)", attributes: focusedAttrs)
                let cursor = userCursorVisible ? "|" : " "
                line.append(NSAttributedString(string: cursor, attributes: cursorAttrs))
                label.attributedStringValue = line
            } else if let draft = currentUserDraft?.trimmingCharacters(in: .whitespacesAndNewlines),
                      !draft.isEmpty {
                label.attributedStringValue = NSAttributedString(
                    string: "\(userLinePrefix)\(draft)",
                    attributes: baseAttrs
                )
            } else {
                label.attributedStringValue = NSAttributedString(string: "")
            }
        }
    }

    private func handleHudMessage(_ msg: [String: Any]) {
        lastInboundAt = Date()
        guard let type = msg["type"] as? String else { return }
        switch type {
        case "reset":
            closeRequested = false
            sawTerminalMessage = false
            minVisibleUntil = Date().addingTimeInterval(Double(minHudOpenMs) / 1000.0)
            closeWorkItem?.cancel()
            closeWorkItem = nil
            scheduledCloseAt = nil
            baseStatus = "Preparing"
            isAnimating = true
            dotCount = 0
            currentUserDraft = ""
            userDraftActive = true
            userCursorVisible = true
            if (msg["clear"] as? Bool) == true {
                conversationLines.removeAll(keepingCapacity: true)
            }
            renderConversation()
            updateStatusUI()
        case "prompt":
            ensureUserDraftVisible(force: true)
            let text = (msg["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !text.isEmpty {
                appendConversationLine("AI: \(text)")
            }
        case "status":
            baseStatus = (msg["text"] as? String) ?? baseStatus
            isAnimating = (msg["animate"] as? Bool) ?? false
            dotCount = 0
            ensureUserDraftVisible(force: true)
            updateStatusUI()
            renderConversation()
        case "partial":
            let text = (msg["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            currentUserDraft = text
            userDraftActive = true
            userCursorVisible = true
            renderConversation()
            if !text.isEmpty {
                debugLog("hud: partial text=\(String(text.prefix(120)))")
            }
        case "final":
            sawTerminalMessage = true
            extendVisibility(ms: postTerminalHoldMs)
            baseStatus = "Done"
            isAnimating = false
            dotCount = 0
            let rawText = (msg["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let text = rawText == "[empty]" ? "未识别到清晰语音" : rawText
            if !text.isEmpty {
                appendConversationLine("\(userLinePrefix)\(text)")
            }
            currentUserDraft = nil
            userDraftActive = false
            userCursorVisible = false
            renderConversation()
            debugLog("hud: final text=\(String(text.prefix(120)))")
            updateStatusUI()
            if closeRequested {
                requestClose()
            }
        case "timeout":
            sawTerminalMessage = true
            extendVisibility(ms: postTerminalHoldMs)
            baseStatus = "Timeout"
            isAnimating = false
            dotCount = 0
            currentUserDraft = nil
            userDraftActive = false
            userCursorVisible = false
            appendConversationLine("System: No speech detected")
            debugLog("hud: timeout")
            updateStatusUI()
            if closeRequested {
                requestClose()
            }
        case "error":
            sawTerminalMessage = true
            extendVisibility(ms: postTerminalHoldMs)
            baseStatus = "Error"
            isAnimating = false
            dotCount = 0
            let text = (msg["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            currentUserDraft = nil
            userDraftActive = false
            userCursorVisible = false
            appendConversationLine(text.isEmpty ? "System: ASR error" : "System: \(text)")
            debugLog("hud: error text=\(String(text.prefix(120)))")
            updateStatusUI()
            if closeRequested {
                requestClose()
            }
        case "close":
            debugLog("hud: close requested")
            requestClose()
        default:
            break
        }
    }

    private func startStatusAnimationTimer() {
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.main)
        timer.schedule(
            deadline: .now() + .milliseconds(statusDotIntervalMs),
            repeating: .milliseconds(statusDotIntervalMs)
        )
        timer.setEventHandler { [weak self] in
            guard let self = self else { return }
            guard self.isAnimating else { return }
            self.dotCount = (self.dotCount + 1) % 4
            self.updateStatusUI()
        }
        statusAnimationTimer = timer
        timer.resume()
    }

    private func startCursorBlinkTimer() {
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.main)
        timer.schedule(
            deadline: .now() + .milliseconds(cursorBlinkIntervalMs),
            repeating: .milliseconds(cursorBlinkIntervalMs)
        )
        timer.setEventHandler { [weak self] in
            guard let self = self else { return }
            guard self.userDraftActive else { return }
            self.userCursorVisible.toggle()
            self.renderConversation()
        }
        cursorBlinkTimer = timer
        timer.resume()
    }

    private func startIdleWatchdogTimer() {
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.main)
        timer.schedule(
            deadline: .now() + .milliseconds(1000),
            repeating: .milliseconds(1000)
        )
        timer.setEventHandler { [weak self] in
            guard let self = self else { return }
            if self.closeRequested { return }
            let idleMs = Date().timeIntervalSince(self.lastInboundAt) * 1000.0
            if idleMs < Double(self.hardIdleCloseMs) { return }
            debugLog("hud: idle watchdog close")
            self.requestClose()
        }
        idleWatchdogTimer = timer
        timer.resume()
    }

    private func updateStatusUI() {
        let dots = String(repeating: ".", count: isAnimating ? dotCount : 0)
        statusLabel?.stringValue = isAnimating ? "\(baseStatus)\(dots)" : baseStatus
    }

    private func requestClose(extraHoldMs: Int = 0) {
        closeRequested = true
        let extraUntil = Date().addingTimeInterval(Double(max(0, extraHoldMs)) / 1000.0)
        let holdUntil = max(minVisibleUntil ?? Date(), extraUntil)
        let delayMs = Int((holdUntil.timeIntervalSinceNow * 1000.0).rounded())
        debugLog("hud: requestClose extraHoldMs=\(extraHoldMs) delayMs=\(max(0, delayMs))")
        scheduleClose(at: holdUntil)
    }

    private func terminateApp() {
        debugLog("hud: terminate app")
        NSApp.stop(nil)
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
            NSApp.postEvent(event, atStart: true)
        }
    }
}

final class HudAppDelegate: NSObject, NSApplicationDelegate {
    private let socketPath: String
    private let ownerPid: Int32
    private var overlay: HudOverlayController?

    init(socketPath: String, ownerPid: Int32) {
        self.socketPath = socketPath
        self.ownerPid = ownerPid
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let fd = connectUnixSocket(socketPath)
        if fd < 0 {
            NSApp.terminate(nil)
            return
        }
        let controller = HudOverlayController(socketFd: fd)
        overlay = controller
        controller.start()
    }

    func applicationWillTerminate(_ notification: Notification) {
        overlay?.shutdown()
        overlay = nil
        clearHudPidIfOwned(ownerPid)
    }
}

// MARK: - Debug log (file-based since stdout/stderr are lost when launched via `open`)

func debugLog(_ msg: String) {
    let logPath = "/tmp/mic-helper-debug.log"
    let line = "\(Date()): \(msg)\n"
    if let fh = FileHandle(forWritingAtPath: logPath) {
        fh.seekToEndOfFile()
        fh.write(line.data(using: .utf8)!)
        fh.closeFile()
    } else {
        try? line.write(toFile: logPath, atomically: true, encoding: .utf8)
    }
}

func readHudPid() -> Int32? {
    guard let raw = try? String(contentsOfFile: hudPidFilePath, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
          let value = Int32(raw)
    else {
        return nil
    }
    return value
}

func isPidAlive(_ pid: Int32) -> Bool {
    if pid <= 1 { return false }
    if kill(pid, 0) == 0 { return true }
    return errno == EPERM
}

func writeHudPid(_ pid: Int32) {
    try? "\(pid)".write(toFile: hudPidFilePath, atomically: true, encoding: .utf8)
}

func clearHudPidIfOwned(_ pid: Int32) {
    guard let existing = readHudPid(), existing == pid else { return }
    try? FileManager.default.removeItem(atPath: hudPidFilePath)
}

func claimHudSingleton() {
    let selfPid = Int32(getpid())
    if let existing = readHudPid(), existing != selfPid, isPidAlive(existing) {
        debugLog("hud: terminating stale pid=\(existing)")
        _ = kill(existing, SIGTERM)
        usleep(120_000)
        if isPidAlive(existing) {
            _ = kill(existing, SIGKILL)
        }
    }
    writeHudPid(selfPid)
}

// MARK: - Main

// Filter out macOS Launch Services -psn_N_NNNN args injected by `open`
let args = CommandLine.arguments.dropFirst().filter { !$0.hasPrefix("-psn_") }
guard let command = args.first else {
    fputs("Usage: mic-helper <check|authorize|record|stream-record|hud> [args...]\n", stderr)
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
    writeExitFile(ok ? 0 : 1)
    print(ok ? "authorized" : "denied")
    exit(ok ? 0 : 1)

case "record":
    let argList = Array(args)
    debugLog("record: args=\(argList)")
    guard argList.count >= 3,
          let seconds = Double(argList[1])
    else {
        debugLog("record: bad args, count=\(argList.count)")
        fputs("Usage: mic-helper record <seconds> <output.wav>\n", stderr)
        exit(2)
    }
    let outPath = argList[2]
    debugLog("record: seconds=\(seconds) path=\(outPath)")

    if !checkPermission() {
        debugLog("record: permission not granted")
        fputs("Microphone permission denied. Run mic-helper authorize first.\n", stderr)
        exit(1)
    }
    debugLog("record: permission already granted")

    let recorder = Recorder()
    debugLog("record: starting recording")
    let ok = recorder.record(seconds: seconds, outputPath: outPath)
    debugLog("record: finished ok=\(ok)")
    exit(ok ? 0 : 1)

case "stream-record":
    let argList = Array(args)
    debugLog("stream-record: args=\(argList)")
    guard argList.count >= 2 else {
        fputs("Usage: mic-helper stream-record <socket-path> [seconds] [--voice-processing|--no-voice-processing]\n", stderr)
        exit(2)
    }
    let socketPath = argList[1]
    var seconds: Double = 90
    var forceVoiceProcessing: Bool? = nil
    if argList.count >= 3 {
        for token in argList.dropFirst(2) {
            if token == "--voice-processing" {
                forceVoiceProcessing = true
                continue
            }
            if token == "--no-voice-processing" {
                forceVoiceProcessing = false
                continue
            }
            if let parsed = Double(token) {
                seconds = parsed
                continue
            }
        }
    }
    debugLog("stream-record: socket=\(socketPath) seconds=\(seconds) forceVoiceProcessing=\(String(describing: forceVoiceProcessing))")

    if !checkPermission() {
        debugLog("stream-record: permission not granted")
        fputs("Microphone permission denied. Run mic-helper authorize first.\n", stderr)
        exit(1)
    }
    debugLog("stream-record: permission already granted")

    let recorder = StreamRecorder()
    let ok = recorder.stream(seconds: seconds, socketPath: socketPath, forceVoiceProcessing: forceVoiceProcessing)
    debugLog("stream-record: finished ok=\(ok)")
    exit(ok ? 0 : 1)

case "hud":
    let argList = Array(args)
    guard argList.count >= 2 else {
        fputs("Usage: mic-helper hud <socket-path>\n", stderr)
        exit(2)
    }
    let socketPath = argList[1]
    claimHudSingleton()
    let selfPid = Int32(getpid())

    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let delegate = HudAppDelegate(socketPath: socketPath, ownerPid: selfPid)
    app.delegate = delegate
    app.run()
    exit(0)

default:
    fputs("Unknown command: \(command)\n", stderr)
    exit(2)
}
