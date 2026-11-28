import Foundation
import Testing
@testable import QvacSDK

@Suite struct WireVariantTests {
    @Test func picksTheUnionArmByShape() throws {
        let text = try JSONDecoder().decode(
            CompletionStreamRequestHistoryItemContent.self, from: Data(#""hello""#.utf8))
        let parts = try JSONDecoder().decode(
            CompletionStreamRequestHistoryItemContent.self,
            from: Data(#"[{"type":"text","text":"hi"},{"type":"media","path":"/a.png"}]"#.utf8))

        #expect(text == .variant1("hello"))
        guard case .variant2(let items) = parts else {
            Issue.record("expected the array arm")
            return
        }
        guard case .completionStreamRequestHistoryItemContentItemMedia(let media) = items[1] else {
            Issue.record("expected the media arm")
            return
        }
        #expect(media.path == "/a.png")
    }

    @Test func encodesAUnionAsItsArm() throws {
        let encoded = try JSONEncoder().encode(CompletionStreamRequestHistoryItemContent.variant1("hello"))

        #expect(String(decoding: encoded, as: UTF8.self) == #""hello""#)
    }

    @Test func rejectsJSONNoArmMatches() {
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(CompletionStreamRequestHistoryItemContent.self, from: Data("42".utf8))
        }
    }
}
