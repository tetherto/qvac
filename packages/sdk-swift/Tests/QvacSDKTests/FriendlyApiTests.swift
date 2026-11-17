import Foundation
import Testing
@testable import QvacSDK

@Suite struct FriendlyApiTests {
    @Test func loadsAModelConstantThroughTheCustomPluginShape() async throws {
        let transport = FakeTransport(replies: [[#"{"type":"loadModel","success":true,"modelId":"m1"}"#]])
        let client = QvacClient(transport: transport)

        let reply = try await client.models.load(Models.QWEN3_600M_INST_Q4)

        #expect(reply.modelId == "m1")
        #expect(
            transport.sent == [[
                "type": .string("loadModel"),
                "modelSrc": .string(Models.QWEN3_600M_INST_Q4.src),
                "modelName": .string("QWEN3_600M_INST_Q4"),
                "modelType": .string("llamacpp-completion"),
            ]])
    }

    @Test func runsACompletionIntoEventsTokensAndAFinalResult() async throws {
        let frames = [
            #"{"type":"completionStream","events":[{"type":"contentDelta","seq":0,"text":"Hel"},{"type":"thinkingDelta","seq":1,"text":"hmm"}]}"#,
            #"{"type":"completionStream","events":[{"type":"contentDelta","seq":2,"text":"lo"},{"type":"futureEvent","seq":3,"x":1}]}"#,
            #"{"type":"completionStream","done":true,"events":[{"type":"completionStats","seq":4,"stats":{"tokensPerSecond":12.5,"backendDevice":"gpu","extra":7}},{"type":"completionDone","seq":5,"stopReason":"eos","raw":{"fullText":"<think>hmm</think>Hello"}}]}"#,
        ]
        let transport = FakeTransport(replies: [frames])
        let client = QvacClient(transport: transport)

        let run = try client.completion.run(
            modelId: "m1", history: [.system("Be brief."), .user("Hi")],
            options: QvacCompletionOptions(requestId: "r1"))

        var tokens: [String] = []
        for try await token in run.tokens { tokens.append(token) }
        var unknown: [String] = []
        for try await event in run.events {
            if case .unknown(_, let payload) = event { unknown.append(payload["type"]?.stringValue ?? "") }
        }
        let final = try await run.final

        #expect(tokens == ["Hel", "lo"])
        #expect(unknown == ["futureEvent"])
        #expect(final.text == "Hello")
        #expect(final.thinking == "hmm")
        #expect(final.stopReason == "eos")
        #expect(final.stats?.tokensPerSecond == 12.5)
        #expect(final.stats?.backendDevice == "gpu")
        #expect(final.stats?.raw["extra"] == .number(7))
        #expect(final.cacheableAssistantContent == "Hello")

        let sent = try #require(transport.sent.first)
        #expect(sent["requestId"] == .string("r1"))
        #expect(sent["stream"] == .bool(true))
        #expect(sent["generationParams"] == .object(["predict": .number(-1)]))
        #expect(
            sent["history"]
                == .array([
                    .object(["role": .string("system"), "content": .string("Be brief.")]),
                    .object(["role": .string("user"), "content": .string("Hi")]),
                ]))
    }

    @Test func sendsOrderedPartsOfAUserTurn() async throws {
        let done = #"{"type":"completionStream","done":true,"events":[{"type":"completionDone","seq":0,"stopReason":"eos"}]}"#
        let transport = FakeTransport(replies: [[done]])
        let client = QvacClient(transport: transport)

        _ = try await client.completion.run(
            modelId: "m1", history: [.user(parts: [.text("What is this?"), .media(path: "/a.png")])]
        ).final

        let history = try #require(transport.sent.first?["history"])
        #expect(
            history
                == .array([
                    .object([
                        "role": .string("user"),
                        "content": .array([
                            .object(["type": .string("text"), "text": .string("What is this?")]),
                            .object(["type": .string("media"), "path": .string("/a.png")]),
                        ]),
                    ])
                ]))
    }

    @Test func failsTheFinalResultOfACancelledRunWithWhatItHad() async throws {
        let frames = [
            #"{"type":"completionStream","events":[{"type":"contentDelta","seq":0,"text":"One"}]}"#,
            #"{"type":"completionStream","done":true,"events":[{"type":"completionDone","seq":1,"stopReason":"cancelled"}]}"#,
        ]
        let client = QvacClient(transport: FakeTransport(replies: [frames]))
        let run = try client.completion.run(modelId: "m1", history: [.user("Count")])

        await #expect {
            _ = try await run.final
        } throws: { error in
            guard let error = error as? QvacCompletionCancelledError else { return false }
            return error.partial.text == "One"
        }
    }

    @Test func failsTheFinalResultOfARunThatEndsWithAnError() async throws {
        let frames = [
            #"{"type":"completionStream","done":true,"events":[{"type":"completionDone","seq":0,"stopReason":"error","error":{"message":"context full"}}]}"#
        ]
        let client = QvacClient(transport: FakeTransport(replies: [frames]))
        let run = try client.completion.run(modelId: "m1", history: [.user("Hi")])

        await #expect {
            _ = try await run.final
        } throws: { error in
            (error as? QvacCompletionError)?.message == "context full"
        }
    }

    @Test func streamsTheAnswerTextOfEachFrame() async throws {
        let frames = [
            #"{"type":"completionStream","events":[{"type":"contentDelta","seq":0,"text":"a"},{"type":"rawDelta","seq":1,"text":"x"},{"type":"contentDelta","seq":2,"text":"b"}]}"#,
            #"{"type":"completionStream","done":true,"events":[{"type":"completionDone","seq":3,"stopReason":"eos"}]}"#,
        ]
        let client = QvacClient(transport: FakeTransport(replies: [frames]))
        let request = CompletionStreamRequest(history: [QvacMessage.user("Hi").wire], modelId: "m1", stream: true)

        var texts: [String] = []
        for try await text in client.completion.text(request) { texts.append(text) }

        #expect(texts == ["ab", ""])
    }
}
