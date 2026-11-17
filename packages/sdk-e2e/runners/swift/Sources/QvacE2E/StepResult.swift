import Foundation

/// The outcome of a step or a test, from the client's side.
public struct StepResult {
    public var passed: Bool
    public var output: String
    public var incomplete: Bool
    public var reason: String?
    /// The value the assertion ran against, or nil when no assertion ran. The cross-client
    /// comparison reads it.
    public var assertedValue: Value?

    public init(passed: Bool, output: String = "", incomplete: Bool = false, reason: String? = nil, assertedValue: Value? = nil) {
        self.passed = passed
        self.output = output
        self.incomplete = incomplete
        self.reason = reason
        self.assertedValue = assertedValue
    }

    public static func ok(_ output: String = "") -> StepResult { StepResult(passed: true, output: output) }

    public static func fail(_ output: String) -> StepResult { StepResult(passed: false, output: output) }

    public static func incomplete(_ reason: String) -> StepResult {
        StepResult(passed: false, output: reason, incomplete: true, reason: reason)
    }

    /// The bridge's `result` message, without its `id`.
    public var message: Value {
        var message: [String: Value] = ["type": "result", "passed": .bool(passed), "output": .string(output)]
        if incomplete {
            message["incomplete"] = true
            message["reason"] = Value(reason)
        }
        if let assertedValue { message["assertedValue"] = summarise(assertedValue) }
        return .object(message)
    }
}

/// A step could not run. `incomplete` separates a gap in this client (the test applies, the client
/// has not implemented what it needs) from a failure of the SDK under test.
public struct StepError: Error, CustomStringConvertible {
    public let message: String
    public let incomplete: Bool

    public init(_ message: String, incomplete: Bool = false) {
        self.message = message
        self.incomplete = incomplete
    }

    public var description: String { message }
}
