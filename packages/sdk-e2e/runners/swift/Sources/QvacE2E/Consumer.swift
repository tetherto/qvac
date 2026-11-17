import Foundation

/// The run an app consumer joins: baked into the app at build time (`E2E/consumer-config.json`,
/// from MQTT_* and E2E_RUN_ID) and overridable by the launch environment, which carries the names
/// the framework gives an mqtt-mode client.
public struct ConsumerConfig: Sendable {
    public var runId: String
    public var platform: String
    public var mqtt: MqttSettings

    public static func resolve(baked: Value, environment: [String: String]) throws -> ConsumerConfig {
        func env(_ key: String) -> String? { environment[key].flatMap { $0.isEmpty ? nil : $0 } }
        let mqtt = baked["mqtt"]
        let bakedUrl =
            "\(jsString(mqtt["protocol"].or("ws")))://\(jsString(mqtt["host"].or("localhost"))):\(jsString(mqtt["port"].or(8080)))\(jsString(mqtt["path"].or("/mqtt")))"
        let expiry =
            env("QVAC_MQTT_SESSION_EXPIRY").flatMap(UInt32.init).flatMap { $0 > 0 ? $0 : nil }
            ?? mqtt["sessionExpiryInterval"].int.flatMap { UInt32(exactly: $0) }
        let url = env("QVAC_MQTT_BROKER_URL") ?? bakedUrl
        guard let parsed = URL(string: url), parsed.scheme != nil, parsed.host != nil else {
            throw MqttError("invalid broker URL")
        }
        return ConsumerConfig(
            runId: env("QVAC_RUN_ID") ?? baked["runId"].string ?? "*",
            platform: env("QVAC_TEST_PLATFORM") ?? baked["platform"].string ?? "swift-ios",
            mqtt: MqttSettings(
                url: url,
                username: env("QVAC_MQTT_USERNAME") ?? mqtt["username"].string,
                password: env("QVAC_MQTT_PASSWORD") ?? mqtt["password"].string,
                ca: mqtt["ca"].string,
                rejectUnauthorized: mqtt["rejectUnauthorized"].bool != false,
                sessionExpiryInterval: expiry.flatMap { $0 > 0 ? $0 : nil }
            )
        )
    }
}

/// Platform policy as the framework applies it (consumer-base.ts `getTestSkipReason`).
public enum Platforms {
    private static let operatingSystems: Set<String> = ["macos", "linux", "windows", "ios", "android"]

    /// Matching is by segment prefix, and a coarse entry widens over the OS and nothing else:
    /// `mobile` covers `mobile-ios`, but `swift` does not cover some other Swift client.
    public static func matches(_ declared: [Value], _ platform: String) -> Bool {
        let segments = platform.split(separator: "-").map(String.init)
        return declared.contains { raw in
            let entry = jsString(raw)
            if entry == platform { return true }
            let entrySegments = entry.split(separator: "-").map(String.init)
            return entrySegments.count < segments.count
                && entrySegments.indices.allSatisfy { entrySegments[$0] == segments[$0] }
                && segments.dropFirst(entrySegments.count).allSatisfy(operatingSystems.contains)
        }
    }

    public static func skipReason(_ definition: Value, _ platform: String) -> String? {
        let skip = definition["skip"]
        let platforms = skip["platforms"].list
        if platforms.isEmpty || !matches(platforms, platform) { return nil }
        let own = skip["reasons"].list.filter { matches($0["platforms"].list, platform) }.map { jsString($0["reason"]) }
        return own.isEmpty ? (skip["reason"].isNil ? nil : jsString(skip["reason"])) : own.joined(separator: " | ")
    }
}

/// The batch consumer protocol, ported from packages/test-suite/src/core/consumer-base.ts through
/// the Kotlin client. Log lines match the JS consumer's: the device test spec reads progress by them.
public final class Consumer: @unchecked Sendable {
    private let config: ConsumerConfig
    private let consumerId: String
    private let definitions: [String: Value]
    private let log: @Sendable (String) -> Void
    private let start: @Sendable () async throws -> Runner
    private let link: MqttLink
    private let inbox: AsyncStream<(String, Data)>
    private let deliver: AsyncStream<(String, Data)>.Continuation
    private let state = Locked(State())
    private let finished = Promise<Void>()

    private struct State {
        var registered = false
        var bootstrapped = false
        var shutdownRequested = false
        var processingTest = false
        var shutdownStarted = false
        var totalTests = 0
        var testsCompleted = 0
        var testsRetried = 0
        var testsRetriedPassed = 0
        var runner: Runner?
        var finalProfiling: Task<Void, Never>?
        var heartbeat: Task<Void, Never>?
        var memorySampler: Task<Void, Never>?
        var registration: Task<Void, Never>?
    }

    private var isWildcard: Bool { config.runId == "*" }

    /// The runtime starts in bootstrap, after registration, as the JS mobile consumer's worker does:
    /// worker startup does not have to fit in the producer's registration window.
    public init(config: ConsumerConfig, definitions: [Value], log: @escaping @Sendable (String) -> Void, start: @escaping @Sendable () async throws -> Runner) {
        self.config = config
        let device = Self.deviceName()
        self.consumerId = "consumer-\(config.platform)-\(device)-\(config.runId == "*" ? String(Int(Date().timeIntervalSince1970 * 1000)) : config.runId)"
        var byId: [String: Value] = [:]
        for definition in definitions { byId[jsString(definition["testId"])] = definition }
        self.definitions = byId
        self.log = log
        self.start = start
        self.link = MqttLink(settings: config.mqtt, clientId: consumerId)
        (inbox, deliver) = AsyncStream<(String, Data)>.makeStream()
    }

    private static func deviceName() -> String {
        var size = 0
        sysctlbyname("hw.machine", nil, &size, nil, 0)
        var value = [CChar](repeating: 0, count: max(size, 1))
        sysctlbyname("hw.machine", &value, &size, nil, 0)
        return String(cString: value).map { $0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" ? String($0) : "_" }.joined()
    }

    /// Runs until the batch completes or the consumer stops.
    public func run() async {
        log("🔧 Initializing consumer...")
        log("📱 Device: \(Self.deviceName()) | Run ID: \(config.runId) | Platform: \(config.platform)")
        // Scheme and port only: in CI the host is a secret.
        if let url = URL(string: config.mqtt.url) {
            log("📡 Connecting to \(url.scheme ?? "?")://…:\(url.port.map(String.init) ?? "?")")
        }
        log("📚 \(definitions.count) test definitions bundled")
        let inbox = inbox
        Task {
            for await (topic, payload) in inbox {
                do {
                    let message = try Value.parse(payload)
                    if !isWildcard && message["runId"].string != config.runId { continue }
                    switch topic {
                    case "qvac/register-ack/\(consumerId)": await handleRegistrationAck(message)
                    case "qvac/batch-complete": await handleBatchComplete(message)
                    default: break
                    }
                } catch {
                    log("❌ Error handling \(topic): \(error)")
                }
            }
        }
        let deliver = deliver
        link.connect(
            MqttLink.Listener(
                connected: { [self] _ in connected() },
                message: { topic, payload in deliver.yield((topic, payload)) },
                lost: { [self] reason in
                    if !state.withLock({ $0.shutdownStarted }) { log("📴 Consumer offline: \(reason)") }
                }
            ))
        try? await finished.value()
    }

    private func connected() {
        if state.withLock({ $0.registered }) {
            log("✅ Reconnected to MQTT broker")
            return
        }
        log("✅ Connected to MQTT broker")
        log("🔑 Run ID: \(config.runId)\(isWildcard ? " (wildcard mode)" : "")")
        link.subscribe(["qvac/register-ack/\(consumerId)", "qvac/batch-complete"]) { [self] error in
            if let error {
                log("❌ Failed to subscribe: \(error)")
                return
            }
            log("📡 Subscribed to topics\n")
            let registration = Task {
                self.sendRegistration()
                while !Task.isCancelled && !self.state.withLock({ $0.registered }) {
                    await sleep(milliseconds: Self.registrationRetryMs)
                    if !self.state.withLock({ $0.registered }) && !Task.isCancelled {
                        self.log("🔄 Re-sending registration...")
                        self.sendRegistration()
                    }
                }
            }
            state.withLock {
                $0.registration?.cancel()
                $0.registration = registration
            }
        }
    }

    private static func now() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date())
    }

    private static func millis() -> Double { (Date().timeIntervalSince1970 * 1000).rounded(.down) }

    private func publish(_ topic: String, _ payload: Value, qos: UInt8 = 1, done: MqttLink.Done? = nil) {
        let data: Data
        do {
            data = try payload.encoded()
        } catch {
            log("⚠️  Failed to encode \(topic): \(error)")
            done?(error)
            return
        }
        link.publish(topic, data, qos: qos) { [self] error in
            if let done { return done(error) }
            if let error, !state.withLock({ $0.shutdownStarted }) { log("⚠️  Failed to publish \(topic): \(error)") }
        }
    }

    private func base() -> [String: Value] {
        ["runId": .string(config.runId), "consumerId": .string(consumerId), "timestamp": .string(Self.now())]
    }

    /// What the JS consumer does after a reload or retry times out: the worker may be wedged.
    private func stopAfterTimeout(_ phase: String) {
        state.withLock { $0.shutdownRequested = true }
        log("   ⚠️  consumer will stop after \(phase) timeout")
    }

    private func sendRegistration() {
        publish("qvac/register", .object(base().merging(["platform": .string(config.platform)]) { $1 }))
    }

    private func handleRegistrationAck(_ message: Value) async {
        guard let queue = message["queue"].array, let ackedTotal = message["totalTests"].int else {
            log("⚠️  Invalid register-ack payload: \(message.fields.keys.sorted())")
            return
        }
        let first = state.withLock { state -> Bool in
            state.totalTests = max(state.totalTests, ackedTotal)
            // Only the first acknowledgment bootstraps.
            if state.registered { return false }
            state.registered = true
            return true
        }
        if !first { return }
        log("🔌 Registration ack - \(state.withLock { $0.totalTests }) tests in queue\n")
        startHeartbeat()
        startMemorySampler()

        var filtered: [Value]?
        if let ids = message["filteredTestIds"].array {
            var unresolved = 0
            var skipped = 0
            filtered = ids.compactMap { id in
                guard let definition = definitions[jsString(id)] else {
                    unresolved += 1
                    return nil
                }
                if Platforms.skipReason(definition, config.platform) != nil {
                    skipped += 1
                    return nil
                }
                return definition
            }
            if unresolved > 0 { log("⚠️  Producer sent \(ids.count) testId(s); \(unresolved) don't resolve against local definitions") }
            if skipped > 0 { log("⏭️  Dropping bootstrap deps for \(skipped) test(s) marked as skipped on platform '\(config.platform)'") }
        }
        log("🔧 Running bootstrap...")
        let started = Date()
        do {
            let runner = try await start()
            state.withLock { $0.runner = runner }
            try await runner.bootstrap(filtered, log: log)
            state.withLock { $0.bootstrapped = true }
            log("🔧 Bootstrap completed in \(Int(Date().timeIntervalSince(started) * 1000))ms\n")
        } catch {
            log("❌ Bootstrap failed: \(error)")
            await shutdown()
            return
        }

        if queue.isEmpty {
            publish("qvac/queue-empty", .object(base()))
            log("📭 No more tests in queue - waiting for batch-complete")
            return
        }
        Task { [self] in await executeQueue(queue) }
    }

    private func executeQueue(_ queue: [Value]) async {
        for (index, item) in queue.enumerated() {
            let stop = state.withLock { state -> Bool in
                state.processingTest = true
                return state.shutdownRequested
            }
            if !stop {
                let testId = jsString(item["testId"])
                let uniqueTestId = jsString(item["uniqueTestId"])
                if let definition = definitions[testId] {
                    await executeTest(uniqueTestId, definition)
                } else {
                    publishTestPrepare(uniqueTestId)
                    log("❌ No local test definition for: \(testId)")
                    publishResult(testId, uniqueTestId, "failure", 0, "No local test definition for: \(testId)")
                }
            }
            let shuttingDown = state.withLock { state -> Bool in
                state.processingTest = false
                return state.shutdownRequested
            }
            if shuttingDown {
                await finalize()
                return
            }
            if index < queue.count - 1 { await sleep(milliseconds: Self.interTestDelayMs) }
        }
        log("📭 No more tests in queue - waiting for batch-complete")
    }

    private func publishTestPrepare(_ uniqueTestId: String) {
        publish("qvac/test-prepare", .object(base().merging(["uniqueTestId": .string(uniqueTestId)]) { $1 }))
    }

    private func publishResult(
        _ testId: String, _ uniqueTestId: String, _ outcome: String, _ duration: Double, _ error: String?, _ extra: [String: Value] = [:]
    ) {
        var payload = base()
        payload["testId"] = .string(testId)
        payload["uniqueTestId"] = .string(uniqueTestId)
        payload["outcome"] = .string(outcome)
        payload["duration"] = .number(duration)
        if let error { payload["error"] = .string(error) }
        payload.merge(extra) { $1 }
        publish("qvac/results", .object(payload))
    }

    private func handleBatchComplete(_ message: Value) async {
        log("\n🎉 Batch complete!")
        log("📊 Total: \(jsString(message["totalTests"].or(0)))")
        log("✅ Passed: \(jsString(message["successCount"].or(0)))")
        log("❌ Failed: \(jsString(message["failureCount"].or(0)))")
        let (retried, retriedPassed) = state.withLock { ($0.testsRetried, $0.testsRetriedPassed) }
        if retried > 0 {
            var parts: [String] = []
            if retriedPassed > 0 { parts.append("✅ passed: \(retriedPassed)") }
            if retried - retriedPassed > 0 { parts.append("❌ failed: \(retried - retriedPassed)") }
            log("🔄 Retried: \(retried) (\(parts.joined(separator: ", ")))")
        }
        log("⏱️  Duration: \(String(format: "%.2f", locale: Locale(identifier: "en_US_POSIX"), (message["duration"].number ?? 0) / 1000))s")
        let busy = state.withLock { state -> Bool in
            state.shutdownRequested = true
            return state.processingTest
        }
        if busy {
            log("⏳ Waiting for in-progress test to complete before finalizing...")
            return
        }
        await finalize()
    }

    private func executeTest(_ uniqueTestId: String, _ definition: Value) async {
        publishTestPrepare(uniqueTestId)
        let testId = jsString(definition["testId"])
        let (completed, total) = state.withLock { ($0.testsCompleted, $0.totalTests) }
        log("▶️  \(total > 0 ? "[\(completed + 1)/\(total)]" : "") \(testId)")

        if let reason = Platforms.skipReason(definition, config.platform) {
            log("⏭️  \(testId): \(reason)")
            state.withLock { $0.testsCompleted += 1 }
            publishResult(testId, uniqueTestId, "skipped", 0, reason)
            return
        }
        guard let runner = state.withLock({ $0.runner }) else {
            let message = "the runner is not started"
            log("❌ \(testId) failed: \(message)")
            state.withLock { $0.testsCompleted += 1 }
            publishResult(testId, uniqueTestId, "failure", 0, message)
            return
        }

        publish("qvac/test-start", .object(base().merging(["uniqueTestId": .string(uniqueTestId)]) { $1 }))
        let startTime = Self.millis()
        let estimated = definition["metadata"]["estimatedDurationMs"].number ?? 0
        let timeoutMs = max(estimated * 2, Self.minTestTimeoutMs)
        let retryOnFailure = definition["retryOnFailure"].isTrue
        let timeoutMessage = "Test timeout after \(Int(timeoutMs / 1000))s"
        // A timed-out attempt is cancelled and given a bounded wait to clean up before the next one.
        func bounded<T: Sendable>(_ operation: @escaping @Sendable () async -> T) async -> T? {
            try? await withTimeout(timeoutMs / 1000, grace: Self.abandonedGraceMs / 1000, operation)
        }

        let attempt = await bounded { await runner.execute(definition) }
        let result: StepResult
        if let attempt {
            result = attempt
        } else if retryOnFailure {
            result = .fail(timeoutMessage)
        } else {
            log("❌ \(testId) failed: \(timeoutMessage)")
            state.withLock { $0.testsCompleted += 1 }
            publishResult(testId, uniqueTestId, "failure", Self.millis() - startTime, timeoutMessage)
            return
        }

        var retried = false
        var retryPassed: Bool?
        var retryOutput: String?
        var attempt1DurationMs: Double?
        if !result.passed && !result.incomplete && retryOnFailure {
            retried = true
            log("   ❌ attempt 1:")
            for line in result.output.split(separator: "\n", omittingEmptySubsequences: false) { log("      \(line)") }
            log("   ┄┄ reload + retry ┄┄")
            let reloadBoundary = Self.millis()
            attempt1DurationMs = reloadBoundary - startTime
            publish(
                "qvac/test-reload",
                [
                    "runId": .string(config.runId), "consumerId": .string(consumerId), "uniqueTestId": .string(uniqueTestId),
                    "testId": .string(testId), "ts": .number(reloadBoundary),
                ])
            let reloadStart = Self.millis()
            if await bounded({ await runner.resources.close(); return true }) == nil {
                stopAfterTimeout("reload")
                log("   ⚠️  reload failed: timed out")
                retryPassed = false
                retryOutput = "reload failed: timed out"
            } else {
                log("   reload: \(Int(Self.millis() - reloadStart))ms")
            }
            if retryOutput == nil {
                if let retry = await bounded({ await runner.execute(definition) }) {
                    retryPassed = retry.passed
                    retryOutput = retry.output
                    if retry.passed {
                        log("   ✅ attempt 2: PASSED")
                    } else {
                        log("   ❌ attempt 2: FAILED")
                        for line in retry.output.split(separator: "\n", omittingEmptySubsequences: false) { log("      \(line)") }
                    }
                } else {
                    retryPassed = false
                    retryOutput = "retry threw: \(timeoutMessage)"
                    log("   ❌ attempt 2 threw: \(retryOutput!)")
                    stopAfterTimeout("retry")
                }
            }
            state.withLock {
                $0.testsRetried += 1
                if retryPassed == true { $0.testsRetriedPassed += 1 }
            }
        }

        let duration = Self.millis() - startTime
        let outcome = result.incomplete ? "incomplete" : result.passed ? "success" : "failure"
        if result.incomplete {
            log("🚧 \(testId): \(result.reason ?? result.output)")
        } else if retried {
            log("⚠️  \(testId) (\(Int(duration))ms) [retry:\(retryPassed == true ? "✅ passed" : "❌ failed")]")
        } else {
            log("\(outcome == "success" ? "✅" : "❌") \(testId) (\(Int(duration))ms)")
            if !result.passed && !result.output.isEmpty {
                for line in result.output.split(separator: "\n", omittingEmptySubsequences: false) { log("   \(line)") }
            }
        }
        state.withLock { $0.testsCompleted += 1 }

        var extra: [String: Value] = [:]
        if result.incomplete { extra["incompleteReason"] = .string(result.reason ?? result.output) }
        if let asserted = result.assertedValue { extra["assertedValue"] = summarise(asserted) }
        if retried {
            extra["retried"] = true
            extra["retryPassed"] = retryPassed.map(Value.bool) ?? .null
            extra["retryOutput"] = Value(retryOutput)
            extra["attempt1DurationMs"] = attempt1DurationMs.map(Value.number) ?? .null
        }
        publishResult(testId, uniqueTestId, outcome, result.incomplete ? 0 : duration, result.passed && !result.incomplete ? nil : result.output, extra)
    }

    private func startHeartbeat() {
        let heartbeat = Task { [self] in
            while !Task.isCancelled {
                await sleep(milliseconds: Self.heartbeatMs)
                let (stopping, bootstrapped) = state.withLock { ($0.shutdownRequested, $0.bootstrapped) }
                if !stopping && !Task.isCancelled {
                    publish("qvac/heartbeat", .object(base().merging(["bootstrapped": .bool(bootstrapped)]) { $1 }), qos: 0)
                }
            }
        }
        state.withLock { $0.heartbeat = heartbeat }
    }

    /// Publishes the app's memory on `qvac/app-memory` for the producer's per-test chart, as the JS
    /// mobile consumer does.
    private func startMemorySampler() {
        let pid = Double(getpid())
        let sampler = Task { [self] in
            while !Task.isCancelled {
                if let sample = MemorySample.now(), !state.withLock({ $0.shutdownRequested }) {
                    let ts = Value.number(Self.millis())
                    for record in sample.records {
                        publish("qvac/app-memory", [
                            "runId": .string(config.runId), "consumerId": .string(consumerId), "ts": ts,
                            "pid": .number(pid), "memoryKb": .number(record.value), "metric": .string(record.metric),
                            "unit": .string(record.unit), "platform": .string(config.platform),
                        ], qos: 0)
                    }
                }
                await sleep(milliseconds: Self.memorySampleMs)
            }
        }
        state.withLock { $0.memorySampler = sampler }
    }

    /// Every caller waits for the one final profiling publish before shutting down, so a second
    /// caller cannot close the link under the first one's publish.
    private func finalize() async {
        let profiling = state.withLock { state -> Task<Void, Never> in
            if let task = state.finalProfiling { return task }
            let task = Task { await self.publishFinalProfiling() }
            state.finalProfiling = task
            return task
        }
        await profiling.value
        await shutdown()
    }

    private func publishFinalProfiling() async {
        // No profiler here, but the producer waits for a final export: send an empty one.
        let published = Promise<Void>()
        var payload = base()
        payload["kind"] = "final"
        payload["sequence"] = 1
        payload["profilerExport"] = [
            "config": [
                "enabled": false, "mode": "summary", "includeServerBreakdown": false, "operationFilters": [], "maxRecentEvents": 0,
            ],
            "aggregates": [:],
            "exportedAt": .number(Self.millis()),
        ]
        publish("qvac/profiling", .object(payload)) { [self] error in
            if let error { log("⚠️  Failed to publish profiling data: \(error)") } else { log("📈 Profiling data published") }
            published.complete(.success(()))
        }
        _ = try? await withTimeout(Self.profilingPublishTimeoutMs / 1000) { try await published.value() }
    }

    public func shutdown() async {
        let first = state.withLock { state -> Bool in
            defer { state.shutdownStarted = true }
            return !state.shutdownStarted
        }
        guard first else { return }
        log("\n👋 Consumer shutting down...")
        let runner = state.withLock { state -> Runner? in
            state.heartbeat?.cancel()
            state.memorySampler?.cancel()
            state.registration?.cancel()
            return state.runner
        }
        if let runner {
            // A worker wedged enough to have stopped the run must not keep the broker session open.
            let closed = try? await withTimeout(Self.closeTimeoutMs / 1000) { await runner.close(); return true }
            if closed == nil { log("⚠️  onShutdown: closing the runner did not finish within \(Int(Self.closeTimeoutMs / 1000))s") }
        }
        await link.close()
        deliver.finish()
        finished.complete(.success(()))
    }

    private static let registrationRetryMs = 3000.0
    private static let heartbeatMs = 15000.0
    private static let memorySampleMs = 1000.0
    private static let interTestDelayMs = 100.0
    private static let minTestTimeoutMs = 120_000.0
    private static let profilingPublishTimeoutMs = 10_000.0
    private static let closeTimeoutMs = 90_000.0
    private static let abandonedGraceMs = 30_000.0
}
