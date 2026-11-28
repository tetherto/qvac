import Combine
import Foundation
import OSLog
import QvacE2E
import QvacSDK
import QvacWorker

/// One run of the consumer: the app carries the catalog, the resource table and the fixtures under
/// `E2E/`, and the run settings in `E2E/consumer-config.json`. The launch environment overrides the
/// settings, so a local run can retarget an installed app.
@MainActor
final class Session: ObservableObject {
    @Published private(set) var lines: [String] = []
    /// Lines ever shown, which keeps growing after the display cap drops old ones.
    @Published private(set) var shown = 0
    private var started = false

    /// The resource table's name for this host; see catalog/resource-table-types.ts.
    private static let resourcePlatform = "mobile-ios"
    private static let displayLimit = 500
    /// The device log truncates long entries; as the Kotlin client chunks for logcat.
    private nonisolated static let deviceLogChunk = 3000

    /// The device log, which the Device Farm test spec follows; stdout is what a simulator run reads.
    private nonisolated static let deviceLog = Logger(subsystem: "io.tether.qvac.e2e", category: "QvacE2E")

    nonisolated func log(_ message: String) {
        for line in message.split(separator: "\n", omittingEmptySubsequences: false) {
            print("QvacE2E: \(line)")
            var rest = Substring(line)
            repeat {
                let chunk = rest.prefix(Self.deviceLogChunk)
                rest = rest.dropFirst(chunk.count)
                Self.deviceLog.notice("\(String(chunk), privacy: .public)")
            } while !rest.isEmpty
        }
        // Main-actor tasks may run out of order, so each one shows whatever is pending, in logged order.
        pendingLock.lock()
        pending.append(message)
        pendingLock.unlock()
        Task { @MainActor in showPending() }
    }

    private nonisolated let pendingLock = NSLock()
    private nonisolated(unsafe) var pending: [String] = []

    private func showPending() {
        pendingLock.lock()
        let messages = pending
        pending = []
        pendingLock.unlock()
        if messages.isEmpty { return }
        lines.append(contentsOf: messages)
        shown += messages.count
        if lines.count > Self.displayLimit { lines.removeFirst(lines.count - Self.displayLimit) }
    }

    func run() async {
        if started { return }
        started = true
        let log: @Sendable (String) -> Void = { [weak self] in self?.log($0) }
        do {
            guard let root = Bundle.main.url(forResource: "E2E", withExtension: nil) else {
                throw StepError("the app does not carry its E2E resources")
            }
            let config = try ConsumerConfig.resolve(
                baked: try Self.json(root.appendingPathComponent("consumer-config.json")),
                environment: ProcessInfo.processInfo.environment)
            let definitions = try Self.json(root.appendingPathComponent("catalog/test-definitions.json")).list
            let workerConfig = try Self.json(root.appendingPathComponent("worker-config.json"))
            let settings = Runner.Settings(
                resourcePlatform: Self.resourcePlatform,
                resourceTable: try Self.json(root.appendingPathComponent("resources/resource-table.json")),
                platformPolicy: try Self.json(root.appendingPathComponent("resources/platform-policy.json")),
                assetRoot: root.appendingPathComponent("fixtures"),
                scratchRoot: FileManager.default.temporaryDirectory.appendingPathComponent("e2e-scratch")
            )
            let home = try FileManager.default.url(
                for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            let workerSettings = workerConfig.fields.mapValues(\.json)
            let consumer = Consumer(config: config, definitions: definitions, log: log) {
                log("🔧 Starting the QVAC worker...")
                let runner = try await Runner.start(settings: settings, log: log) {
                    let worker = try await QvacWorker.start(timeout: 60)
                    return try await QvacClient.connect(
                        ipc: worker.ipc, worklet: worker.worklet, homeDirectory: home, config: workerSettings)
                }
                log("✅ Worker ready")
                return runner
            }
            await consumer.run()
        } catch {
            log("❌ Consumer failed to start: \(error)")
            // The device test spec waits for this line; without it a failed start would sit until the job times out.
            log("\n👋 Consumer shutting down...")
        }
    }

    private static func json(_ url: URL) throws -> Value { try Value.parse(try Data(contentsOf: url)) }
}
