import Foundation

/// A value behind a lock.
final class Locked<State>: @unchecked Sendable {
    private let lock = NSLock()
    private var state: State

    init(_ state: State) {
        self.state = state
    }

    func withLock<Result>(_ body: (inout State) throws -> Result) rethrows -> Result {
        lock.lock()
        defer { lock.unlock() }
        return try body(&state)
    }
}

/// A value that arrives once, which any number of callers can wait for.
final class Promise<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var result: Result<T, Error>?
    private var waiters: [CheckedContinuation<T, Error>] = []

    var isCompleted: Bool {
        lock.lock()
        defer { lock.unlock() }
        return result != nil
    }

    func complete(_ outcome: Result<T, Error>) {
        lock.lock()
        guard result == nil else {
            lock.unlock()
            return
        }
        result = outcome
        let waiting = waiters
        waiters = []
        lock.unlock()
        for waiter in waiting { waiter.resume(with: outcome) }
    }

    func value() async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            if let result {
                lock.unlock()
                continuation.resume(with: result)
            } else {
                waiters.append(continuation)
                lock.unlock()
            }
        }
    }
}

/// Runs `operation`, or returns nil once `seconds` have passed, without waiting for an operation
/// that ignores cancellation. On a timeout the operation is cancelled, `onTimeout` runs, and the
/// operation gets up to `grace` more seconds to finish its cleanup before this returns. Cancelling
/// the caller cancels the operation.
public func withTimeout<T: Sendable>(
    _ seconds: Double, grace: Double = 0, onTimeout: @escaping @Sendable () -> Void = {},
    _ operation: @escaping @Sendable () async throws -> T
) async throws -> T? {
    let work = Task { try await operation() }
    let outcome = await withTaskCancellationHandler {
        await race(work, seconds)
    } onCancel: {
        work.cancel()
    }
    if let outcome { return try outcome.get() }
    work.cancel()
    onTimeout()
    if grace > 0 { _ = await race(work, grace) }
    return nil
}

/// The work's result, or nil once `seconds` have passed.
private func race<T: Sendable>(_ work: Task<T, Error>, _ seconds: Double) async -> Result<T, Error>? {
    let settled = Locked(false)
    let claim: @Sendable () -> Bool = { settled.withLock { done in defer { done = true }; return !done } }
    return await withCheckedContinuation { (continuation: CheckedContinuation<Result<T, Error>?, Never>) in
        let sleeper = Task {
            do {
                try await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
            } catch {
                return
            }
            if claim() { continuation.resume(returning: nil) }
        }
        Task {
            let result = await work.result
            if claim() { continuation.resume(returning: result) }
            sleeper.cancel()
        }
    }
}

func sleep(milliseconds: Double) async {
    try? await Task.sleep(nanoseconds: UInt64(max(0, milliseconds) * 1_000_000))
}
