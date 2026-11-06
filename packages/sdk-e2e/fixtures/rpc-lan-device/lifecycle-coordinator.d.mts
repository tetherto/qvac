export interface LifecycleTransition {
  operation: 'suspend' | 'resume' | 'close'
  outcome: 'succeeded' | 'failed'
  runtimeState?: string
  closing: boolean
  closed: boolean
  error?: string
  at: number
}

export interface LifecycleCoordinator {
  readonly closing: boolean
  readonly closed: boolean
  setForeground(active: boolean): Promise<void>
  suspend(): Promise<void>
  resume(): Promise<void>
  run<T>(work: () => Promise<T>): Promise<T>
  close(cleanup?: () => Promise<void>): Promise<void>
}

export function createLifecycleCoordinator(engine: {
  suspend(): Promise<unknown>
  resume(): Promise<unknown>
  state(): Promise<string>
  close(): Promise<unknown>
  ontransition?(transition: LifecycleTransition): void
}): LifecycleCoordinator
