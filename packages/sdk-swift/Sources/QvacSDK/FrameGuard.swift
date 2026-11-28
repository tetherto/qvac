import BareRPC
import CompactEncoding
import Foundation

/// A transport that hands the RPC session whole frames, with each frame over
/// `maxFrameBytes` replaced by one failing only the call it addresses. The
/// session would otherwise fail every call on an oversized frame.
final class FrameGuard<Base: BareRPC.Transport>: BareRPC.Transport, @unchecked Sendable {
    typealias Element = Data

    private let base: Base
    private let frames: AsyncThrowingStream<Data, Error>

    init(_ base: Base, maxFrameBytes: Int) {
        self.base = base
        let (frames, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        self.frames = frames
        let reader = Task {
            var splitter = FrameSplitter(maxFrameBytes: maxFrameBytes)
            do {
                for try await chunk in base {
                    for frame in try splitter.feed(chunk) { continuation.yield(frame) }
                }
                continuation.finish()
            } catch {
                continuation.finish(throwing: error)
            }
        }
        continuation.onTermination = { _ in reader.cancel() }
    }

    func makeAsyncIterator() -> AsyncThrowingStream<Data, Error>.AsyncIterator {
        frames.makeAsyncIterator()
    }

    func write(_ data: Data) async throws {
        try await base.write(data)
    }

    func close() async {
        await base.close()
    }
}

struct FrameSplitter {
    static let prefixBytes = 4
    // The message type, request id and stream flags are compact-encoded
    // unsigned integers of at most nine bytes each.
    static let maxHeaderBytes = 27
    static let frameTooLarge = "ERR_FRAME_TOO_LARGE"

    private static let messageResponse: UInt = 2
    private static let messageStream: UInt = 3
    private static let streamClose: UInt = 0x2
    private static let streamError: UInt = 0x80
    private static let streamResponse: UInt = 0x200

    private let maxFrameBytes: Int
    private var buffer: [UInt8] = []
    private var dropping = 0

    init(maxFrameBytes: Int) {
        self.maxFrameBytes = maxFrameBytes
    }

    mutating func feed(_ chunk: Data) throws -> [Data] {
        var bytes = [UInt8](chunk)
        if dropping > 0 {
            let dropped = min(dropping, bytes.count)
            dropping -= dropped
            bytes.removeFirst(dropped)
        }
        buffer.append(contentsOf: bytes)
        var frames: [Data] = []
        var start = 0
        while buffer.count - start >= Self.prefixBytes {
            let length = Int(buffer[start]) | Int(buffer[start + 1]) << 8 | Int(buffer[start + 2]) << 16
                | Int(buffer[start + 3]) << 24
            let frameBytes = Self.prefixBytes + length
            if frameBytes > maxFrameBytes {
                let headBytes = Self.prefixBytes + Self.maxHeaderBytes
                guard buffer.count - start >= headBytes else { break }
                frames.append(try rejectOversized(Array(buffer[start..<start + headBytes]), frameBytes: frameBytes))
                let rest = length - Self.maxHeaderBytes
                let available = min(rest, buffer.count - start - headBytes)
                start += headBytes + available
                dropping = rest - available
                if dropping > 0 { break }
                continue
            }
            guard buffer.count - start >= frameBytes else { break }
            frames.append(Data(buffer[start..<start + frameBytes]))
            start += frameBytes
        }
        buffer.removeFirst(start)
        return frames
    }

    /// A frame failing the call the oversized frame addresses with the error
    /// the session reports for a peer error, so that it ends only that call.
    private func rejectOversized(_ head: [UInt8], frameBytes: Int) throws -> Data {
        var state = State(Data(head))
        state.start = Self.prefixBytes
        let type = try Primitive.UInt().decode(&state)
        let id = try Primitive.UInt().decode(&state)
        let message = "frame of \(frameBytes) bytes exceeds the cap of \(maxFrameBytes) bytes"
        guard id != 0 else { throw QvacWorkerProtocolError(message) }
        let error: [Field] = [.utf8(message), .utf8(Self.frameTooLarge), .int(0)]
        if type == Self.messageResponse {
            return try Self.frame([.uint(Self.messageResponse), .uint(id), .bool(true), .uint(0)] + error)
        }
        if type == Self.messageStream, try Primitive.UInt().decode(&state) & Self.streamResponse != 0 {
            let flags = Self.streamResponse | Self.streamClose | Self.streamError
            return try Self.frame([.uint(Self.messageStream), .uint(id), .uint(flags)] + error)
        }
        throw QvacWorkerProtocolError(message)
    }

    private enum Field {
        case uint(UInt)
        case int(Int)
        case bool(Bool)
        case utf8(String)
    }

    private static func frame(_ fields: [Field]) throws -> Data {
        var body = State()
        for field in fields {
            switch field {
            case .uint(let value): Primitive.UInt().preencode(&body, value)
            case .int(let value): Primitive.Int().preencode(&body, value)
            case .bool(let value): Primitive.Bool().preencode(&body, value)
            case .utf8(let value): Primitive.UTF8().preencode(&body, value)
            }
        }
        body.allocate()
        for field in fields {
            switch field {
            case .uint(let value): try Primitive.UInt().encode(&body, value)
            case .int(let value): try Primitive.Int().encode(&body, value)
            case .bool(let value): try Primitive.Bool().encode(&body, value)
            case .utf8(let value): try Primitive.UTF8().encode(&body, value)
            }
        }
        let length = UInt32(body.buffer.count)
        return withUnsafeBytes(of: length.littleEndian) { Data($0) } + body.buffer
    }
}
