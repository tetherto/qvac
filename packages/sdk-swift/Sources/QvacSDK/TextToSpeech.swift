import Foundation

protocol SpeechFrame {
    var buffer: [Double] { get set }
    var pcm: String? { get set }
}

extension SpeechFrame {
    func withDecodedPcm() -> Self {
        guard let pcm, !pcm.isEmpty else { return self }
        var decoded = self
        decoded.buffer = ttsSamples(buffer, pcm: pcm)
        decoded.pcm = nil
        return decoded
    }
}

extension TextToSpeechResponse: SpeechFrame {}

extension TextToSpeechStreamResponse: SpeechFrame {}

/// The worker sends speech as base64 little-endian signed 16-bit samples in
/// `pcm` with `buffer` empty; a frame without `pcm` carries its samples in `buffer`.
func ttsSamples(_ buffer: [Double], pcm: String) -> [Double] {
    guard let bytes = Data(base64Encoded: pcm) else { return buffer }
    var samples: [Double] = []
    samples.reserveCapacity(bytes.count / 2)
    var index = bytes.startIndex
    while index + 1 < bytes.endIndex {
        let value = Int16(bitPattern: UInt16(bytes[index]) | UInt16(bytes[index + 1]) << 8)
        samples.append(Double(value))
        index += 2
    }
    return samples
}
