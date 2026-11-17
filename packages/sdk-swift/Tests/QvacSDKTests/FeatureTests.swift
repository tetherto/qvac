import Foundation
import Testing
@testable import QvacSDK

@Suite struct FeatureTests {
    @Test func embedsOneTextAndSeveral() async throws {
        let transport = FakeTransport(replies: [
            [#"{"type":"embed","success":true,"embedding":[0.5,0.25]}"#],
            [#"{"type":"embed","success":true,"embedding":[[1,0],[0,1]]}"#],
        ])
        let client = QvacClient(transport: transport)

        let one = try await client.embeddings.embed(modelId: "e1", text: "cat", requestId: "r1")
        let many = try await client.embeddings.embed(modelId: "e1", texts: ["cat", "dog"])

        #expect(one == [0.5, 0.25])
        #expect(many == [[1, 0], [0, 1]])
        #expect(
            transport.sent.first
                == ["type": .string("embed"), "modelId": .string("e1"), "text": .string("cat"), "requestId": .string("r1")])
    }

    @Test func transcribesIntoTextSegmentsAndRawStats() async throws {
        let frames = [
            #"{"type":"transcribe","text":"Hello ","segment":{"text":"Hello","startMs":0,"endMs":500,"append":false,"id":0}}"#,
            #"{"type":"transcribe","text":"world","done":true,"stats":{"audioDuration":1.5,"extra":2}}"#,
        ]
        let transport = FakeTransport(replies: [frames])
        let client = QvacClient(transport: transport)

        let result = try await client.speech.transcribe(modelId: "w1", audio: .filePath("/a.wav"))

        #expect(result.text == "Hello world")
        #expect(result.segments == [QvacTranscriptionSegment(text: "Hello", startMs: 0, endMs: 500, append: false, id: 0)])
        #expect(result.stats?["extra"] == .number(2))
        #expect(transport.sent.first?["audioChunk"] == .object(["type": .string("filePath"), "value": .string("/a.wav")]))
    }

    @Test func synthesizesSamplesFromPcmAndBuffer() async throws {
        let pcm = Data([0x01, 0x00, 0xFF, 0xFF]).base64EncodedString()
        let frames = [
            #"{"type":"textToSpeech","buffer":[],"pcm":"\#(pcm)","done":false,"sentenceChunk":"Hi."}"#,
            #"{"type":"textToSpeech","buffer":[7],"pcm":"","done":true}"#,
        ]
        let transport = FakeTransport(replies: [frames])
        let client = QvacClient(transport: transport)

        let result = try await client.speech.synthesize(
            modelId: "t1", text: "Hi.", voice: QvacVoiceOptions(emotion: .happy, pace: .slow))

        #expect(result.samples == [1, -1, 7])
        #expect(result.sentenceChunks == ["Hi."])
        #expect(transport.sent.first?["emotion"] == .string("happy"))
        #expect(transport.sent.first?["pace"] == .string("slow"))
    }

    @Test func translatesWithTheEngineTheModelTypeNames() async throws {
        let frames = [
            #"{"type":"translate","token":"Bon"}"#,
            #"{"type":"translate","token":"jour","done":true}"#,
        ]
        let transport = FakeTransport(replies: [frames])
        let client = QvacClient(transport: transport)

        let run = try client.translation.run(modelId: "m1", text: "Hello", modelType: "llm", to: "fr")
        var tokens: [String] = []
        for try await token in run.tokens { tokens.append(token) }

        #expect(tokens == ["Bon", "jour"])
        #expect(try await run.text() == "Bonjour")
        #expect(transport.sent.first?["to"] == .string("fr"))
        #expect(throws: QvacFeatureError.self) {
            try client.translation.run(modelId: "m1", text: "Hello", modelType: "nmt", to: "fr")
        }
        #expect(throws: QvacFeatureError.self) {
            try client.translation.run(modelId: "m1", text: "Hello", modelType: "llm")
        }
    }

    @Test func collectsMediaFramesAndGivesARunItsRequestId() async throws {
        let frames = [
            #"{"type":"diffusionStream","step":1,"totalSteps":2}"#,
            #"{"type":"diffusionStream","data":"aW1n","done":true,"stats":{"totalMs":10}}"#,
        ]
        let transport = FakeTransport(replies: [frames])
        let client = QvacClient(transport: transport)

        let run = client.media.diffusion(DiffusionStreamRequest(modelId: "d1", prompt: "a cat"))
        let final = try await run.final

        #expect(final.data == ["aW1n"])
        #expect(final.stats?["totalMs"] == .number(10))
        #expect(transport.sent.first?["requestId"] == .string(run.requestId))
    }

    @Test func rejectsBciWindowsThatCannotSlide() async {
        let client = QvacClient(transport: FakeTransport(replies: []))
        let (input, feed) = AsyncStream<Data>.makeStream()
        feed.finish()

        await #expect(throws: QvacFeatureError.self) {
            try await client.bci.transcribeStream(
                modelId: "b1", neuralChunks: input,
                options: QvacBciStreamOptions(windowTimesteps: 4, hopTimesteps: 4))
        }
    }
}
