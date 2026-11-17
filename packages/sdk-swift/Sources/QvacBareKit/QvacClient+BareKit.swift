import BareKit
import BareStowHost
import Foundation
import QvacSDK

extension BareKit.IPC: BareStowHost.Transport {}

/// A published worker profile: a framework linked into the app that carries
/// the worker bundle for one set of plugins.
public struct QvacWorkerProfile: Sendable, Hashable {
    public let frameworkName: String

    public init(frameworkName: String) {
        self.frameworkName = frameworkName
    }

    public static let allInOne = QvacWorkerProfile(frameworkName: "QvacWorkerAll")
    public static let assistant = QvacWorkerProfile(frameworkName: "QvacWorkerAssistant")
    public static let llm = QvacWorkerProfile(frameworkName: "QvacWorkerLLM")
    public static let speech = QvacWorkerProfile(frameworkName: "QvacWorkerSpeech")
    public static let vision = QvacWorkerProfile(frameworkName: "QvacWorkerVision")
    public static let media = QvacWorkerProfile(frameworkName: "QvacWorkerMedia")
    public static let robotics = QvacWorkerProfile(frameworkName: "QvacWorkerRobotics")

    /// The bundle identifier `build-profiles.mjs` gives the profile's framework.
    var bundleIdentifier: String {
        let prefix = "QvacWorker"
        let suffix = frameworkName.hasPrefix(prefix) ? String(frameworkName.dropFirst(prefix.count)) : frameworkName
        return "io.tether.qvac.worker.\(suffix.lowercased())"
    }

    /// The worker bundle inside the profile's framework, or nil when the app
    /// does not link it.
    public var bundleURL: URL? {
        Bundle(identifier: bundleIdentifier)?.url(forResource: "index", withExtension: "bundle")
    }
}

extension QvacClient {
    /// Starts the worker of `profile` in this process and connects to it.
    public static func start(
        profile: QvacWorkerProfile,
        homeDirectory: URL = defaultHomeDirectory,
        config: [String: JSONValue] = [:],
        options: Worklet.Options = Worklet.Options(),
        timeout: TimeInterval? = 30,
        maxFrameBytes: Int = defaultMaxFrameBytes
    ) async throws -> QvacClient {
        guard let bundle = profile.bundleURL else {
            throw QvacWorkerError(
                code: "WORKER_PROFILE_MISSING",
                message: "The app does not link the \(profile.frameworkName) worker profile")
        }
        return try await start(
            bundle: bundle, homeDirectory: homeDirectory, config: config, options: options, timeout: timeout,
            maxFrameBytes: maxFrameBytes)
    }

    /// Starts the worker bundle at `bundle` as a Bare Kit worklet in this
    /// process and connects to it. The native addons the bundle loads must be
    /// linked into the app.
    public static func start(
        bundle: URL,
        homeDirectory: URL = defaultHomeDirectory,
        config: [String: JSONValue] = [:],
        options: Worklet.Options = Worklet.Options(),
        timeout: TimeInterval? = 30,
        maxFrameBytes: Int = defaultMaxFrameBytes
    ) async throws -> QvacClient {
        try checkFrameBytes(maxFrameBytes)
        let worklet = try Worklet(options: options)
        let transport = try BareKit.IPC(worklet: worklet)
        try worklet.start(bundle)
        let ipc = BareStowHost.IPC(transport, kill: { worklet.terminate() }, timeout: timeout)
        Task { ipc.exited(code: await worklet.wait()) }
        do {
            try await ipc.ready()
        } catch let error as WorkerError {
            throw QvacWorkerError(code: error.code, message: error.message, exitCode: error.exitCode)
        }
        do {
            return try await connect(
                ipc: ipc, worklet: worklet, homeDirectory: homeDirectory, config: config, maxFrameBytes: maxFrameBytes)
        } catch {
            worklet.terminate()
            throw error
        }
    }
}
