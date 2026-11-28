import Foundation

public enum QvacProgressEvent<Progress: Sendable, Output: Sendable>: Sendable {
    case progress(Progress)
    case result(Output)
}

/// Sends typed requests to a worker over a ``QvacTransport``.
public final class QvacClient: Sendable {
    private let transport: any QvacTransport

    public init(transport: any QvacTransport) {
        self.transport = transport
    }

    public func heartbeat() async throws -> HeartbeatResponse {
        try await heartbeat(HeartbeatRequest())
    }

    public func close() async {
        await transport.close()
    }

    func callTyped<Request: Encodable, Response: Decodable>(_ request: Request) async throws -> Response {
        try decode(Response.self, from: try await transport.call(try encode(request)))
    }

    func streamTyped<Request: Encodable, Response: Decodable, Output: Sendable>(
        _ request: Request,
        map: @escaping @Sendable (Response) throws -> Output
    ) -> AsyncThrowingStream<Output, Error> {
        relay(payload: { try encode(request) }, open: { transport.stream($0) }) {
            try map(try decode(Response.self, from: $0))
        }
    }

    func duplexTyped<Request: Encodable, Response: Decodable, Output: Sendable>(
        _ request: Request,
        input: AsyncStream<Data>,
        map: @escaping @Sendable (Response) throws -> Output
    ) -> AsyncThrowingStream<Output, Error> {
        relay(payload: { try encode(request) }, open: { transport.duplex($0, input: input) }) {
            try map(try decode(Response.self, from: $0))
        }
    }

    /// Typed frames paired with the raw frame, for open objects such as `stats`
    /// whose extra keys the typed frame drops.
    func streamWithRaw<Request: Encodable, Response: Decodable & Sendable>(_ request: Request)
        -> AsyncThrowingStream<(Response, [String: JSONValue]), Error>
    {
        relay(payload: { try encode(request) }, open: { transport.stream($0) }) {
            (try decode(Response.self, from: $0), try decode([String: JSONValue].self, from: $0))
        }
    }

    func duplexWithRaw<Request: Encodable, Response: Decodable & Sendable>(
        _ request: Request,
        input: AsyncStream<Data>
    ) -> AsyncThrowingStream<(Response, [String: JSONValue]), Error> {
        relay(payload: { try encode(request) }, open: { transport.duplex($0, input: input) }) {
            (try decode(Response.self, from: $0), try decode([String: JSONValue].self, from: $0))
        }
    }

    func progressTyped<Request: Encodable, Progress: Decodable & Sendable, Response: Decodable & Sendable>(
        _ request: Request,
        progressType: String
    ) -> AsyncThrowingStream<QvacProgressEvent<Progress, Response>, Error> {
        relay(payload: { try encodeWithProgress(request) }, open: { transport.stream($0) }) { frame in
            if try checkedFrame(frame).type == progressType {
                return .progress(try decode(Progress.self, from: frame))
            }
            return .result(try decode(Response.self, from: frame))
        }
    }

    private func relay<Element: Sendable>(
        payload: () throws -> Data,
        open: (Data) -> AsyncThrowingStream<Data, Error>,
        map: @escaping @Sendable (Data) throws -> Element
    ) -> AsyncThrowingStream<Element, Error> {
        let frames: AsyncThrowingStream<Data, Error>
        do {
            frames = open(try payload())
        } catch {
            return AsyncThrowingStream { $0.finish(throwing: error) }
        }
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for try await frame in frames {
                        continuation.yield(try map(frame))
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

private struct FrameHead: Decodable {
    let type: String?
}

private func encode<Request: Encodable>(_ request: Request) throws -> Data {
    try encodeForWorker(request)
}

/// The worker streams progress only when the request asks for it.
private func encodeWithProgress<Request: Encodable>(_ request: Request) throws -> Data {
    guard case .object(var payload) = try JSONDecoder().decode(JSONValue.self, from: try encode(request)) else {
        return try encode(request)
    }
    payload["withProgress"] = .bool(true)
    return try encodeForWorker(payload)
}

/// JSON for the worker, with sorted keys: a dictionary's key order varies between equal values, and the worker's
/// prompt caches match a request's exact text.
func encodeForWorker<Value: Encodable>(_ value: Value) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    return try encoder.encode(value)
}

private func checkedFrame(_ frame: Data) throws -> FrameHead {
    let head: FrameHead
    do {
        head = try JSONDecoder().decode(FrameHead.self, from: frame)
    } catch {
        throw QvacWorkerProtocolError("worker returned invalid JSON: \(error)")
    }
    if head.type == "error" {
        guard case .object(let payload) = try JSONDecoder().decode(JSONValue.self, from: frame) else {
            throw QvacWorkerProtocolError("worker returned an error that is not a JSON object")
        }
        throw QvacError(payload: payload)
    }
    return head
}

private func decode<Response: Decodable>(_ type: Response.Type, from frame: Data) throws -> Response {
    _ = try checkedFrame(frame)
    return try JSONDecoder().decode(type, from: frame)
}
