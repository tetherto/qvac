import type { ChildSpec } from './index.js'

export interface StowLogger {
  info?(...args: unknown[]): void
  warn?(...args: unknown[]): void
}

export interface StowIpc {
  ready: Promise<void>
  on(event: string, listener: (data: unknown) => void): unknown
  write(data: Uint8Array): unknown
  destroy(): void
}

// the host's spawn primitive: boot the bundle, hand back its wire and a death signal
export type StowRunner = (
  entry: string,
  args: string[],
  logger: StowLogger | null
) => { ipc: StowIpc; exit: Promise<number> }

export interface StowChildOptions<T = StowIpc> {
  runner: StowRunner
  args?: string[]
  logger?: StowLogger | null
  create?(ipc: StowIpc): T | Promise<T>
  deps?: string[]
  restart?: 'always' | 'never'
  maxRestarts?: number
  window?: number
  backoff?: number
  maxBackoff?: number
  suspend?(handle: T): unknown
  resume?(handle: T): unknown
}

export default function stowChild<T = StowIpc>(
  entry: string,
  opts?: StowChildOptions<T>
): ChildSpec<T>
