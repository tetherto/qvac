import Darwin
import ExtensionFoundation
import Foundation
import XPC

@available(iOS 26.0, *)
extension AppExtensionPoint {
  @Definition
  static var isolationProbe: AppExtensionPoint {
    Name("isolationProbe")
    EnhancedSecurity()
  }
}

enum IsolationProbeHost {
  static func runIfRequested() {
    guard ProcessInfo.processInfo.environment["QVAC_ISOLATION_PROBE"] == "1" else {
      return
    }

    guard #available(iOS 26.0, *) else {
      fail("Enhanced Security helper extensions require iOS 26")
    }

    Task {
      do {
        try await run()
      } catch {
        fail(String(describing: error))
      }
    }
  }

  private static func fail(_ error: String) -> Never {
    print("QVAC_ISOLATION_PROBE_FAIL error=\(error)")
    fflush(stdout)
    fflush(stderr)
    exit(EXIT_FAILURE)
  }

  @available(iOS 26.0, *)
  private static func run() async throws {
    let hostPid = getpid()
    let monitor = try await AppExtensionPoint.Monitor(
      appExtensionPoint: AppExtensionPoint.isolationProbe)
    guard let identity = monitor.identities.first else {
      throw IsolationProbeError.extensionNotFound
    }

    let firstInterruption = InterruptionWaiter()
    let firstProcess = try await AppExtensionProcess(
      configuration: .init(
        appExtensionIdentity: identity,
        onInterruption: {
          firstInterruption.signal()
        }))
    let firstSession = try firstProcess.makeXPCSession()
    try firstSession.activate()
    let firstPid = try await ping(firstSession)

    guard firstPid != hostPid else {
      throw IsolationProbeError.extensionSharesHostProcess(pid: firstPid)
    }

    try firstSession.send(IsolationProbeMessage(command: .abort))
    try await firstInterruption.wait(seconds: 10)

    guard getpid() == hostPid else {
      throw IsolationProbeError.hostPidChanged(expected: hostPid, actual: getpid())
    }

    let secondProcess = try await AppExtensionProcess(
      configuration: .init(appExtensionIdentity: identity))
    let secondSession = try secondProcess.makeXPCSession()
    try secondSession.activate()
    let secondPid = try await ping(secondSession)

    guard secondPid != firstPid else {
      throw IsolationProbeError.extensionDidNotRestart(pid: secondPid)
    }

    print(
      "QVAC_ISOLATION_PROBE_PASS hostPid=\(hostPid) firstPid=\(firstPid) secondPid=\(secondPid)")
    fflush(stdout)

    withExtendedLifetime((monitor, firstProcess, secondProcess, firstSession, secondSession)) {}
  }

  @available(iOS 26.0, *)
  private static func ping(_ session: XPCSession) async throws -> Int32 {
    let response: IsolationProbeResponse = try await withCheckedThrowingContinuation {
      continuation in
      do {
        try session.send(IsolationProbeMessage(command: .ping)) {
          (result: Result<IsolationProbeResponse, any Error>) in
          continuation.resume(with: result)
        }
      } catch {
        continuation.resume(throwing: error)
      }
    }
    return response.pid
  }
}

private enum IsolationProbeError: Error, CustomStringConvertible {
  case extensionNotFound
  case extensionSharesHostProcess(pid: Int32)
  case hostPidChanged(expected: Int32, actual: Int32)
  case extensionDidNotRestart(pid: Int32)
  case interruptionTimedOut

  var description: String {
    switch self {
    case .extensionNotFound:
      return "extensionNotFound"
    case .extensionSharesHostProcess(let pid):
      return "extensionSharesHostProcess pid=\(pid)"
    case .hostPidChanged(let expected, let actual):
      return "hostPidChanged expected=\(expected) actual=\(actual)"
    case .extensionDidNotRestart(let pid):
      return "extensionDidNotRestart pid=\(pid)"
    case .interruptionTimedOut:
      return "interruptionTimedOut"
    }
  }
}

private final class InterruptionWaiter: @unchecked Sendable {
  private let lock = NSLock()
  private var interrupted = false
  private var continuation: CheckedContinuation<Void, any Error>?

  func signal() {
    lock.lock()
    interrupted = true
    let continuation = continuation
    self.continuation = nil
    lock.unlock()
    continuation?.resume()
  }

  func wait(seconds: TimeInterval) async throws {
    try await withCheckedThrowingContinuation {
      (continuation: CheckedContinuation<Void, any Error>) in
      lock.lock()
      if interrupted {
        lock.unlock()
        continuation.resume()
        return
      }
      self.continuation = continuation
      lock.unlock()

      DispatchQueue.global().asyncAfter(deadline: .now() + seconds) { [weak self] in
        guard let self else {
          return
        }
        self.lock.lock()
        guard let continuation = self.continuation else {
          self.lock.unlock()
          return
        }
        self.continuation = nil
        self.lock.unlock()
        continuation.resume(throwing: IsolationProbeError.interruptionTimedOut)
      }
    }
  }
}
