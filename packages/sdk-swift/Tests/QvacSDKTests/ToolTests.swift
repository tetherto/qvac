import Foundation
import Testing
@testable import QvacSDK

@Suite struct ToolTests {
    private let weather = QvacTool(
        name: "weather",
        description: "Current weather in a city",
        parameters: ["city": QvacToolParameter(.string, description: "City name")],
        required: ["city"],
        handler: { arguments in .string("Sunny in \(arguments["city"]?.stringValue ?? "?")") })

    @Test func sendsToolsAndHandsBackCallsThatInvokeTheirHandler() async throws {
        let frames = [
            #"{"type":"completionStream","done":true,"events":[{"type":"toolCall","seq":0,"call":{"id":"c1","name":"weather","arguments":{"city":"Rome"}}},{"type":"completionDone","seq":1,"stopReason":"eos"}]}"#
        ]
        let transport = FakeTransport(replies: [frames])
        let client = QvacClient(transport: transport)

        let run = try client.completion.run(modelId: "m1", history: [.user("Weather in Rome?")], tools: [weather])
        var streamed: [String] = []
        for try await call in run.toolCallEvents { streamed.append(call.name) }
        let calls = try await run.toolCalls()

        #expect(streamed == ["weather"])
        #expect(calls.count == 1)
        #expect(calls[0].canInvoke)
        #expect(try await calls[0].invoke() == .string("Sunny in Rome"))
        #expect(
            transport.sent.first?["tools"]
                == .array([
                    .object([
                        "type": .string("function"),
                        "name": .string("weather"),
                        "description": .string("Current weather in a city"),
                        "parameters": .object([
                            "type": .string("object"),
                            "properties": .object([
                                "city": .object(["type": .string("string"), "description": .string("City name")])
                            ]),
                            "required": .array([.string("city")]),
                        ]),
                    ])
                ]))
    }

    @Test func answersTheWorkersToolCallbacksAndKeepsTheLastTurn() async throws {
        let frames = [
            #"{"type":"completionOrchestrate","turn":0,"events":[{"type":"contentDelta","seq":0,"text":"Let me check."}],"toolCallback":{"callId":"cb1","name":"weather","arguments":{"city":"Oslo"}}}"#,
            #"{"type":"completionOrchestrate","turn":1,"done":true,"stopReason":"eos","events":[{"type":"contentDelta","seq":1,"text":"It is sunny."},{"type":"completionDone","seq":2,"stopReason":"eos"}]}"#,
        ]
        let transport = FakeTransport(replies: [frames])
        let client = QvacClient(transport: transport)

        let run = try client.completion.orchestrate(
            modelId: "m1", history: [.user("Weather in Oslo?")], tools: [weather], maxToolTurns: 3)
        let final = try await run.final

        #expect(final.text == "It is sunny.")
        #expect(final.stopReason == "eos")
        #expect(transport.sent.first?["maxToolTurns"] == .number(3))
        let replies = await transport.duplexInputs()
        let reply = try JSONDecoder().decode(JSONValue.self, from: try #require(replies.first?.first))
        #expect(reply == .object(["callId": .string("cb1"), "result": .string("Sunny in Oslo")]))
    }

    @Test func sendsAFailedHandlerBackAsTheToolError() async throws {
        let failing = QvacTool(name: "broken", description: "Always fails") { _ in
            throw QvacCompletionError(message: "no network")
        }
        let frames = [
            #"{"type":"completionOrchestrate","turn":0,"events":[],"toolCallback":{"callId":"cb1","name":"broken","arguments":{}}}"#,
            #"{"type":"completionOrchestrate","turn":1,"done":true,"events":[{"type":"contentDelta","seq":0,"text":"Sorry."},{"type":"completionDone","seq":1,"stopReason":"eos"}]}"#,
        ]
        let transport = FakeTransport(replies: [frames])
        let client = QvacClient(transport: transport)

        _ = try await client.completion.orchestrate(modelId: "m1", history: [.user("Go")], tools: [failing]).final

        let replies = await transport.duplexInputs()
        let reply = try JSONDecoder().decode(JSONValue.self, from: try #require(replies.first?.first))
        #expect(reply == .object(["callId": .string("cb1"), "error": .string("no network")]))
    }

    @Test func rejectsRequestsTheWorkerCannotRun() {
        let client = QvacClient(transport: FakeTransport(replies: []))
        let unhandled = QvacTool(name: "lookup", description: "Looks things up")

        #expect(throws: QvacCompletionError.self) {
            try client.completion.orchestrate(modelId: "m1", history: [], tools: [unhandled])
        }
        #expect(throws: QvacCompletionError.self) {
            try client.completion.orchestrate(modelId: "m1", history: [], tools: [weather], maxToolTurns: 0)
        }
        #expect(throws: QvacCompletionError.self) {
            try client.completion.run(
                modelId: "m1", history: [], tools: [weather], options: QvacCompletionOptions(responseFormat: .jsonObject))
        }
        #expect(throws: QvacCompletionError.self) {
            try client.completion.orchestrate(
                modelId: "m1", history: [], tools: [weather], options: QvacCompletionOptions(responseFormat: .jsonObject))
        }
        #expect(throws: QvacCompletionError.self) {
            try client.completion.run(
                modelId: "m1", history: [],
                options: QvacCompletionOptions(toolSearch: QvacToolSearchLimits(defaultLimit: 5, maxLimit: 2)))
        }
    }
}
