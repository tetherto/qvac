// Structured errors for the OpenCode plugin. Mirrors the small branded
// hierarchy used by `@qvac/ai-sdk-provider` (stable `code`, original preserved
// via the standard `cause` option) so failures surface with a machine-readable
// code rather than a bare `Error`.

export type QvacOpencodePluginErrorCode =
  | 'INVALID_OPTION'
  | 'HOST_SPAWN_FAILED'
  | 'HOST_EXITED'
  | 'HOST_LISTEN_TIMEOUT'
  | 'HOST_INVALID_HANDSHAKE'
  | 'HOST_HANDSHAKE_CHANNEL_UNAVAILABLE'

export class QvacOpencodePluginError extends Error {
  readonly code: QvacOpencodePluginErrorCode

  constructor(code: QvacOpencodePluginErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'QvacOpencodePluginError'
    this.code = code
  }
}

export class InvalidOptionError extends QvacOpencodePluginError {
  readonly option: string

  constructor(option: string, message: string) {
    super('INVALID_OPTION', `Invalid \`${option}\` option for @qvac/opencode-plugin: ${message}`)
    this.name = 'InvalidOptionError'
    this.option = option
  }
}

export class HostSpawnFailedError extends QvacOpencodePluginError {
  constructor(message: string, cause?: unknown) {
    super('HOST_SPAWN_FAILED', message, cause === undefined ? undefined : { cause })
    this.name = 'HostSpawnFailedError'
  }
}

export class HostExitedError extends QvacOpencodePluginError {
  readonly exitCode: number | null

  constructor(exitCode: number | null) {
    super(
      'HOST_EXITED',
      `qvac serve host exited (code ${exitCode ?? 'null'}) before it began listening`
    )
    this.name = 'HostExitedError'
    this.exitCode = exitCode
  }
}

export class HostListenTimeoutError extends QvacOpencodePluginError {
  constructor(timeoutMs: number) {
    super(
      'HOST_LISTEN_TIMEOUT',
      `qvac serve host did not return a listening handshake within ${timeoutMs}ms. ` +
        'This is the proxy startup budget, not the model download — raise `listenTimeoutMs` only if the host process itself is slow to boot.'
    )
    this.name = 'HostListenTimeoutError'
  }
}

export class HostInvalidHandshakeError extends QvacOpencodePluginError {
  constructor(message: string, cause?: unknown) {
    super(
      'HOST_INVALID_HANDSHAKE',
      `qvac serve host returned an invalid QVAC_LISTENING handshake: ${message}`,
      cause === undefined ? undefined : { cause }
    )
    this.name = 'HostInvalidHandshakeError'
  }
}

export class HostHandshakeChannelUnavailableError extends QvacOpencodePluginError {
  constructor(fd: number, cause?: unknown) {
    super(
      'HOST_HANDSHAKE_CHANNEL_UNAVAILABLE',
      `qvac serve host could not write its QVAC_LISTENING handshake to fd ${fd}. ` +
        'The host must be spawned with a pipe on that descriptor; it never falls back to stdout, which would expose the token to log mirroring.',
      cause === undefined ? undefined : { cause }
    )
    this.name = 'HostHandshakeChannelUnavailableError'
  }
}
