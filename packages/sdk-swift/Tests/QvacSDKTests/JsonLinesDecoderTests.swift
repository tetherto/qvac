import Foundation
import Testing
@testable import QvacSDK

@Suite struct JsonLinesDecoderTests {
    @Test func joinsALineSplitAcrossChunks() throws {
        var decoder = JsonLinesDecoder(maxLineBytes: 1024)

        let first = try decoder.feed(Data(#"{"a":1}"#.utf8) + Data("\n{\"b\"".utf8))
        let second = try decoder.feed(Data(":2}\n\n  \n".utf8))

        #expect(first.map(text) == [#"{"a":1}"#])
        #expect(second.map(text) == [#"{"b":2}"#])
        #expect(decoder.finish().isEmpty)
    }

    @Test func returnsAnUnterminatedLastLineOnFinish() throws {
        var decoder = JsonLinesDecoder(maxLineBytes: 1024)

        #expect(try decoder.feed(Data(#"{"done":true}"#.utf8)).isEmpty)
        #expect(decoder.finish().map(text) == [#"{"done":true}"#])
    }

    @Test func rejectsALineOverTheLimit() {
        var decoder = JsonLinesDecoder(maxLineBytes: 8)

        #expect(throws: QvacWorkerProtocolError.self) {
            try decoder.feed(Data(#"{"long":"value"}"#.utf8))
        }
    }

    private func text(_ line: Data) -> String {
        String(decoding: line, as: UTF8.self)
    }
}
