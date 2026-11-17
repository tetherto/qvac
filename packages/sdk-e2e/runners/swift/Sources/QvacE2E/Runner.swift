import Foundation
import QvacSDK

/// Runs catalog definitions against a worker: the part every Swift client shares.
public final class Runner: @unchecked Sendable {
    public struct Settings: Sendable {
        /// The resource table's name for this host; see catalog/resource-table-types.ts.
        public var resourcePlatform: String
        /// catalog/resources/resource-table.json.
        public var resourceTable: Value
        /// catalog/resources/platform-policy.json.
        public var platformPolicy: Value
        /// The fixtures: `<root>/images`, `<root>/audio`, ...
        public var assetRoot: URL
        /// Where `scratchDirectory` makes its directories.
        public var scratchRoot: URL

        public init(resourcePlatform: String, resourceTable: Value, platformPolicy: Value, assetRoot: URL, scratchRoot: URL) {
            self.resourcePlatform = resourcePlatform
            self.resourceTable = resourceTable
            self.platformPolicy = platformPolicy
            self.assetRoot = assetRoot
            self.scratchRoot = scratchRoot
        }
    }

    private struct Host: HostResolvers {
        let assetRoot: URL

        func asset(kind: String, file: String) -> String {
            assetRoot.appendingPathComponent(Interpreter.assetRoots[kind] ?? kind).appendingPathComponent(file).path
        }
    }

    public let worker: Worker
    public let resources: Resources
    private let calls: Calls
    private let interpreter: Interpreter

    /// Starts the worker with `start`, which `close` steps call again for a new one.
    public static func start(
        settings: Settings, log: @escaping @Sendable (String) -> Void, start: @escaping @Sendable () async throws -> QvacClient
    ) async throws -> Runner {
        try Runner(settings: settings, log: log, worker: await Worker.start(start))
    }

    private init(settings: Settings, log: @escaping @Sendable (String) -> Void, worker: Worker) throws {
        // Policy is keyed by app family, the first segment of the platform (policyFor in platform-policy.ts).
        let family = String(settings.resourcePlatform.split(separator: "-").first ?? "")
        let policy = settings.platformPolicy[family]
        guard let unloadSettleMs = policy["unloadSettleMs"].number else {
            throw StepError("no platform policy for \"\(settings.resourcePlatform)\" in platform-policy.json")
        }
        self.worker = worker
        self.resources = Resources(
            worker: worker, table: settings.resourceTable, platform: settings.resourcePlatform,
            host: Host(assetRoot: settings.assetRoot), log: log, unloadSettleMs: unloadSettleMs,
            singleUseResources: policy["singleUseResources"].list.map(jsString))
        self.calls = Calls(wire: Wire(worker: worker), resources: resources, scratchRoot: settings.scratchRoot)
        self.interpreter = Interpreter(
            resources: resources, calls: calls, assetRoot: settings.assetRoot, log: log,
            restartWorker: { try await worker.restart() })
    }

    /// Downloads every model the tests declare, or the whole table without a filter, before the
    /// first test: a model download over a phone's network does not fit in one test's time.
    public func bootstrap(_ tests: [Value]?, log: @escaping @Sendable (String) -> Void) async throws {
        // As runners/js/shared/collect-test-deps.ts: declared deps, or every key without a filter.
        let deps = tests.map { Set($0.flatMap(Self.declaredDeps)) } ?? Set(resources.keys)
        let constants = resources.constantsFor(deps)
        log("📥 Pre-downloading \(constants.count) unique model constant(s) for \(deps.count) resource key(s)...")
        let wire = Wire(worker: worker)
        let done = Locked(0)
        try await withThrowingTaskGroup(of: Void.self) { group in
            var next = constants.makeIterator()
            func launch() {
                guard let constant = next.next() else { return }
                group.addTask {
                    try await Self.download(wire, constant, log: log)
                    let count = done.withLock { $0 += 1; return $0 }
                    log("   [\(count)/\(constants.count)] \(constant.name)")
                }
            }
            for _ in 0..<Self.downloadConcurrency { launch() }
            while try await group.next() != nil { launch() }
        }
        log("📦 All \(constants.count) constant(s) pre-cached")
    }

    /// One model into the cache, retried: a registry download over a phone's network is flaky.
    private static func download(_ wire: Wire, _ constant: ModelConstant, log: @Sendable (String) -> Void) async throws {
        var attempt = 1
        while true {
            do {
                let response = try await wire.send([
                    "type": "downloadAsset", "assetSrc": .string(constant.src), "withProgress": false, "seed": false,
                    "requestId": .string(Wire.requestId()),
                ])
                try Wire.requireSuccess(response, "DOWNLOAD_ASSET_FAILED")
                return
            } catch {
                if attempt >= downloadAttempts {
                    throw StepError("pre-download of \(constant.name) failed: \(Wire.message(of: error))")
                }
                log("   ⚠️  \(constant.name) attempt \(attempt) failed (\(Wire.message(of: error))); retrying")
                await sleep(milliseconds: downloadRetryDelayMs * Double(attempt))
                attempt += 1
            }
        }
    }

    private static func declaredDeps(_ test: Value) -> [String] {
        let metadata = test["metadata"]
        let single = metadata["dependency"].string.flatMap { $0 == "none" ? nil : $0.split(separator: "+").map(String.init) } ?? []
        let multi = metadata["dependencies"].list.map(jsString)
        return (single + multi).filter { !$0.isEmpty && $0 != "none" }
    }

    /// DEFAULT_DOWNLOAD_CONCURRENCY.mobile in runners/js/shared/bootstrap-downloads.ts.
    private static let downloadConcurrency = 4
    private static let downloadAttempts = 3
    private static let downloadRetryDelayMs = 5000.0

    /// Runs one definition: its `steps`, then its `finally`.
    public func execute(_ definition: Value) async -> StepResult {
        let steps = definition["steps"].list
        if steps.isEmpty {
            // A test without a declarative body is written per client; this one has none of those.
            return .incomplete("\(jsString(definition["testId"])) carries no steps and this client has no body for it")
        }
        let result = await interpreter.run(
            steps: steps, params: definition["params"], expectation: definition["expectation"],
            teardown: definition["finally"].list)
        await resources.evictSingleUse()
        return result
    }

    public func close() async {
        await resources.close()
        calls.close()
        _ = try? await withTimeout(Self.clientCloseTimeoutSeconds) { [worker] in
            await worker.close()
            return true
        }
    }

    private static let clientCloseTimeoutSeconds = 10.0
}
