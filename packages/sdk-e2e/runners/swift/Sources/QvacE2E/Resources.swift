import Foundation
import QvacSDK

/// Where the shared table's placeholders point on this host.
public protocol HostResolvers: Sendable {
    /// A bundled fixture, as a path the worker can open.
    func asset(kind: String, file: String) -> String
}

/// Resource key -> model, loaded and evicted around each test. Table: catalog/resources/resource-table.json;
/// `on` / `configOn` platform matching: catalog/resource-table-types.ts.
public final class Resources: @unchecked Sendable {
    private let worker: Worker
    private let platform: String
    private let host: HostResolvers
    private let log: @Sendable (String) -> Void
    /// Pause after an unload before the next load (`unloadSettleMs` in catalog/platform-policy.ts).
    private let unloadSettleMs: Double
    /// Keys never kept loaded between tests (`singleUseResources` in catalog/platform-policy.ts).
    private let singleUseResources: [String]
    private let definitions: [String: Value]
    private let loaded = Locked<[(dep: String, modelId: String)]>([])

    public init(
        worker: Worker, table: Value, platform: String, host: HostResolvers, log: @escaping @Sendable (String) -> Void,
        unloadSettleMs: Double, singleUseResources: [String]
    ) {
        self.worker = worker
        self.platform = platform
        self.host = host
        self.log = log
        self.unloadSettleMs = unloadSettleMs
        self.singleUseResources = singleUseResources
        var definitions: [String: Value] = [:]
        for (key, entry) in table.fields {
            if entry["on"].array?.contains(where: { Self.applies(jsString($0), platform) }) ?? true { definitions[key] = entry }
        }
        self.definitions = definitions
    }

    private static func applies(_ entry: String, _ platform: String) -> Bool {
        if entry == platform { return true }
        let segments = entry.split(separator: "-")
        let platformSegments = platform.split(separator: "-")
        if segments.count >= platformSegments.count { return false }
        return segments.indices.allSatisfy { segments[$0] == platformSegments[$0] }
    }

    private func appliesHere(_ entry: String) -> Bool { Self.applies(entry, platform) }

    private func definition(_ dep: String) throws -> Value {
        guard let entry = definitions[dep] else {
            throw StepError("resource \"\(dep)\" is not defined for platform \"\(platform)\"", incomplete: true)
        }
        return entry
    }

    /// The entry's config with this platform's overrides merged over it.
    private func configFor(_ entry: Value) -> Value? {
        let config = entry["config"].object
        let overrides = entry["configOn"].fields.filter { appliesHere($0.key) }.sorted { $0.key < $1.key }.map(\.value)
        if config == nil && overrides.isEmpty { return nil }
        return overrides.reduce(Value.object(config ?? [:])) { $0.merging($1) }
    }

    /// Replace `$const` and `$asset` placeholders, recursively.
    func resolve(_ value: Value) throws -> Value {
        switch value {
        case .array(let items): return .array(try items.map(resolve))
        case .object(let object):
            if let name = object["$const"]?.string { return Self.descriptor(try Self.constant(name)) }
            if let asset = object["$asset"], asset.object != nil {
                return .string(host.asset(kind: jsString(asset["kind"]), file: jsString(asset["file"])))
            }
            return .object(try object.mapValues(resolve))
        default: return value
        }
    }

    /// What `loadModel` would be called with for this key, without calling it.
    func sourceOf(_ dep: String) throws -> Value {
        let entry = try definition(dep)
        var out: [String: Value] = [:]
        let constant = try resolve(entry["constant"])
        if !constant.isNil { out["modelSrc"] = constant }
        if !entry["modelSrc"].isNil { out["modelSrc"] = entry["modelSrc"] }
        if !entry["type"].isNil { out["modelType"] = entry["type"] }
        if let config = configFor(entry) { out["modelConfig"] = try resolve(config) }
        return .object(out)
    }

    func ensureLoaded(_ dep: String) async throws -> String {
        if let modelId = loaded.withLock({ $0.first { $0.dep == dep }?.modelId }) { return modelId }
        let source = try sourceOf(dep)
        log("loading \(dep)")
        let modelId = try await loadModel(source)
        loaded.withLock { $0.append((dep, modelId)) }
        return modelId
    }

    /// What a `loadModel` step asks for, resolved the way the JS client resolves it.
    struct LoadArgs {
        let src: String
        let type: String
        let name: String?
        let requestId: String?
        let config: Value?
    }

    static func loadArgs(_ params: Value) throws -> LoadArgs {
        let source = params["modelSrc"]
        // Value is ExpressibleByNilLiteral, so a bare `nil` here would become `.some(.null)`.
        let descriptor: Value? = source.object != nil ? source : Optional.none
        let src = descriptor.map { jsString($0["src"]) } ?? (source.isNil ? "" : jsString(source))
        let declared = params["modelType"].isNil ? descriptor.flatMap { $0["engine"].string } : jsString(params["modelType"])
        guard let declared else { throw Wire.refusal("MODEL_TYPE_REQUIRED", Self.modelTypeRequired) }
        return LoadArgs(
            src: src,
            type: Self.canonicalModelType(declared),
            name: params["modelName"].string ?? descriptor?["name"].string,
            requestId: params["requestId"].string,
            config: params["modelConfig"].isNil ? nil : Self.wireConfig(params["modelConfig"])
        )
    }

    /// The `loadModel` contract method: a descriptor or a plain source, a type, a config.
    func loadModel(_ params: Value) async throws -> String {
        let args = try Self.loadArgs(params)
        let config: [String: JSONValue]?
        if case .object(let object)? = args.config?.json { config = object } else { config = nil }
        let response = try await worker.client.models.load(
            source: args.src, modelType: args.type, modelName: args.name, requestId: args.requestId, modelConfig: config)
        guard response.success, let modelId = response.modelId else {
            throw Wire.refusal("MODEL_LOAD_FAILED", response.error ?? "loading \(args.src) failed")
        }
        return modelId
    }

    func evict(_ dep: String) async {
        let modelId = loaded.withLock { list -> String? in
            guard let index = list.firstIndex(where: { $0.dep == dep }) else { return nil }
            return list.remove(at: index).modelId
        }
        if let modelId { await unload(dep, modelId) }
    }

    func evictAllExcept(_ keep: Set<String>) async {
        let evicted = loaded.withLock { list -> [(dep: String, modelId: String)] in
            let gone = list.filter { !keep.contains($0.dep) }
            list.removeAll { !keep.contains($0.dep) }
            return gone
        }
        for (dep, modelId) in evicted { await unload(dep, modelId) }
    }

    /// Unloads the keys this platform never keeps between tests.
    public func evictSingleUse() async {
        for dep in singleUseResources { await evict(dep) }
    }

    public func close() async { await evictAllExcept([]) }

    /// Drops every model from the table without unloading it, for a worker that is about to stop.
    func forgetLoaded() { loaded.withLock { $0.removeAll() } }

    /// Runs to the end, within a bound: a model left in the worker but dropped from `loaded` would
    /// be loaded twice.
    private func unload(_ dep: String, _ modelId: String) async {
        log("evicting \(dep)")
        let worker = worker
        let log = log
        let settle = unloadSettleMs
        let done = try? await withTimeout(Self.unloadTimeoutSeconds) {
            // Cancel in-flight decoding first, as the JS resource manager does: a timed-out test leaves it running.
            do {
                _ = try await worker.client.raw.call([
                    "type": .string("cancel"), "operation": .string("broad"), "modelId": .string(modelId),
                    "kind": .string("completion"),
                ])
            } catch {
                log("cancelling \(dep) before evicting it failed (continuing): \(Wire.message(of: error))")
            }
            do {
                let reply = try await worker.client.models.unload(modelId)
                if reply.unloaded == false {
                    log("evicting \(dep) left it loaded (open sessions: \(reply.hasOpenSessions.map(String.init) ?? "?"))")
                }
            } catch {
                log("evicting \(dep) failed (continuing): \(Wire.message(of: error))")
            }
            if settle > 0 { await sleep(milliseconds: settle) }
            return true
        }
        if done == nil { log("evicting \(dep) did not finish within \(Int(Self.unloadTimeoutSeconds * 1000))ms (continuing)") }
    }

    /// Every model constant the table's entries for these keys reference, for the bootstrap download.
    func constantsFor(_ deps: Set<String>) -> [ModelConstant] {
        var found: [String: ModelConstant] = [:]
        var order: [String] = []
        func collect(_ value: Value) {
            switch value {
            case .array(let items): items.forEach(collect)
            case .object(let object):
                if let name = object["$const"]?.string {
                    // A missing constant makes only its own test incomplete; the download goes on.
                    if let constant = Self.constants[name], found[constant.src] == nil {
                        found[constant.src] = constant
                        order.append(constant.src)
                    }
                } else {
                    for key in object.keys.sorted() { collect(object[key]!) }
                }
            default: break
            }
        }
        for dep in deps.sorted() {
            guard let entry = definitions[dep], !entry["skipPreDownload"].isTrue else { continue }
            if let skipOn = entry["skipPreDownloadOn"].array, skipOn.contains(where: { appliesHere(jsString($0)) }) { continue }
            collect(entry["constant"])
            if let config = configFor(entry) { collect(config) }
        }
        return order.map { found[$0]! }
    }

    public var keys: [String] { definitions.keys.sorted() }

    private static let unloadTimeoutSeconds = 60.0

    /// The JS client's ModelTypeRequiredError message (sdk-errors-client.ts).
    private static let modelTypeRequired =
        "modelType is required: modelSrc is a plain string or lacks an engine/addon descriptor that can be inferred."

    private static let constants: [String: ModelConstant] = Dictionary(
        Models.all.map { ($0.name, $0) }, uniquingKeysWith: { first, _ in first })

    static func constant(_ name: String) throws -> ModelConstant {
        guard let constant = constants[name] else {
            throw StepError("model constant \"\(name)\" is missing from the Swift registry", incomplete: true)
        }
        return constant
    }

    /// A model constant as the JS client passes it: the whole descriptor object.
    static func descriptor(_ constant: ModelConstant) -> Value {
        [
            "name": .string(constant.name),
            "src": .string(constant.src),
            "modelId": .string(constant.modelId),
            "registryPath": .string(constant.registryPath),
            "registrySource": .string(constant.registrySource),
            "blobCoreKey": .string(constant.blobCoreKey),
            "blobBlockOffset": Value(constant.blobBlockOffset),
            "blobBlockLength": Value(constant.blobBlockLength),
            "blobByteOffset": Value(constant.blobByteOffset),
            "engine": .string(constant.engine),
            "quantization": .string(constant.quantization),
            "params": .string(constant.params),
            "expectedSize": Value(constant.expectedSize),
            "sha256Checksum": .string(constant.sha256Checksum),
            "addon": .string(constant.addon),
        ]
    }

    static func canonicalModelType(_ type: String) -> String { ModelTypeMaps.aliasToCanonical[type] ?? type }

    /// The config as the JS client puts it on the wire: a Bergamot pivot's own model source is
    /// reduced to its `src`, the one place the JS load schema transforms a nested descriptor.
    static func wireConfig(_ config: Value) -> Value {
        let pivot = config["pivotModel"]
        guard config["engine"].string == "Bergamot", pivot.object != nil else { return config }
        let pivotSource = pivot["modelSrc"]
        let src = pivotSource.object != nil ? pivotSource["src"] : pivotSource
        return config.merging(["pivotModel": pivot.merging(["modelSrc": src])])
    }
}
