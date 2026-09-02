import { isLoopbackHost } from '@/serve/cors'

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

export interface NetworkExposureOptions {
  readonly host: string
  readonly apiKey?: string | undefined
  readonly allowUnauthenticated?: boolean | undefined
}

// Throws for an unauthenticated non-loopback bind unless the operator opted in,
// in which case the returned warning is theirs to see. Checked during option
// resolution so it lands before the port opens and before a multi-minute preload.
export function checkNetworkExposure(options: NetworkExposureOptions): string | undefined {
  if (isLoopbackHost(options.host) || options.apiKey) return undefined
  if (options.allowUnauthenticated === true) {
    return `Security warning: binding to non-loopback host "${options.host}" without an API key. Anyone who can reach this address can use this server.`
  }
  throw new ServeOptionsError(
    '--host',
    `binding to non-loopback host "${options.host}" would expose an unauthenticated API to the network. ` +
      'Pass --api-key <key> or --api-key-file <path> to require authentication, or --allow-unauthenticated to accept the risk.'
  )
}
