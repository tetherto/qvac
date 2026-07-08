interface BareRuntime {
  readonly argv: string[]
  exit(code?: number): void
  on(event: 'uncaughtException', listener: (err: Error) => void): BareRuntime
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): BareRuntime
}

declare global {
  const Bare: BareRuntime

  const console: {
    log(...data: unknown[]): void
    error(...data: unknown[]): void
    warn(...data: unknown[]): void
    info(...data: unknown[]): void
    debug(...data: unknown[]): void
  }

  function setTimeout(
    callback: (...args: never[]) => void,
    ms?: number,
    ...args: unknown[]
  ): unknown
  function clearTimeout(handle?: unknown): void

  function setImmediate(callback: (...args: never[]) => void, ...args: unknown[]): unknown

  function btoa(data: string): string
  function atob(data: string): string
}

export {}
