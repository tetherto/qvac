import type { Duplex } from 'bare-stream'

interface BareGlobal {
  readonly argv: string[]
  readonly IPC: Duplex
  exit(code?: number): void
  on(event: 'beforeExit', listener: (code: number) => void): BareGlobal
  on(event: 'uncaughtException', listener: (err: Error) => void): BareGlobal
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): BareGlobal
}

declare global {
  const Bare: BareGlobal
}

export {}
