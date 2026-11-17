import Foundation
import QvacSDK

/// Answers each request with canned JSON lines and records what was sent.
final class FakeTransport: QvacTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var replies: [[String]]
    private var sentPayloads: [Data] = []
    private var inputReaders: [Task<[Data], Never>] = []

    init(replies: [[String]]) {
        self.replies = replies
    }

    var sentBytes: [Data] { lock.withLock { sentPayloads } }

    var sent: [[String: JSONValue]] {
        lock.withLock { sentPayloads }.map { payload in
            guard case .object(let object) = try! JSONDecoder().decode(JSONValue.self, from: payload) else {
                fatalError("payload is not a JSON object")
            }
            return object
        }
    }

    private func next(_ payload: Data) -> [Data] {
        lock.withLock {
            sentPayloads.append(payload)
            return replies.removeFirst().map { Data($0.utf8) }
        }
    }

    func call(_ payload: Data) async throws -> Data {
        next(payload)[0]
    }

    func stream(_ payload: Data) -> AsyncThrowingStream<Data, Error> {
        let frames = next(payload)
        return AsyncThrowingStream { continuation in
            for frame in frames { continuation.yield(frame) }
            continuation.finish()
        }
    }

    /// The chunks each two-way call sent after its payload, once its input ended.
    func duplexInputs() async -> [[Data]] {
        var inputs: [[Data]] = []
        for reader in lock.withLock({ inputReaders }) { inputs.append(await reader.value) }
        return inputs
    }

    func duplex(_ payload: Data, input: AsyncStream<Data>) -> AsyncThrowingStream<Data, Error> {
        let reader = Task {
            var chunks: [Data] = []
            for await chunk in input { chunks.append(chunk) }
            return chunks
        }
        lock.withLock { inputReaders.append(reader) }
        return stream(payload)
    }

    func close() async {}
}
