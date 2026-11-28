import Foundation
import QvacSDK

/// The client of the running worker. `restart` replaces the worker, so whoever holds this keeps a
/// usable client.
public final class Worker: @unchecked Sendable {
    private let current: Locked<QvacClient>
    private let start: @Sendable () async throws -> QvacClient

    private init(_ client: QvacClient, start: @escaping @Sendable () async throws -> QvacClient) {
        self.current = Locked(client)
        self.start = start
    }

    public static func start(_ start: @escaping @Sendable () async throws -> QvacClient) async throws -> Worker {
        Worker(try await start(), start: start)
    }

    public var client: QvacClient { current.withLock { $0 } }

    /// Stops the worker with the models it holds and starts a new one.
    public func restart() async throws {
        await client.close()
        let next = try await start()
        current.withLock { $0 = next }
    }

    public func close() async {
        await client.close()
    }
}
