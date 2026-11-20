import Foundation

/// Swift port of the shared step interpreter (packages/test-suite StepInterpreter,
/// runners/python/qvac_e2e/interpreter.py, runners/kotlin Interpreter.kt); keep operations,
/// bindings and verdicts in sync.
final class Interpreter: @unchecked Sendable {
    private let resources: Resources
    private let calls: Calls
    /// Fixtures: `<root>/images`, `<root>/audio`, ...
    private let assetRoot: URL
    private let log: @Sendable (String) -> Void
    private let restartWorker: @Sendable () async throws -> Void

    init(
        resources: Resources, calls: Calls, assetRoot: URL, log: @escaping @Sendable (String) -> Void,
        restartWorker: @escaping @Sendable () async throws -> Void
    ) {
        self.resources = resources
        self.calls = calls
        self.assetRoot = assetRoot
        self.log = log
        self.restartWorker = restartWorker
    }

    private final class Pending: @unchecked Sendable {
        let task: Task<Result<Value, Error>, Never>
        init(_ task: Task<Result<Value, Error>, Never>) { self.task = task }
    }

    private final class Scope: @unchecked Sendable {
        var values: [String: Value]
        let started: Locked<[Pending]>

        init(_ values: [String: Value], started: Locked<[Pending]> = Locked([])) {
            self.values = values
            self.started = started
        }

        func child(_ name: String, _ value: Value) -> Scope {
            var values = self.values
            values[name] = value
            return Scope(values, started: started)
        }

        func snapshot() -> Scope { Scope(values, started: started) }
    }

    func run(steps: [Value], params: Value, expectation: Value, teardown: [Value] = []) async -> StepResult {
        // Evict undeclared models first so a result does not depend on test order.
        let declared = Set((steps + teardown).filter { $0.has("useModel") }.flatMap { $0["useModel"]["deps"].list.map(jsString) })
        await resources.evictAllExcept(declared)

        let scope = Scope(["params": params])
        let body = await runBody(steps, scope, expectation)
        guard let failedTeardown = await cleanUp(teardown, scope, expectation) else { return body }
        // A body that passed cannot be claimed on a client that could not clean up after it.
        if body.passed {
            var result = failedTeardown
            result.output = "teardown failed: \(failedTeardown.output)"
            return result
        }
        var result = body
        result.output = "\(body.output) [teardown also failed: \(failedTeardown.output)]"
        return result
    }

    private func failure(_ error: Error) -> StepResult {
        if let error = error as? StepError { return error.incomplete ? .incomplete(error.message) : .fail(error.message) }
        return .fail("\(type(of: error)): \(Wire.message(of: error))")
    }

    private func runBody(_ steps: [Value], _ scope: Scope, _ expectation: Value) async -> StepResult {
        do {
            return try await runSteps(steps, scope, expectation) ?? .fail("test body ran but asserted nothing")
        } catch {
            return failure(error)
        }
    }

    /// Runs teardown and drains started calls even after a body failure: a suspended worker or
    /// open session would fail every later test. Bounded like the JS consumer's teardown.
    private func cleanUp(_ teardown: [Value], _ scope: Scope, _ expectation: Value) async -> StepResult? {
        let started = scope.started
        let finished = try? await withTimeout(
            Self.teardownTimeoutSeconds, grace: Self.abandonedGraceSeconds,
            onTimeout: { for pending in started.withLock({ $0 }) { pending.task.cancel() } }
        ) { [self] in
            let failed = await runTeardown(teardown, scope, expectation)
            for pending in started.withLock({ $0 }) { _ = await pending.task.value }
            return Box(failed)
        }
        if let finished { return finished.value }
        return .fail("teardown did not finish within \(Int(Self.teardownTimeoutSeconds * 1000))ms")
    }

    /// Wrapped: a clean teardown is nil, which a timeout must not be mistaken for.
    private struct Box: @unchecked Sendable {
        let value: StepResult?
        init(_ value: StepResult?) { self.value = value }
    }

    /// Runs the teardown steps, returning only a failure.
    private func runTeardown(_ steps: [Value], _ scope: Scope, _ expectation: Value) async -> StepResult? {
        if steps.isEmpty { return nil }
        // Teardown that asserts nothing is clean: `resume()` restores state and claims nothing.
        let result: StepResult?
        do {
            result = try await runSteps(steps, scope, expectation)
        } catch {
            result = failure(error)
        }
        guard let result, !result.passed else { return nil }
        return result
    }

    private func runSteps(_ steps: [Value], _ scope: Scope, _ expectation: Value) async throws -> StepResult? {
        var lastAssert: StepResult?
        for step in steps {
            guard let result = try await runStep(step, scope, expectation) else { continue }
            // The first failing check decides the test; a later passing one must not mask it.
            if !result.passed { return result }
            lastAssert = result
        }
        return lastAssert
    }

    private func runStep(_ step: Value, _ scope: Scope, _ expectation: Value) async throws -> StepResult? {
        let fields = step.fields
        guard fields.count == 1, let (op, body) = fields.first else {
            throw StepError("a step must carry exactly one operation, got \(fields.keys.sorted())")
        }
        switch op {
        case "useModel": return try await useModel(body, scope)
        case "modelSource": return try modelSource(body, scope)
        case "asset": return try asset(body, scope)
        case "call":
            scope.values[body["as"].string ?? "result"] = try await callValue(body, scope)
            return nil
        case "start": return await start(body, scope)
        case "settle": return try await settle(body, scope)
        case "callError": return try await callError(body, scope)
        case "repeat": return try await repeatSteps(body, scope, expectation)
        case "project": return try project(body, scope)
        case "assert": return try assert(body, scope, expectation)
        case "compare": return try compare(body, scope)
        default: throw StepError("step operation \"\(op)\" is not implemented by the Swift interpreter yet", incomplete: true)
        }
    }

    private func compare(_ body: Value, _ scope: Scope) throws -> StepResult {
        let named = jsString(body["named"])
        guard let comparison = Assertions.comparisons[named] else {
            throw StepError("named comparison \"\(named)\" is not in the Swift registry", incomplete: true)
        }
        return comparison(try resolve(body["left"], scope), try resolve(body["right"], scope), try resolve(body["with"].or([:]), scope))
    }

    private func callError(_ body: Value, _ scope: Scope) async throws -> StepResult? {
        let method = jsString(body["method"])
        let collect = body["collect"].string
        if calls.calls[method] == nil && collect == nil {
            throw StepError("SDK method \"\(method)\" is not wired into the Swift interpreter yet", incomplete: true)
        }
        let params = try callParams(body["params"], scope)
        log("callError \(method)")
        do {
            _ = try await invoke(method, params, collect)
        } catch {
            // A gap stays incomplete; any other refusal, client-side included, binds as in the JS interpreter.
            if let error = error as? StepError, error.incomplete { throw error }
            scope.values[jsString(body["as"])] = Wire.errorBinding(error)
            return nil
        }
        throw StepError("\(method) was expected to fail but resolved")
    }

    private func invoke(_ method: String, _ params: Value, _ collect: String?) async throws -> Value {
        if let collect {
            guard let fold = calls.streams[method] else {
                throw StepError("SDK method \"\(method)\" has no stream fold in the Swift interpreter yet", incomplete: true)
            }
            return try await fold(params, collect)
        }
        guard let call = calls.calls[method] else {
            throw StepError("SDK method \"\(method)\" is not wired into the Swift interpreter yet", incomplete: true)
        }
        return try await call(params)
    }

    private func repeatSteps(_ body: Value, _ scope: Scope, _ expectation: Value) async throws -> StepResult? {
        guard let items = try resolve(body["over"], scope).array else {
            throw StepError("repeat.over \"\(jsString(body["over"]))\" did not resolve to a list")
        }
        let steps = body["steps"].list
        var collected: [Value] = []
        for item in items {
            // A child scope per item so bindings cannot leak into the next iteration.
            let inner = scope.child(jsString(body["as"]), item)
            if let failure = try await runSteps(steps, inner, expectation), !failure.passed {
                throw StepError(failure.output.isEmpty ? "repeat iteration failed" : failure.output, incomplete: failure.incomplete)
            }
            collected.append(inner.values[Self.lastBinding(steps) ?? "result"] ?? .null)
        }
        scope.values[jsString(body["collectInto"])] = .array(collected)
        return nil
    }

    private func asset(_ body: Value, _ scope: Scope) throws -> StepResult? {
        let kind = jsString(try resolve(body["kind"], scope))
        let name = jsString(try resolve(body["file"], scope))
        let target = jsString(body["as"])
        if kind == "bytes" || kind == "tone" {
            if body["form"].string == "path" {
                throw StepError(kind == "tone" ? "a synthesized tone has no path" : "synthesized bytes have no path")
            }
            scope.values[target] = .bytes(kind == "tone" ? try Media.synthesizeTone(name) : try Media.synthesizeBytes(name))
            return nil
        }
        let absolute = try assetPath(kind, name)
        switch body["form"].string {
        case "path": scope.values[target] = .string(absolute.path)
        case "text": scope.values[target] = .string(try String(contentsOf: absolute, encoding: .utf8))
        default: scope.values[target] = .bytes(try Data(contentsOf: absolute))
        }
        return nil
    }

    /// A fixture of this kind, contained in its root: the name comes from shared data.
    func assetPath(_ kind: String, _ name: String) throws -> URL {
        guard let root = Self.assetRoots[kind] else {
            throw StepError("asset kind \"\(kind)\" is not known to the Swift client", incomplete: true)
        }
        let base = assetRoot.appendingPathComponent(root).standardizedFileURL
        let absolute = base.appendingPathComponent(name).standardizedFileURL
        if absolute.path != base.path && !absolute.path.hasPrefix(base.path + "/") {
            throw StepError("asset \"\(name)\" resolves outside the \"\(kind)\" asset root")
        }
        // A missing fixture fails the test outright.
        if !FileManager.default.fileExists(atPath: absolute.path) { throw StepError("asset not found: \(absolute.path)") }
        return absolute
    }

    private func modelSource(_ body: Value, _ scope: Scope) throws -> StepResult? {
        scope.values[jsString(body["as"])] = try resources.sourceOf(jsString(try resolve(body["dep"], scope)))
        return nil
    }

    private func useModel(_ body: Value, _ scope: Scope) async throws -> StepResult? {
        var modelIds: [String] = []
        for dep in body["deps"].list.map(jsString) { modelIds.append(try await resources.ensureLoaded(dep)) }
        if let target = body["as"].string {
            scope.values[target] = modelIds.count == 1 ? .string(modelIds[0]) : Value(modelIds)
        }
        // The first declared model is addressable as $model.
        if let first = modelIds.first, scope.values["model"] == nil { scope.values["model"] = .string(first) }
        return nil
    }

    private func callValue(_ body: Value, _ scope: Scope) async throws -> Value {
        let method = jsString(body["method"])
        // Not an SDK call: reload tests evict through the resource manager so it can reload the model.
        if method == "evictResource" {
            await resources.evict(jsString(try callParams(body["params"], scope)["dep"]))
            return ["evicted": true]
        }
        if method == "close" {
            resources.forgetLoaded()
            try await restartWorker()
            return .null
        }
        if Self.scratch.contains(method) { return try calls.scratch(method, try callParams(body["params"], scope)) }
        let collect = body["collect"].string
        if calls.calls[method] == nil && collect == nil {
            throw StepError("SDK method \"\(method)\" is not wired into the Swift interpreter yet", incomplete: true)
        }
        let params = try callParams(body["params"], scope)
        log("call \(method)")
        return try await invoke(method, params, collect)
    }

    private func start(_ body: Value, _ scope: Scope) async -> StepResult? {
        log("start \(jsString(body["method"]))")
        let snapshot = scope.snapshot()
        let task = Task { [self] () -> Result<Value, Error> in
            do {
                return .success(try await callValue(body, snapshot))
            } catch {
                return .failure(error)
            }
        }
        let pending = Pending(task)
        scope.values[jsString(body["as"])] = .handle(pending)
        scope.started.withLock { $0.append(pending) }
        // Long enough for the request to leave before the next step runs.
        await sleep(milliseconds: Self.startOnWireMs)
        return nil
    }

    /// Waits for a call begun by `start`, re-raising its rejection here.
    private func settle(_ body: Value, _ scope: Scope) async throws -> StepResult? {
        guard case .handle(let object) = try resolve(body["of"], scope), let handle = object as? Pending else {
            throw StepError("settle: \"\(jsString(body["of"]))\" is not a started call")
        }
        let outcome: Result<Value, Error>
        if let withinMs = body["withinMs"].number {
            // A missed deadline fails the step, but the call is still drained at the end of the run.
            let task = handle.task
            guard let settled = try await withTimeout(withinMs / 1000, { await task.value }) else {
                throw StepError("\(jsString(body["of"])) did not settle within \(jsNumber(withinMs))ms")
            }
            outcome = settled
        } else {
            outcome = await handle.task.value
        }
        let target = body["as"].string ?? "result"
        if body["expect"].string == "reject" {
            guard case .failure(let error) = outcome else {
                throw StepError("\(jsString(body["of"])) was expected to fail but resolved")
            }
            if let error = error as? StepError, error.incomplete { throw error }
            scope.values[target] = Wire.errorBinding(error)
            return nil
        }
        scope.values[target] = try outcome.get()
        return nil
    }

    private func project(_ body: Value, _ scope: Scope) throws -> StepResult? {
        var value = try Self.walk(try resolve(body["from"], scope), jsString(body["path"]))
        if !body["join"].isNil, let items = value.array { value = .string(items.map(jsString).joined(separator: jsString(body["join"]))) }
        if body["count"].isTrue {
            switch value {
            case .array, .bytes: value = Value(value.dataLength)
            default: throw StepError("project count: \"\(jsString(body["path"]))\" is not a list")
            }
        }
        scope.values[jsString(body["as"])] = value
        return nil
    }

    private func assert(_ body: Value, _ scope: Scope, _ expectation: Value) throws -> StepResult {
        let value = try resolve(body["on"], scope)
        var result: StepResult
        if let named = body["named"].string {
            guard let assertion = Assertions.named[named] else {
                throw StepError("named assertion \"\(named)\" is not in the Swift registry yet", incomplete: true)
            }
            result = assertion(value, try resolve(body["with"].or([:]), scope))
        } else {
            result = Validation.validate(value, expectation)
        }
        // An optional reference that resolved to nothing is not a value the assertion ran against.
        if !value.isMissing { result.assertedValue = value }
        return result
    }

    /// Resolve a call's parameters, dropping the ones that resolved to nothing.
    private func callParams(_ params: Value, _ scope: Scope) throws -> Value {
        .object(try resolve(params.or([:]), scope).fields.filter { !$0.value.isMissing })
    }

    /// Replace `$name` / `$params.x` references, recursively.
    private func resolve(_ value: Value, _ scope: Scope) throws -> Value {
        switch value {
        case .string(let text) where text.hasPrefix("$"):
            if text.hasSuffix("?") {
                return (try? Self.walk(.object(scope.values), String(text.dropFirst().dropLast()))) ?? .missing
            }
            return try Self.walk(.object(scope.values), String(text.dropFirst()))
        case .object(let object): return .object(try object.mapValues { try resolve($0, scope) })
        case .array(let items): return .array(try items.map { try resolve($0, scope) })
        default: return value
        }
    }

    /// Asset family -> directory.
    static let assetRoots = ["image": "images", "audio": "audio", "document": "documents", "neural": "neural"]

    private static let scratch: Set<String> = ["scratchDirectory", "producedFile", "discardScratchDirectory"]
    private static let startOnWireMs = 50.0

    /// Matches DEFAULT_TEARDOWN_TIMEOUT_MS in consumer-base.ts.
    private static let teardownTimeoutSeconds = 120.0
    private static let abandonedGraceSeconds = 30.0

    /// Name the last value a nested step list bound, for `repeat.collectInto`.
    static func lastBinding(_ steps: [Value]) -> String? {
        for step in steps.reversed() {
            guard let (op, body) = step.fields.first else { continue }
            switch op {
            case "project", "asset", "modelSource": return body["as"].string
            case "call", "settle": return body["as"].string ?? "result"
            default: continue
            }
        }
        return nil
    }

    /// Resolve a dotted path with optional `[i]` indexes and a `[*]` fan-out.
    static func walk(_ source: Value, _ path: String) throws -> Value {
        var current = source
        let segments = path.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        for (position, rawSegment) in segments.enumerated() {
            if rawSegment.hasSuffix("[*]") {
                let name = String(rawSegment.dropLast(3))
                if !name.isEmpty { current = try stepInto(current, name, path) }
                guard let list = current.array else {
                    throw StepError("path \"\(path)\" used [*] on a \(current.isNil ? "null" : jsType(current))")
                }
                let rest = segments.dropFirst(position + 1).joined(separator: ".")
                return rest.isEmpty ? current : .array(try list.map { try walk($0, rest) })
            }
            var segment = rawSegment
            var index: Int?
            if rawSegment.hasSuffix("]"), let open = rawSegment.lastIndex(of: "["),
                let parsed = Int(rawSegment[rawSegment.index(after: open)..<rawSegment.index(before: rawSegment.endIndex)]), parsed >= 0
            {
                segment = String(rawSegment[..<open])
                index = parsed
            }
            if !segment.isEmpty { current = try stepInto(current, segment, path) }
            // Out of range reads as nothing, the way a JS index does.
            if let index {
                switch current {
                case .array(let items): current = index < items.count ? items[index] : .null
                case .bytes(let data): current = index < data.count ? Value(Int(data[data.startIndex + index])) : .null
                default: throw StepError("path \"\(path)\" has no index \(index)")
                }
            }
        }
        return current
    }

    private static func stepInto(_ current: Value, _ segment: String, _ path: String) throws -> Value {
        if case .null = current { throw StepError("path \"\(path)\" walked off a null at \"\(segment)\"") }
        if let object = current.object {
            guard let value = object[segment] else { throw StepError("path \"\(path)\" has no \"\(segment)\"") }
            return value
        }
        if segment == "length" {
            switch current {
            case .array(let items): return Value(items.count)
            case .bytes(let data): return Value(data.count)
            case .string(let text): return Value(text.utf16.count)
            default: break
            }
        }
        throw StepError("path \"\(path)\" has no \"\(segment)\"")
    }
}
