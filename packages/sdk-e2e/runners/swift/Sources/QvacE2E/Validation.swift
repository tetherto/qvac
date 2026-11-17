import Foundation

/// The framework's ValidationHelpers, as the Python and Kotlin clients port them.
enum Validation {
    static func validate(_ result: Value, _ expectation: Value) -> StepResult {
        let kind = expectation["validation"]
        switch kind.string {
        case "contains-all": return containsAll(result, strings(expectation["contains"]))
        case "contains-any": return containsAny(result, strings(expectation["contains"]))
        case "regex": return regex(result, jsString(expectation["pattern"]))
        case "numeric-range": return numericRange(result, expectation["min"].number, expectation["max"].number)
        case "type": return type(result, jsString(expectation["expectedType"]), expectation["minLength"].int)
        case "throws-error": return throwsError(result, jsString(expectation["errorContains"]))
        case "function":
            return .incomplete(
                "expectation uses validation: 'function'; a JS closure cannot cross the wire. Migrate it to a named assertion.")
        default: return .fail("Unknown validation type: \(jsString(kind))")
        }
    }

    private static func strings(_ value: Value) -> [String] { value.list.map(jsString) }

    private static func containsAll(_ result: Value, _ contains: [String]) -> StepResult {
        let text = jsString(result).lowercased()
        let missing = contains.filter { !includes(text, $0.lowercased()) }
        if missing.isEmpty { return .ok(text) }
        return .fail("Missing required strings: \(missing.joined(separator: ", ")). Got: \(text.prefix(200))")
    }

    private static func containsAny(_ result: Value, _ contains: [String]) -> StepResult {
        let text = jsString(result).lowercased()
        if contains.contains(where: { includes(text, $0.lowercased()) }) { return .ok(text) }
        return .fail("None of the required strings found: \(contains.joined(separator: ", ")). Got: \(text.prefix(200))")
    }

    private static func regex(_ result: Value, _ pattern: String) -> StepResult {
        let text = jsString(result)
        guard let expression = try? NSRegularExpression(pattern: pattern) else {
            return .fail("Validation error: invalid pattern \(pattern)")
        }
        if expression.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil { return .ok(text) }
        return .fail("Text does not match pattern \(pattern). Got: \(text.prefix(200))")
    }

    private static func numericRange(_ result: Value, _ minimum: Double?, _ maximum: Double?) -> StepResult {
        // JS `Number(result)`: null, a blank string and false are 0, true is 1.
        let number: Double
        switch result {
        case .null: number = 0
        case .bool(let flag): number = flag ? 1 : 0
        case .number(let value): number = value
        case .string(let text):
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            number = trimmed.isEmpty ? 0 : Double(trimmed) ?? .nan
        default: number = .nan
        }
        if number.isNaN { return .fail("Expected number, got: \(jsString(result))") }
        if let minimum, number < minimum { return .fail("Value \(jsNumber(number)) is below minimum \(jsNumber(minimum))") }
        if let maximum, number > maximum { return .fail("Value \(jsNumber(number)) is above maximum \(jsNumber(maximum))") }
        return .ok(jsNumber(number))
    }

    private static func type(_ result: Value, _ expectedType: String, _ minLength: Int?) -> StepResult {
        let actual = jsType(result)
        if actual != expectedType { return .fail("Expected \(expectedType), got \(actual)") }
        if expectedType == "array" {
            let size = result.dataLength
            if let minLength, minLength > 0, size < minLength {
                return .fail("Array has \(size) elements, expected at least \(minLength)")
            }
            return .ok("Array with \(size) elements")
        }
        return .ok("Type \(actual) matches")
    }

    private static func throwsError(_ result: Value, _ errorContains: String) -> StepResult {
        let text = jsString(result)
        if includes(text.lowercased(), errorContains.lowercased()) {
            return .ok("Error contains expected text: \(errorContains)")
        }
        return .fail("Error does not contain \"\(errorContains)\". Got: \(text.prefix(200))")
    }
}
