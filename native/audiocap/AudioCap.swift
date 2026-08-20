import AVFoundation
import CoreGraphics
import Darwin
import Foundation
import ScreenCaptureKit

/**
 Computer audio on macOS, the way OBS does it.

 Chromium's `getDisplayMedia` returns video only on macOS -- Electron's own
 typings say the `loopback` option is Windows-only -- so an Electron app cannot
 reach the system mix from JavaScript at all. Apple does expose it, but only
 through ScreenCaptureKit, which is Objective-C/Swift and lives outside the
 renderer. Hence this: a tiny helper that runs an SCStream with audio enabled
 and writes raw 48 kHz stereo float PCM to stdout, for the main process to feed
 straight into ffmpeg.

 The alternative is a virtual audio device (BlackHole), which works but asks the
 user to install a system-wide driver and re-route their output before they can
 record what they are hearing. That path stays as the fallback for macOS 12 and
 for anyone who has already set it up.
 */

// MARK: - Output plumbing

/// stdout is a pipe to the parent. A short write or a dead reader must not
/// crash us mid-recording, so this loops and exits quietly if the pipe closes.
private func writeAll(_ base: UnsafeRawPointer, _ count: Int) {
    var offset = 0
    while offset < count {
        let n = write(1, base.advanced(by: offset), count - offset)
        if n > 0 {
            offset += n
            continue
        }
        if errno == EINTR { continue }
        // Parent went away. Nothing left to write to, so stop cleanly.
        exit(0)
    }
}

/// Status goes to stderr as one JSON object per line, so the parent can tell
/// "running" from "denied" without parsing prose.
private func note(_ event: String, _ fields: [String: Any] = [:]) {
    var payload: [String: Any] = ["event": event]
    for (k, v) in fields { payload[k] = v }
    guard let data = try? JSONSerialization.data(withJSONObject: payload),
          var line = String(data: data, encoding: .utf8) else { return }
    line += "\n"
    FileHandle.standardError.write(Data(line.utf8))
}

private let sampleRate = 48_000
private let channelCount = 2

// MARK: - Stream

final class AudioTap: NSObject, SCStreamOutput, SCStreamDelegate {
    /// Reused between callbacks so a 21 ms audio tick does not allocate.
    private var scratch = [Float32]()

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        guard type == .audio, sampleBuffer.isValid, sampleBuffer.numSamples > 0 else { return }
        try? sampleBuffer.withAudioBufferList { list, _ in
            emit(list)
        }
    }

    /**
     ScreenCaptureKit hands audio over as non-interleaved Float32 -- one buffer
     per channel -- but the format is not contractual, so mono and already
     interleaved buffers are handled too. ffmpeg wants interleaved f32le.
     */
    private func emit(_ list: UnsafeMutableAudioBufferListPointer) {
        guard let first = list.first, let firstData = first.mData else { return }
        let frames = Int(first.mDataByteSize) / MemoryLayout<Float32>.size

        if list.count == 1 && first.mNumberChannels == UInt32(channelCount) {
            writeAll(firstData, Int(first.mDataByteSize))
            return
        }

        if scratch.count != frames * channelCount {
            scratch = [Float32](repeating: 0, count: frames * channelCount)
        }

        if list.count == 1 {
            // Mono: duplicate across both channels rather than emit a stream
            // whose channel count disagrees with what we announced.
            let src = firstData.assumingMemoryBound(to: Float32.self)
            for i in 0..<frames {
                scratch[i * 2] = src[i]
                scratch[i * 2 + 1] = src[i]
            }
        } else {
            guard let rightData = list[1].mData else { return }
            let left = firstData.assumingMemoryBound(to: Float32.self)
            let right = rightData.assumingMemoryBound(to: Float32.self)
            for i in 0..<frames {
                scratch[i * 2] = left[i]
                scratch[i * 2 + 1] = right[i]
            }
        }

        scratch.withUnsafeBytes { raw in
            guard let base = raw.baseAddress else { return }
            writeAll(base, raw.count)
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        note("stopped", ["message": error.localizedDescription])
        exit(3)
    }
}

// MARK: - Entry point

@main
struct AudioCap {
    static func main() async {
        // A closed stdout must not raise a signal; writeAll handles it.
        signal(SIGPIPE, SIG_IGN)

        if CommandLine.arguments.contains("--probe") {
            probe()
            return
        }

        if #available(macOS 13.0, *) {} else {
            note("error", ["message": "ScreenCaptureKit audio capture needs macOS 13 or newer."])
            exit(2)
        }

        do {
            let content = try await SCShareableContent.excludingDesktopWindows(
                false,
                onScreenWindowsOnly: false
            )
            guard let display = content.displays.first else {
                note("error", ["message": "No display available to capture audio from."])
                exit(2)
            }

            let filter = SCContentFilter(display: display, excludingWindows: [])
            let config = SCStreamConfiguration()
            config.capturesAudio = true
            config.excludesCurrentProcessAudio = true
            config.sampleRate = sampleRate
            config.channelCount = channelCount
            // Video is not consumed -- no output is registered for it -- but the
            // stream still needs a size, so keep it at the minimum the API will
            // take rather than paying to scale a whole display we throw away.
            config.width = 2
            config.height = 2
            config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
            config.queueDepth = 6

            let tap = AudioTap()
            let stream = SCStream(filter: filter, configuration: config, delegate: tap)
            try stream.addStreamOutput(
                tap,
                type: .audio,
                sampleHandlerQueue: DispatchQueue(label: "showoff.audiocap")
            )
            try await stream.startCapture()

            note("started", [
                "sampleRate": sampleRate,
                "channels": channelCount,
                "format": "f32le",
                "display": display.displayID
            ])

            installShutdown(stream)
            // Park forever; shutdown happens on a signal or when stdin closes.
            while true {
                try? await Task.sleep(nanoseconds: 3_600_000_000_000)
            }
        } catch {
            note("error", ["message": "\(error)"])
            exit(2)
        }
    }

    /// Reports what the parent needs to decide whether to offer this route at
    /// all, without triggering a permission prompt.
    private static func probe() {
        let version = ProcessInfo.processInfo.operatingSystemVersion
        let supported = version.majorVersion >= 13
        note("probe", [
            "supported": supported,
            "granted": CGPreflightScreenCaptureAccess(),
            "os": "\(version.majorVersion).\(version.minorVersion)"
        ])
    }

    /**
     Stops the stream on SIGTERM/SIGINT, and also when stdin reaches EOF -- if
     the app crashes, an orphaned capture process holding the microphone-style
     recording indicator would be far worse than a lost tail of audio.
     */
    private static func installShutdown(_ stream: SCStream) {
        let stop: () -> Void = {
            Task {
                try? await stream.stopCapture()
                note("finished")
                exit(0)
            }
        }

        for sig in [SIGTERM, SIGINT] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler(handler: stop)
            source.resume()
            sources.append(source)
        }

        let stdinWatch = DispatchSource.makeReadSource(fileDescriptor: 0, queue: .main)
        stdinWatch.setEventHandler {
            var byte: UInt8 = 0
            if read(0, &byte, 1) == 0 { stop() }
        }
        stdinWatch.resume()
        sources.append(stdinWatch)
    }
}

/// Dispatch sources are only live while referenced.
private var sources: [DispatchSourceProtocol] = []
