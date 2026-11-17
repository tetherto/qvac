import BareStowHost
import Foundation

extension QvacClient {
    public static let defaultMaxFrameBytes = 16 * 1024 * 1024
    public static let frameBytesRange = (4 * 1024)...(512 * 1024 * 1024)

    /// Where the worker keeps models and caches unless told otherwise: on iOS
    /// `Application Support/qvac`; on macOS `QVAC_HOME_DIR` when set, else the
    /// user's home directory.
    public static var defaultHomeDirectory: URL {
        #if os(iOS)
            return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("qvac", isDirectory: true)
        #else
            if let path = ProcessInfo.processInfo.environment["QVAC_HOME_DIR"], !path.isEmpty {
                return URL(fileURLWithPath: path, isDirectory: true)
            }
            return FileManager.default.homeDirectoryForCurrentUser
        #endif
    }

    /// Connects to a worker started by `start()` of a `bundleSdk` bundle
    /// (target `bare-kit`, language `swift`) and sends it its configuration.
    ///
    /// - Parameters:
    ///   - ipc: The `ipc` of the started worker.
    ///   - worklet: The `worklet` of the started worker, which the client keeps
    ///     alive, as releasing it terminates the worker.
    ///   - homeDirectory: Where the worker keeps models and caches. It is
    ///     created when missing.
    ///   - config: The QVAC configuration, as in `qvac.config.json`.
    ///   - maxFrameBytes: The longest reply frame and JSON line accepted from
    ///     the worker, within `frameBytesRange`. A longer one fails only the
    ///     call it belongs to.
    public static func connect(
        ipc: BareStowHost.IPC,
        worklet: AnyObject? = nil,
        homeDirectory: URL = defaultHomeDirectory,
        config: [String: JSONValue] = [:],
        maxFrameBytes: Int = defaultMaxFrameBytes
    ) async throws -> QvacClient {
        try checkFrameBytes(maxFrameBytes)
        try FileManager.default.createDirectory(at: homeDirectory, withIntermediateDirectories: true)
        let connection = WorkerConnection(ipc, maxFrameBytes: maxFrameBytes, keepAlive: worklet)
        var message: [String: JSONValue] = [
            "type": .string("__init_config"),
            "homeDir": .string(homeDirectory.path),
            "runtimeContext": .object(DeviceContext.current),
        ]
        if !config.isEmpty { message["config"] = .object(config) }
        do {
            let reply = try JSONDecoder().decode(
                JSONValue.self, from: try await connection.call(try encodeForWorker(message)))
            if reply["success"] != .bool(true) {
                throw QvacWorkerError(
                    code: "WORKER_CONFIGURATION_FAILED",
                    message: reply["error"]?.stringValue ?? "The worker rejected its configuration")
            }
        } catch {
            await connection.close()
            throw error
        }
        return QvacClient(transport: connection)
    }

    /// Throws when `maxFrameBytes` is outside `frameBytesRange`.
    public static func checkFrameBytes(_ maxFrameBytes: Int) throws {
        guard frameBytesRange.contains(maxFrameBytes) else {
            throw QvacConfigurationError(
                "maxFrameBytes must be between \(frameBytesRange.lowerBound) and \(frameBytesRange.upperBound), "
                    + "got \(maxFrameBytes)")
        }
    }
}

enum DeviceContext {
    static var current: [String: JSONValue] {
        #if os(iOS)
            let platform = "ios"
            let model = sysctl("hw.machine")
        #else
            let platform = "darwin"
            let model = sysctl("hw.model")
        #endif
        var context: [String: JSONValue] = ["platform": .string(platform), "deviceBrand": .string("Apple")]
        if let model { context["deviceModel"] = .string(model) }
        return context
    }

    private static func sysctl(_ name: String) -> String? {
        var size = 0
        guard sysctlbyname(name, nil, &size, nil, 0) == 0, size > 0 else { return nil }
        var value = [CChar](repeating: 0, count: size)
        guard sysctlbyname(name, &value, &size, nil, 0) == 0 else { return nil }
        return String(cString: value)
    }
}
