import { getClientLogger } from '@/logging'

export interface CommandLoggerOptions {
  quiet?: boolean | undefined
  verbose?: boolean | undefined
}

export function createCommandLogger(options: CommandLoggerOptions) {
  if (options.quiet) {
    return getClientLogger({ level: 'error', enableConsole: false })
  }
  if (options.verbose) {
    return getClientLogger({ level: 'debug' })
  }
  return getClientLogger()
}
