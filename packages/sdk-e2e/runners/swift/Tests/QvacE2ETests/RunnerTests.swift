import Foundation
import QvacSDK
import Testing

@testable import QvacE2E

@Suite struct PathTests {
    let record: Value = [
        "items": [["name": "a", "score": 1], ["name": "b", "score": 2]],
        "text": "hello",
        "bytes": .bytes(Data([7, 8, 9])),
        "nothing": nil,
    ]

    @Test func walksFieldsAndIndexes() throws {
        #expect(jsString(try Interpreter.walk(record, "items[1].name")) == "b")
        #expect(try Interpreter.walk(record, "items[5]").isNil)
        #expect(try Interpreter.walk(record, "bytes[2]").number == 9)
    }

    @Test func fansOutOverWildcards() throws {
        #expect(jsString(try Interpreter.walk(record, "items[*].score")) == "1,2")
    }

    @Test func readsLengths() throws {
        #expect(try Interpreter.walk(record, "items.length").number == 2)
        #expect(try Interpreter.walk(record, "text.length").number == 5)
        #expect(try Interpreter.walk(record, "bytes.length").number == 3)
    }

    @Test func refusesMissingFieldsAndNulls() {
        #expect(throws: StepError.self) { try Interpreter.walk(record, "absent") }
        #expect(throws: StepError.self) { try Interpreter.walk(record, "nothing.inner") }
    }

    @Test func namesTheLastBinding() {
        let steps: [Value] = [["call": ["method": "embed"]], ["project": ["as": "vector"]], ["assert": ["on": "$vector"]]]
        #expect(Interpreter.lastBinding(steps) == "vector")
        #expect(Interpreter.lastBinding([["call": ["method": "embed"]]]) == "result")
    }
}

@Suite struct ConcurrencyTests {
    @Test func returnsWorkThatFinishesBeforeTheDeadline() async throws {
        let missed = try await withThrowingTaskGroup(of: Bool.self) { group in
            for attempt in 0..<2000 {
                group.addTask {
                    let value = try await withTimeout(60) { () async -> Int in
                        await Task.yield()
                        return attempt
                    }
                    return value != attempt
                }
            }
            return try await group.reduce(0) { $0 + ($1 ? 1 : 0) }
        }
        #expect(missed == 0)
    }

    @Test func returnsNilAtTheDeadline() async throws {
        let value = try await withTimeout(0.05) {
            try await Task.sleep(nanoseconds: 5_000_000_000)
            return 1
        }
        #expect(value == nil)
    }
}

@Suite struct ResourcesTests {
    @Test func loadsAPlainSourceAsItIs() throws {
        let args = try Resources.loadArgs(["modelSrc": "https://example.com/model.gguf", "modelType": "llm"])
        #expect(args.src == "https://example.com/model.gguf")
        #expect(args.name == nil)
    }

    @Test func loadsADescriptorThroughItsFields() throws {
        let args = try Resources.loadArgs(["modelSrc": ["src": "pear://key/model.gguf", "engine": "llm", "name": "M"]])
        #expect(args.src == "pear://key/model.gguf")
        #expect(args.name == "M")
    }
}

@Suite struct ValueTests {
    @Test func printsLikeJavaScript() {
        #expect(jsString(2.0) == "2")
        #expect(jsString(2.5) == "2.5")
        #expect(jsString([1, nil, "x"]) == "1,,x")
        #expect(jsString(["a": 1]) == "[object Object]")
        #expect(jsType(.bytes(Data())) == "object")
    }

    @Test func comparesStrictly() {
        #expect(jsEquals(["a": [1, 2]], ["a": [1.0, 2.0]]))
        #expect(!jsEquals(1, "1"))
        #expect(!jsEquals(["a": 1], ["a": 1, "b": nil]))
    }

    @Test func summarisesLongValues() {
        let summary = summarise(.array((0..<20).map { Value($0) }))
        #expect(summary["length"].number == 20)
        #expect(summary["head"].list.count == 8)
        #expect(summarise(.bytes(Data([0xAB, 0xCD])))["head"].string == "abcd")
        #expect(summarise(.string(String(repeating: "😀", count: 300))).string?.utf16.count == 512 + 1)
    }

    @Test func readsIntegersWithinRange() {
        #expect(Value(2.9).int == 2)
        #expect(Value(1e300).int == nil)
    }

    @Test func dropsMissingFieldsFromJSON() {
        let value: Value = ["kept": nil, "dropped": .missing]
        #expect(value.json == .object(["kept": .null]))
    }
}

@Suite struct ValidationTests {
    @Test func containsAllIgnoresCase() {
        #expect(Validation.validate("Red, Orange and Yellow", ["validation": "contains-all", "contains": ["red", "yellow"]]).passed)
        #expect(!Validation.validate("red", ["validation": "contains-all", "contains": ["red", "blue"]]).passed)
    }

    @Test func numericRangeReadsLikeNumber() {
        #expect(Validation.validate(" 4 ", ["validation": "numeric-range", "min": 1, "max": 5]).passed)
        #expect(!Validation.validate("x", ["validation": "numeric-range"]).passed)
    }

    @Test func anErrorIncludesTheEmptyString() {
        #expect(Validation.validate("Undefined error: 0", ["validation": "throws-error", "errorContains": ""]).passed)
    }

    @Test func functionValidationIsAGap() {
        #expect(Validation.validate(1, ["validation": "function"]).incomplete)
    }
}

@Suite struct AssertionTests {
    func named(_ name: String, _ value: Value, _ args: Value = [:]) -> StepResult {
        Assertions.named[name]!(value, args)
    }

    @Test func unitVectors() {
        #expect(named("unitVectors", [0.6, 0.8], ["dimensions": 2, "tolerance": 0.01]).passed)
        #expect(!named("unitVectors", [1, 1], ["dimensions": 2, "tolerance": 0.01]).passed)
    }

    @Test func errorMatches() {
        let error: Value = ["code": "52404", "message": "Model not found", "hasCause": false, "details": [:]]
        #expect(named("errorMatches", error, ["code": 52404, "messageContains": "not FOUND"]).passed)
        #expect(!named("errorMatches", error, ["messageNotMatching": "found"]).passed)
    }

    @Test func fieldsPresentCountsExplicitNull() {
        #expect(named("fieldsPresent", ["a": nil], ["fields": ["a"]]).passed)
        #expect(!named("fieldsPresent", [:], ["fields": ["a"]]).passed)
    }

    @Test func cosineComparisons() {
        let compare = Assertions.comparisons["cosineAtLeast"]!
        #expect(compare([1, 0], [1, 0.1], ["min": 0.9]).passed)
        #expect(!compare([1, 0], [0, 1], ["min": 0.9]).passed)
    }

    @Test func everyNameIsRegistered() {
        let named: Set<String> = [
            "unitVectors", "lengthIs", "lengthAtLeast", "anyFieldPresent", "containsAll", "eventTypeCounts",
            "transcriptSegmentsShape", "noPartialDownloads", "anyElementPositive", "sortedAscendingBy", "noProgressBatchGaps",
            "framesAre", "safetensorsContainer", "atLeast", "isAbsent", "belowBudget", "atLeastField", "jsonObjectShape",
            "pngDimensions", "nonNegativeNumbers", "fieldsSumTo", "eventShape", "containsAny", "equalsJoined", "isEmptyText",
            "numbersInRange", "sortedDescendingBy", "sumsTo", "systemResourcesShape", "textsById", "streamedEachId",
            "noToolCallsFor", "fieldsPresent", "fieldsAbsent", "fieldsMatch", "errorIsStructured", "nonEmptyText", "errorMatches",
            "toolCallShape", "textBlockShape", "timingStatsPresent", "producedAudio", "isTrue", "positiveIntegers", "valueIn",
            "fieldEquals", "loadedModelInfoShape", "emptyArray", "mossSoundEffect",
        ]
        let comparisons: Set<String> = [
            "cosineAtLeast", "moreSimilarThan", "equalStrings", "greaterThan", "prefillReuse", "identicalBytes",
            "differentBytes", "lengthRatioAtLeast", "imageDivergesFrom",
        ]
        #expect(Set(Assertions.named.keys) == named)
        #expect(Set(Assertions.comparisons.keys) == comparisons)
    }

    @Test func badInputFailsInsteadOfCrashing() {
        #expect(named("sortedAscendingBy", [], ["field": "x", "minimum": 0]).passed)
        #expect(!named("safetensorsContainer", .bytes(Data([1, 0, 0])), ["minBytes": 0]).passed)
        let error: Value = ["message": "boom"]
        #expect(!named("errorMatches", error, ["messageNotMatching": "("]).passed)
    }
}

@Suite struct MqttPacketTests {
    private func frame(_ packet: Data) throws -> MqttPacket.Frame {
        let frame = try #require(try MqttPacket.next(packet))
        #expect(frame.length == packet.count)
        return frame
    }

    @Test func encodesRemainingLengths() throws {
        #expect(MqttPacket.remainingLength(0) == Data([0x00]))
        #expect(MqttPacket.remainingLength(127) == Data([0x7F]))
        #expect(MqttPacket.remainingLength(128) == Data([0x80, 0x01]))
        #expect(MqttPacket.remainingLength(16_383) == Data([0xFF, 0x7F]))
        #expect(MqttPacket.remainingLength(2_097_152) == Data([0x80, 0x80, 0x80, 0x01]))
        let large = MqttPacket.packet(0x30, Data(count: 300))
        #expect(try frame(large).body.count == 300)
    }

    @Test func waitsForAWholePacket() throws {
        let packet = MqttPacket.pubAck(7)
        #expect(try MqttPacket.next(packet.prefix(3)) == nil)
        #expect(throws: MqttError.self) { try MqttPacket.next(Data([0x30, 0xFF, 0xFF, 0xFF, 0xFF, 0x01])) }
    }

    @Test func connectsWith311() {
        let packet = MqttPacket.connect(
            version: 4, clientId: "c", username: "u", password: "p", keepAlive: 30, sessionExpiry: nil)
        let body: [UInt8] = [0, 4] + Array("MQTT".utf8) + [4, 0xC0, 0, 30, 0, 1, 0x63, 0, 1, 0x75, 0, 1, 0x70]
        #expect(packet == Data([0x10, UInt8(body.count)] + body))
    }

    @Test func dropsAPasswordWithoutAUsernameOn311Only() {
        let v4 = MqttPacket.connect(version: 4, clientId: "c", username: nil, password: "p", keepAlive: 30, sessionExpiry: nil)
        #expect(v4[9] == 0x00)
        #expect(v4.count == 2 + 10 + 3)
        let v5 = MqttPacket.connect(version: 5, clientId: "c", username: nil, password: "p", keepAlive: 30, sessionExpiry: nil)
        #expect(v5[9] == 0x40)
    }

    @Test func connectsWith5AndASessionExpiry() {
        let packet = MqttPacket.connect(
            version: 5, clientId: "c", username: nil, password: nil, keepAlive: 30, sessionExpiry: 7200)
        let body: [UInt8] = [0, 4] + Array("MQTT".utf8) + [5, 0x00, 0, 30, 5, 0x11, 0, 0, 0x1C, 0x20, 0, 1, 0x63]
        #expect(packet == Data([0x10, UInt8(body.count)] + body))
    }

    @Test func roundTripsPublishes() throws {
        for version: UInt8 in [4, 5] {
            let qos0 = MqttPacket.Publish(topic: "a/b", qos: 0, packetId: nil, dup: false, payload: Data("hi".utf8))
            let qos1 = MqttPacket.Publish(topic: "a/b", qos: 1, packetId: 513, dup: true, payload: Data("{}".utf8))
            for publish in [qos0, qos1] {
                let decoded = try frame(MqttPacket.publish(version: version, publish))
                #expect(decoded.type == MqttPacket.publishType)
                #expect(try MqttPacket.publish(decoded.body, flags: decoded.flags, version: version) == publish)
            }
        }
        let v4 = MqttPacket.publish(version: 4, .init(topic: "t", qos: 0, packetId: nil, dup: false, payload: Data()))
        let v5 = MqttPacket.publish(version: 5, .init(topic: "t", qos: 0, packetId: nil, dup: false, payload: Data()))
        #expect(v5.count == v4.count + 1)
        #expect(MqttPacket.publish(version: 4, .init(topic: "t", qos: 1, packetId: 1, dup: true, payload: Data()))[0] == 0x3A)
    }

    @Test func roundTripsPubAcks() throws {
        let decoded = try frame(MqttPacket.pubAck(0x0102))
        #expect(decoded.type == MqttPacket.pubAckType)
        #expect(try MqttPacket.pubAck(decoded.body) == .init(packetId: 0x0102, code: 0))
        #expect(try MqttPacket.pubAck(Data([0, 9, 0x87])) == .init(packetId: 9, code: 0x87))
    }

    @Test func encodesSubscribesAndReadsSubAcks() throws {
        let v4 = MqttPacket.subscribe(version: 4, packetId: 3, topics: ["x"])
        #expect(v4 == Data([0x82, 6, 0, 3, 0, 1, 0x78, 1]))
        let v5 = MqttPacket.subscribe(version: 5, packetId: 3, topics: ["x"])
        #expect(v5 == Data([0x82, 7, 0, 3, 0, 0, 1, 0x78, 1]))
        #expect(try MqttPacket.subAck(Data([0, 3, 1, 0x80]), version: 4) == .init(packetId: 3, codes: [1, 0x80]))
        #expect(try MqttPacket.subAck(Data([0, 3, 3, 0x1F, 0, 0, 1]), version: 5) == .init(packetId: 3, codes: [1]))
    }

    @Test func readsConnAcks() throws {
        #expect(try MqttPacket.connAck(Data([1, 0]), version: 4) == .init(sessionPresent: true, code: 0))
        let properties: [UInt8] = [0x21, 0, 10, 0x13, 0, 60, 0x22, 0, 5, 0x12, 0, 1, 0x61]
        let v5 = try MqttPacket.connAck(Data([0, 0, UInt8(properties.count)] + properties), version: 5)
        #expect(v5 == .init(sessionPresent: false, code: 0, receiveMaximum: 10, serverKeepAlive: 60))
        #expect(throws: MqttError.self) { try MqttPacket.connAck(Data([0, 0, 2, 0x7F, 0]), version: 5) }
    }

    @Test func readsDisconnectReasons() throws {
        #expect(try MqttPacket.disconnectReason(Data(), version: 4) == nil)
        #expect(try MqttPacket.disconnectReason(Data([0x8E]), version: 5) == "reason 0x8E")
        let reason: [UInt8] = [0x8E, 6, 0x1F, 0, 3] + Array("dup".utf8)
        #expect(try MqttPacket.disconnectReason(Data(reason), version: 5) == "reason 0x8E: dup")
        #expect(MqttPacket.disconnect(version: 4) == Data([0xE0, 0]))
        #expect(MqttPacket.disconnect(version: 5) == Data([0xE0, 7, 0, 5, 0x11, 0, 0, 0, 0]))
    }
}

@Suite struct MediaTests {
    @Test func synthesizesHexBytes() throws {
        #expect(try Media.synthesizeBytes("00ff10") == Data([0x00, 0xFF, 0x10]))
        #expect(throws: StepError.self) { try Media.synthesizeBytes("abc") }
    }

    @Test func synthesizesTones() throws {
        #expect(try Media.synthesizeTone("0.01s-440hz").count == 480 * 2 * 4)
    }

    @Test func roundTripsWav() throws {
        var wav = Data("RIFF".utf8) + le(36 + 4, 4) + Data("WAVE".utf8)
        wav += Data("fmt ".utf8) + le(16, 4) + le(1, 2) + le(1, 2) + le(16000, 4) + le(32000, 4) + le(2, 2) + le(16, 2)
        wav += Data("data".utf8) + le(4, 4) + le(16384, 2) + le(0xC000, 2)
        let decoded = try Media.decodeWavToMonoF32(wav)
        #expect(decoded.sampleRate == 16000)
        #expect(decoded.samplesMono == [0.5, -0.5])
        #expect(Media.f32ToS16LeBytes(decoded.samplesMono) == le(16384, 2) + le(0xC001, 2))
    }

    private func le(_ value: Int, _ bytes: Int) -> Data {
        Data((0..<bytes).map { UInt8(truncatingIfNeeded: value >> ($0 * 8)) })
    }
}

@Suite struct ConsumerTests {
    @Test func coarseSkipsWidenOverTheOperatingSystemOnly() {
        #expect(Platforms.matches(["swift"], "swift-ios"))
        #expect(!Platforms.matches(["mobile"], "swift-ios"))
        #expect(!Platforms.matches(["swift-macos"], "swift-ios"))
    }

    @Test func skipReasonsAreTheLegsOwn() {
        let definition: Value = [
            "skip": [
                "platforms": ["swift-ios", "mobile-android"],
                "reason": "both",
                "reasons": [["platforms": ["swift-ios"], "reason": "memory"], ["platforms": ["mobile-android"], "reason": "flaky"]],
            ]
        ]
        #expect(Platforms.skipReason(definition, "swift-ios") == "memory")
        #expect(Platforms.skipReason(definition, "swift-macos") == nil)
    }

    @Test func theLaunchEnvironmentOverridesTheBakedRun() throws {
        let baked: Value = ["runId": "baked", "mqtt": ["host": "broker", "port": "1883", "sessionExpiryInterval": 7200]]
        let local = try ConsumerConfig.resolve(baked: baked, environment: ["QVAC_RUN_ID": "local", "QVAC_MQTT_BROKER_URL": "ws://host:8080"])
        #expect(local.runId == "local")
        #expect(local.platform == "swift-ios")
        #expect(local.mqtt.url == "ws://host:8080")
        #expect(local.mqtt.sessionExpiryInterval == 7200)
        let ci = try ConsumerConfig.resolve(baked: baked, environment: [:])
        #expect(ci.mqtt.url == "ws://broker:1883/mqtt")
        let zero = try ConsumerConfig.resolve(baked: baked, environment: ["QVAC_MQTT_SESSION_EXPIRY": "0"])
        #expect(zero.mqtt.sessionExpiryInterval == 7200)
        #expect(throws: MqttError.self) {
            try ConsumerConfig.resolve(baked: baked, environment: ["QVAC_MQTT_BROKER_URL": "not a url"])
        }
    }
}

@Suite struct WireTests {
    @Test func bindsWorkerErrors() {
        let error = QvacError(payload: [
            "name": .string("MODEL_NOT_FOUND"), "code": .number(52404), "message": .string("gone"),
            "typedFields": .object(["tokens": .number(9)]), "cause": .string("disk"),
        ])
        let binding = Wire.errorBinding(error)
        #expect(binding["code"].string == "52404")
        #expect(binding["hasCause"].isTrue)
        #expect(binding["details"]["tokens"].number == 9)
        #expect(binding["details"]["name"].string == "MODEL_NOT_FOUND")
        #expect(!binding["details"].has("cause"))
    }

    @Test func decodesTtsSamples() {
        let frame: Value = ["pcm": .string(Data([0x01, 0x00, 0xFF, 0xFF]).base64EncodedString())]
        #expect(jsString(.array(Wire.ttsSamples(frame))) == "1,-1")
    }
}
