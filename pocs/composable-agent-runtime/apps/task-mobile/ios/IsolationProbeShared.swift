import Foundation

enum IsolationProbeCommand: String, Codable, Sendable {
  case ping
  case abort
}

struct IsolationProbeMessage: Codable, Sendable {
  let command: IsolationProbeCommand
}

struct IsolationProbeResponse: Codable, Sendable {
  let pid: Int32
}
