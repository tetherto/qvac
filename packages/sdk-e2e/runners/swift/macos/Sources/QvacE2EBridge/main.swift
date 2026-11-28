// Bridge client: reads one test at a time from stdin, answers on stdout. The framework keeps the
// MQTT state machine, so this process only interprets a definition and reports a verdict.
//
//   -> {"type": "ready", "protocol": 1}
//   <- {"type": "execute", "id", "testId", "params", "expectation", "metadata", "steps"}
//   -> {"type": "log", "message": "..."}            (zero or more)
//   -> {"type": "result", "id", "passed", "output", ...}
//   <- {"type": "shutdown"}
//
// stdout is protocol only; anything diagnostic goes to stderr, which the framework forwards into
// the run log.
import Foundation
import QvacE2E
import QvacSDK
import QvacWorker

let protocolVersion = 1
let output = NSLock()
let environment = ProcessInfo.processInfo.environment

@discardableResult
func write(_ message: Value) -> Bool {
    guard let data = try? message.encoded() else { return false }
    output.lock()
    FileHandle.standardOutput.write(data + Data("\n".utf8))
    output.unlock()
    return true
}

@Sendable func log(_ message: String) {
    write(["type": "log", "message": .string(message)])
}

func path(_ variable: String, default fallback: String) -> URL {
    let value = environment[variable].flatMap { $0.isEmpty ? nil : $0 } ?? fallback
    return URL(fileURLWithPath: value).standardizedFileURL
}

func readJSON(_ url: URL) throws -> Value {
    try Value.parse(try Data(contentsOf: url))
}

// The framework starts this in runners/swift/macos; the catalog and fixtures live three levels up.
let e2eRoot = URL(fileURLWithPath: "../../..").standardizedFileURL
let workerConfig = try readJSON(e2eRoot.appendingPathComponent("fixtures/qvac.config.e2e.json"))
// The bundle decides the plugins and the RPC server provider. QVAC_CONFIG_PATH lays its settings
// over the rest, as the JS desktop consumer (runners/js/desktop/consumer.ts) merges it over the
// fixture config: CI points the model cache there.
var configFields = workerConfig.fields.filter { $0.key != "plugins" && $0.key != "rpcServerProvider" }
if let overrides = environment["QVAC_CONFIG_PATH"].flatMap({ $0.isEmpty ? nil : $0 }) {
    configFields.merge(try readJSON(URL(fileURLWithPath: overrides)).fields) { $1 }
}
let config = configFields.mapValues(\.json)
// The user's home, as the JS and Python desktop clients give it, so all share `~/.qvac/models`.
let home = URL(fileURLWithPath: NSHomeDirectory())

let settings = Runner.Settings(
    resourcePlatform: environment["QVAC_RESOURCE_PLATFORM"] ?? "desktop-macos",
    resourceTable: try readJSON(
        path("QVAC_RESOURCE_TABLE", default: e2eRoot.appendingPathComponent("catalog/resources/resource-table.json").path)),
    platformPolicy: try readJSON(e2eRoot.appendingPathComponent("catalog/resources/platform-policy.json")),
    assetRoot: path("QVAC_ASSET_ROOT", default: e2eRoot.appendingPathComponent("assets").path),
    scratchRoot: FileManager.default.temporaryDirectory.appendingPathComponent("qvac-e2e-swift")
)

let runner = try await Runner.start(settings: settings, log: log) {
    let worker = try await QvacWorker.start(timeout: 60)
    return try await QvacClient.connect(ipc: worker.ipc, worklet: worker.worklet, homeDirectory: home, config: config)
}

write(["type": "ready", "protocol": .number(Double(protocolVersion))])

for try await line in FileHandle.standardInput.bytes.lines {
    if line.isEmpty { continue }
    let request: Value
    do {
        request = try Value.parse(Data(line.utf8))
    } catch {
        log("ignoring malformed request: \(error)")
        continue
    }
    let kind = request["type"].string
    if kind == "shutdown" { break }
    if kind != "execute" {
        log("ignoring unknown request type: \(jsString(request["type"]))")
        continue
    }
    let result = await runner.execute(request)
    // Echo the id: a reply the framework can no longer place is dropped, which is what keeps a
    // late answer off the next test.
    if !write(result.message.merging(["id": request["id"]])) {
        write([
            "type": "result", "id": request["id"], "passed": false,
            "output": .string("the result for \(jsString(request["testId"])) could not be encoded"),
        ])
    }
}

await runner.close()
