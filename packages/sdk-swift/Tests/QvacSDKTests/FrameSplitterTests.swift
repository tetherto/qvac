import Foundation
import Testing
@testable import QvacSDK

@Suite struct FrameSplitterTests {
    @Test func passesWholeFramesThroughAcrossChunks() throws {
        var splitter = FrameSplitter(maxFrameBytes: 4096)
        let first = reply(id: 1, body: Data("one".utf8))
        let second = reply(id: 2, body: Data("two".utf8))
        let wire = first + second

        let a = try splitter.feed(wire.prefix(5))
        let b = try splitter.feed(wire.dropFirst(5))

        #expect(a.isEmpty)
        #expect(b == [first, second])
    }

    @Test func replacesAnOversizedReplyWithAnErrorForThatCallAndKeepsReading() throws {
        var splitter = FrameSplitter(maxFrameBytes: 4096)
        let oversized = reply(id: 7, body: Data(repeating: 0x61, count: 10_000))
        let next = reply(id: 8, body: Data("ok".utf8))
        let wire = oversized + next

        var frames: [Data] = []
        var offset = 0
        while offset < wire.count {
            let end = min(offset + 1500, wire.count)
            frames += try splitter.feed(wire.subdata(in: offset..<end))
            offset = end
        }

        #expect(frames.count == 2)
        let rejection = [UInt8](frames[0].dropFirst(4))
        #expect(Array(rejection.prefix(4)) == [2, 7, 1, 0])
        let message = "frame of \(oversized.count) bytes exceeds the cap of 4096 bytes"
        let expected = [2, 7, 1, 0] + text(message) + text(FrameSplitter.frameTooLarge) + [0]
        #expect(rejection == expected)
        #expect(frames[1] == next)
    }

    @Test func failsTheConnectionForAnOversizedFrameNoCallOwns() {
        var splitter = FrameSplitter(maxFrameBytes: 4096)

        #expect(throws: QvacWorkerProtocolError.self) {
            try splitter.feed(reply(id: 0, body: Data(repeating: 0x61, count: 10_000)))
        }
    }

    @Test func reportsOnlyAnOversizedFrameAsAProtocolError() {
        let oversized = workerError(QvacRemoteError(message: "too large", code: FrameSplitter.frameTooLarge))
        let other = workerError(QvacRemoteError(message: "handler failed", code: "ERR_HANDLER"))

        #expect(oversized is QvacWorkerProtocolError)
        #expect((other as? QvacRemoteError)?.code == "ERR_HANDLER")
    }

    @Test func rejectsAFrameLimitOutsideItsRange() {
        #expect(throws: QvacConfigurationError.self) { try QvacClient.checkFrameBytes(1024) }
        #expect(throws: Never.self) { try QvacClient.checkFrameBytes(QvacClient.defaultMaxFrameBytes) }
    }

    /// A bare-rpc reply frame: type 2, the id, no error, no stream, the body.
    private func reply(id: UInt8, body: Data) -> Data {
        let frame = [2, id, 0, 0] + length(body.count) + [UInt8](body)
        return withUnsafeBytes(of: UInt32(frame.count).littleEndian) { Data($0) } + Data(frame)
    }

    private func text(_ value: String) -> [UInt8] {
        length(value.utf8.count) + Array(value.utf8)
    }

    /// A compact-encoded length below 65536.
    private func length(_ count: Int) -> [UInt8] {
        count < 0xFD ? [UInt8(count)] : [0xFD, UInt8(count & 0xFF), UInt8(count >> 8)]
    }
}
