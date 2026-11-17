import Foundation

/// The index of the union arm `value` matches, chosen by discriminator and
/// required-field structure. Overlapping arms resolve to the most specific
/// match, then to schema order. Value and range checks stay in the worker.
func selectWireVariant(_ value: JSONValue, _ shapes: [JSONValue]) throws -> Int {
    var best: (index: Int, score: Int)?
    for (index, shape) in shapes.enumerated() {
        let score = wireShapeScore(value, shape)
        if score >= 0, score > (best?.score ?? -1) { best = (index, score) }
    }
    guard let best else {
        throw DecodingError.dataCorrupted(
            .init(codingPath: [], debugDescription: "JSON does not match any QVAC wire variant"))
    }
    return best.index
}

private func wireShapeScore(_ value: JSONValue, _ shape: JSONValue) -> Int {
    guard case .object(let shape) = shape else { return 0 }
    if shape["not"] == .object([:]) { return -1 }
    if let expected = shape["const"], !sameWireLiteral(value, expected) { return -1 }
    if case .array(let literals) = shape["enum"], !literals.contains(where: { sameWireLiteral(value, $0) }) {
        return -1
    }
    let types: [String]
    switch shape["type"] {
    case .array(let names): types = names.compactMap(\.stringValue)
    case .string(let name): types = [name]
    default: types = []
    }
    if !types.isEmpty, !types.contains(where: { matchesType(value, $0) }) { return -1 }
    var score = shape["const"] != nil ? 100 : shape["enum"] != nil ? 10 : 0
    for union in ["oneOf", "anyOf"] {
        guard case .array(let arms) = shape[union] else { continue }
        let best = arms.map { wireShapeScore(value, $0) }.max() ?? -1
        if best < 0 { return -1 }
        score += best
    }
    if case .object(let object) = value {
        let required: [String]
        if case .array(let names) = shape["required"] { required = names.compactMap(\.stringValue) } else { required = [] }
        if required.contains(where: { object[$0] == nil }) { return -1 }
        score += required.count
        if case .object(let properties) = shape["properties"] {
            for (key, child) in properties {
                guard let field = object[key] else { continue }
                let match = wireShapeScore(field, child)
                if match < 0 { return -1 }
                score += 1 + match
            }
        }
    }
    if case .array(let items) = value, let item = shape["items"] {
        if items.contains(where: { wireShapeScore($0, item) < 0 }) { return -1 }
    }
    return score
}

private func matchesType(_ value: JSONValue, _ type: String) -> Bool {
    switch (type, value) {
    case ("null", .null), ("object", .object), ("array", .array), ("string", .string), ("boolean", .bool),
        ("number", .number):
        return true
    case ("integer", .number(let number)):
        return number.isFinite && number.rounded() == number
    default:
        return false
    }
}

private func sameWireLiteral(_ value: JSONValue, _ expected: JSONValue) -> Bool {
    if value == expected { return true }
    if case .number(let actual) = value, case .number(let number) = expected {
        return actual.isFinite && number.isFinite && actual == number
    }
    return false
}
