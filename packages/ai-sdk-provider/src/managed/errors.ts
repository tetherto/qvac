// Structured errors for managed mode. The provider is a standalone npm package
// and does not depend on `@qvac/sdk`'s error infrastructure, so we ship a small
// branded error hierarchy here. Every error carries a stable `code` and
// preserves the original via the standard `cause` option.

export type QvacManagedErrorCode =
  | 'UNKNOWN_MODEL'
  | 'DUPLICATE_MODEL'
  | 'MULTIPLE_DEFAULTS'
  | 'CLI_NOT_FOUND'
  | 'SERVE_SPAWN_FAILED'
  | 'SERVE_START_TIMEOUT'
  | 'SERVE_EXITED'
  | 'PORT_ALLOCATION_FAILED'

export class QvacManagedModeError extends Error {
  readonly code: QvacManagedErrorCode

  constructor (code: QvacManagedErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'QvacManagedModeError'
    this.code = code
  }
}

export class UnknownManagedModelError extends QvacManagedModeError {
  readonly unknownModels: readonly string[]

  constructor (unknownModels: readonly string[]) {
    super(
      'UNKNOWN_MODEL',
      `Unknown QVAC model constant(s): ${unknownModels.join(', ')}. ` +
        'Pass valid SDK model names (e.g. QWEN3_600M_INST_Q4); see the `models` export for the full catalog.'
    )
    this.name = 'UnknownManagedModelError'
    this.unknownModels = unknownModels
  }
}

export class DuplicateManagedModelError extends QvacManagedModeError {
  readonly duplicateModels: readonly string[]

  constructor (duplicateModels: readonly string[]) {
    super(
      'DUPLICATE_MODEL',
      `Duplicate model name(s) in managed \`models\`: ${duplicateModels.join(', ')}. ` +
        'Each model becomes a single serve alias, so list each name at most once ' +
        '(a repeat would silently overwrite the earlier entry, including its `default`).'
    )
    this.name = 'DuplicateManagedModelError'
    this.duplicateModels = duplicateModels
  }
}

export class MultipleDefaultManagedModelsError extends QvacManagedModeError {
  readonly defaultModels: readonly string[]

  constructor (defaultModels: readonly string[]) {
    super(
      'MULTIPLE_DEFAULTS',
      `More than one managed model sets \`default: true\`: ${defaultModels.join(', ')}. ` +
        'A serve has a single default alias — mark exactly one model as default ' +
        '(or none, and the first model becomes the default).'
    )
    this.name = 'MultipleDefaultManagedModelsError'
    this.defaultModels = defaultModels
  }
}

export class CliNotFoundError extends QvacManagedModeError {
  constructor (cause?: unknown) {
    super(
      'CLI_NOT_FOUND',
      'Managed mode requires the `@qvac/cli` package. Install it (e.g. `npm i @qvac/cli`) ' +
        'or pass `serveBinPath` pointing at a `qvac` executable.',
      cause === undefined ? undefined : { cause }
    )
    this.name = 'CliNotFoundError'
  }
}

export class ServeSpawnFailedError extends QvacManagedModeError {
  constructor (message: string, cause?: unknown) {
    super('SERVE_SPAWN_FAILED', message, cause === undefined ? undefined : { cause })
    this.name = 'ServeSpawnFailedError'
  }
}

export class ServeStartTimeoutError extends QvacManagedModeError {
  constructor (timeoutMs: number, baseURL: string) {
    super(
      'SERVE_START_TIMEOUT',
      `qvac serve did not become healthy at ${baseURL} within ${timeoutMs}ms. ` +
        'Cold model downloads can be slow — raise `serveStartTimeout` if the model is large.'
    )
    this.name = 'ServeStartTimeoutError'
  }
}

export class ServeExitedError extends QvacManagedModeError {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null

  constructor (exitCode: number | null, signal: NodeJS.Signals | null, tail: string) {
    super(
      'SERVE_EXITED',
      `qvac serve exited before becoming healthy (code=${String(exitCode)}, signal=${String(signal)}).` +
        (tail ? `\n--- serve output ---\n${tail}` : '')
    )
    this.name = 'ServeExitedError'
    this.exitCode = exitCode
    this.signal = signal
  }
}

export class PortAllocationFailedError extends QvacManagedModeError {
  constructor (cause?: unknown) {
    super(
      'PORT_ALLOCATION_FAILED',
      'Failed to allocate a free port for qvac serve.',
      cause === undefined ? undefined : { cause }
    )
    this.name = 'PortAllocationFailedError'
  }
}
