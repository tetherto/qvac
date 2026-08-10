import { isLoopbackHost } from './cors.js'

export class ServeOptionsError extends Error {
  readonly option: string

  constructor(option: string, message: string) {
    super(message)
    this.name = 'ServeOptionsError'
    this.option = option
  }
}

export interface ServeStartupOptions {
  readonly cors?: boolean | undefined
  readonly docs?: boolean | undefined
  readonly port: number
}

export function validateServeStartup(
  trustedOrigins: readonly string[],
  options: ServeStartupOptions
): void {
  if (options.cors === true && trustedOrigins.length === 0) {
    throw new ServeOptionsError(
      '--cors',
      '--cors requires at least one explicit origin from --cors-origin or serve.cors.origins'
    )
  }
  // The docs allowlist is derived from the configured port, which is only known
  // after bind when it is 0 — so `--docs --port 0` could only ever allow
  // `http://localhost:0`, which no browser sends.
  if (options.docs === true && options.port === 0) {
    throw new ServeOptionsError(
      '--docs',
      '--docs requires a fixed --port: the trusted loopback origins for Swagger UI are derived ' +
        'from the port, and --port 0 is resolved only after the listener binds. Choose a port ' +
        '(e.g. --port 11434), or drop --docs and read the spec from /openapi.json.'
    )
  }
}

// Returned rather than logged so callers can emit it during option resolution,
// before the port is open and before a multi-minute model preload.
export function networkExposureWarning(options: {
  readonly host: string
  readonly apiKey?: string | undefined
}): string | undefined {
  if (isLoopbackHost(options.host) || options.apiKey) return undefined
  return `Security warning: binding to non-loopback host "${options.host}" without --api-key exposes the API to the network.`
}
