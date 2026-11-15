// VoiceAec system-audio tap (macOS 14.4+).
//
// Captures every process's audio output through a Core Audio process tap,
// downmixes it to mono, resamples it to 16 kHz and writes raw little-endian
// int16 PCM to stdout. The DeepSeek Harness host plugin reads this stream and
// serves it to the Web UI as the echo reference for the microphone.
//
// stdout: raw s16le, 16 kHz, mono, 20 ms chunks.
// stderr: one JSON object per line (ready / warning / error).
//
// Usage: voiceaec-tap [--rate 16000]

import AVFoundation
import CoreAudio
import Foundation

let outRate = 16_000.0
let hopFrames = 320  // 20 ms at 16 kHz

func emit(_ fields: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: fields),
          var text = String(data: data, encoding: .utf8) else { return }
    text += "\n"
    FileHandle.standardError.write(Data(text.utf8))
}

/// Blocking write of the whole buffer to stdout.
func writeAll(_ data: Data) -> Bool {
    var offset = 0
    return data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> Bool in
        guard let base = raw.baseAddress else { return true }
        while offset < raw.count {
            let written = write(1, base.advanced(by: offset), raw.count - offset)
            if written <= 0 {
                if errno == EINTR { continue }
                return false
            }
            offset += written
        }
        return true
    }
}

/// One-pole-free second order low-pass (RBJ biquad, Butterworth Q).
struct Biquad {
    var b0 = 1.0, b1 = 0.0, b2 = 0.0, a1 = 0.0, a2 = 0.0
    var x1 = 0.0, x2 = 0.0, y1 = 0.0, y2 = 0.0

    static func lowpass(cutoff: Double, rate: Double) -> Biquad? {
        guard cutoff > 0, cutoff < rate / 2, rate > 0 else { return nil }
        let w0 = 2 * Double.pi * cutoff / rate
        let cosw = cos(w0)
        let alpha = sin(w0) / (2 * 0.7071067811865476)
        let a0 = 1 + alpha
        var f = Biquad()
        f.b0 = (1 - cosw) / 2 / a0
        f.b1 = (1 - cosw) / a0
        f.b2 = f.b0
        f.a1 = -2 * cosw / a0
        f.a2 = (1 - alpha) / a0
        return f
    }

    mutating func process(_ x: Double) -> Double {
        let y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        x2 = x1; x1 = x
        y2 = y1; y1 = y
        return y
    }
}

/// Streaming converter: interleaved float32 at `inputRate` -> mono s16le at 16 kHz.
final class Downsampler {
    private var filter: Biquad?
    private var phase = 1.0
    private let step: Double
    private var last = 0.0
    private var haveLast = false
    private var scratch = [Int16]()
    private let lock = NSLock()
    private var pending = Data()

    init(inputRate: Double) {
        step = inputRate / outRate
        if inputRate > outRate * 1.5 {
            filter = Biquad.lowpass(cutoff: outRate * 0.45, rate: inputRate)
        }
    }

    /// Feed interleaved float samples; returns finished 16 kHz frames.
    func feed(_ samples: UnsafePointer<Float>, count: Int, channels: Int) -> [Int16] {
        guard channels > 0, count > 0 else { return [] }
        let frames = count / channels
        scratch.removeAll(keepingCapacity: true)
        for frame in 0..<frames {
            var mix = 0.0
            for channel in 0..<channels {
                mix += Double(samples[frame * channels + channel])
            }
            mix /= Double(channels)
            var value = mix
            if filter != nil { value = filter!.process(value) }
            if !haveLast {
                last = value; haveLast = true
                phase = 0.0
                continue
            }
            phase += 1.0
            while phase >= step {
                phase -= step
                let frac = phase / step  // 0..1 position between last and value
                let interpolated = last + (value - last) * frac
                let clamped = max(-1.0, min(1.0, interpolated))
                scratch.append(Int16(clamped * 32767.0))
            }
            last = value
        }
        return scratch
    }

    func append(_ frames: [Int16]) -> [Int16] {
        // Frames are produced in order; chunking happens in the writer.
        return frames
    }
}

/// Buffers PCM and flushes whole 20 ms chunks from a background queue so the
/// realtime audio callback never blocks on stdout.
final class PcmSink {
    private let lock = NSLock()
    private var buffer = [Int16]()
    private var stopped = false
    private var timer: DispatchSourceTimer?

    func start() {
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "voiceaec.pcm"))
        timer.schedule(deadline: .now(), repeating: .milliseconds(20), leeway: .milliseconds(5))
        timer.setEventHandler { [weak self] in self?.flush() }
        timer.resume()
        self.timer = timer
    }

    func push(_ frames: [Int16]) {
        guard !frames.isEmpty else { return }
        lock.lock()
        buffer.append(contentsOf: frames)
        // Never grow without bound if stdout stalls.
        if buffer.count > outRateInt * 2 { buffer.removeFirst(buffer.count - outRateInt) }
        lock.unlock()
    }

    func stop() {
        lock.lock(); stopped = true; lock.unlock()
        timer?.cancel(); timer = nil
        flush()
    }

    private func flush() {
        lock.lock()
        guard buffer.count >= hopFrames else { lock.unlock(); return }
        let take = buffer.count - (buffer.count % hopFrames)
        let chunk = Array(buffer[0..<take])
        buffer.removeFirst(take)
        lock.unlock()

        var data = Data(capacity: chunk.count * 2)
        for sample in chunk {
            let bits = UInt16(bitPattern: sample)
            data.append(UInt8(bits & 0xff))
            data.append(UInt8(bits >> 8))
        }
        if !writeAll(data) { exit(0) }
    }

    private var outRateInt: Int { Int(outRate) }
}

// MARK: - Core Audio tap

func defaultOutputUID() -> CFString? {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var device = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device) == noErr else {
        return nil
    }
    var uidAddress = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceUID,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var uid: Unmanaged<CFString>?
    var uidSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(device, &uidAddress, 0, nil, &uidSize, &uid) == noErr else { return nil }
    return uid?.takeRetainedValue()
}

func outputUID(named name: String) -> CFString? {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else { return nil }
    let count = Int(size) / MemoryLayout<AudioObjectID>.size
    var devices = [AudioObjectID](repeating: 0, count: count)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &devices) == noErr else { return nil }
    for device in devices {
        var nameAddress = AudioObjectPropertyAddress(
            mSelector: kAudioObjectPropertyName,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var value: Unmanaged<CFString>?
        var valueSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(device, &nameAddress, 0, nil, &valueSize, &value) == noErr else { continue }
        guard let title = value?.takeRetainedValue() as String?, title == name else { continue }
        var uidAddress = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceUID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var uid: Unmanaged<CFString>?
        var uidSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(device, &uidAddress, 0, nil, &uidSize, &uid) == noErr else { continue }
        return uid?.takeRetainedValue()
    }
    return nil
}

func tapFormat(_ tapID: AudioObjectID) -> AudioStreamBasicDescription? {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioTapPropertyFormat,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var asbd = AudioStreamBasicDescription()
    var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    guard AudioObjectGetPropertyData(tapID, &address, 0, nil, &size, &asbd) == noErr else { return nil }
    return asbd
}

signal(SIGPIPE, SIG_IGN)

var tapID = AudioObjectID(kAudioObjectUnknown)
let description = CATapDescription(__stereoGlobalTapButExcludeProcesses: [])
description.name = "VoiceAec Reference"
description.uuid = UUID()
description.muteBehavior = .unmuted
description.isPrivate = true
description.isExclusive = false

let tapStatus = AudioHardwareCreateProcessTap(description, &tapID)
guard tapStatus == noErr else {
    emit(["event": "error", "message": "AudioHardwareCreateProcessTap failed", "status": tapStatus])
    exit(2)
}

let requestedDevice = ProcessInfo.processInfo.environment["VOICEAEC_DEVICE"]
guard let outputUID = requestedDevice.flatMap({ outputUID(named: $0) }) ?? defaultOutputUID() else {
    emit(["event": "error", "message": "no default output device"])
    exit(3)
}

let aggregateUID = "voiceaec-tap-\(UUID().uuidString)"
let aggregate: [String: Any] = [
    kAudioAggregateDeviceNameKey: "VoiceAec Reference",
    kAudioAggregateDeviceUIDKey: aggregateUID,
    kAudioAggregateDeviceMainSubDeviceKey: outputUID as String,
    kAudioAggregateDeviceIsPrivateKey: true,
    kAudioAggregateDeviceIsStackedKey: false,
    kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID as String]],
    kAudioAggregateDeviceTapListKey: [[
        kAudioSubTapUIDKey: description.uuid.uuidString,
        kAudioSubTapDriftCompensationKey: true,
    ]],
    kAudioAggregateDeviceClockDeviceKey: outputUID as String,
]

var aggregateID = AudioObjectID(kAudioObjectUnknown)
let aggregateStatus = AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateID)
guard aggregateStatus == noErr else {
    emit(["event": "error", "message": "AudioHardwareCreateAggregateDevice failed", "status": aggregateStatus])
    AudioHardwareDestroyProcessTap(tapID)
    exit(4)
}

guard let format = tapFormat(tapID), format.mSampleRate > 0 else {
    emit(["event": "error", "message": "tap format unavailable"])
    AudioHardwareDestroyAggregateDevice(aggregateID)
    AudioHardwareDestroyProcessTap(tapID)
    exit(5)
}

let sink = PcmSink()
let down = Downsampler(inputRate: format.mSampleRate)
let lastFrameLock = NSLock()
var lastFrameAt = Date()
var totalFrames = 0

let streamIndex = Int(ProcessInfo.processInfo.environment["VOICEAEC_STREAM"] ?? "0") ?? 0
let ioBlock: AudioDeviceIOBlock = { _, input, _, _, _ in
    let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input))
    guard !buffers.isEmpty else { return }
    let index = min(max(streamIndex, 0), buffers.count - 1)
    let buffer = buffers[index]
    guard let data = buffer.mData else { return }
    let channels = max(Int(buffer.mNumberChannels), 1)
    let samples = Int(buffer.mDataByteSize) / MemoryLayout<Float>.size
    let frames = samples / channels
    guard frames > 0 else { return }
    let produced = down.feed(data.assumingMemoryBound(to: Float.self), count: samples, channels: channels)
    if !produced.isEmpty {
        sink.push(produced)
        lastFrameLock.lock()
        lastFrameAt = Date()
        totalFrames += produced.count
        lastFrameLock.unlock()
    }
}

sink.start()

var procID: AudioDeviceIOProcID?
let ioQueue = DispatchQueue(label: "voiceaec.io", qos: .userInteractive)
let createStatus = AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, ioQueue, ioBlock)
guard createStatus == noErr, let procID else {
    emit(["event": "error", "message": "AudioDeviceCreateIOProcIDWithBlock failed", "status": createStatus])
    exit(6)
}
let startStatus = AudioDeviceStart(aggregateID, procID)
guard startStatus == noErr else {
    emit(["event": "error", "message": "AudioDeviceStart failed", "status": startStatus])
    exit(7)
}

emit([
    "event": "ready",
    "sampleRate": Int(outRate),
    "channels": 1,
    "format": "s16le",
    "inputRate": format.mSampleRate,
    "inputChannels": Int(format.mChannelsPerFrame),
    "pid": Int(getpid()),
])

/// Watchdog: rebuild is the host's job, but never look alive while silent.
let watchdog = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "voiceaec.watchdog"))
watchdog.schedule(deadline: .now() + 3, repeating: 3)
watchdog.setEventHandler {
    lastFrameLock.lock()
    let idle = Date().timeIntervalSince(lastFrameAt)
    let frames = totalFrames
    lastFrameLock.unlock()
    if idle > 4.5 && frames > 0 {
        emit(["event": "stalled", "idleSeconds": idle])
        exit(8)
    }
}
watchdog.resume()



func shutdown() {
    AudioDeviceStop(aggregateID, procID)
    AudioDeviceDestroyIOProcID(aggregateID, procID)
    AudioHardwareDestroyAggregateDevice(aggregateID)
    AudioHardwareDestroyProcessTap(tapID)
    sink.stop()
    emit(["event": "stopped"])
    exit(0)
}

signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
termSource.setEventHandler { shutdown() }
termSource.resume()
let intSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
intSource.setEventHandler { shutdown() }
intSource.resume()

RunLoop.main.run()
