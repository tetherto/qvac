import Foundation
import Testing
@testable import QvacSDK

@Suite struct QvacClientTests {
    @Test func sendsTheConstTypeAndLeavesUnsetFieldsOut() async throws {
        let transport = FakeTransport(replies: [[#"{"type":"heartbeat","number":1}"#]])
        let client = QvacClient(transport: transport)

        let response = try await client.heartbeat()

        #expect(response.type == "heartbeat")
        #expect(transport.sent == [["type": .string("heartbeat")]])
    }

    // A model's prompt cache matches the request text, so equal objects must encode to equal bytes.
    @Test func encodesEqualObjectsToTheSameBytes() async throws {
        let keys = (0..<40).map { "property\($0)" }
        func schema(_ order: [String]) -> [String: JSONValue] {
            var properties: [String: JSONValue] = [:]
            for key in order { properties[key] = .object(["type": .string("string")]) }
            return ["type": .string("echo"), "properties": .object(properties)]
        }
        let transport = FakeTransport(replies: [[#"{"type":"echo"}"#], [#"{"type":"echo"}"#]])
        let client = QvacClient(transport: transport)

        _ = try await client.raw.call(schema(keys))
        _ = try await client.raw.call(schema(keys.reversed()))

        #expect(transport.sentBytes[0] == transport.sentBytes[1])
    }

    @Test func decodesAReplyIntoItsType() async throws {
        let transport = FakeTransport(replies: [[#"{"type":"unloadModel","success":true,"released":true}"#]])
        let client = QvacClient(transport: transport)

        let response = try await client.unloadModel(UnloadModelRequest(modelId: "m1"))

        #expect(response.success)
        #expect(response.released == true)
        #expect(transport.sent == [["type": .string("unloadModel"), "modelId": .string("m1")]])
    }

    @Test func throwsTheWorkerErrorWithItsKind() async throws {
        let error = #"{"type":"error","name":"MODEL_NOT_FOUND","code":52002,"message":"no such model"}"#
        let client = QvacClient(transport: FakeTransport(replies: [[error]]))

        await #expect {
            try await client.unloadModel(UnloadModelRequest(modelId: "m1"))
        } throws: { error in
            guard let error = error as? QvacError else { return false }
            return error.kind == .serverModelNotFound && error.message == "no such model"
        }
    }

    @Test func matchesAnErrorNameSharedByGroupsOnlyByCode() {
        let shared = QvacError(payload: ["name": .string("MODEL_NOT_FOUND"), "code": .number(19003)])
        let uncoded = QvacError(payload: ["name": .string("MODEL_NOT_FOUND")])
        let unique = QvacError(payload: ["name": .string("MODEL_NOT_LOADED")])

        #expect(shared.kind == .registryModelNotFound)
        #expect(uncoded.kind == nil)
        #expect(unique.kind == .serverModelNotLoaded)
    }

    @Test func splitsProgressFramesFromTheResult() async throws {
        let frames = [
            #"{"type":"modelProgress","downloaded":5,"total":10,"percentage":50,"downloadKey":"k"}"#,
            #"{"type":"loadModel","success":true,"modelId":"m1"}"#,
        ]
        let client = QvacClient(transport: FakeTransport(replies: [frames]))

        var events: [String] = []
        for try await event in client.loadModelWithProgress(try loadModelRequest()) {
            switch event {
            case .progress(let progress): events.append("progress \(progress.percentage)")
            case .result(let result): events.append("result \(result.modelId ?? "")")
            }
        }

        #expect(events == ["progress 50.0", "result m1"])
    }

    @Test func decodesSpeechSamplesFromPcm() {
        let pcm = Data([0x01, 0x00, 0xFF, 0xFF, 0x00, 0x80]).base64EncodedString()

        #expect(ttsSamples([], pcm: pcm) == [1, -1, -32768])
    }

    private func loadModelRequest() throws -> LoadModelRequest {
        try JSONDecoder().decode(
            LoadModelRequest.self,
            from: Data(#"{"type":"loadModel","modelSrc":"https://example.com/model.gguf","modelType":"llm"}"#.utf8))
    }
}
