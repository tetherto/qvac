import Foundation
import QvacSDK

/// The SDK's raw request surface in plain values. Payloads mirror the JS client's
/// (packages/sdk/src/client/api), so a cross-client difference points at the SDKs.
public struct Wire: Sendable {
    let worker: Worker

    public func send(_ payload: Value) async throws -> Value {
        Value(json: .object(try await worker.client.raw.call(encode(payload))))
    }

    public func stream(_ payload: Value) -> AsyncThrowingStream<Value, Error> {
        relay { $0.raw.stream(encode(payload)) }
    }

    public func duplex(_ payload: Value, input: AsyncStream<Data>) -> AsyncThrowingStream<Value, Error> {
        relay { $0.raw.duplex(encode(payload), input: input) }
    }

    private func relay(
        _ open: @escaping @Sendable (QvacClient) -> AsyncThrowingStream<[String: JSONValue], Error>
    ) -> AsyncThrowingStream<Value, Error> {
        let worker = worker
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for try await frame in open(worker.client) {
                        continuation.yield(Value(json: .object(frame)))
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func encode(_ payload: Value) -> [String: JSONValue] {
        payload.fields.filter { !$0.value.isNil }.mapValues(\.json)
    }

    public static func requestId() -> String { UUID().uuidString.lowercased() }

    /// A `success: false` reply, as the error the JS client raises for it.
    public static func refusal(_ name: String, _ message: String?) -> QvacError {
        let text = message.flatMap { $0.isEmpty ? nil : $0 } ?? "request failed"
        var payload: [String: JSONValue] = ["name": .string(name), "message": .string(text)]
        if let code = code(name) { payload["code"] = .number(code) }
        return QvacError(payload: payload)
    }

    /// The SDK's numeric code for an error name.
    static func code(_ name: String) -> Double? {
        QvacErrorKind.allCases.first { $0.name == name }.map { Double($0.code) }
    }

    @discardableResult
    public static func requireSuccess(_ response: Value, _ name: String, fallback: String? = nil) throws -> Value {
        if response["success"].bool == false { throw refusal(name, response["error"].string ?? fallback) }
        return response
    }

    private static let notDetails: Set<String> = ["type", "code", "message", "stack", "cause", "typedFields"]

    /// What a rejection binds: `{ code, message, hasCause, details }`, as every client binds it.
    public static func errorBinding(_ error: Error) -> Value {
        var details: [String: Value] = [:]
        var code = ""
        var hasCause = false
        if let error = error as? QvacError {
            code = error.code.map(String.init) ?? ""
            // As errorDetails in step-interpreter.ts: envelope fields, plus `typedFields`
            // (e.g. context-overflow token counts) lifted to the top.
            for (key, value) in error.payload where !notDetails.contains(key) {
                details[key] = Value(json: value)
            }
            if case .object(let typed) = error.payload["typedFields"] {
                for (key, value) in typed { details[key] = Value(json: value) }
            }
            if let cause = error.payload["cause"], cause != .null { hasCause = true }
        }
        return ["code": .string(code), "message": .string(message(of: error)), "hasCause": .bool(hasCause), "details": .object(details)]
    }

    public static func message(of error: Error) -> String {
        switch error {
        case let error as QvacError: return error.message
        case let error as QvacWorkerError: return error.message
        case let error as QvacWorkerProtocolError: return error.message
        case let error as StepError: return error.message
        default: return String(describing: error)
        }
    }

    /// The samples of a TTS frame. The worker sends them as base64 little-endian signed 16-bit
    /// bytes in `pcm` with `buffer` empty; a frame without `pcm` carries them in `buffer`.
    public static func ttsSamples(_ frame: Value) -> [Value] {
        guard let pcm = frame["pcm"].string, !pcm.isEmpty, let bytes = Data(base64Encoded: pcm) else {
            return frame["buffer"].list
        }
        var samples: [Value] = []
        samples.reserveCapacity(bytes.count / 2)
        var index = bytes.startIndex
        while index + 1 < bytes.endIndex {
            let sample = Int16(bitPattern: UInt16(bytes[index]) | UInt16(bytes[index + 1]) << 8)
            samples.append(.number(Double(sample)))
            index += 2
        }
        return samples
    }

    /// A path stays a path; bytes travel inline. The `{ type, value }` union the worker reads.
    public static func fileOrBase64(_ value: Value) -> Value {
        if let path = value.string { return ["type": "filePath", "value": .string(path)] }
        return ["type": "base64", "value": .string(value.data.base64EncodedString())]
    }
}
