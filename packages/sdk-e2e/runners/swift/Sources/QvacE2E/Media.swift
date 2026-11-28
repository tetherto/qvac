import Foundation

/// Media helpers kept in step with runners/js/shared/wav-pcm.ts and the Python and Kotlin ports.
enum Media {
    struct DecodedPcm {
        let sampleRate: Int
        let channels: Int
        let samplesMono: [Float]
    }

    /// Width and height out of a PNG's IHDR, or nil if it is not a PNG.
    static func pngDimensions(_ data: Data) -> (Int, Int)? {
        let bytes = [UInt8](data)
        let signature: [UInt8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
        guard bytes.count >= 24, Array(bytes[0..<8]) == signature else { return nil }
        return (bigEndian(bytes, 16, 4), bigEndian(bytes, 20, 4))
    }

    /// PNG IHDR or JPEG SOF0..SOF3 dimensions, so both frame encodings are accepted.
    static func frameDimensions(_ data: Data) -> (Int, Int)? {
        if let dimensions = pngDimensions(data) { return dimensions }
        let bytes = [UInt8](data)
        guard bytes.count >= 24, bytes[0] == 0xFF, bytes[1] == 0xD8 else { return nil }
        var offset = 2
        while offset + 9 < bytes.count {
            if bytes[offset] != 0xFF { return nil }
            let marker = bytes[offset + 1]
            let length = bigEndian(bytes, offset + 2, 2)
            if (0xC0...0xC3).contains(marker) {
                return (bigEndian(bytes, offset + 7, 2), bigEndian(bytes, offset + 5, 2))
            }
            offset += 2 + length
        }
        return nil
    }

    private static func bigEndian(_ bytes: [UInt8], _ offset: Int, _ length: Int) -> Int {
        bytes[offset..<offset + length].reduce(0) { $0 << 8 | Int($1) }
    }

    private static func littleEndian(_ bytes: [UInt8], _ offset: Int, _ length: Int) -> Int {
        bytes[offset..<offset + length].reversed().reduce(0) { $0 << 8 | Int($1) }
    }

    /// 16-bit PCM WAV -> mono float32 in [-1, 1].
    static func decodeWavToMonoF32(_ data: Data) throws -> DecodedPcm {
        let bytes = [UInt8](data)
        func tag(_ at: Int) -> String { String(decoding: bytes[at..<at + 4], as: UTF8.self) }
        guard bytes.count >= 12, tag(0) == "RIFF", tag(8) == "WAVE" else {
            throw StepError("decodeWavToMonoF32: not a RIFF/WAVE file")
        }
        var offset = 12
        var sampleRate = 0
        var channels = 0
        var bitsPerSample = 0
        var format = 0
        while offset + 8 <= bytes.count {
            let id = tag(offset)
            // Unsigned on disk; clamp to what the buffer holds so a bad header cannot overrun it.
            let size = min(littleEndian(bytes, offset + 4, 4), bytes.count - offset - 8)
            let body = offset + 8
            if id == "fmt " {
                guard size >= 16 else { throw StepError("decodeWavToMonoF32: fmt chunk of \(size) bytes is shorter than 16") }
                format = littleEndian(bytes, body, 2)
                channels = Int(Int16(truncatingIfNeeded: littleEndian(bytes, body + 2, 2)))
                sampleRate = littleEndian(bytes, body + 4, 4)
                bitsPerSample = littleEndian(bytes, body + 14, 2)
            } else if id == "data" {
                guard format == 1 || format == 0xFFFE else {
                    throw StepError("decodeWavToMonoF32: only PCM is supported, got format \(format)")
                }
                guard channels > 0 else { throw StepError("decodeWavToMonoF32: no fmt chunk before the data chunk") }
                guard bitsPerSample == 16 else {
                    throw StepError("decodeWavToMonoF32: only 16-bit PCM is supported, got \(bitsPerSample)-bit")
                }
                let frames = size / 2 / channels
                var mono = [Float](repeating: 0, count: frames)
                for frame in 0..<frames {
                    var total = 0
                    for channel in 0..<channels {
                        total += Int(Int16(truncatingIfNeeded: littleEndian(bytes, body + (frame * channels + channel) * 2, 2)))
                    }
                    mono[frame] = Float(Double(total) / Double(channels) / 32768.0)
                }
                return DecodedPcm(sampleRate: sampleRate, channels: channels, samplesMono: mono)
            }
            offset = body + size + (size & 1)
        }
        throw StepError("decodeWavToMonoF32: no data chunk")
    }

    /// Raw little-endian float32, the form the whisper stream takes.
    static func f32ToLeBytes(_ samples: [Float]) -> Data {
        var out = Data(capacity: samples.count * 4)
        for sample in samples {
            withUnsafeBytes(of: sample.bitPattern.littleEndian) { out.append(contentsOf: $0) }
        }
        return out
    }

    /// Signed 16-bit little-endian PCM, the form the parakeet stream takes.
    static func f32ToS16LeBytes(_ samples: [Float]) -> Data {
        var out = Data(capacity: samples.count * 2)
        for sample in samples {
            let clamped = max(-1.0, min(1.0, Double(sample)))
            // JS's Math.round: a half rounds toward +Infinity.
            let value = Int16(truncatingIfNeeded: Int((clamped * 32767 + 0.5).rounded(.down)))
            withUnsafeBytes(of: value.littleEndian) { out.append(contentsOf: $0) }
        }
        return out
    }

    private static let toneSampleRate = 48000.0
    private static let toneChannels = 2

    /// Raw interleaved stereo 48 kHz Float32 LE PCM for a named tone: "2s-440hz".
    static func synthesizeTone(_ spec: String) throws -> Data {
        let pattern = try NSRegularExpression(pattern: #"^(\d+(?:\.\d+)?)s-(\d+(?:\.\d+)?)hz$"#)
        guard let match = pattern.firstMatch(in: spec, range: NSRange(spec.startIndex..., in: spec)),
            let secondsRange = Range(match.range(at: 1), in: spec), let frequencyRange = Range(match.range(at: 2), in: spec),
            let seconds = Double(spec[secondsRange]), let frequency = Double(spec[frequencyRange])
        else {
            throw StepError("tone \"\(spec)\" is not \"<seconds>s-<frequency>hz\"")
        }
        let frames = Int((toneSampleRate * seconds).rounded())
        var out = Data(capacity: frames * toneChannels * 4)
        for frame in 0..<frames {
            let sample = Float(0.1 * sin(2 * Double.pi * frequency * Double(frame) / toneSampleRate))
            for _ in 0..<toneChannels {
                withUnsafeBytes(of: sample.bitPattern.littleEndian) { out.append(contentsOf: $0) }
            }
        }
        return out
    }

    /// A fixture spelled out in hex: "00010203" is four bytes.
    static func synthesizeBytes(_ spec: String) throws -> Data {
        let characters = Array(spec.utf8)
        let hexDigit = { (byte: UInt8) in (0x30...0x39).contains(byte) || (0x41...0x46).contains(byte) || (0x61...0x66).contains(byte) }
        guard characters.count % 2 == 0, characters.allSatisfy(hexDigit) else {
            throw StepError("bytes \"\(spec)\" is not an even-length hex string")
        }
        return Data(stride(from: 0, to: characters.count, by: 2).map { UInt8(String(decoding: characters[$0...$0 + 1], as: UTF8.self), radix: 16)! })
    }
}
