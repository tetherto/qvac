import Foundation
import QvacSDK
import QvacWorker

func check(_ label: String, _ passed: Bool, _ detail: String) {
    print("\(passed ? "ok" : "FAIL") \(label): \(detail)")
    if !passed { exit(1) }
}

let worker = try await QvacWorker.start(timeout: 60)
let client = try await QvacClient.connect(ipc: worker.ipc, worklet: worker.worklet)

let heartbeat = try await client.heartbeat()
check("heartbeat", heartbeat.type == "heartbeat", heartbeat.type)

let resources = try await client.getSystemResources(GetSystemResourcesRequest())
check("system resources", resources.type == "getSystemResources", resources.type)

let unload = try await client.unloadModel(UnloadModelRequest(modelId: "missing"))
check("unload a missing model", !unload.success, unload.error ?? "-")

do {
    let (input, feed) = AsyncStream<Data>.makeStream()
    feed.finish()
    for try await _ in client.transcribeStream(TranscribeStreamRequest(modelId: "missing"), input: input) {}
    check("two-way stream on a missing model", false, "ended without an error")
} catch let error as QvacError {
    check("two-way stream on a missing model", error.kind != nil, "\(error.name)")
}

await client.close()
print("ok closed")
