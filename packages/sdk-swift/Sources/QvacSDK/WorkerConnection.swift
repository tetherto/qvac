import BareRPC
import BareStowHost
import Foundation

extension BareStowHost.IPC: BareRPC.Transport {}

/// JSON requests to a worker over one bare-rpc session. Closing it terminates
/// the worker.
final class WorkerConnection: QvacTransport, @unchecked Sendable {
    private let rpc: RPC
    private let maxFrameBytes: Int
    private let keepAlive: AnyObject?

    init<Base: BareRPC.Transport>(_ transport: Base, maxFrameBytes: Int, keepAlive: AnyObject? = nil) {
        self.maxFrameBytes = maxFrameBytes
        self.keepAlive = keepAlive
        rpc = RPC(
            FrameGuard(transport, maxFrameBytes: maxFrameBytes),
            maxFrameSize: maxFrameBytes,
            maxBufferedBytes: 4 * maxFrameBytes)
    }

    func call(_ payload: Data) async throws -> Data {
        do {
            guard let reply = try await rpc.request(0, data: payload) else {
                throw QvacWorkerProtocolError("worker sent an empty reply")
            }
            return reply
        } catch {
            throw workerError(error)
        }
    }

    func stream(_ payload: Data) -> AsyncThrowingStream<Data, Error> {
        lines { rpc, _ in
            (try await rpc.requestWithResponseStream(command: 0, data: payload), nil)
        }
    }

    func duplex(_ payload: Data, input: AsyncStream<Data>) -> AsyncThrowingStream<Data, Error> {
        lines { rpc, fail in
            let (outgoing, incoming) = try await rpc.createBidirectionalStream(command: 0)
            let writer = Task {
                do {
                    try await outgoing.write(payload)
                    for await chunk in input { try await outgoing.write(chunk) }
                } catch {
                    fail(error)
                }
                await outgoing.end()
            }
            return (incoming, {
                writer.cancel()
                await outgoing.end()
            })
        }
    }

    func close() async {
        await rpc.close()
    }

    /// The JSON lines of the reply stream `open` starts. When the lines end, the
    /// request's input ends and its reply closes on the worker. `open` gets a
    /// `fail` that ends the lines with an error, such as a failed write of the
    /// request's input.
    private func lines(
        _ open: @escaping @Sendable (RPC, _ fail: @escaping @Sendable (Error) -> Void) async throws
            -> (IncomingStream, (@Sendable () async -> Void)?)
    ) -> AsyncThrowingStream<Data, Error> {
        let rpc = rpc
        let maxLineBytes = maxFrameBytes
        let opened = OpenedStream()
        return AsyncThrowingStream { continuation in
            let fail: @Sendable (Error) -> Void = { error in
                continuation.finish(throwing: workerError(error))
                Task { await opened.stop() }
            }
            let reader = Task {
                do {
                    let (incoming, endInput) = try await open(rpc, fail)
                    guard await opened.set(incoming, endInput) else { return }
                    var decoder = JsonLinesDecoder(maxLineBytes: maxLineBytes)
                    for try await chunk in incoming {
                        for line in try decoder.feed(chunk) { continuation.yield(line) }
                    }
                    for line in decoder.finish() { continuation.yield(line) }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: workerError(error))
                }
            }
            continuation.onTermination = { _ in
                reader.cancel()
                Task { await opened.stop() }
            }
        }
    }
}

/// The reply stream of a request once open, so that a reader that stops can
/// close it whether or not it has opened yet.
private actor OpenedStream {
    private var incoming: IncomingStream?
    private var endInput: (@Sendable () async -> Void)?
    private var stopped = false

    func set(_ incoming: IncomingStream, _ endInput: (@Sendable () async -> Void)?) async -> Bool {
        guard !stopped else {
            await endInput?()
            await incoming.destroy()
            return false
        }
        self.incoming = incoming
        self.endInput = endInput
        return true
    }

    func stop() async {
        guard !stopped else { return }
        stopped = true
        await endInput?()
        await incoming?.destroy()
    }
}

func workerError(_ error: Error) -> Error {
    switch error {
    case let error as BareStowHost.WorkerError:
        return QvacWorkerError(code: error.code, message: error.message, exitCode: error.exitCode)
    case RPCError.channelClosed:
        return QvacWorkerError(code: "WORKER_CLOSED", message: "The worker connection is closed")
    case let error as RPCRemoteError where error.code == FrameSplitter.frameTooLarge:
        return QvacWorkerProtocolError(error.message)
    case let error as RPCError:
        return QvacWorkerProtocolError(String(describing: error))
    default:
        return error
    }
}
