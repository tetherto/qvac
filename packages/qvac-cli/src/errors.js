// ─────────────────────────────────────────────────────────────────────────────
// Config Errors
// ─────────────────────────────────────────────────────────────────────────────

export class ConfigNotFoundError extends Error {
  constructor (explicitPath, candidates = []) {
    const message = explicitPath
      ? `Config file not found: ${explicitPath}`
      : `No config file found. Create one of:\n${candidates.map((c) => `  - ${c}`).join('\n')}`
    super(message)
    this.name = 'ConfigNotFoundError'
  }
}

export class ConfigLoadError extends Error {
  constructor (configPath, cause) {
    const causeMessage =
      cause instanceof Error ? cause.message : String(cause)
    super(`Failed to load config from ${configPath}: ${causeMessage}`)
    this.name = 'ConfigLoadError'
    this.cause = cause
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugin Errors
// ─────────────────────────────────────────────────────────────────────────────

export class InvalidPluginSpecifierError extends Error {
  constructor (specifiers) {
    const list = specifiers.map((s) => `  - ${s}`).join('\n')
    super(`Invalid plugin specifiers (must end with /plugin):\n${list}`)
    this.name = 'InvalidPluginSpecifierError'
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bundler Errors
// ─────────────────────────────────────────────────────────────────────────────

export class BarePackNotInstalledError extends Error {
  constructor () {
    super(
      'bare-pack binary not found.\n\n' +
      '  This indicates a corrupted @qvac/cli installation.\n' +
      '  Try reinstalling: npm install @qvac/cli'
    )
    this.name = 'BarePackNotInstalledError'
  }
}

export class BarePackError extends Error {
  constructor (exitCode, entryPath, outputPath) {
    super(
      `bare-pack exited with code ${exitCode}\n\n` +
      `  Entry file: ${entryPath}\n` +
      `  Output file: ${outputPath}\n\n` +
      '  Run bare-pack manually for more details.'
    )
    this.name = 'BarePackError'
    this.entryPath = entryPath
    this.outputPath = outputPath
  }
}

export class BareImportsMapNotFoundError extends Error {
  constructor (sdkName, expectedPath) {
    super(
      'bare-imports.json not found.\n\n' +
      `  Expected at: ${expectedPath}\n\n` +
      `  Make sure ${sdkName} is installed in your project.`
    )
    this.name = 'BareImportsMapNotFoundError'
    this.sdkName = sdkName
    this.expectedPath = expectedPath
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Error Handler (for CLI output)
// ─────────────────────────────────────────────────────────────────────────────

const ERROR_LABELS = {
  ConfigNotFoundError: 'Configuration Error',
  ConfigLoadError: 'Config Load Error',
  InvalidPluginSpecifierError: 'Plugin Error',
  BarePackNotInstalledError: 'Bundler Error',
  BarePackError: 'Bundle Failed',
  BareImportsMapNotFoundError: 'SDK Error'
}

export function handleError (error) {
  if (error instanceof Error) {
    const label = ERROR_LABELS[error.name]
    if (label) {
      console.error(`\n❌ ${label}:`)
      console.error(`   ${error.message}\n`)
    } else {
      console.error('\n❌ Error:', error.message)
      if (process.env.DEBUG) {
        console.error(error.stack)
      }
    }
  } else {
    console.error('\n❌ Error:', error)
  }
}
