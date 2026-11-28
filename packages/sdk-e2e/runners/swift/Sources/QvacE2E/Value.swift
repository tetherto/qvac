import Foundation
import QvacSDK

/// A test value, compared the way the JS, Python and Kotlin clients compare theirs.
public enum Value {
    case null
    /// An optional reference (`$name?`) that resolved to nothing. Dropped from call parameters.
    case missing
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([Value])
    case object([String: Value])
    case bytes(Data)
    case handle(AnyObject)
}

extension Value: @unchecked Sendable {}

extension Value: ExpressibleByNilLiteral, ExpressibleByBooleanLiteral, ExpressibleByIntegerLiteral,
    ExpressibleByFloatLiteral, ExpressibleByStringLiteral, ExpressibleByArrayLiteral,
    ExpressibleByDictionaryLiteral
{
    public init(nilLiteral: ()) { self = .null }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
    public init(floatLiteral value: Double) { self = .number(value) }
    public init(stringLiteral value: String) { self = .string(value) }
    public init(arrayLiteral elements: Value...) { self = .array(elements) }

    public init(dictionaryLiteral elements: (String, Value)...) {
        self = .object(Dictionary(elements, uniquingKeysWith: { _, last in last }))
    }

    public init(_ value: Int) { self = .number(Double(value)) }
    public init(_ value: Double) { self = .number(value) }
    public init(_ value: String?) { self = value.map(Value.string) ?? .null }
    public init(_ values: [String]) { self = .array(values.map(Value.string)) }
}

extension Value {
    /// The value under `key`, or null when this is not an object or lacks the key.
    public subscript(key: String) -> Value {
        if case .object(let object) = self { return object[key] ?? .null }
        return .null
    }

    public func has(_ key: String) -> Bool {
        if case .object(let object) = self, let value = object[key] {
            if case .missing = value { return false }
            return true
        }
        return false
    }

    /// Null or missing: what Kotlin's `?:` and a JS `== null` treat as absent.
    public var isNil: Bool {
        switch self {
        case .null, .missing: return true
        default: return false
        }
    }

    public var isMissing: Bool {
        if case .missing = self { return true }
        return false
    }

    public func or(_ fallback: Value) -> Value { isNil ? fallback : self }

    public var string: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    public var number: Double? {
        if case .number(let value) = self { return value }
        return nil
    }

    public var int: Int? {
        guard let number, number.isFinite else { return nil }
        return Int(exactly: number.rounded(.towardZero))
    }

    public var bool: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    public var array: [Value]? {
        if case .array(let value) = self { return value }
        return nil
    }

    public var object: [String: Value]? {
        if case .object(let value) = self { return value }
        return nil
    }

    public var list: [Value] { array ?? [] }

    public var fields: [String: Value] { object ?? [:] }

    public var isTrue: Bool { bool == true }

    /// The bytes this carries, whether it arrived as bytes or as an array of numbers.
    public var data: Data {
        switch self {
        case .bytes(let data): return data
        case .array(let items): return Data(items.map { UInt8(truncatingIfNeeded: $0.int ?? 0) })
        default: return Data()
        }
    }

    /// How much data a value carries, whether it arrived as bytes or as a list.
    public var dataLength: Int {
        switch self {
        case .bytes(let data): return data.count
        case .array(let items): return items.count
        default: return 0
        }
    }

    public func compacted() -> Value {
        guard case .object(let object) = self else { return self }
        return .object(object.filter { !$0.value.isNil })
    }

    /// This object with `other`'s fields laid over it.
    public func merging(_ other: Value) -> Value {
        .object(fields.merging(other.fields) { _, new in new })
    }

    public func removing(_ key: String) -> Value {
        var object = fields
        object[key] = nil
        return .object(object)
    }
}

extension Value {
    public init(json: JSONValue) {
        switch json {
        case .null: self = .null
        case .bool(let value): self = .bool(value)
        case .number(let value): self = .number(value)
        case .string(let value): self = .string(value)
        case .array(let items): self = .array(items.map(Value.init(json:)))
        case .object(let object): self = .object(object.mapValues(Value.init(json:)))
        }
    }

    public static func parse(_ data: Data) throws -> Value {
        Value(json: try JSONDecoder().decode(JSONValue.self, from: data))
    }

    /// The JSON this value encodes to. JSON has no NaN or Infinity; JSON.stringify writes null for
    /// them, and so does this.
    public var json: JSONValue {
        switch self {
        case .null, .missing, .handle: return .null
        case .bool(let value): return .bool(value)
        case .number(let value): return value.isFinite ? .number(value) : .null
        case .string(let value): return .string(value)
        case .array(let items): return .array(items.map(\.json))
        case .object(let object): return .object(object.filter { !$0.value.isMissing }.mapValues(\.json))
        case .bytes(let data): return .array(data.map { .number(Double($0)) })
        }
    }

    public func encoded() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(json)
    }
}

/// A number the way JavaScript's `String(number)` prints it: no trailing `.0`.
public func jsNumber(_ value: Double) -> String {
    if value.isNaN { return "NaN" }
    if value.isInfinite { return value > 0 ? "Infinity" : "-Infinity" }
    if value == value.rounded() && abs(value) < 1e21 { return String(Int64(value)) }
    return String(value)
}

/// JavaScript's `String(value)`.
public func jsString(_ value: Value) -> String {
    switch value {
    case .null: return "null"
    case .missing: return "undefined"
    case .bool(let flag): return flag ? "true" : "false"
    case .number(let number): return jsNumber(number)
    case .string(let text): return text
    case .bytes(let data): return data.map(String.init).joined(separator: ",")
    case .array(let items): return items.map { $0.isNil ? "" : jsString($0) }.joined(separator: ",")
    case .object: return "[object Object]"
    case .handle(let object): return String(describing: object)
    }
}

/// `typeof`, with arrays told apart the way the validators expect. Bytes are a typed array in JS: an object.
public func jsType(_ value: Value) -> String {
    switch value {
    case .array: return "array"
    case .bool: return "boolean"
    case .number: return "number"
    case .string: return "string"
    case .missing: return "undefined"
    default: return "object"
    }
}

/// JavaScript's `String.prototype.includes`: every string includes the empty one, which Swift's
/// `contains` denies.
public func includes(_ haystack: String, _ needle: String) -> Bool {
    needle.isEmpty || haystack.contains(needle)
}

/// JS's `Number.isInteger`, so 2.0 counts and true does not.
public func isInteger(_ value: Value) -> Bool {
    guard let number = value.number else { return false }
    return number.isFinite && number == number.rounded()
}

/// Strict equality, recursively.
public func jsEquals(_ left: Value, _ right: Value) -> Bool {
    switch (left, right) {
    case (.null, .null), (.missing, .missing): return true
    case (.bool(let a), .bool(let b)): return a == b
    case (.number(let a), .number(let b)): return a == b
    case (.string(let a), .string(let b)): return a == b
    case (.bytes(let a), .bytes(let b)): return a == b
    case (.array(let a), .array(let b)):
        return a.count == b.count && zip(a, b).allSatisfy { jsEquals($0, $1) }
    case (.object(let a), .object(let b)):
        return Set(a.keys) == Set(b.keys) && a.allSatisfy { key, item in jsEquals(item, b[key] ?? .missing) }
    case (.handle(let a), .handle(let b)): return a === b
    default: return false
    }
}

/// Python-style `repr`, for the messages that quote a value back.
public func describe(_ value: Value) -> String {
    switch value {
    case .null: return "null"
    case .string(let text): return "'\(text)'"
    case .bytes(let data): return "<\(data.count) bytes>"
    default: return String(jsString(value).prefix(200))
    }
}

/// Keep the report small while still comparable across clients (same shape as Python's).
public func summarise(_ value: Value, depth: Int = 0, limit: Int = 64) -> Value {
    if depth > 3 { return "…" }
    switch value {
    case .null, .missing: return .null
    case .array(let items):
        return [
            "kind": "array", "length": Value(items.count),
            "head": .array(items.prefix(8).map { summarise($0, depth: depth + 1, limit: limit) }),
        ]
    case .bytes(let data):
        return [
            "kind": "bytes", "length": Value(data.count),
            "head": .string(data.prefix(8).map { String(format: "%02x", $0) }.joined()),
        ]
    case .string(let text):
        // Length in UTF-16 units, as Kotlin and JS count it.
        let units = text.utf16
        return units.count <= limit * 8 ? value : .string(String(decoding: Array(units.prefix(limit * 8)), as: UTF16.self) + "…")
    case .object(let object):
        // The first 16 sorted keys: Kotlin takes the first 16 in insertion order, which a Swift dictionary does not keep.
        let kept = object.keys.sorted().prefix(16)
        return .object(Dictionary(uniqueKeysWithValues: kept.map { ($0, summarise(object[$0]!, depth: depth + 1, limit: limit)) }))
    case .bool, .number: return value
    case .handle(let object): return .string(String(describing: object))
    }
}
