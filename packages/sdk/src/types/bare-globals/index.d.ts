import type { Duplex } from 'bare-stream'

interface BareGlobal {
  readonly argv: string[]
  /** The host's pipe under bare-sidecar or a worklet; `null` under plain `bare`. */
  readonly IPC: Duplex | null
  exit(code?: number): void
  on(event: 'uncaughtException', listener: (err: Error) => void): BareGlobal
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): BareGlobal
}

declare global {
  const Bare: BareGlobal
}

export {}
