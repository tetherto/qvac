import BareRPC
import Foundation

/// An error the worker reported for a request.
public struct QvacError: Error, Sendable, CustomStringConvertible {
    public let name: String
    public let code: Int?
    public let message: String
    public let payload: [String: JSONValue]

    public init(payload: [String: JSONValue]) {
        self.name = payload["name"]?.stringValue ?? "QVAC_ERROR"
        self.code = payload["code"]?.numberValue.flatMap { Int(exactly: $0) }
        self.message = payload["message"]?.stringValue ?? "QVAC worker error"
        self.payload = payload
    }

    /// The contract error this is, matched by name, and by code where several share a name.
    public var kind: QvacErrorKind? {
        guard let kinds = QvacErrorKind.byName[name] else { return nil }
        if kinds.count == 1 { return code == nil || code == kinds[0].code ? kinds[0] : nil }
        return kinds.first { $0.code == code }
    }

    public var description: String { "\(name): \(message)" }
}

/// The worker sent something outside the contract, such as invalid JSON or a
/// frame over `maxFrameBytes`.
public struct QvacWorkerProtocolError: Error, Sendable, CustomStringConvertible {
    public let message: String

    public init(_ message: String) {
        self.message = message
    }

    public var description: String { message }
}

/// The worker could not start, rejected its configuration, or went away.
public struct QvacWorkerError: Error, Sendable, CustomStringConvertible {
    public let code: String
    public let message: String
    public let exitCode: Int32?

    public init(code: String, message: String, exitCode: Int32? = nil) {
        self.code = code
        self.message = message
        self.exitCode = exitCode
    }

    public var description: String { "\(code): \(message)" }
}

/// A client setting is outside its allowed range.
public struct QvacConfigurationError: Error, Sendable, CustomStringConvertible {
    public let message: String

    public init(_ message: String) {
        self.message = message
    }

    public var description: String { message }
}

/// A bare-rpc error the worker answered a request with.
public typealias QvacRemoteError = RPCRemoteError
