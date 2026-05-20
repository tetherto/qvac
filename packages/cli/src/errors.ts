export class ConfigNotFoundError extends Error {
  constructor (explicitPath: string | null, candidates: string[] = []) {
    const message = explicitPath
      ? `Config file not found: ${explicitPath}`
      : `No config file found. Create one of:\n${candidates.map((c) => `  - ${c}`).join('\n')}`
    super(message)
    this.name = 'ConfigNotFoundError'
  }
}

export class ConfigLoadError extends Error {
  override cause: unknown
  constructor (configPath: string, cause: unknown) {
    const causeMessage =
      cause instanceof Error ? cause.message : String(cause)
    super(`Failed to load config from ${configPath}: ${causeMessage}`)
    this.name = 'ConfigLoadError'
    this.cause = cause
  }
}

const ERROR_LABELS: Record<string, string> = {
  ConfigNotFoundError: 'Configuration Error',
  ConfigLoadError: 'Config Load Error',
  LockfileReadError: 'Lockfile Error',
  LockfileNotFoundAtRefError: 'Lockfile Error',
  UnsupportedLockfileError: 'Lockfile Error'
}

export function handleError (error: unknown): void {
  if (error instanceof Error) {
    const label = ERROR_LABELS[error.name]
    if (label) {
      console.error(`\n❌ ${label}:`)
      console.error(`   ${error.message}\n`)
    } else {
      console.error('\n❌ Error:', error.message)
      if (process.env['DEBUG']) {
        console.error(error.stack)
      }
    }
  } else {
    console.error('\n❌ Error:', error)
  }
}
