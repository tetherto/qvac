import Foundation

/// Splits the chunks of a reply stream into its newline-delimited JSON lines.
/// A line can span many chunks, so only the bytes new since the last chunk are
/// scanned.
struct JsonLinesDecoder {
    private let maxLineBytes: Int
    private var buffer: [UInt8] = []
    private var scanned = 0

    init(maxLineBytes: Int) {
        precondition(maxLineBytes > 0)
        self.maxLineBytes = maxLineBytes
    }

    mutating func feed(_ chunk: Data) throws -> [Data] {
        guard !chunk.isEmpty else { return [] }
        buffer.append(contentsOf: chunk)
        var lines: [Data] = []
        var lineStart = 0
        for index in scanned..<buffer.count where buffer[index] == UInt8(ascii: "\n") {
            try checkLength(index - lineStart)
            appendLine(lineStart..<index, to: &lines)
            lineStart = index + 1
        }
        try checkLength(buffer.count - lineStart)
        buffer.removeFirst(lineStart)
        scanned = buffer.count
        return lines
    }

    mutating func finish() -> [Data] {
        var lines: [Data] = []
        appendLine(0..<buffer.count, to: &lines)
        buffer = []
        scanned = 0
        return lines
    }

    private mutating func checkLength(_ length: Int) throws {
        guard length > maxLineBytes else { return }
        buffer = []
        scanned = 0
        throw QvacWorkerProtocolError("JSON line exceeds \(maxLineBytes) bytes")
    }

    private func appendLine(_ range: Range<Int>, to lines: inout [Data]) {
        let line = buffer[range]
        if line.contains(where: { !isWhitespace($0) }) { lines.append(Data(line)) }
    }

    private func isWhitespace(_ byte: UInt8) -> Bool {
        byte == UInt8(ascii: " ") || byte == UInt8(ascii: "\t") || byte == UInt8(ascii: "\r")
            || byte == UInt8(ascii: "\n")
    }
}
