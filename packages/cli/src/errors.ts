export class ConfigNotFoundError extends Error {
  constructor(explicitPath: string | null, candidates: string[] = []) {
    const message = explicitPath
      ? `Config file not found: ${explicitPath}`
      : `No config file found. Create one of:\n${candidates.map((c) => `  - ${c}`).join('\n')}`
    super(message)
    this.name = 'ConfigNotFoundError'
  }
}

export class ConfigLoadError extends Error {
  override cause: unknown
  constructor(configPath: string, cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause)
    super(`Failed to load config from ${configPath}: ${causeMessage}`)
    this.name = 'ConfigLoadError'
    this.cause = cause
  }
}

// Keys are `error.name` values. QvacErrorBase sets `.name` from the SDK's
// error-code definitions in packages/sdk/schemas/sdk-errors-client.ts —
// hence the SCREAMING_SNAKE entries below mirror the bundle/verify error
// classes that moved from this package into @qvac/sdk.
const ERROR_LABELS: Record<string, string> = {
  ConfigNotFoundError: 'Configuration Error',
  ConfigLoadError: 'Config Load Error',
  LockfileReadError: 'Lockfile Error',
  LockfileNotFoundAtRefError: 'Lockfile Error',
  UnsupportedLockfileError: 'Lockfile Error',
  INVALID_PLUGIN_SPECIFIER: 'Plugin Error',
  BARE_PACK_NOT_INSTALLED: 'Bundler Error',
  BARE_PACK_ERROR: 'Bundle Failed',
  BARE_IMPORTS_MAP_NOT_FOUND: 'SDK Error',
  SDK_NOT_FOUND_IN_NODE_MODULES: 'SDK Error',
  MULTIPLE_SDK_INSTALLATIONS: 'SDK Error'
}

export function handleError(error: unknown): void {
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
