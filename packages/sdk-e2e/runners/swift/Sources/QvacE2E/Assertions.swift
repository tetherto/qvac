import Foundation

typealias Assertion = (_ value: Value, _ args: Value) -> StepResult
typealias Comparison = (_ left: Value, _ right: Value, _ args: Value) -> StepResult

/// Named assertions ported from runners/python/qvac_e2e/assertions.py, as the Kotlin client ports
/// them; keep verdicts and messages identical. A name missing here makes the step incomplete.
enum Assertions {
    private static func text(_ value: Value) -> String { value.isNil ? "" : jsString(value) }

    private static func names(_ args: Value, _ key: String = "fields") -> [String] { args[key].list.map(jsString) }

    private static func vector(_ value: Value) -> [Double]? {
        guard let values = value.array, !values.isEmpty else { return nil }
        var numbers: [Double] = []
        for item in values {
            guard let number = item.number, number.isFinite else { return nil }
            numbers.append(number)
        }
        return numbers
    }

    private static func fixed(_ value: Double, _ digits: Int) -> String {
        String(format: "%.\(digits)f", locale: Locale(identifier: "en_US_POSIX"), value)
    }

    private static func quoted(_ items: [String]) -> String { "[\(items.joined(separator: ", "))]" }

    private static func unitVectors(_ value: Value, _ args: Value) -> StepResult {
        let dimensions = args["dimensions"].number
        let tolerance = args["tolerance"].number
        guard let dimensions, isInteger(args["dimensions"]), dimensions > 0,
            let tolerance, tolerance.isFinite, tolerance > 0, tolerance < 1
        else {
            return .fail("expected positive dimensions and a tolerance between 0 and 1")
        }
        let vectors = vector(value) != nil ? [value] : value.array
        guard let vectors, !vectors.isEmpty else { return .fail("expected a vector or a non-empty array of vectors") }
        for (index, item) in vectors.enumerated() {
            guard let values = vector(item), Double(values.count) == dimensions else {
                return .fail("vector \(index): expected \(jsNumber(dimensions)) finite numbers")
            }
            let squaredNorm = values.reduce(0) { $0 + $1 * $1 }
            if !squaredNorm.isFinite || abs(squaredNorm - 1) >= tolerance {
                return .fail("vector \(index): squared norm \(jsNumber(squaredNorm))")
            }
        }
        return .ok("\(vectors.count) unit vectors, \(jsNumber(dimensions)) dimensions")
    }

    private static func lengthIs(_ value: Value, _ args: Value) -> StepResult {
        guard let items = value.array else { return .fail("expected an array, got \(jsType(value))") }
        let expected = args["length"].int ?? -1
        if items.count != expected { return .fail("expected \(expected) element(s), got \(items.count)") }
        return .ok("\(items.count) element(s)")
    }

    private static func lengthAtLeast(_ value: Value, _ args: Value) -> StepResult {
        guard let items = value.array else { return .fail("expected an array, got \(jsType(value))") }
        let minimum = args["length"].int ?? 0
        if items.count < minimum { return .fail("expected at least \(minimum), got \(items.count)") }
        return .ok("\(items.count) element(s)")
    }

    private static func numbersInRange(_ value: Value, _ args: Value) -> StepResult {
        let field = args["field"].isNil ? nil : jsString(args["field"])
        let low = args["min"].number ?? 0
        let high = args["max"].number ?? 1
        let integer = args["integer"].isTrue
        let items = value.array ?? [value]
        let label = field ?? "value"
        for item in items {
            let measured = field.map { item[$0] } ?? item
            guard let reading = measured.number, reading >= low, reading <= high else {
                return .fail("\(label) is outside [\(jsNumber(low)), \(jsNumber(high))]: \(describe(measured))")
            }
            if integer && !isInteger(measured) { return .fail("\(label) is not an integer: \(jsString(measured))") }
        }
        return .ok("\(items.count) value(s) within [\(jsNumber(low)), \(jsNumber(high))]")
    }

    private static func equalsJoined(_ value: Value, _ args: Value) -> StepResult {
        let parts = args["parts"].list.map(jsString)
        let expected = parts.joined(separator: jsString(args["separator"].or("\n")))
        if !jsEquals(value, .string(expected)) { return .fail("expected \(describe(.string(expected))), got \(describe(value))") }
        return .ok("\(parts.count) part(s) joined")
    }

    private static func framesAre(_ value: Value, _ args: Value) -> StepResult {
        let frames = value.list
        let expected = args["count"].int ?? 0
        if frames.count != expected { return .fail("expected \(expected) frame(s), got \(frames.count)") }
        let width = args["width"].int ?? 0
        let height = args["height"].int ?? 0
        for (index, frame) in frames.enumerated() {
            guard let dimensions = Media.frameDimensions(frame.data) else { return .fail("frame \(index) is undecodable") }
            if dimensions != (width, height) {
                return .fail("frame \(index) is \(dimensions.0)x\(dimensions.1), expected \(width)x\(height)")
            }
        }
        return .ok("\(expected) frame(s) at \(width)x\(height)")
    }

    private static func safetensorsContainer(_ value: Value, _ args: Value) -> StepResult {
        let data = [UInt8](value.data)
        let floor = args["minBytes"].int ?? 1024
        if data.count < floor { return .fail("pack is \(data.count) bytes, expected at least \(floor)") }
        if data.count < 9 { return .fail("not a safetensors container (\(data.count) bytes)") }
        let headerLength = data[0..<8].reversed().reduce(Int64(0)) { $0 << 8 | Int64($1) }
        if headerLength <= 0 || headerLength + 8 > data.count || data[8] != 0x7B {
            return .fail("not a safetensors container (header length \(headerLength))")
        }
        return .ok("\(data.count) bytes, header \(headerLength)")
    }

    private static func noProgressBatchGaps(_ value: Value, _ args: Value) -> StepResult {
        let events = value.list
        if events.isEmpty { return .fail("no progress events received") }
        var order: [String] = []
        var phases: [String: (batches: Set<Double?>, total: Int)] = [:]
        for event in events {
            guard event.object != nil else { continue }
            let key = (event["is_train"].isTrue ? "train" : "val") + ":epoch\(jsString(event["current_epoch"]))"
            let total = event["total_batches"].int ?? 0
            if phases[key] == nil {
                phases[key] = ([], total)
                order.append(key)
            }
            phases[key]!.batches.insert(event["current_batch"].isNil ? nil : event["current_batch"].number)
            if total > phases[key]!.total { phases[key]!.total = total }
        }
        let drops = order.compactMap { key -> String? in
            let phase = phases[key]!
            guard phase.batches.count < phase.total else { return nil }
            let received = phase.batches.compactMap { $0 }.map { Int64($0) }.sorted()
            return "\(key): \(received.count)/\(phase.total) (received=[\(received.map(String.init).joined(separator: ","))])"
        }
        if !drops.isEmpty { return .fail("progress events dropped: \(drops.joined(separator: "; "))") }
        return .ok("\(events.count) event(s) across \(phases.count) phase(s), no batch gaps")
    }

    private static func sortedAscendingBy(_ value: Value, _ args: Value) -> StepResult {
        let items = value.list
        let field = jsString(args["field"])
        let minimum = args["minimum"].int ?? 2
        if items.count < minimum { return .fail("need at least \(minimum) element(s), got \(items.count)") }
        for index in items.indices.dropFirst() where (items[index][field].number ?? 0) < (items[index - 1][field].number ?? 0) {
            return .fail("out of order by \(field) at index \(index)")
        }
        return .ok("\(items.count) element(s) in order")
    }

    private static func anyElementPositive(_ value: Value, _ args: Value) -> StepResult {
        let items = value.list
        let field = jsString(args["field"])
        let found = items.filter { ($0[field].number ?? 0) > 0 }.count
        if found == 0 { return .fail("no finite positive \(field) across \(items.count) element(s)") }
        return .ok("\(found) of \(items.count) had a positive \(field)")
    }

    private static func atLeast(_ value: Value, _ args: Value) -> StepResult {
        let minimum = args["value"].number ?? 0
        guard let reading = value.number else { return .fail("expected a number, got \(describe(value))") }
        if reading < minimum { return .fail("expected at least \(jsNumber(minimum)), got \(jsString(value))") }
        return .ok(jsString(value))
    }

    private static func isAbsent(_ value: Value, _ args: Value) -> StepResult {
        value.isNil ? .ok("(absent)") : .fail("expected nothing, got \(describe(value))")
    }

    private static func belowBudget(_ value: Value, _ args: Value) -> StepResult {
        let budget = args["budget"].number ?? 0
        guard let reading = value.number else { return .fail("expected a number, got \(describe(value))") }
        if reading >= budget {
            return .fail(
                "expected fewer than the \(jsNumber(budget)) budgeted (boundary, not prediction cutoff), got \(jsString(value))")
        }
        return .ok("\(jsString(value)) of \(jsNumber(budget))")
    }

    private static func atLeastField(_ value: Value, _ args: Value) -> StepResult {
        let field = jsString(args["field"])
        let other = jsString(args["atLeast"])
        guard let left = value[field].number, let right = value[other].number else {
            return .fail("expected numbers, got \(field)=\(describe(value[field])) \(other)=\(describe(value[other]))")
        }
        if left < right { return .fail("expected \(field) >= \(other), got \(jsNumber(left)) < \(jsNumber(right))") }
        return .ok("\(jsNumber(left)) >= \(jsNumber(right))")
    }

    private static func jsonObjectShape(_ value: Value, _ args: Value) -> StepResult {
        let raw = text(value)
        let parsed: Value
        do {
            parsed = try Value.parse(Data(raw.utf8))
        } catch {
            return .fail("not valid JSON: \(error.localizedDescription). Output: \(raw.prefix(200))")
        }
        guard let object = parsed.object else {
            return .fail("expected a JSON object, got \(jsType(parsed))")
        }
        for (field, kind) in args["fields"].fields.sorted(by: { $0.key < $1.key }) {
            let measured = parsed[field]
            switch kind.string {
            case "string":
                if (measured.string ?? "").isEmpty { return .fail("\(field) must be a non-empty string, got \(describe(measured))") }
            case "integer":
                if !isInteger(measured) { return .fail("\(field) must be an integer, got \(describe(measured))") }
            case "number":
                if measured.number == nil { return .fail("\(field) must be a number, got \(describe(measured))") }
            default: break
            }
        }
        let exact = names(args, "exactKeys")
        if !exact.isEmpty {
            let actual = object.keys.sorted()
            let expected = exact.sorted()
            if actual != expected {
                return .fail(
                    "additionalProperties:false violated. Expected exactly [\(expected.joined(separator: ","))], got [\(actual.joined(separator: ","))]")
            }
        }
        return .ok("object with keys [\(object.keys.sorted().joined(separator: ","))]")
    }

    private static func pngDimensions(_ value: Value, _ args: Value) -> StepResult {
        var raw = value
        if let items = value.array, let first = items.first, first.number == nil { raw = first }
        let data = raw.data
        guard let dimensions = Media.pngDimensions(data) else { return .fail("not a valid PNG (\(data.count) bytes)") }
        let width = args["width"].int ?? 0
        let height = args["height"].int ?? 0
        if dimensions != (width, height) {
            return .fail("expected \(width)x\(height), got \(dimensions.0)x\(dimensions.1)")
        }
        return .ok("\(dimensions.0)x\(dimensions.1)")
    }

    private static func nonNegativeNumbers(_ value: Value, _ args: Value) -> StepResult {
        let fields = names(args)
        for field in fields {
            guard let measured = value[field].number, measured >= 0 else {
                return .fail("\(field) is not a non-negative number (got \(describe(value[field])))")
            }
        }
        return .ok("\(fields.count) field(s) non-negative")
    }

    private static func fieldsSumTo(_ value: Value, _ args: Value) -> StepResult {
        let total = names(args).reduce(0) { $0 + (value[$1].number ?? 0) }
        let totalField = jsString(args["total"])
        guard let expected = value[totalField].number else { return .fail("\(totalField) is missing from the record") }
        let tolerance = max(args["minTolerance"].number ?? 2, expected * (args["ratio"].number ?? 0.01))
        let delta = abs(total - expected)
        if delta > tolerance {
            return .fail(
                "phases sum to \(fixed(total, 2)), \(totalField)=\(jsNumber(expected)), delta \(fixed(delta, 2))ms exceeds \(fixed(tolerance, 2))ms")
        }
        return .ok("phases reconcile within \(fixed(delta, 2))ms")
    }

    private static func noPartialDownloads(_ value: Value, _ args: Value) -> StepResult {
        let events = value.list
        let partials = events.filter { event in
            guard event.object != nil else { return false }
            let total = event["total"].number ?? 0
            return total > 0 && (event["downloaded"].number ?? 0) < total
        }
        if !partials.isEmpty {
            let keys = Set(partials.map { jsString($0["downloadKey"]) })
            let sample = partials.prefix(3).map { "\(jsString($0["downloadKey"]))@\(fixed($0["percentage"].number ?? 0, 0))%" }
            return .fail("re-downloaded \(keys.count) file(s), \(partials.count) partial event(s). First: \(sample.joined(separator: ", "))")
        }
        return .ok("\(events.count) cache-hit notification(s)")
    }

    private static func transcriptSegmentsShape(_ value: Value, _ args: Value) -> StepResult {
        let flags = names(args, "flags")
        guard let segments = value.array else { return .fail("expected an array, got \(jsType(value))") }
        if segments.isEmpty { return .fail("expected at least one segment") }
        var previousStart = -Double.infinity
        var previousId = -Double.infinity
        for (index, segment) in segments.enumerated() {
            guard segment.object != nil else { return .fail("segment \(index): not an object") }
            if segment["text"].string == nil { return .fail("segment \(index): missing/invalid text") }
            guard let start = segment["startMs"].number else { return .fail("segment \(index): missing/invalid startMs") }
            guard let end = segment["endMs"].number else { return .fail("segment \(index): missing/invalid endMs") }
            if end < start { return .fail("segment \(index): endMs \(jsNumber(end)) < startMs \(jsNumber(start))") }
            if segment["append"].bool == nil { return .fail("segment \(index): missing/invalid append") }
            if !isInteger(segment["id"]) { return .fail("segment \(index): missing/invalid id") }
            for flag in flags where segment[flag].bool == nil {
                return .fail("segment \(index): missing/invalid \(flag)")
            }
            if start < previousStart {
                return .fail("segment \(index): out-of-order startMs \(jsNumber(start)) < \(jsNumber(previousStart))")
            }
            let id = segment["id"].number!
            if id < previousId { return .fail("segment \(index): out-of-order id \(jsNumber(id)) < \(jsNumber(previousId))") }
            previousStart = start
            previousId = id
        }
        let carried = flags.isEmpty ? "" : ", all carrying \(flags.joined(separator: " / "))"
        return .ok("\(segments.count) segment(s) in order\(carried)")
    }

    private static func eventTypeCounts(_ value: Value, _ args: Value) -> StepResult {
        var counts: [String: Int] = [:]
        for event in value.list {
            let kind = event["type"].isNil ? "unknown" : jsString(event["type"])
            counts[kind, default: 0] += 1
        }
        let summary = "{" + counts.keys.sorted().map { "\"\($0)\": \(counts[$0]!)" }.joined(separator: ", ") + "}"
        for (kind, minimum) in args["atLeast"].fields.sorted(by: { $0.key < $1.key }) {
            let floor = minimum.int ?? 0
            if counts[kind, default: 0] < floor { return .fail("expected at least \(floor) \(kind) event(s), got \(summary)") }
        }
        for kind in names(args, "absent") where counts[kind, default: 0] > 0 {
            return .fail("\(kind) event(s) were emitted but must not be: \(summary)")
        }
        return .ok(summary)
    }

    private static func eventShape(_ value: Value, _ args: Value) -> StepResult {
        let kind = jsString(args["type"])
        let equals = args["equals"].fields
        let absent = names(args, "absent")
        for event in value.list {
            guard event.object != nil, event["type"].string == kind else { continue }
            for (field, expected) in equals.sorted(by: { $0.key < $1.key }) where !jsEquals(event[field], expected) {
                return .fail("\(kind) event has \(field)=\(describe(event[field])), expected \(describe(expected)): \(jsString(event))")
            }
            for field in absent where !event[field].isNil {
                return .fail("\(kind) event must omit \(field): \(jsString(event))")
            }
        }
        return .ok("\(kind) events well formed")
    }

    private static func containsAll(_ value: Value, _ args: Value) -> StepResult {
        let haystack = text(value).lowercased()
        let terms = names(args, "terms")
        let missing = terms.filter { !includes(haystack, $0.lowercased()) }
        if !missing.isEmpty { return .fail("missing \(quoted(missing)) in: \(text(value).prefix(200))") }
        return .ok("\(terms.count) term(s) present")
    }

    private static func containsAny(_ value: Value, _ args: Value) -> StepResult {
        let haystack = text(value).lowercased()
        let terms = names(args, "terms")
        if !terms.contains(where: { includes(haystack, $0.lowercased()) }) {
            return .fail("none of \(quoted(terms)) in: \(text(value).prefix(200))")
        }
        return .ok("matched")
    }

    private static func anyFieldPresent(_ value: Value, _ args: Value) -> StepResult {
        let fields = names(args)
        let found = fields.filter { value.has($0) }
        if found.isEmpty { return .fail("none of \(fields.joined(separator: ", ")) are present") }
        return .ok("\(found.joined(separator: ", ")) present")
    }

    private static func isEmptyText(_ value: Value, _ args: Value) -> StepResult {
        if !value.isNil && value.string == nil { return .fail("expected a string, got \(jsType(value))") }
        let body = value.string ?? ""
        if !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return .fail("expected no text, got: \(body.prefix(120))") }
        return .ok("(empty)")
    }

    private static func sortedDescendingBy(_ value: Value, _ args: Value) -> StepResult {
        let items = value.list
        let field = jsString(args["field"])
        if items.count > 1 {
            for index in items.indices.dropFirst() where (items[index][field].number ?? 0) > (items[index - 1][field].number ?? 0) {
                return .fail("not sorted by \(field) at index \(index)")
            }
        }
        return .ok("\(items.count) element(s) in order")
    }

    private static func sumsTo(_ value: Value, _ args: Value) -> StepResult {
        let field = jsString(args["field"])
        let total = value.list.reduce(0) { $0 + ($1[field].number ?? 0) }
        let expected = args["total"].number ?? 1
        let tolerance = args["tolerance"].number ?? 1e-3
        if abs(total - expected) > tolerance {
            return .fail("\(field) sums to \(total), not within \(tolerance) of \(jsNumber(expected))")
        }
        return .ok("\(field) sums to \(total)")
    }

    private static func systemResourcesShape(_ value: Value, _ args: Value) -> StepResult {
        var problems: [String] = []

        func metric(_ measured: Value, _ label: String) -> Value {
            if measured["status"].string == "supported" {
                if measured["provenance"]["source"].isNil { problems.append("\(label) has no provenance source") }
            } else if measured.has("value") {
                problems.append("\(label) exposes a value with status \(jsString(measured["status"]))")
            }
            return measured
        }

        func utilization(_ raw: Value, _ label: String) {
            let measured = metric(raw, label)
            if measured["status"].string == "supported", let reading = measured["value"].number, reading < 0 || reading > 1 {
                problems.append("\(label) is outside 0..1: \(jsNumber(reading))")
            }
        }

        let capabilities = value["capabilities"]
        if capabilities.isNil { problems.append("capabilities are missing") }
        _ = metric(capabilities["cpu"], "capabilities.cpu")
        _ = metric(capabilities["memory"]["totalBytes"], "capabilities.memory.totalBytes")
        let capabilityGpus = metric(capabilities["gpus"], "capabilities.gpus")
        let rawIdentity = ["vendorId", "deviceId", "subsystemId", "revision"]
        var capabilityIds: [String]?
        if capabilityGpus["status"].string == "supported" {
            let gpus = capabilityGpus["value"].list
            capabilityIds = gpus.map { jsString($0["id"]) }
            for gpu in gpus {
                if gpu["id"].isNil || gpu["id"].string == "" { problems.append("GPU has no opaque ID") }
                for field in rawIdentity where gpu.has(field) { problems.append("GPU exposes private identity field \(field)") }
            }
        }

        if !args["sample"].isTrue {
            if !value["sample"].isNil { problems.append("sample returned when it was not requested") }
            return problems.isEmpty ? .ok("capabilities valid; sample omitted") : .fail(problems.joined(separator: "; "))
        }

        let sampled = value["sample"]
        if sampled.isNil {
            problems.append("requested sample is missing")
            return .fail(problems.joined(separator: "; "))
        }
        utilization(sampled["cpu"], "sample.cpu")
        let memory = sampled["memory"]
        _ = metric(memory["usedBytes"], "sample.memory.usedBytes")
        _ = metric(memory["totalBytes"], "sample.memory.totalBytes")
        _ = metric(memory["processUsedBytes"], "sample.memory.processUsedBytes")
        let allowance = metric(memory["processAvailableBytes"], "sample.memory.processAvailableBytes")
        if allowance["status"].string == "supported" {
            if let reading = allowance["value"].number, reading <= 0 {
                problems.append("sample.memory.processAvailableBytes is not positive: \(jsNumber(reading))")
            }
            let scope = allowance["provenance"]["scope"]
            if scope.string != "process" { problems.append("sample.memory.processAvailableBytes carries scope \(jsString(scope))") }
        } else if args["platform"].string == "ios" {
            problems.append("sample.memory.processAvailableBytes is \(jsString(allowance["status"])) on iOS")
        }
        let sampleGpus = metric(sampled["gpus"], "sample.gpus")
        if let capabilityIds, sampleGpus["status"].string == "supported" {
            let gpus = sampleGpus["value"].list
            if capabilityIds != gpus.map({ jsString($0["id"]) }) { problems.append("capability and sample GPU IDs do not correlate") }
            for gpu in gpus {
                let label = "sample.gpus.\(jsString(gpu["id"]))"
                utilization(gpu["compute"], "\(label).compute")
                utilization(gpu["encode"], "\(label).encode")
                utilization(gpu["decode"], "\(label).decode")
            }
        }
        return problems.isEmpty ? .ok("capabilities valid; sample valid") : .fail(problems.joined(separator: "; "))
    }

    private static func textsById(_ value: Value, _ args: Value) -> StepResult {
        var byId: [String: String] = [:]
        for item in value.list where item.object != nil {
            byId[jsString(item["id"])] = item["final"]["contentText"].string ?? ""
        }
        let expected = args["expect"].fields
        let anyMode = args["mode"].string == "any"
        for (promptId, raw) in expected.sorted(by: { $0.key < $1.key }) {
            let terms = raw.list.map(jsString)
            guard let body = byId[promptId] else { return .fail("no result for id \"\(promptId)\": got \(quoted(byId.keys.sorted()))") }
            let hits = terms.filter { includes(body.lowercased(), $0.lowercased()) }
            let failed = anyMode ? hits.isEmpty : hits.count != terms.count
            if failed {
                let missing = terms.filter { !hits.contains($0) }
                return .fail("\"\(promptId)\" is missing \(anyMode ? "any of " : "")\(quoted(missing)): \(body.prefix(160))")
            }
        }
        return .ok("\(expected.count) id(s) matched")
    }

    private static func streamedEachId(_ value: Value, _ args: Value) -> StepResult {
        var order: [String] = []
        var counts: [String: Int] = [:]
        for item in value.list where item.object != nil && !item["id"].isNil {
            let event = item["event"]
            if event["type"].string == "contentDelta", !(event["text"].string ?? "").isEmpty {
                let id = jsString(item["id"])
                if counts[id] == nil { order.append(id) }
                counts[id, default: 0] += 1
            }
        }
        let missing = args["ids"].list.map(jsString).filter { counts[$0, default: 0] == 0 }
        if !missing.isEmpty { return .fail("no streamed content for: \(missing.joined(separator: ", "))") }
        return .ok("streamed \(order.map { String(counts[$0]!) }.joined(separator: "/")) delta(s)")
    }

    private static func noToolCallsFor(_ value: Value, _ args: Value) -> StepResult {
        let results = value.list
        let ids = args["ids"].list
        for promptId in ids {
            let calls = results.first { $0.object != nil && jsEquals($0["id"], promptId) }?["final"]["toolCalls"].list ?? []
            if !calls.isEmpty {
                let names = calls.map { jsString($0["name"]) }.joined(separator: ", ")
                return .fail("\"\(jsString(promptId))\" was expected to make no tool call, made: \(names)")
            }
        }
        return .ok("\(ids.count) id(s) stayed quiet")
    }

    private static func fieldsPresent(_ value: Value, _ args: Value) -> StepResult {
        guard let object = value.object else { return .fail("expected an object, got \(jsType(value))") }
        let fields = names(args)
        // JS checks `=== undefined`, so an explicit null counts as present.
        let missing = fields.filter { object[$0] == nil }
        if !missing.isEmpty { return .fail("missing fields: \(missing.joined(separator: ", "))") }
        return .ok("\(fields.count) field(s) present")
    }

    private static func fieldsAbsent(_ value: Value, _ args: Value) -> StepResult {
        guard let object = value.object else { return .fail("expected an object, got \(jsType(value))") }
        let fields = names(args)
        // JS checks `!== undefined`, so an explicit null counts as present.
        let present = fields.filter { object[$0] != nil }
        if !present.isEmpty { return .fail("unexpected fields: \(present.joined(separator: ", "))") }
        return .ok("\(fields.count) field(s) absent")
    }

    private static func fieldsMatch(_ value: Value, _ args: Value) -> StepResult {
        let expected = args["expected"]
        let fields = names(args)
        let mismatched = fields.filter { jsString(value[$0]) != jsString(expected[$0]) }
        if !mismatched.isEmpty {
            return .fail(mismatched.map { "\($0): \(jsString(value[$0])) != \(jsString(expected[$0]))" }.joined(separator: "; "))
        }
        return .ok("\(fields.count) field(s) match")
    }

    private static func errorIsStructured(_ value: Value, _ args: Value) -> StepResult {
        let code = value["code"].string ?? ""
        if code.isEmpty && !value["hasCause"].isTrue {
            return .fail("rejection carried neither a code nor a cause: \(value["message"].string ?? "(no message)")")
        }
        return .ok("hasCause=\(value["hasCause"].isTrue), code=\(code.isEmpty ? "(none)" : code)")
    }

    private static func nonEmptyText(_ value: Value, _ args: Value) -> StepResult {
        guard let text = value.string else { return .fail("expected a string, got \(jsType(value))") }
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return .fail("expected text, got an empty string") }
        return .ok("\(text.count) character(s)")
    }

    private static func errorMatches(_ value: Value, _ args: Value) -> StepResult {
        let message = value["message"].string ?? ""
        let expectedCode = args["code"]
        if !expectedCode.isNil && jsString(value["code"]) != jsString(expectedCode) {
            return .fail("expected code \(jsString(expectedCode)), got \(jsString(value["code"]))")
        }
        let contains = args["messageContains"]
        if !contains.isNil && !includes(message.lowercased(), jsString(contains).lowercased()) {
            return .fail("message does not contain \"\(jsString(contains))\": \(message)")
        }
        let forbidden = args["messageNotMatching"]
        if !forbidden.isNil {
            guard let expression = try? NSRegularExpression(pattern: jsString(forbidden), options: .caseInsensitive) else {
                return .fail("messageNotMatching \"\(jsString(forbidden))\" is not a valid pattern")
            }
            if expression.firstMatch(in: message, range: NSRange(message.startIndex..., in: message)) != nil {
                return .fail("message matched the forbidden pattern: \(message)")
            }
        }
        let code = value["code"].string ?? ""
        return .ok("code=\(code.isEmpty ? "(none)" : code): \(message.prefix(120))")
    }

    private static func toolCallShape(_ value: Value, _ args: Value) -> StepResult {
        let calls = value.list
        if calls.isEmpty { return .fail("expected a structured tool call but the model made none") }
        let declared = Set(args["declared"].list.map(jsString))
        let valid = calls.filter { $0["name"].string.map(declared.contains) ?? false }
        if valid.isEmpty {
            let got = calls.map { ($0["name"].string).flatMap { $0.isEmpty ? nil : $0 } ?? "<unnamed>" }.joined(separator: ", ")
            return .fail("no tool call matched a declared tool. Got: [\(got)], declared: [\(declared.sorted().joined(separator: ", "))]")
        }
        if let match = valid.first(where: { jsEquals($0["name"], args["name"]) }) {
            let callArgs = match["arguments"]
            for key in args["argKeys"].list.map(jsString) where !callArgs.has(key) {
                return .fail("tool call '\(jsString(args["name"]))' is missing argument '\(key)': \(jsString(callArgs))")
            }
        }
        return .ok("tool call(s): " + valid.map { jsString($0["name"]) }.joined(separator: ", "))
    }

    private static func textBlockShape(_ value: Value, _ args: Value) -> StepResult {
        let blocks = value.list
        for (index, block) in blocks.enumerated() {
            if block["text"].string == nil { return .fail("block[\(index)].text is not a string") }
            guard let bbox = block["bbox"].array, bbox.count == 4 else { return .fail("block[\(index)].bbox is not a 4-element array") }
            for (position, coordinate) in bbox.enumerated() where coordinate.number == nil {
                return .fail("block[\(index)].bbox[\(position)] is not a number")
            }
            if block["confidence"].number == nil { return .fail("block[\(index)].confidence is not a number") }
        }
        return .ok("\(blocks.count) well-formed block(s)")
    }

    private static func timingStatsPresent(_ value: Value, _ args: Value) -> StepResult {
        guard value.object != nil else { return .fail("stats is undefined, expected timing data") }
        let field = jsString(args["field"].or("totalTime"))
        guard let measured = value[field].number, measured > 0 else {
            return .fail("expected stats.\(field) > 0, got \(describe(value[field]))")
        }
        return .ok("\(field)=\(jsString(value[field]))")
    }

    private static func producedAudio(_ value: Value, _ args: Value) -> StepResult {
        let samples = value.dataLength
        let floor = args["minSamples"].int ?? 1
        if samples < floor { return .fail("expected at least \(floor) sample(s), got \(samples)") }
        return .ok("\(samples) sample(s)")
    }

    private static func isTrue(_ value: Value, _ args: Value) -> StepResult {
        value.isTrue ? .ok("true") : .fail("expected true, got \(describe(value))")
    }

    private static func positiveIntegers(_ value: Value, _ args: Value) -> StepResult {
        let fields = names(args)
        for field in fields {
            let measured = value[field]
            if !isInteger(measured) || measured.number! <= 0 {
                return .fail("\(field) is not a positive integer (got \(describe(measured)))")
            }
        }
        return .ok("\(fields.count) field(s) positive")
    }

    private static func valueIn(_ value: Value, _ args: Value) -> StepResult {
        if value.isNil && args["allowNull"].isTrue { return .ok("null") }
        let allowed = args["values"].list
        if !allowed.contains(where: { jsEquals($0, value) }) {
            return .fail("\(describe(value)) is not one of \(quoted(allowed.map(jsString)))")
        }
        return .ok(jsString(value))
    }

    private static func fieldEquals(_ value: Value, _ args: Value) -> StepResult {
        let field = jsString(args["field"])
        let other = jsString(args["other"])
        if !jsEquals(value[field], value[other]) {
            return .fail("\(field)=\(describe(value[field])) != \(other)=\(describe(value[other]))")
        }
        return .ok("\(field) == \(other)")
    }

    private static func loadedModelInfoShape(_ value: Value, _ args: Value) -> StepResult {
        guard value.object != nil else { return .fail("expected an object, got \(jsType(value))") }
        var checks: [(String, Bool)] = [
            ("modelIdMatches", jsEquals(value["modelId"], args["expectedModelId"])),
            ("handlersIsList", value["handlers"].array != nil),
            ("modelTypePresent", !(value["modelType"].string ?? "").isEmpty),
        ]
        if !args["handlerIncludes"].isNil {
            checks.append(("handlerPresent", value["handlers"].list.contains { jsEquals($0, args["handlerIncludes"]) }))
        }
        let failed = checks.filter { !$0.1 }.map(\.0)
        if !failed.isEmpty {
            return .fail(
                "loadedModelInfoShape failed: \(failed.joined(separator: ", ")) (modelId=\(jsString(value["modelId"])), modelType=\(jsString(value["modelType"])), handlers=\(jsString(value["handlers"])))")
        }
        return .ok("modelType=\(jsString(value["modelType"])), handlers=\(value["handlers"].list.count)")
    }

    private static func emptyArray(_ value: Value, _ args: Value) -> StepResult {
        value.array?.isEmpty == true ? .ok("empty PCM") : .fail("expected empty PCM")
    }

    private static func mossSoundEffect(_ value: Value, _ args: Value) -> StepResult {
        let pcm = value["pcm"].list
        let expected = (args["seconds"].number ?? 0) * 48000
        let valid = value["done"].isTrue && value["sampleRate"].number == 48000 && abs(Double(pcm.count) - expected) <= 480
            && pcm.allSatisfy { ($0.number ?? .nan).isFinite } && pcm.contains { $0.number != 0 }
        let output = "\(pcm.count) samples at \(jsString(value["sampleRate"])) Hz; expected \(jsNumber(expected))"
        return valid ? .ok(output) : .fail(output)
    }

    static let named: [String: Assertion] = [
        "unitVectors": unitVectors,
        "lengthIs": lengthIs,
        "lengthAtLeast": lengthAtLeast,
        "anyFieldPresent": anyFieldPresent,
        "containsAll": containsAll,
        "eventTypeCounts": eventTypeCounts,
        "transcriptSegmentsShape": transcriptSegmentsShape,
        "noPartialDownloads": noPartialDownloads,
        "anyElementPositive": anyElementPositive,
        "sortedAscendingBy": sortedAscendingBy,
        "noProgressBatchGaps": noProgressBatchGaps,
        "framesAre": framesAre,
        "safetensorsContainer": safetensorsContainer,
        "atLeast": atLeast,
        "isAbsent": isAbsent,
        "belowBudget": belowBudget,
        "atLeastField": atLeastField,
        "jsonObjectShape": jsonObjectShape,
        "pngDimensions": pngDimensions,
        "nonNegativeNumbers": nonNegativeNumbers,
        "fieldsSumTo": fieldsSumTo,
        "eventShape": eventShape,
        "containsAny": containsAny,
        "equalsJoined": equalsJoined,
        "isEmptyText": isEmptyText,
        "numbersInRange": numbersInRange,
        "sortedDescendingBy": sortedDescendingBy,
        "sumsTo": sumsTo,
        "systemResourcesShape": systemResourcesShape,
        "textsById": textsById,
        "streamedEachId": streamedEachId,
        "noToolCallsFor": noToolCallsFor,
        "fieldsPresent": fieldsPresent,
        "fieldsAbsent": fieldsAbsent,
        "fieldsMatch": fieldsMatch,
        "errorIsStructured": errorIsStructured,
        "nonEmptyText": nonEmptyText,
        "errorMatches": errorMatches,
        "toolCallShape": toolCallShape,
        "textBlockShape": textBlockShape,
        "timingStatsPresent": timingStatsPresent,
        "producedAudio": producedAudio,
        "isTrue": isTrue,
        "positiveIntegers": positiveIntegers,
        "valueIn": valueIn,
        "fieldEquals": fieldEquals,
        "loadedModelInfoShape": loadedModelInfoShape,
        "emptyArray": emptyArray,
        "mossSoundEffect": mossSoundEffect,
    ]

    private static func greaterThan(_ left: Value, _ right: Value, _ args: Value) -> StepResult {
        guard let a = left.number, let b = right.number else {
            return .fail("expected numbers, got \(describe(left)) and \(describe(right))")
        }
        if a <= b { return .fail("expected \(jsNumber(a)) > \(jsNumber(b))") }
        return .ok("\(jsNumber(a)) > \(jsNumber(b))")
    }

    private static func cosine(_ left: Value, _ right: Value) -> Double? {
        guard let a = vector(left), let b = vector(right), a.count == b.count else { return nil }
        let normA = a.reduce(0) { hypot($0, $1) }
        let normB = b.reduce(0) { hypot($0, $1) }
        guard normA.isFinite, normB.isFinite, normA != 0, normB != 0 else { return nil }
        let similarity = zip(a, b).reduce(0) { $0 + ($1.0 / normA) * ($1.1 / normB) }
        return similarity.isFinite ? similarity : nil
    }

    private static func cosineAtLeast(_ left: Value, _ right: Value, _ args: Value) -> StepResult {
        guard let minimum = args["min"].number, minimum.isFinite, minimum >= -1, minimum <= 1 else {
            return .fail("expected a cosine minimum between -1 and 1")
        }
        guard let similarity = cosine(left, right) else { return .fail("expected finite, nonzero vectors of the same length") }
        let output = "cosine \(jsNumber(similarity)), minimum \(jsNumber(minimum))"
        return similarity >= minimum ? .ok(output) : .fail(output)
    }

    private static func moreSimilarThan(_ left: Value, _ right: Value, _ args: Value) -> StepResult {
        guard let near = cosine(left, right), let far = cosine(left, args["than"]) else {
            return .fail("expected finite, nonzero vectors of the same length")
        }
        let output = "cosine to match \(jsNumber(near)), to other \(jsNumber(far))"
        return near > far ? .ok(output) : .fail(output)
    }

    /// The warm prompt is the cold one minus exactly the primed tokens.
    private static func prefillReuse(_ left: Value, _ right: Value, _ args: Value) -> StepResult {
        let values = [left, right, args["primedTokens"]]
        let shown = values.map { $0.number.map(jsNumber) ?? describe($0) }
        let message = "cold=\(shown[0]), warm=\(shown[1]), primed=\(shown[2])"
        let numbers = values.compactMap { $0.number.flatMap { $0.isFinite ? $0 : nil } }
        guard numbers.count == 3 else { return .fail(message) }
        let (cold, warm, primed) = (numbers[0], numbers[1], numbers[2])
        if primed <= 0 || warm <= 0 || cold - warm != primed { return .fail(message) }
        return .ok(message)
    }

    private static func equalStrings(_ left: Value, _ right: Value, _ args: Value) -> StepResult {
        let a = jsString(left)
        let b = jsString(right)
        if a != b {
            return .fail("differ:\n  \(describe(.string(String(a.prefix(200)))))\n  \(describe(.string(String(b.prefix(200)))))")
        }
        return .ok("identical, \(a.count) char(s)")
    }

    private static func identicalBytes(_ left: Value, _ right: Value, _ args: Value) -> StepResult {
        if left.data != right.data {
            return .fail("expected identical output, got \(left.dataLength) and \(right.dataLength) byte(s) that differ")
        }
        return .ok("identical, \(left.dataLength) byte(s)")
    }

    private static func differentBytes(_ left: Value, _ right: Value, _ args: Value) -> StepResult {
        if left.dataLength == 0 || right.dataLength == 0 {
            return .fail("one side produced nothing (\(left.dataLength) and \(right.dataLength) byte(s))")
        }
        if left.data == right.data { return .fail("expected the outputs to differ, they are identical") }
        return .ok("differ, \(left.dataLength) vs \(right.dataLength) byte(s)")
    }

    private static func imageDivergesFrom(_ left: Value, _ right: Value, _ args: Value) -> StepResult {
        let a = [UInt8](left.data)
        let b = [UInt8](right.data)
        if a.isEmpty || b.isEmpty { return .fail("missing output (\(a.count) and \(b.count) bytes)") }
        guard let da = Media.pngDimensions(Data(a)), let db = Media.pngDimensions(Data(b)) else {
            return .fail("one of the outputs is not a valid PNG")
        }
        if da != db {
            return .fail("dimensions differ: \(da.0)x\(da.1) vs \(db.0)x\(db.1) -- the comparison is only meaningful at equal size")
        }
        let longest = max(a.count, b.count)
        var changed = abs(a.count - b.count)
        for index in 0..<min(a.count, b.count) where a[index] != b[index] { changed += 1 }
        let ratio = Double(changed) / Double(longest)
        let minimum = args["minRatio"].number ?? 0.01
        if ratio <= minimum {
            return .fail(
                "outputs are \(fixed(ratio * 100, 2))% apart, at or below the \(fixed(minimum * 100, 2))% floor -- the input was probably dropped")
        }
        return .ok("\(fixed(ratio * 100, 2))% byte delta")
    }

    private static func lengthRatioAtLeast(_ left: Value, _ right: Value, _ args: Value) -> StepResult {
        let leftSize = left.dataLength
        let rightSize = right.dataLength
        if leftSize == 0 || rightSize == 0 { return .fail("comparison produced empty output (\(leftSize) and \(rightSize))") }
        let minimum = args["ratio"].number ?? 1
        let ratio = Double(leftSize) / Double(rightSize)
        if ratio < minimum {
            return .fail("ratio too low: \(fixed(ratio, 2)) < \(jsNumber(minimum)) (\(leftSize) vs \(rightSize))")
        }
        return .ok("ratio \(fixed(ratio, 2)) (\(leftSize) vs \(rightSize))")
    }

    static let comparisons: [String: Comparison] = [
        "cosineAtLeast": cosineAtLeast,
        "moreSimilarThan": moreSimilarThan,
        "equalStrings": equalStrings,
        "greaterThan": greaterThan,
        "prefillReuse": prefillReuse,
        "identicalBytes": identicalBytes,
        "differentBytes": differentBytes,
        "lengthRatioAtLeast": lengthRatioAtLeast,
        "imageDivergesFrom": imageDivergesFrom,
    ]
}
