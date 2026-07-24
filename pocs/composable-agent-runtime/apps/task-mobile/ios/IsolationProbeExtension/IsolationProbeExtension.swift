import Darwin
import ExtensionFoundation
import XPC

protocol IsolationProbeExtension: AppExtension {}

extension IsolationProbeExtension {
  var configuration: some AppExtensionConfiguration {
    ConnectionHandler(onSessionRequest: { request in
      request.accept { _ in
        IsolationProbeMessageHandler()
      }
    })
  }
}

private struct IsolationProbeMessageHandler: XPCPeerHandler, Sendable {
  func handleIncomingRequest(
    _ message: IsolationProbeMessage
  ) -> (any Encodable)? {
    switch message.command {
    case .ping:
      return IsolationProbeResponse(pid: getpid())
    case .abort:
      abort()
    }
  }
}

@main
struct IsolationProbeHelper: IsolationProbeExtension {
  @AppExtensionPoint.Bind
  var boundExtensionPoint: AppExtensionPoint {
    AppExtensionPoint.Identifier(
      host: "com.qvac.poc.composable-runtime",
      name: "isolationProbe")
  }
}
