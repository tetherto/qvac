export interface StartContext {
  get<T = unknown>(name: string): T
  onDeath(error?: Error): void
}

export interface ChildSpec<T = unknown> {
  start(ctx: StartContext): T | Promise<T>
  stop?(handle: T): unknown
  suspend?(handle: T): unknown
  resume?(handle: T): unknown
  inspect?(handle: T): unknown
  deps?: string[]
  restart?: 'always' | 'never'
  maxRestarts?: number
  window?: number
  backoff?: number
  maxBackoff?: number
}

export type ChildState = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' | 'failed'

export interface ChildInfo {
  name: string
  state: ChildState
  lives: number
  deps: string[]
  error?: string
  uptime: number | null
  deaths: number
  info?: unknown
}

export interface SupervisorOptions {
  stallTimeout?: number
}

export interface SuspendOptions {
  linger?: number
}

export interface SupervisorEvents {
  'child-ready': { name: string; lives: number }
  'child-died': { name: string; error: Error }
  'child-restarting': { name: string; delay: number }
  'child-stopped': { name: string }
  'child-reloaded': { name: string }
  'gave-up': { name: string; error: Error }
  'suspend-coalesced': void
  stall: { name: string }
}

export default class Supervisor {
  constructor(opts?: SupervisorOptions)

  readonly opened: boolean
  readonly closing: Promise<void> | null
  readonly closed: boolean
  stallTimeout: number

  add<T>(name: string, spec: ChildSpec<T> | (() => ChildSpec<T>)): this
  get<T = unknown>(name: string): T
  ready(): Promise<void>
  close(): Promise<void>
  suspend(opts?: SuspendOptions): Promise<void>
  resume(): Promise<void>
  reload<T>(name: string, spec?: ChildSpec<T>): Promise<void>
  inspect(): ChildInfo[]

  on<E extends keyof SupervisorEvents>(
    event: E,
    listener: (payload: SupervisorEvents[E]) => void
  ): this
  off<E extends keyof SupervisorEvents>(
    event: E,
    listener: (payload: SupervisorEvents[E]) => void
  ): this
  once<E extends keyof SupervisorEvents>(
    event: E,
    listener: (payload: SupervisorEvents[E]) => void
  ): this
  emit(event: string, ...args: unknown[]): boolean
}
