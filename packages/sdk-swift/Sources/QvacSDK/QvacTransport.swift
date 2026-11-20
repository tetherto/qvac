import Foundation

/// Carries JSON requests to a worker. Each payload and each element yielded is
/// one JSON object.
public protocol QvacTransport: Sendable {
    func call(_ payload: Data) async throws -> Data

    func stream(_ payload: Data) -> AsyncThrowingStream<Data, Error>

    /// Sends `payload`, then each chunk of `input`, on one request stream.
    func duplex(_ payload: Data, input: AsyncStream<Data>) -> AsyncThrowingStream<Data, Error>

    func close() async
}
